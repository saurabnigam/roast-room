import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, mockFetch, sse } from "./helpers.mjs";

// Everything here runs against a disposable repo and a fake fetch. No test makes a live call.
// Every council a test starts is run to its end before the test returns, so the fake fetch is
// never put back while a council could still call out.
const repo = makeRepo({
  seats: [
    { key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos", pillar: "Customer obsession" },
    { key: "graham", name: "Paul Graham", short: "Graham", slug: "paul-graham", model: "claude-opus-5-5" },
    { key: "buffett", name: "Warren Buffett", short: "Buffett", slug: "warren-buffett", provider: "openai" },
    { key: "naval", name: "Naval Ravikant", short: "Naval", slug: "naval-ravikant", provider: "google" },
    { key: "priya", name: "Priya Rao", short: "Priya", provider: "human", pillar: "Family and health", dimension: "Family cost" },
    { key: "munger", name: "Charlie Munger", short: "Munger", slug: "charlie-munger" },
  ],
  def: ["bezos", "graham", "buffett", "priya"],
});
process.env.ROAST_ROOT = repo.root;
process.env.ANTHROPIC_API_KEY = "a-test";
process.env.OPENAI_API_KEY = "sk-test";
for (const k of ["GEMINI_API_KEY", "SEAT_MODEL", "CHAIR_MODEL", "OPENAI_SEAT_MODEL", "GEMINI_SEAT_MODEL"]) delete process.env[k];
process.env.HUMAN_DEADLINE_MIN = "0.05";
// CHAIR_MODEL comes from .env, not from the process environment, to prove MODELS reads through env().
fs.writeFileSync(path.join(repo.root, ".env"), "CHAIR_MODEL=chair-from-dotenv\n");

const { setSleep } = await import("../app/lib/providers/http.mjs");
setSleep(async () => {});
after(() => { repo.cleanup(); setSleep(); });

const C = await import("../app/lib/council.mjs");
const {
  startCouncil, resume, missingKeys, pickableSeats, runnersFor, finalNumbers, verdictSeats, MODELS, DISCLAIMER,
  setSeatTimeout,
} = C;
const { listPending, submitAnswer } = await import("../app/lib/inbox.mjs");
const runnersJs = await import("../app/public/runners.js");

// ---------------------------------------------------------------- the fake providers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evs = (s, type) => s.events.filter((e) => e.type === type);
const ev = (s, type) => evs(s, type)[0];
const pauseOf = (s, kind) => s.events.find((e) => e.type === "pause" && e.kind === kind);
const countOf = (calls, host) => calls.filter((c) => c.url.includes(host)).length;

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${fn}`);
    await sleep(15);
  }
}

/** Stop whatever pause comes, until the council ends. */
async function settle(s, ms = 15000) {
  const t0 = Date.now();
  while (s.status === "running") {
    resume(s.id, "stop");
    if (Date.now() - t0 > ms) throw new Error("the council did not end");
    await sleep(15);
  }
}
/** Pass the privacy pause. */
async function confirm(s) {
  await until(() => pauseOf(s, "privacy"));
  assert.equal(resume(s.id, "continue"), true);
}

const LEAN = { bezos: [7, 4], graham: [6, 5], buffett: [8, 3], naval: [7, 5] };
const VOTE = { bezos: "Endorse", graham: "Endorse with amendment", buffett: "Dissent", naval: "Endorse" };
function card(key, round) {
  const [a, b] = LEAN[key] || [6, 5];
  const name = key.toUpperCase();
  const scores = `OPTION SCORES: A ${a}/10 · B ${b}/10`;
  if (round === 1) return `SEAT: ${name} (Pillar)\nSTANCE: Yes\n${scores}\nPILLAR SCORE: 6/10\nCONFIDENCE: 4/5\nRUIN RISK: none\nDOOR: two-way\n\nTHE CALL: ${name} says do A.\nWHY:\n1. It pays.`;
  if (round === 2) return `SEAT: ${name}\nI DISAGREE MOST WITH: Graham. Too slow.\nI CONCEDE: Nothing.\nSTANCE: Yes\n${scores}\nPILLAR SCORE: 6/10\nCONFIDENCE: 4/5\nRUIN RISK: none\nMOVED: no`;
  return `SEAT: ${name}\nVOTE: ${VOTE[key] || "Endorse"}\n${scores}\nFINAL SCORE: 8/10\nONE LINE FOR THE FOUNDER: ${name} line.`;
}
const who = (text) => ({
  key: /You hold the (\w+) seat/.exec(text)[1].toLowerCase(),
  round: Number(/ROUND (\d) OF 3/.exec(text)[1]),
});

const seatStream = (text, stop = "end_turn") => sse([
  { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
  { type: "content_block_delta", delta: { type: "text_delta", text } },
  { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 50 } },
]);
const chairJson = (obj) => ({ json: { content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } });
const openaiBody = (text, status = "completed") => ({ json: { status, output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 50 } } });
const googleBody = (text) => ({ json: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 40 } } });
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));

function chair(prompt, body, o) {
  if (prompt.includes("A founder brought this")) {
    const seats = body.output_config.format.schema.properties.seats.items.enum;
    return chairJson({
      title: "Raise prices", decision: "Raise prices for everyone or only new clients?", brief: "A small studio with 40 clients.",
      options: [{ id: "A", label: "Raise for everyone" }, { id: "B", label: "Only new clients" }],
      assumptions: ["Churn is 3 percent a year"],
      weights: seats.map((seat, i) => ({ seat, weight: i === 0 ? 3 : 2, reason: "It touches this pillar." })),
      quick_seats: seats.slice(0, 4), seats,
    });
  }
  if (prompt.includes("Name the one to three cruxes")) {
    if (o.failCruxes) return { status: 400, text: "stop here" };
    return chairJson({ cruxes: [{ question: "Will churn rise?", sides: [{ position: "yes", seats: ["bezos"] }, { position: "no", seats: ["graham"] }] }], unanimous: false, note: "They split on churn.", pressure: [] });
  }
  if (prompt.includes("Write the draft resolution")) {
    return chairJson({ option: "A", label: "GO WITH CONDITIONS", recommendation: "Raise prices for new clients first.", conditions: ["Churn stays under 5 percent"], next_steps: ["Email ten clients"], cheapest_test: "One month on new clients", kill_criteria: "Churn above 8 percent" });
  }
  if (prompt.includes("Write the verdict")) {
    return chairJson({
      label: "GO WITH CONDITIONS", call: "Raise prices for new clients first.", override_note: "",
      why: [{ point: "It pays", seat: "Bezos", framework: "Flywheel" }], fights: [{ crux: "Will churn rise?", story: "Bezos and Graham split." }],
      minority: { seat: "Buffett", quote: "No.", would_have_to_be_true: "Churn rises." }, amendments: [],
      conditions: ["Churn stays under 5 percent"], next_steps: [{ when: "Monday", action: "Email ten clients" }],
      cheapest_test: "One month", kill_criteria: "Churn above 8 percent", revisit: "In 90 days",
    });
  }
  throw new Error(`unrouted chair prompt: ${prompt.slice(0, 60)}`);
}

/**
 * Fake Anthropic, OpenAI and Google. `o.claude`, `o.openai` and `o.google` may return a reply for
 * a seat call, or nothing to get the normal card. `o.failCruxes` ends the council after Round 1.
 */
function world(t, o = {}) {
  const tries = new Map();
  const m = mockFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes("api.anthropic.com")) {
      if (body.stream) {
        const { key, round } = who(body.messages[0].content);
        return (await o.claude?.(key, round, init)) ?? seatStream(card(key, round));
      }
      return chair(body.messages[0].content, body, o);
    }
    if (url.includes("api.openai.com")) {
      const { key, round } = who(body.input);
      const id = `${key}/${round}`;
      tries.set(id, (tries.get(id) || 0) + 1);
      return (await o.openai?.(key, round, tries.get(id), init)) ?? openaiBody(card(key, round));
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      const { key, round } = who(body.contents[0].parts[0].text);
      return (await o.google?.(key, round, init)) ?? googleBody(card(key, round));
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(() => m.restore());
  return m;
}

let bump = 0;
const rosterFile = path.join(repo.root, ".claude", "skills", "roast-room", "roster.json");
const rosterOriginal = JSON.parse(fs.readFileSync(rosterFile, "utf8"));
/** Rewrite the roster for one test: which seats exist, the board mode and the default board. */
function setRoster({ keys, board = "default", def } = {}) {
  const seats = rosterOriginal.seats.filter((x) => !keys || keys.includes(x.key));
  fs.writeFileSync(rosterFile, JSON.stringify({ ...rosterOriginal, board, default: def ?? rosterOriginal.default, seats }, null, 2));
  const at = new Date(Date.now() + (++bump) * 2000);
  fs.utimesSync(rosterFile, at, at);
}
/** Set (or delete) one env var around fn. A sync fn runs and restores synchronously, so its failures
 * surface in the test; an async fn is awaited by the caller. */
function withEnv(key, value, fn) {
  const old = process.env[key];
  const restore = () => { if (old === undefined) delete process.env[key]; else process.env[key] = old; };
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}
const NO_HUMAN = ["bezos", "graham", "buffett"];

const good = {
  1: { STANCE: "Conditional yes", "OPTION SCORES": { A: 7, B: 4 }, "THE CALL": "Do A first.", CONFIDENCE: 4, "RUIN RISK": "none", DOOR: "two-way" },
  3: { VOTE: "Endorse", "OPTION SCORES": { A: 8, B: 3 }, "FINAL SCORE": 8 },
};

// ---------------------------------------------------------------- the numbers
const mk = (vote) => ({ text: "x", parsed: { optionScores: { A: 7, B: 3 }, vote, finalScore: 8, confidence: 3 } });
const stOf = (cards3, rounds = [1, 2, 3]) => ({
  options: [{ id: "A" }, { id: "B" }], seats: ["bezos", "graham", "buffett"],
  weights: { bezos: { weight: 2 }, graham: { weight: 1 }, buffett: { weight: 1 } },
  rounds, cards: { 1: {}, 2: {}, 3: cards3 }, scores: {},
});

test("finalNumbers ignores absent seats in votes", () => {
  const st = stOf({ bezos: mk("endorse"), graham: mk("dissent") });
  assert.deepEqual(finalNumbers(st).votes, { endorse: 1, dissent: 1 });
});

test("finalNumbers does not count a Round 3 card with no parsed vote", () => {
  const st = stOf({ bezos: mk("endorse"), graham: mk(""), buffett: mk("amend") });
  assert.deepEqual(finalNumbers(st).votes, { endorse: 1, amend: 1 });
});

test("finalNumbers has no votes before Round 3, and no vote at all when nobody voted", () => {
  assert.equal(finalNumbers(stOf({}, [1, 2])).votes, null);
  assert.deepEqual(finalNumbers(stOf({})).votes, {});
});

test("verdictSeats marks a seat with no card in the last round as absent", () => {
  const st = stOf({ bezos: mk("endorse") });
  const rows = verdictSeats(st, 3);
  assert.deepEqual(rows.map((r) => [r.key, r.absent]), [["bezos", false], ["graham", true], ["buffett", true]]);
});

const cardOf = (parsed) => ({ text: "x", parsed: { optionScores: { A: 7, B: 3 }, vote: "", finalScore: null, confidence: 3, pillar: null, stance: "Yes", oneLine: "", moved: "", ...parsed } });

test("verdictSeats gives an absent seat no stance, scores, pillar or line, even if it spoke in an earlier round", () => {
  const st = stOf({ bezos: cardOf({ vote: "endorse", pillar: 6, oneLine: "Protect the family." }) });
  // Graham answered Round 2 and then missed the vote: his Round 2 words must not read as a vote
  st.cards[2] = { graham: cardOf({ stance: "Strong yes", pillar: 9, optionScores: { A: 9, B: 1 }, oneLine: "stale" }) };
  const row = Object.fromEntries(verdictSeats(st, 3).map((r) => [r.key, r]));
  assert.equal(row.graham.absent, true);
  assert.deepEqual([row.graham.stance, row.graham.optionScores, row.graham.pillar, row.graham.oneLine], [null, null, null, null]);
  assert.deepEqual([row.buffett.stance, row.buffett.optionScores, row.buffett.pillar, row.buffett.oneLine], [null, null, null, null]);
  assert.equal(row.bezos.absent, false);
  assert.equal(row.bezos.stance, "endorse");
  assert.deepEqual(row.bezos.optionScores, { A: 7, B: 3 });
  assert.equal(row.bezos.pillar, 6);
  assert.equal(row.bezos.oneLine, "Protect the family.");
});

test("verdictSeats still falls back to the Round 2 stance for a seat that answered the last round without a vote", () => {
  const st = stOf({ bezos: cardOf({ vote: "" }) });
  st.cards[2] = { bezos: cardOf({ stance: "Conditional yes", pillar: 5 }) };
  const row = verdictSeats(st, 3)[0];
  assert.equal(row.absent, false);
  assert.equal(row.stance, "Conditional yes");
  assert.equal(row.pillar, 5);
});

// Confidence averages the Round 2 card's confidence. Weights are 2, 1, 1; all three lean the same way, so the spread is 0.
const stConf = (cards1, cards2) => ({
  options: [{ id: "A" }, { id: "B" }], seats: ["bezos", "graham", "buffett"],
  weights: { bezos: { weight: 2 }, graham: { weight: 1 }, buffett: { weight: 1 } },
  rounds: [1, 2], cards: { 1: cards1, 2: cards2, 3: {} }, scores: {},
});

test("finalNumbers leaves a seat with no Round 2 card out of the confidence average", () => {
  // Buffett was sure (5) in Round 1 and missed Round 2. Averaging 3, 3 and 5 would give 7; the answer is 6.
  const r1 = { bezos: cardOf({ confidence: 3 }), graham: cardOf({ confidence: 3 }), buffett: cardOf({ confidence: 5 }) };
  const r2 = { bezos: cardOf({ confidence: 3 }), graham: cardOf({ confidence: 3 }) };
  assert.equal(finalNumbers(stConf(r1, r2)).confidence, 6);
});

test("finalNumbers uses the Round 1 confidence only for a Round 2 card that gave none", () => {
  const r1 = { bezos: cardOf({ confidence: 3 }), graham: cardOf({ confidence: 3 }), buffett: cardOf({ confidence: 5 }) };
  const r2 = { bezos: cardOf({ confidence: 3 }), graham: cardOf({ confidence: 3 }), buffett: cardOf({ confidence: null }) };
  assert.equal(finalNumbers(stConf(r1, r2)).confidence, 7, "(3 + 3 + 5) / 3 = 3.67, doubled and rounded");
});

test("finalNumbers has no confidence when nobody answered Round 2", () => {
  const r1 = { bezos: cardOf({ confidence: 4 }) };
  assert.equal(finalNumbers(stConf(r1, {})).confidence, null);
});

// ---------------------------------------------------------------- keys, seats, runners
test("MODELS reads SEAT_MODEL and CHAIR_MODEL through env(), so .env works", () => {
  assert.equal(MODELS.chair, "chair-from-dotenv");
  assert.equal(MODELS.seat, "claude-sonnet-5-5");
});

test("DISCLAIMER is the one in runners.js", () => {
  assert.equal(DISCLAIMER, runnersJs.DISCLAIMER);
});

test("missingKeys names the seat and the env var", () => {
  setRoster();
  withEnv("OPENAI_API_KEY", undefined, () => {
    assert.deepEqual(missingKeys(["bezos", "buffett"]), [{ seat: "buffett", provider: "openai", env: "OPENAI_API_KEY" }]);
    assert.deepEqual(missingKeys(["naval"]), [{ seat: "naval", provider: "google", env: "GEMINI_API_KEY" }]);
  });
  assert.deepEqual(missingKeys(["bezos", "buffett", "priya"]), [], "a person needs no key, and every key is set");
  assert.deepEqual(missingKeys(["nobody"]), [], "an unknown seat is not a key problem");
});

test("missingKeys also reports the Chair when ANTHROPIC_API_KEY is unset", async () => {
  await withEnv("ANTHROPIC_API_KEY", undefined, () => {
    assert.deepEqual(missingKeys(["bezos", "buffett"]), [
      { seat: "bezos", provider: "anthropic", env: "ANTHROPIC_API_KEY" },
      { seat: "chair", provider: "anthropic", env: "ANTHROPIC_API_KEY" },
    ]);
    assert.deepEqual(missingKeys(["priya"]), [{ seat: "chair", provider: "anthropic", env: "ANTHROPIC_API_KEY" }]);
  });
});

test("pickableSeats excludes humans and keyless providers", () => {
  setRoster();
  assert.deepEqual(pickableSeats(), ["bezos", "graham", "buffett", "munger"]);
  withEnv("GEMINI_API_KEY", "g-test", () => assert.deepEqual(pickableSeats(), ["bezos", "graham", "buffett", "naval", "munger"]));
  withEnv("OPENAI_API_KEY", undefined, () => assert.deepEqual(pickableSeats(), ["bezos", "graham", "munger"]));
});

test("runnersFor gives each seat a provider, a model and a transport", () => {
  setRoster();
  assert.deepEqual(runnersFor(["bezos", "graham", "buffett", "naval", "priya", "nobody"]), {
    bezos: { provider: "anthropic", model: "claude-sonnet-5-5", transport: "http" },
    graham: { provider: "anthropic", model: "claude-opus-5-5", transport: "http" },
    buffett: { provider: "openai", model: "gpt-6.1-sol", transport: "http" },
    naval: { provider: "google", model: "gemini-3.8-flash", transport: "http" },
    priya: { provider: "human", model: null, transport: "form" },
  });
});

test("runnersFor honours SEAT_MODEL for an Anthropic seat with no model of its own", () => {
  setRoster();
  withEnv("SEAT_MODEL", "claude-env-model", () => {
    const r = runnersFor(["bezos", "graham"]);
    assert.equal(r.bezos.model, "claude-env-model");
    assert.equal(r.graham.model, "claude-opus-5-5", "the seat's own model still wins");
  });
});

test("resume is false when nothing is paused, and for an action it does not know", async (t) => {
  assert.equal(resume("no-such-session", "continue"), false);
  world(t);
  setRoster({ def: NO_HUMAN });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await until(() => pauseOf(s, "privacy"));
  assert.equal(resume(s.id, "later"), false);
  assert.equal(resume(s.id, undefined), false);
  assert.equal(ev(s, "resumed"), undefined, "a refused action leaves the pause in place");
  assert.equal(resume(s.id, "stop"), true);
  assert.equal(resume(s.id, "stop"), false, "a pause answers once");
  await settle(s);
});

// ---------------------------------------------------------------- the privacy pause
test("stop at the privacy pause sends nothing outside Anthropic", async (t) => {
  const w = world(t);
  setRoster();
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  const p = await until(() => pauseOf(s, "privacy"));
  assert.match(p.recipients, /OpenAI \(Buffett, via API\)/);
  assert.equal(countOf(w.calls, "api.openai.com"), 0);
  assert.equal(countOf(w.calls, "generativelanguage"), 0);
  assert.equal(w.calls.filter((c) => c.body?.stream).length, 0, "no seat has been called");
  assert.equal(s.status, "running");
  // Priya is on this board, but nobody has asked her anything yet. An answer with no fields is a 400 if
  // her request exists and a 404 if it does not, and it can never resolve a request.
  const noInbox = () => {
    assert.equal(listPending().filter((x) => x.session === s.id).length, 0, "no request is waiting for a person");
    assert.equal(submitAnswer({ session: s.id, seat: "priya", round: 1, fields: {} }).code, 404, "no request was opened for her");
  };
  noInbox();

  assert.equal(resume(s.id, "stop"), true);
  await until(() => s.status !== "running");
  assert.equal(s.status, "stopped");
  assert.equal(ev(s, "resumed").action, "stop");
  assert.equal(ev(s, "resumed").kind, "privacy");
  assert.equal(ev(s, "error").error, "Stopped before Round 1. Nothing was sent outside Anthropic.");
  assert.equal(ev(s, "round_start"), undefined);
  assert.equal(countOf(w.calls, "api.openai.com"), 0);
  noInbox();
  assert.equal(evs(s, "waiting").length, 0);
  assert.ok(fs.existsSync(path.join(s.dir, "events.json")), "the stopped council is saved");
  assert.equal(subscribeEnds(s), true);
});

/** A late subscriber to a finished council gets the events and then "end". */
function subscribeEnds(s) {
  let out = "";
  C.subscribe(s, { write: (x) => { out += x; }, on() {} });
  return out.trimEnd().endsWith('data: {"type":"end"}');
}

test("a two-seat all-Anthropic board has no privacy pause, and two answers are a full table", async (t) => {
  world(t, { failCruxes: true });
  setRoster({ keys: ["bezos", "graham"], def: ["bezos", "graham"] });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await until(() => s.status !== "running"); // failCruxes ends the council after Round 1
  assert.equal(pauseOf(s, "privacy"), undefined);
  assert.deepEqual(Object.values(ev(s, "setup").runners).map((r) => r.provider), ["anthropic", "anthropic"]);
  assert.equal(evs(s, "round_done").length, 1);
  assert.deepEqual(evs(s, "seat_done").map((e) => e.seat).sort(), ["bezos", "graham"]);
  assert.equal(evs(s, "pause").length, 0, "both seats answered, so nothing is short");
});

test("a two-seat board where one seat answers pauses with have 1", async (t) => {
  world(t, { failCruxes: true, claude: (key) => (key === "graham" ? { status: 400, text: "refused" } : undefined) });
  setRoster({ keys: ["bezos", "graham"], def: ["bezos", "graham"] });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  const q = await until(() => pauseOf(s, "quorum"));
  assert.deepEqual([q.round, q.have], [1, 1]);
  assert.deepEqual(evs(s, "seat_absent").map((e) => e.seat), ["graham"]);
  await settle(s);
  assert.equal(ev(s, "error").error, "Stopped after Round 1: only 1 seats answered.");
});

test("a one-seat board whose seat fails pauses with have 0", async (t) => {
  world(t, { failCruxes: true, claude: () => ({ status: 400, text: "refused" }) });
  setRoster({ keys: ["bezos"], def: ["bezos"] });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  const q = await until(() => pauseOf(s, "quorum"));
  assert.deepEqual([q.round, q.have], [1, 0]);
  await settle(s);
});

test("an all-Anthropic council runs to a verdict with no pause and no waiting, and the footer is the plain disclaimer", async (t) => {
  world(t);
  setRoster({ keys: ["bezos", "graham", "munger"], def: ["bezos", "graham", "munger"] });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await until(() => s.status !== "running", 15000);
  assert.equal(s.status, "done");
  assert.deepEqual(evs(s, "pause"), []);
  assert.deepEqual(evs(s, "waiting"), []);
  assert.deepEqual(evs(s, "waiting_done"), []);
  assert.deepEqual(Object.values(ev(s, "setup").runners).map((r) => r.provider), ["anthropic", "anthropic", "anthropic"]);
  assert.equal(evs(s, "seat_done").length, 9, "three seats, three rounds");
  const { verdict, seats } = ev(s, "verdict");
  assert.equal(verdict.disclaimer, DISCLAIMER);
  assert.deepEqual(verdict.votes, { endorse: 2, amend: 1 });
  assert.ok(seats.every((r) => r.absent === false && r.stance));
  const md = fs.readFileSync(path.join(s.dir, "verdict.md"), "utf8");
  assert.equal(md.trimEnd().split("\n").at(-1), DISCLAIMER, "the last line of verdict.md is the disclaimer");
  assert.equal(subscribeEnds(s), true);
});

// ---------------------------------------------------------------- the board
test("an empty board ends the council before any call", async (t) => {
  const w = world(t);
  setRoster({ keys: ["buffett", "priya"], def: [] });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await until(() => s.status !== "running");
  assert.equal(s.status, "error");
  assert.equal(ev(s, "error").error, "No seats can run: the board is empty.");
  assert.equal(w.calls.length, 0);
  assert.equal(ev(s, "setup"), undefined);
  setRoster();
});

test("in pick mode the Chair is offered only seats that can run, never a person", async (t) => {
  const w = world(t, { failCruxes: true });
  setRoster({ board: "auto" });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await until(() => pauseOf(s, "privacy"));
  const offered = w.calls[0].body.output_config.format.schema.properties.seats.items.enum;
  assert.deepEqual(offered, ["bezos", "graham", "buffett", "munger"], "no priya, and no naval without a Gemini key");
  assert.deepEqual(ev(s, "setup").seats, offered);
  await settle(s);

  // Without an OpenAI key Buffett cannot run, so the Chair is not offered him
  await withEnv("OPENAI_API_KEY", undefined, async () => {
    const first = w.calls.length;
    const s2 = startCouncil("Should I raise prices for everyone or only new clients?", "full");
    await until(() => s2.status !== "running"); // three Claude seats: no pause, and failCruxes ends it after Round 1
    assert.deepEqual(w.calls[first].body.output_config.format.schema.properties.seats.items.enum, ["bezos", "graham", "munger"]);
    assert.equal(pauseOf(s2, "privacy"), undefined);
  });
  setRoster();
});

test("in default mode the Chair sees the default board, person included", async (t) => {
  const w = world(t);
  setRoster();
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await until(() => pauseOf(s, "privacy"));
  assert.deepEqual(w.calls[0].body.output_config.format.schema.properties.seats.items.enum, ["bezos", "graham", "buffett", "priya"]);
  const system = w.calls[0].body.system;
  const text = typeof system === "string" ? system : system.map((b) => b.text).join("");
  assert.match(text, /real person who answers live: Priya Rao/);
  const simulated = text.split(", and 1 real person")[0];
  assert.match(simulated, /^You are the Chair of a Roast Room council: 3 simulated advisors built from the public work of Jeff Bezos/);
  assert.doesNotMatch(simulated, /Priya/, "a person is not described as a simulation");
  await settle(s);
});

// ---------------------------------------------------------------- a mixed council end to end
test("mixed council: privacy pause, human answers, absent seat, verdict", async (t) => {
  const w = world(t, {
    // Buffett fails in Round 3 only: a seat that is absent in the last round
    openai: (key, round) => (round === 3 ? { status: 500, text: "down" } : undefined),
  });
  setRoster();
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await until(() => pauseOf(s, "privacy"));
  assert.match(pauseOf(s, "privacy").recipients, /OpenAI \(Buffett, via API\).*Priya on this screen/);
  assert.equal(countOf(w.calls, "api.openai.com"), 0); // nothing sent before confirm
  assert.equal(w.calls.length, 1, "only the Chair's setup call has gone out");

  assert.equal(resume(s.id, "continue"), true);
  assert.deepEqual([ev(s, "resumed").kind, ev(s, "resumed").action], ["privacy", "continue"]);
  await until(() => ev(s, "waiting"));
  const w1 = ev(s, "waiting");
  assert.equal(w1.round, 1);
  assert.deepEqual(w1.seats.map((x) => x.key), ["priya"]);
  assert.ok(Date.parse(w1.seats[0].deadline) > Date.now(), "the deadline is in the future");
  assert.ok(s.events.indexOf(w1) < s.events.findIndex((e) => e.type === "seat_start"), "waiting comes before any seat starts");

  // Round 1: the person sees the brief and nothing else
  const r1 = listPending().find((x) => x.session === s.id);
  assert.deepEqual(r1.context.map((c) => c.name), ["brief.md"]);
  assert.match(r1.context[0].text, /THE DECISION: Raise prices/);
  assert.deepEqual(r1.options.map((o) => o.id), ["A", "B"]);
  assert.equal(r1.round, 1);
  assert.equal(submitAnswer({ session: s.id, seat: "priya", round: 1, fields: good[1] }).code, 200);

  // Round 2: Priya sees every Round 1 card and the cruxes, and does not answer
  await until(() => evs(s, "waiting").some((e) => e.round === 2));
  const r2 = listPending().find((x) => x.session === s.id);
  assert.deepEqual(r2.context.map((c) => c.name), ["brief.md", "round-1.md", "cruxes.json"]);
  assert.match(r2.context[1].text, /BEZOS says do A/);
  assert.match(r2.context[1].text, /PRIYA|Priya/);
  assert.match(r2.context[2].text, /Will churn rise\?/);

  // Round 3: the deadline passed in Round 2, and Priya is asked again. She sees no Round 2 card of her own.
  await until(() => evs(s, "waiting").some((e) => e.round === 3));
  assert.ok(evs(s, "seat_absent").some((e) => e.round === 2 && e.seat === "priya" && e.reason === "no answer by the deadline"));
  const r3 = listPending().find((x) => x.session === s.id);
  assert.deepEqual(r3.context.map((c) => c.name), ["brief.md", "draft-resolution.md"]);
  assert.match(r3.context[1].text, /Raise prices for new clients first/);
  assert.equal(submitAnswer({ session: s.id, seat: "priya", round: 3, fields: good[3] }).code, 200);

  await until(() => s.status !== "running", 15000);
  assert.equal(s.status, "done");
  assert.ok(evs(s, "seat_absent").some((e) => e.round === 2 && e.seat === "priya"));
  assert.ok(ev(s, "verdict").verdict.disclaimer.includes("Priya Rao"));
  assert.equal(ev(s, "setup").runners.buffett.transport, "http");
  assert.deepEqual(ev(s, "setup").runners.priya, { provider: "human", model: null, transport: "form" });
  assert.equal(pauseOf(s, "quorum"), undefined, "every round had three cards or more");

  // Buffett was absent in Round 3: he is out of the vote tally and flagged in the verdict seats
  const { verdict, seats } = ev(s, "verdict");
  assert.deepEqual(evs(s, "seat_absent").filter((e) => e.round === 3).map((e) => e.seat), ["buffett"]);
  assert.deepEqual(verdict.votes, { endorse: 2, amend: 1 });
  assert.deepEqual(seats.map((r) => [r.key, r.absent]), [["bezos", false], ["graham", false], ["buffett", true], ["priya", false]]);
  const row = Object.fromEntries(seats.map((r) => [r.key, r]));
  assert.deepEqual([row.buffett.stance, row.buffett.optionScores, row.buffett.pillar, row.buffett.oneLine], [null, null, null, null], "no stale Round 2 stance for the absent seat");
  assert.equal(row.bezos.stance, "endorse");
  assert.deepEqual(row.bezos.optionScores, { A: 7, B: 4 });
  assert.equal(row.bezos.oneLine, "BEZOS line.");
  assert.equal(row.priya.stance, "endorse");

  // The room is told when each wait begins and ends, in order
  for (const round of [1, 2, 3]) {
    const i = s.events.findIndex((e) => e.type === "waiting" && e.round === round);
    const j = s.events.findIndex((e) => e.type === "waiting_done" && e.round === round);
    const k = s.events.findIndex((e) => e.type === "round_done" && e.round === round);
    assert.ok(i >= 0 && j > i && k > j, `round ${round}: waiting, then waiting_done, then round_done`);
  }

  // Models and what each provider was sent
  const claude = w.calls.filter((c) => c.body?.stream);
  assert.ok(claude.length >= 6);
  for (const c of claude) {
    const key = who(c.body.messages[0].content).key;
    assert.equal(c.body.model, key === "graham" ? "claude-opus-5-5" : "claude-sonnet-5-5");
    assert.equal(c.body.max_tokens, 1400);
    assert.ok(c.init.signal instanceof AbortSignal, "every Claude seat call can time out");
  }
  const oa = w.calls.filter((c) => c.url.includes("api.openai.com"));
  assert.ok(oa.length >= 2);
  for (const c of oa) {
    assert.equal(c.body.model, "gpt-6.1-sol");
    assert.equal(c.body.max_output_tokens, 4000);
    assert.ok(c.init.signal instanceof AbortSignal, "every OpenAI seat call can time out");
    assert.match(c.body.instructions, /Answer as Warren Buffett would/);
    assert.match(c.body.input, /Reply with the card only/);
    assert.doesNotMatch(JSON.stringify(c.body), /sk-test|a-test/, "no key in a request body");
  }
  const chairCalls = w.calls.filter((c) => c.url.includes("anthropic") && !c.body.stream);
  assert.ok(chairCalls.every((c) => c.body.model === "chair-from-dotenv"));
  // The Round 3 prompt keeps its text after the refactor, and shows the seat its own Round 2 card
  const r3Prompt = oa.find((c) => who(c.body.input).round === 3).body.input;
  assert.match(r3Prompt, /YOUR ROUND 2 CARD\nSEAT: BUFFETT\n/);
  assert.match(r3Prompt, /THE CHAIR'S DRAFT RESOLUTION\nRecommendation: GO WITH CONDITIONS on option A\. Raise prices for new clients first\.\nConditions:\n- Churn stays under 5 percent\nNext steps:\n- Email ten clients\nCheapest test: One month on new clients\nKill criteria: Churn above 8 percent\n\nAnswer in your seat's voice, first person, under 140 words/);
  // Independence: a Round 1 prompt carries no other seat's card
  const r1Prompts = oa.filter((c) => who(c.body.input).round === 1).map((c) => c.body.input);
  assert.ok(r1Prompts.length === 1 && !/BEZOS says do A/.test(r1Prompts[0]));

  // usage: Claude's tally plus a per-provider tally
  const u = ev(s, "usage").usage;
  assert.ok(u.calls > 0 && u.providers.openai.calls > 0 && u.providers.google.calls >= 0);
  assert.notEqual(u.providers, undefined);

  // The council is over, so its inbox requests are gone
  assert.equal(submitAnswer({ session: s.id, seat: "priya", round: 3, fields: good[3] }).code, 404);
  assert.equal(listPending().filter((x) => x.session === s.id).length, 0);

  // The saved files carry the same disclaimer and say who was absent
  assert.ok(fs.readFileSync(path.join(s.dir, "verdict.md"), "utf8").includes(verdict.disclaimer));
  const round2 = fs.readFileSync(path.join(s.dir, "round-2.md"), "utf8");
  assert.match(round2, /## Priya Rao[^\n]*\n\n\(absent: no answer by the deadline\)/);
  assert.equal(subscribeEnds(s), true);
});

// ---------------------------------------------------------------- failures
test("a seat that fails twice is absent, and the council goes on without it", async (t) => {
  // The network drops and the error text carries the key. A dropped connection is worth one more try,
  // and the key must not reach an event or a saved file.
  const w = world(t, { failCruxes: true, openai: () => { throw new Error("connection reset, key sk-test"); } });
  setRoster({ def: NO_HUMAN });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await confirm(s);
  await until(() => pauseOf(s, "quorum"));
  assert.equal(countOf(w.calls, "api.openai.com"), 2, "tried once, retried once");
  const err = evs(s, "seat_error");
  assert.equal(err.length, 1);
  assert.deepEqual([err[0].seat, err[0].round], ["buffett", 1]);
  assert.match(err[0].error, /OpenAI request failed/);
  const gone = evs(s, "seat_absent");
  assert.equal(gone.length, 1);
  assert.deepEqual([gone[0].seat, gone[0].round], ["buffett", 1]);
  assert.match(gone[0].reason, /OpenAI request failed/);
  assert.ok(s.events.indexOf(err[0]) < s.events.indexOf(gone[0]), "seat_error, then seat_absent");
  assert.deepEqual(evs(s, "seat_done").map((e) => e.seat).sort(), ["bezos", "graham"]);
  assert.equal(pauseOf(s, "quorum").have, 2);
  assert.equal(pauseOf(s, "quorum").round, 1);
  await settle(s);
  assert.match(gone[0].reason, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(s.events), /sk-test|"a-test"/, "no key in any event");
  assert.doesNotMatch(fs.readFileSync(path.join(s.dir, "events.json"), "utf8"), /sk-test/, "no key in the saved file");
  assert.doesNotMatch(fs.readFileSync(path.join(s.dir, "round-1.md"), "utf8"), /sk-test/);
});

test("a seat whose first try fails and whose second works is not absent", async (t) => {
  const w = world(t, { failCruxes: true, openai: (key, round, n) => { if (n === 1) throw new Error("connection reset"); } });
  setRoster({ def: NO_HUMAN });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await confirm(s);
  await until(() => s.status !== "running");
  assert.equal(countOf(w.calls, "api.openai.com"), 2);
  assert.equal(evs(s, "seat_error").length, 0);
  assert.equal(evs(s, "seat_absent").length, 0);
  assert.deepEqual(evs(s, "seat_done").map((e) => e.seat).sort(), ["bezos", "buffett", "graham"]);
  assert.equal(pauseOf(s, "quorum"), undefined, "three cards from three seats: no quorum pause");
  assert.equal(evs(s, "round_done").length, 1);
});

test("an error a second try cannot fix is not retried", async (t) => {
  await withEnv("GEMINI_API_KEY", "g-test", async () => {
    const w = world(t, {
      failCruxes: true,
      openai: () => ({ status: 429, text: '{"error":{"code":"insufficient_quota"}}' }), // no credit left
      google: () => ({ status: 403, text: "forbidden" }),                                // a key that is refused
    });
    setRoster({ def: ["bezos", "buffett", "naval"] });
    const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
    await confirm(s);
    await until(() => pauseOf(s, "quorum"));
    assert.equal(countOf(w.calls, "api.openai.com"), 1, "insufficient_quota is not retried");
    assert.equal(countOf(w.calls, "generativelanguage"), 1, "a 403 is not retried");
    const why = Object.fromEntries(evs(s, "seat_absent").map((e) => [e.seat, e.reason]));
    assert.match(why.buffett, /OpenAI 429/);
    assert.match(why.naval, /Google 403/);
    assert.equal(pauseOf(s, "quorum").have, 1);
    await settle(s);
  });
  setRoster();
});

test("a card that cannot be read makes the seat absent, not silent", async (t) => {
  // Graham's brain folder holds a folder where a file should be, so reading it for the quote check fails.
  const bad = path.join(repo.root, ".claude", "skills", "roast-room", "brains", "paul-graham", "unreadable");
  fs.mkdirSync(bad);
  t.after(() => fs.rmSync(bad, { recursive: true, force: true }));
  world(t, { failCruxes: true });
  setRoster({ def: NO_HUMAN });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await confirm(s);
  await until(() => pauseOf(s, "quorum"));
  const gone = evs(s, "seat_absent");
  assert.deepEqual(gone.map((e) => e.seat), ["graham"]);
  assert.match(gone[0].reason, /EISDIR/);
  assert.equal(evs(s, "seat_error").length, 1);
  assert.deepEqual(evs(s, "seat_done").map((e) => e.seat).sort(), ["bezos", "buffett"], "Graham has no seat_done");
  assert.equal(s.state.cards[1].graham, undefined);
  assert.equal(pauseOf(s, "quorum").have, 2);
  await settle(s);
});

test("a failure outside the seat's own try still ends in seat_absent", async (t) => {
  world(t, { failCruxes: true });
  setRoster({ def: NO_HUMAN });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  // A room connection that throws while it is told Graham started: this happens before runSeat's try
  C.subscribe(s, { write(line) { if (/"type":"seat_start".*"seat":"graham"/.test(line)) throw new Error("boom"); }, on() {} });
  await confirm(s);
  await until(() => pauseOf(s, "quorum"));
  const gone = evs(s, "seat_absent");
  assert.deepEqual(gone.map((e) => [e.seat, e.round, e.reason]), [["graham", 1, "boom"]]);
  assert.deepEqual(evs(s, "seat_done").map((e) => e.seat).sort(), ["bezos", "buffett"]);
  assert.equal(s.state.absent[1].graham, "boom");
  await settle(s);
});

test("a timed-out Claude seat is not held up by the retry wait", async (t) => {
  setSeatTimeout(80);
  t.after(() => setSeatTimeout());
  // A wait that only ends when the signal it is given aborts. The real one would sit out up to 30 seconds.
  setSleep((ms, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })));
  t.after(() => setSleep(async () => {}));
  world(t, { failCruxes: true, claude: (key) => (key === "graham" ? { status: 529, text: "overloaded" } : undefined) });
  setRoster({ def: NO_HUMAN });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await confirm(s);
  await until(() => pauseOf(s, "quorum"), 5000);
  assert.match(evs(s, "seat_absent").find((e) => e.seat === "graham").reason, /timed out/);
  await settle(s);
});

test("a seat with no API key stops the council before the privacy pause, naming each seat and key", async (t) => {
  const w = world(t);
  setRoster({ def: ["bezos", "buffett", "naval", "priya"] });
  await withEnv("OPENAI_API_KEY", undefined, async () => {
    const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
    await until(() => s.status !== "running");
    assert.equal(s.status, "error");
    assert.equal(ev(s, "error").error, "Buffett runs on OpenAI but OPENAI_API_KEY is not set. Naval runs on Google but GEMINI_API_KEY is not set.");
    assert.equal(evs(s, "pause").length, 0, "no privacy pause: the council is not going to start");
    assert.equal(w.calls.length, 1, "only the Chair's setup call went out");
    assert.equal(countOf(w.calls, "api.openai.com") + countOf(w.calls, "generativelanguage"), 0);
    assert.equal(evs(s, "seat_start").length, 0);
    assert.equal(evs(s, "waiting").length, 0);
    assert.equal(listPending().filter((x) => x.session === s.id).length, 0, "no request was opened for Priya");
    assert.ok(fs.existsSync(path.join(s.dir, "events.json")));
    assert.equal(subscribeEnds(s), true);
  });
  setRoster();
});

test("a Google seat is called through complete() with its own model and key", async (t) => {
  await withEnv("GEMINI_API_KEY", "g-test", async () => {
    const w = world(t, { failCruxes: true });
    setRoster({ def: ["bezos", "graham", "naval"] });
    const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
    await confirm(s);
    await until(() => s.status !== "running");
    const g = w.calls.filter((c) => c.url.includes("generativelanguage.googleapis.com"));
    assert.equal(g.length, 1);
    assert.match(g[0].url, /models\/gemini-3\.8-flash:generateContent/);
    assert.equal(g[0].body.generationConfig.maxOutputTokens, 4000);
    assert.ok(g[0].init.signal instanceof AbortSignal);
    assert.deepEqual(evs(s, "seat_done").map((e) => e.seat).sort(), ["bezos", "graham", "naval"]);
    assert.match(pauseOf(s, "privacy").recipients, /Google \(Naval, via API\)/);
    assert.equal(pauseOf(s, "quorum"), undefined);
  });
  setRoster();
});

test("seat_done says whether a card was cut off at the token limit", async (t) => {
  world(t, {
    failCruxes: true,
    claude: (key) => (key === "bezos" ? seatStream(card("bezos", 1), "max_tokens") : undefined),
    openai: (key) => openaiBody(card(key, 1), "incomplete"),
  });
  setRoster({ def: NO_HUMAN });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await confirm(s);
  await until(() => s.status !== "running");
  const partial = Object.fromEntries(evs(s, "seat_done").map((e) => [e.seat, e.partial]));
  assert.deepEqual(partial, { bezos: true, graham: false, buffett: true });
  assert.ok(evs(s, "seat_done").every((e) => typeof e.partial === "boolean"));
});

test("a seat that hangs is cut off, and becomes absent", async (t) => {
  setSeatTimeout(80);
  t.after(() => setSeatTimeout());
  world(t, {
    failCruxes: true,
    openai: (key, round, n, init) => hang(init),
    claude: (key, round, init) => (key === "graham"
      ? new Response(new ReadableStream({ start(c) { init.signal.addEventListener("abort", () => c.error(init.signal.reason), { once: true }); } }), { status: 200 })
      : undefined),
  });
  setRoster({ def: NO_HUMAN });
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await confirm(s);
  await until(() => pauseOf(s, "quorum"), 5000);
  const gone = Object.fromEntries(evs(s, "seat_absent").map((e) => [e.seat, e.reason]));
  assert.deepEqual(Object.keys(gone).sort(), ["buffett", "graham"]);
  assert.match(gone.buffett, /timed out/);
  assert.match(gone.graham, /timed out/);
  assert.deepEqual(evs(s, "seat_done").map((e) => e.seat), ["bezos"]);
  await settle(s);
});

// ---------------------------------------------------------------- the quorum pause
test("quorum pause when fewer than 3 cards, and stop ends the council", async (t) => {
  await withEnv("HUMAN_DEADLINE_MIN", "0.01", async () => {
    const w = world(t, { openai: () => ({ status: 500, text: "down" }) });
    setRoster();
    const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
    await confirm(s);
    const q = await until(() => pauseOf(s, "quorum"), 10000);
    assert.deepEqual([q.round, q.have], [1, 2]);
    assert.equal(s.status, "running");
    assert.ok(countOf(w.calls, "api.openai.com") >= 2);
    const why = Object.fromEntries(evs(s, "seat_absent").map((e) => [e.seat, e.reason]));
    assert.equal(why.priya, "no answer by the deadline");
    assert.match(why.buffett, /OpenAI 500/);
    assert.ok(s.events.findIndex((e) => e.type === "round_done") < s.events.indexOf(q), "the round closes, then the pause");
    assert.equal(evs(s, "cruxes").length, 0);

    assert.equal(resume(s.id, "stop"), true);
    await until(() => s.status !== "running");
    assert.equal(s.status, "stopped");
    assert.equal(ev(s, "error").error, "Stopped after Round 1: only 2 seats answered.");
    assert.deepEqual(evs(s, "resumed").map((e) => [e.kind, e.action]), [["privacy", "continue"], ["quorum", "stop"]]);
    assert.equal(evs(s, "verdict").length, 0);
    const md = fs.readFileSync(path.join(s.dir, "round-1.md"), "utf8");
    assert.match(md, /## Priya Rao[^\n]*\n\n\(absent: no answer by the deadline\)/);
  });
});

test("quorum pause: continue goes on to the next round", async (t) => {
  await withEnv("HUMAN_DEADLINE_MIN", "0.01", async () => {
    world(t, { openai: () => ({ status: 500, text: "down" }) });
    setRoster();
    const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
    await confirm(s);
    await until(() => pauseOf(s, "quorum"), 10000);
    assert.equal(resume(s.id, "continue"), true);
    assert.equal(evs(s, "resumed").at(-1).kind, "quorum");
    assert.equal(evs(s, "resumed").at(-1).action, "continue");
    // Round 2 runs: the Chair finds cruxes first, and the same two seats are short again
    await until(() => evs(s, "pause").filter((p) => p.kind === "quorum").length === 2, 10000);
    assert.equal(evs(s, "cruxes").length, 1);
    assert.deepEqual([evs(s, "pause")[2].round, evs(s, "pause")[2].have], [2, 2]);
    assert.equal(resume(s.id, "stop"), true);
    await until(() => s.status !== "running");
    assert.equal(ev(s, "error").error, "Stopped after Round 2: only 2 seats answered.");
  });
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, makeSession } from "./helpers.mjs";

const repo = makeRepo({
  seats: [
    { key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos", model: "claude-opus-5-5" },
    { key: "graham", name: "Paul Graham", short: "Graham", slug: "paul-graham" },
    { key: "buffett", name: "Warren Buffett", short: "Buffett", slug: "warren-buffett", provider: "openai", model: "gpt-6.1-sol" },
    { key: "naval", name: "Naval Ravikant", short: "Naval", slug: "naval-ravikant", provider: "google" },
    { key: "priya", name: "Priya Rao", short: "Priya", provider: "human", pillar: "Family and health", dimension: "Family cost" },
    { key: "arjun", name: "Arjun Mehta", short: "Arjun", provider: "human", pillar: "Operations", dimension: "Ops load" },
  ],
});
process.env.ROAST_ROOT = repo.root;
after(() => repo.cleanup());

const { scan, getLive, listLive } = await import("../app/lib/watch.mjs");
const { writeRequest, requestPath, answerPath } = await import("../app/lib/inbox.mjs");

// Each test uses its own folder name: the watcher keeps one live session per folder name.
let n = 0;
const nextName = (tag) => `2026-10-28-${tag}-${++n}`;

const OPTIONS = [{ id: "A", label: "Raise the price" }, { id: "B", label: "Keep it" }];
const council = (seats, extra = {}) => ({
  title: "Raise the price", decision: "Raise it?", mode: "full", options: OPTIONS,
  weights: Object.fromEntries(seats.map((k) => [k, { weight: 1, reason: "" }])), seats, brief: "Brief.", assumptions: [], ...extra,
});
const card1 = (short) => `SEAT: ${short.toUpperCase()}\nSTANCE: Conditional yes\nOPTION SCORES: A 7/10 · B 4/10\nCONFIDENCE: 4/5\nTHE CALL: Do A.`;
const card2 = (short) => `SEAT: ${short.toUpperCase()}\nSTANCE: Yes\nOPTION SCORES: A 8/10 · B 3/10\nCONFIDENCE: 4/5`;
const card3 = (short) => `SEAT: ${short.toUpperCase()}\nVOTE: Endorse\nOPTION SCORES: A 8/10 · B 3/10\nFINAL SCORE: 8/10\nONE LINE FOR THE FOUNDER: ${short} line.`;
const round = (card, shorts) => shorts.map((s) => `## ${s}\n\n${card(s)}`).join("\n\n") + "\n\n## Chair notes\n\nNotes.\n";
const CRUXES = { cruxes: [{ question: "Is cash enough?", sides: [{ position: "Yes", seats: ["Bezos"] }, { position: "No", seats: ["Graham"] }] }], unanimous: false, note: "A fight." };
const DRAFT = { option: "A", label: "GO WITH CONDITIONS", recommendation: "Do A.", conditions: [], next_steps: [], cheapest_test: "", kill_criteria: "" };
const VERDICT = { label: "GO WITH CONDITIONS", call: "Do A.", recommended: "A", why: [], next_steps: [], kill_criteria: "k", conditions: [] };

const live = (name) => { scan(); return getLive(name); };
const events = (name, type) => live(name).events.filter((e) => e.type === type);
const types = (name) => live(name).events.map((e) => e.type);
const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();
const request = (dir, seat, r, extra = {}) => writeRequest(dir, {
  seat, round: r, prompt: "Your card.", fields: {}, context: [], options: OPTIONS, deadline: inMinutes(30), status: "pending", ...extra,
});
const files = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
// Move every file's modification time back. Folders keep theirs unless asked.
function age(dir, hours, { folders = false } = {}) {
  const t = new Date(Date.now() - hours * 3600 * 1000);
  const all = fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f));
  for (const p of all) if (folders || fs.statSync(p).isFile()) fs.utimesSync(p, t, t);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- runners

test("setup carries the runners that council.json gives", () => {
  const name = nextName("runners");
  const seats = ["bezos", "buffett", "priya"];
  makeSession(repo.root, name, {
    "council.json": council(seats, {
      runners: {
        bezos: { provider: "anthropic", model: "claude-sonnet-5-5", transport: "subagent" },
        buffett: { provider: "openai", model: "gpt-6.1-sol", transport: "cli" },
        priya: { provider: "human", transport: "form" },
      },
    }),
  });
  const [setup] = events(name, "setup");
  assert.deepEqual(setup.runners, {
    bezos: { provider: "anthropic", model: "claude-sonnet-5-5", transport: "subagent" },
    buffett: { provider: "openai", model: "gpt-6.1-sol", transport: "cli" },
    priya: { provider: "human", model: null, transport: "form" },
  });
});

test("setup falls back to the roster provider and model when council.json has no runners", () => {
  const name = nextName("derived");
  makeSession(repo.root, name, { "council.json": council(["bezos", "graham", "buffett", "naval", "priya"]) });
  const [setup] = events(name, "setup");
  assert.deepEqual(setup.runners, {
    bezos: { provider: "anthropic", model: "claude-opus-5-5", transport: "subagent" },
    graham: { provider: "anthropic", model: null, transport: "subagent" },
    buffett: { provider: "openai", model: "gpt-6.1-sol", transport: "http" },
    naval: { provider: "google", model: null, transport: "http" },
    priya: { provider: "human", model: null, transport: "form" },
  });
});

test("a seat missing from runners is derived, and a runner with no provider takes the roster's", () => {
  const name = nextName("partial");
  makeSession(repo.root, name, {
    "council.json": council(["bezos", "buffett", "naval", "priya"], { runners: { buffett: { transport: "cli" }, naval: { provider: "google" } } }),
  });
  const [setup] = events(name, "setup");
  assert.deepEqual(setup.runners.bezos, { provider: "anthropic", model: "claude-opus-5-5", transport: "subagent" });
  assert.deepEqual(setup.runners.buffett, { provider: "openai", model: null, transport: "cli" }, "provider from the roster; model as the runner gave it");
  assert.deepEqual(setup.runners.naval, { provider: "google", model: null, transport: "http" }, "a runner with no transport gets its provider's usual one");
  assert.deepEqual(setup.runners.priya, { provider: "human", model: null, transport: "form" });
});

test("rewriting council.json with a changed transport emits one runners event", () => {
  const name = nextName("rewrite");
  const seats = ["bezos", "buffett"];
  const base = { bezos: { provider: "anthropic", model: null, transport: "subagent" }, buffett: { provider: "openai", model: "gpt-6.1-sol", transport: "http" } };
  const dir = makeSession(repo.root, name, { "council.json": council(seats, { runners: base }) });
  assert.equal(events(name, "runners").length, 0, "no runners event at setup");

  fs.writeFileSync(path.join(dir, "council.json"), JSON.stringify(council(seats, { runners: { ...base, buffett: { ...base.buffett, transport: "cli" } } })));
  const [ev] = events(name, "runners");
  assert.equal(ev.runners.buffett.transport, "cli");
  assert.equal(ev.runners.bezos.transport, "subagent");
  assert.equal(events(name, "runners").length, 1);

  assert.equal(events(name, "runners").length, 1, "a second scan with nothing new emits nothing");
  fs.writeFileSync(path.join(dir, "council.json"), JSON.stringify(council(seats, { runners: { ...base, buffett: { ...base.buffett, transport: "cli" } }, brief: "Other words." })));
  assert.equal(events(name, "runners").length, 1, "same runners, different text: no event");
});

test("a half-written council.json after setup changes nothing and is read again once whole", () => {
  const name = nextName("halfwritten");
  const seats = ["bezos", "buffett"];
  const dir = makeSession(repo.root, name, { "council.json": council(seats) });
  assert.equal(events(name, "setup").length, 1);
  fs.writeFileSync(path.join(dir, "council.json"), '{"title": "Raise the pr');
  assert.equal(events(name, "runners").length, 0);
  fs.writeFileSync(path.join(dir, "council.json"), JSON.stringify(council(seats, { runners: { buffett: { provider: "openai", model: null, transport: "cli" } } })));
  const evs = events(name, "runners");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].runners.buffett.transport, "cli");
});

// ---------------------------------------------------------------- waiting

test("a pending request gives one waiting event, and answering it gives waiting_done", () => {
  const name = nextName("waiting");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "buffett", "priya"]) });
  assert.equal(events(name, "waiting").length, 0);

  const deadline = inMinutes(30);
  request(dir, "priya", 1, { deadline });
  const [w] = events(name, "waiting");
  assert.equal(w.round, 1);
  assert.deepEqual(w.seats, [{ key: "priya", deadline }]);
  assert.equal(events(name, "waiting").length, 1, "the same list on the next scan is not announced again");
  assert.equal(events(name, "waiting_done").length, 0);

  request(dir, "priya", 1, { deadline, status: "answered", answeredAt: new Date().toISOString() });
  const [done] = events(name, "waiting_done");
  assert.equal(done.round, 1);
  assert.equal(events(name, "waiting_done").length, 1);
  assert.equal(events(name, "waiting").length, 1);
});

test("waiting lists every pending seat, and announces again when one of them answers", () => {
  const name = nextName("two");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya", "arjun"]) });
  const d1 = inMinutes(30);
  const d2 = inMinutes(20);
  request(dir, "priya", 1, { deadline: d1 });
  request(dir, "arjun", 1, { deadline: d2 });
  assert.deepEqual(events(name, "waiting")[0].seats, [{ key: "arjun", deadline: d2 }, { key: "priya", deadline: d1 }]);

  request(dir, "arjun", 1, { deadline: d2, status: "answered" });
  const all = events(name, "waiting");
  assert.equal(all.length, 2);
  assert.deepEqual(all[1].seats, [{ key: "priya", deadline: d1 }]);
  assert.equal(events(name, "waiting_done").length, 0, "one person is still being waited on");

  request(dir, "priya", 1, { deadline: d1, status: "answered" });
  assert.equal(events(name, "waiting_done").length, 1);
});

test("a request whose deadline passes ends the wait on the next scan", async () => {
  const name = nextName("expiry");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1, { deadline: new Date(Date.now() + 1500).toISOString() });
  assert.equal(events(name, "waiting").length, 1);
  assert.equal(events(name, "waiting_done").length, 0);
  await sleep(1700);
  assert.equal(events(name, "waiting_done").length, 1, "found with no file change at all");
  assert.equal(events(name, "waiting").length, 1);
  assert.equal(live(name).status, "running");
});

test("a request that is already past its deadline is not waited on", () => {
  const name = nextName("pastdue");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1, { deadline: inMinutes(-5) });
  assert.equal(events(name, "waiting").length, 0);
  assert.equal(events(name, "waiting_done").length, 0);
});

test("only requests for the round the watcher is on count", () => {
  const name = nextName("otherround");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 2);
  assert.equal(events(name, "waiting").length, 0, "a Round 2 request while the room is on Round 1");
  fs.writeFileSync(path.join(dir, "round-1.md"), round(card1, ["Bezos", "Priya"]));
  fs.writeFileSync(path.join(dir, "cruxes.json"), JSON.stringify(CRUXES));
  const [w] = events(name, "waiting");
  assert.equal(w.round, 2, "the room moved on to Round 2");
  assert.deepEqual(w.seats.map((s) => s.key), ["priya"]);
});

test("the wait for a round ends when the room moves to the next round", () => {
  const name = nextName("moveson");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1);
  assert.equal(events(name, "waiting").length, 1);
  fs.writeFileSync(path.join(dir, "round-1.md"), round(card1, ["Bezos"]));
  fs.writeFileSync(path.join(dir, "cruxes.json"), JSON.stringify(CRUXES));
  const evs = live(name).events;
  const done = evs.filter((e) => e.type === "waiting_done");
  assert.equal(done.length, 1);
  assert.equal(done[0].round, 1);
  assert.equal(evs.filter((e) => e.type === "waiting").length, 1, "the Round 1 request is not a Round 2 wait");
  assert.ok(evs.some((e) => e.type === "round_start" && e.round === 2));
  const at = (type, r) => evs.findIndex((e) => e.type === type && (r === undefined || e.round === r));
  assert.ok(at("waiting") < at("waiting_done"));
  assert.ok(at("waiting_done", 1) < at("round_done", 1), "the wait for Round 1 ends before Round 1 closes");
  assert.ok(at("round_done", 1) < at("round_start", 2));
  assert.equal(live(name).status, "running", "the request is still pending, so the session is not stale");
});

test("the waiting event follows round_start in the same scan that opens the session", () => {
  const name = nextName("order");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1);
  const t = types(name);
  assert.ok(t.indexOf("round_start") < t.indexOf("waiting"));
});

// ---------------------------------------------------------------- order: the room seals on waiting, unseals on waiting_done or round_done

test("a pending request and a partial round file on a fresh session: waiting comes before the first seat_done", () => {
  const name = nextName("order-fresh");
  const dir = makeSession(repo.root, name, {
    "council.json": council(["bezos", "buffett", "priya"]),
    "round-1.md": round(card1, ["Bezos"]),
  });
  request(dir, "priya", 1);
  const evs = live(name).events;
  const first = (type) => evs.findIndex((e) => e.type === type);
  assert.ok(first("seat_done") >= 0 && first("waiting") >= 0);
  assert.ok(first("waiting") < first("seat_done"), "cards are sealed from the first one");
  assert.equal(evs.filter((e) => e.type === "waiting").length, 1);
});

test("an answered request and a complete round file in one scan: waiting_done comes before round_done", () => {
  const name = nextName("order-answered");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1);
  assert.equal(events(name, "waiting").length, 1);
  request(dir, "priya", 1, { status: "answered" });
  fs.writeFileSync(path.join(dir, "round-1.md"), round(card1, ["Bezos", "Priya"]));
  const evs = live(name).events;
  const at = (type) => evs.findIndex((e) => e.type === type);
  assert.ok(at("waiting_done") >= 0 && at("round_done") >= 0);
  assert.ok(at("waiting_done") < at("round_done"));
  assert.equal(evs.filter((e) => e.type === "waiting_done").length, 1);
});

test("a round that closes while its request is still pending ends the wait once, and does not announce it again", () => {
  const name = nextName("order-closed");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  // Priya has a card in the round file, but her request file still says "pending" (the status write
  // came after the Chair read the answer). No cruxes.json yet, so the room stays on Round 1.
  request(dir, "priya", 1);
  fs.writeFileSync(path.join(dir, "round-1.md"), round(card1, ["Bezos", "Priya"]));
  const evs = live(name).events;
  const at = (type) => evs.findIndex((e) => e.type === type);
  assert.ok(at("waiting") < at("seat_done"));
  assert.ok(at("waiting_done") < at("round_done"));
  assert.equal(evs.filter((e) => e.type === "waiting").length, 1);
  assert.equal(evs.filter((e) => e.type === "waiting_done").length, 1);
  assert.equal(live(name).events.filter((e) => e.type === "waiting").length, 1, "later scans do not announce a closed round");
  assert.equal(live(name).status, "running", "the request is still pending, so the session is not stale");
});

// ---------------------------------------------------------------- bad request files

test("a truncated request file and a request with a bad deadline do not throw and are not waited on", () => {
  const name = nextName("badrequests");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya", "arjun"]) });
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.writeFileSync(requestPath(dir, "priya", 1), '{"seat": "priya", "round": 1, "status": "pen');
  const base = { round: 1, prompt: "", fields: {}, context: [], options: OPTIONS, status: "pending" };
  fs.writeFileSync(requestPath(dir, "arjun", 1), JSON.stringify({ ...base, seat: "arjun", deadline: {} }));
  fs.writeFileSync(path.join(dir, "inbox", "bezos-r1.request.json"), JSON.stringify({ ...base, seat: "bezos", deadline: { toString: "x" } }));
  fs.writeFileSync(path.join(dir, "inbox", "buffett-r1.request.json"), JSON.stringify({ ...base, seat: "buffett", deadline: 4102444800000 }));
  assert.doesNotThrow(() => scan());
  assert.equal(events(name, "waiting").length, 0);
  assert.equal(events(name, "waiting_done").length, 0);
});

test("a request with a bad deadline does not keep an old session alive", () => {
  const name = nextName("stale-baddeadline");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.writeFileSync(requestPath(dir, "priya", 1), JSON.stringify({ seat: "priya", round: 1, status: "pending", deadline: { toString: "x" } }));
  age(dir, 4);
  assert.doesNotThrow(() => scan());
  assert.equal(getLive(name).status, "stopped");
});

test("scan logs a folder it cannot read and still reads the others", () => {
  const bad = nextName("broken");
  const good = nextName("fine");
  makeSession(repo.root, bad, { "council.json": { ...council(["bezos", "priya"]), options: "not a list" } });
  makeSession(repo.root, good, { "council.json": council(["bezos", "priya"]) });
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    assert.doesNotThrow(() => scan());
  } finally {
    console.error = original;
    // Remove the broken fixture so later scans in this file do not log it again.
    fs.rmSync(path.join(repo.sessions, bad), { recursive: true, force: true });
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], new RegExp(`^watch: ${bad}: `));
  assert.equal(getLive(good).events.filter((e) => e.type === "setup").length, 1);
});

// ---------------------------------------------------------------- inbox files are not cards

test("an answer file in inbox/ alone produces no seat_done", () => {
  const name = nextName("answeronly");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1, { status: "answered" });
  fs.writeFileSync(answerPath(dir, "priya", 1), "## Priya\n\n" + card1("Priya") + "\n");
  assert.equal(events(name, "seat_done").length, 0);
  assert.ok(fs.existsSync(requestPath(dir, "priya", 1)));
});

// ---------------------------------------------------------------- absent seats

test("a seat with no card when the round closes by force is reported absent, once", () => {
  const name = nextName("absent");
  const dir = makeSession(repo.root, name, {
    "council.json": council(["bezos", "buffett", "priya"]),
    "round-1.md": round(card1, ["Bezos", "Buffett"]),
  });
  assert.equal(events(name, "seat_absent").length, 0, "the round is still open");
  fs.writeFileSync(path.join(dir, "cruxes.json"), JSON.stringify(CRUXES));
  const absent = events(name, "seat_absent");
  assert.deepEqual(absent.map(({ round: r, seat, reason }) => ({ round: r, seat, reason })), [{ round: 1, seat: "priya", reason: "no card" }]);
  assert.equal(events(name, "seat_absent").length, 1, "not repeated on later scans");
  const t = types(name);
  assert.ok(t.indexOf("seat_absent") < t.indexOf("round_done"));
  assert.equal(events(name, "round_done")[0].round, 1);
});

test("a round where every seat answered reports nobody absent", () => {
  const name = nextName("allhere");
  makeSession(repo.root, name, {
    "council.json": council(["bezos", "priya"]),
    "round-1.md": round(card1, ["Bezos", "Priya"]),
    "cruxes.json": CRUXES,
  });
  assert.equal(events(name, "seat_absent").length, 0);
  assert.equal(events(name, "seat_done").length, 2);
});

test("a full council with an absent person: verdict marks them absent and the disclaimer names the person", () => {
  const name = nextName("verdict");
  makeSession(repo.root, name, {
    "council.json": council(["bezos", "buffett", "priya"]),
    "round-1.md": round(card1, ["Bezos", "Buffett"]),
    "cruxes.json": CRUXES,
    "round-2.md": round(card2, ["Bezos", "Buffett"]),
    "draft.json": DRAFT,
    "round-3.md": round(card3, ["Bezos", "Buffett"]),
    "verdict.json": VERDICT,
  });
  const x = live(name);
  assert.equal(x.status, "done");
  const absent = x.events.filter((e) => e.type === "seat_absent");
  assert.deepEqual(absent.map((e) => [e.round, e.seat]), [[1, "priya"], [2, "priya"], [3, "priya"]]);
  const v = x.events.find((e) => e.type === "verdict");
  assert.match(v.verdict.disclaimer, /Real people on this panel, answering live: Priya Rao\./);
  assert.deepEqual(v.verdict.votes, { endorse: 2 }, "the absent person casts no vote");
  const priya = v.seats.find((s) => s.key === "priya");
  assert.equal(priya.absent, true);
  assert.equal(priya.stance, null);
  assert.equal(v.seats.find((s) => s.key === "bezos").absent, false);
});

test("a council with no person has the plain disclaimer", () => {
  const name = nextName("plain");
  makeSession(repo.root, name, {
    "council.json": council(["bezos", "buffett"]),
    "round-1.md": round(card1, ["Bezos", "Buffett"]),
    "cruxes.json": CRUXES,
    "round-2.md": round(card2, ["Bezos", "Buffett"]),
    "draft.json": DRAFT,
    "round-3.md": round(card3, ["Bezos", "Buffett"]),
    "verdict.json": VERDICT,
  });
  const v = events(name, "verdict")[0];
  assert.doesNotMatch(v.verdict.disclaimer, /Real people/);
  assert.match(v.verdict.disclaimer, /^Simulated advisors/);
});

test("a person named in council.json runners counts as a person even if the roster says otherwise", () => {
  const name = nextName("runnerhuman");
  makeSession(repo.root, name, {
    "council.json": council(["bezos", "buffett"], { runners: { buffett: { provider: "human", transport: "form" } } }),
    "round-1.md": round(card1, ["Bezos", "Buffett"]),
    "cruxes.json": CRUXES,
    "round-2.md": round(card2, ["Bezos", "Buffett"]),
    "verdict.json": VERDICT,
  });
  const v = events(name, "verdict")[0];
  assert.match(v.verdict.disclaimer, /answering live: Warren Buffett\./);
});

// ---------------------------------------------------------------- stale sessions

test("an old session stays running while a request is pending before its deadline", () => {
  const name = nextName("stale-pending");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1);
  age(dir, 4);
  assert.equal(live(name).status, "running");
  assert.equal(live(name).status, "running");
});

test("a pending request for another round still keeps an old session running", () => {
  const name = nextName("stale-otherround");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 3);
  age(dir, 4);
  assert.equal(live(name).status, "running");
});

test("an old session with no pending request is marked stopped", () => {
  const name = nextName("stale-none");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  age(dir, 4);
  assert.equal(live(name).status, "stopped");
});

test("an old session whose request was answered is marked stopped", () => {
  const name = nextName("stale-answered");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1, { status: "answered" });
  age(dir, 4);
  assert.equal(live(name).status, "stopped");
});

test("an old session whose request passed its deadline is marked stopped", () => {
  const name = nextName("stale-expired");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1, { deadline: inMinutes(-1) });
  age(dir, 4);
  assert.equal(live(name).status, "stopped");
});

test("a session left running by a pending request stops once the deadline passes", async () => {
  const name = nextName("stale-then-expired");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1, { deadline: new Date(Date.now() + 1500).toISOString() });
  age(dir, 4);
  assert.equal(live(name).status, "running");
  await sleep(1700);
  assert.equal(live(name).status, "stopped");
});

test("a fresh file in inbox/ keeps an old session running", () => {
  const name = nextName("stale-fresh-inbox");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1, { status: "answered" });
  const old = [...files(dir)].filter((f) => !f.includes(`${path.sep}inbox${path.sep}`));
  const t = new Date(Date.now() - 4 * 3600 * 1000);
  for (const f of old) fs.utimesSync(f, t, t);
  assert.equal(live(name).status, "running");
});

test("a stopped session comes back when a new file lands", () => {
  // Found in the first live council: a person missed Round 2, the Chair went on the next day, and the room
  // had stopped the session overnight, so it never showed Rounds 2 and 3 or the verdict.
  const name = nextName("stale-revive");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "graham"]) });
  age(dir, 4);
  assert.equal(live(name).status, "stopped");
  fs.writeFileSync(path.join(dir, "round-1.md"), round(card1, ["Bezos", "Graham"]));
  assert.equal(live(name).status, "running");
  assert.equal(events(name, "seat_done").length, 2);
});

test("an old session is stopped even when its folders have fresh timestamps", () => {
  const name = nextName("stale-folders");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1, { status: "answered" });
  age(dir, 4); // files only: inbox/ itself keeps its new time
  assert.ok(Date.now() - fs.statSync(path.join(dir, "inbox")).mtimeMs < 60000);
  assert.equal(live(name).status, "stopped");
});

test("listLive reports the status a stale-but-waited-on session keeps", () => {
  const name = nextName("stale-list");
  const dir = makeSession(repo.root, name, { "council.json": council(["bezos", "priya"]) });
  request(dir, "priya", 1);
  age(dir, 4);
  assert.equal(listLive().find((s) => s.id === name).status, "running");
});

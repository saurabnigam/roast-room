import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeRepo, makeSession, mockFetch, request } from "./helpers.mjs";

// The room's server, started on a free port in a disposable repo. No test makes a live call:
// fetch is replaced before the server loads, and it answers 500 unless a test says otherwise.
const repo = makeRepo({
  seats: [
    { key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos" },
    { key: "buffett", name: "Warren Buffett", short: "Buffett", slug: "warren-buffett", provider: "openai" },
    { key: "priya", name: "Priya Rao", short: "Priya", provider: "human", pillar: "Family and health", dimension: "Family cost" },
  ],
});
process.env.ROAST_ROOT = repo.root;
process.env.COUNCIL_RUNNER = "api";
for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "PORT", "SEAT_MODEL", "CHAIR_MODEL", "OPENAI_SEAT_MODEL", "GEMINI_SEAT_MODEL", "HUMAN_DEADLINE_MIN"]) {
  delete process.env[k];
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
// PORT comes from .env, not from the process environment, to prove start() reads it through env().
const envPort = await freePort();
fs.writeFileSync(path.join(repo.root, ".env"), `PORT=${envPort}\n`);

let world = async (url) => ({ status: 500, text: `unexpected call to ${url}` });
const fetchMock = mockFetch((url, init) => world(url, init));

const { start, stop } = await import("../app/server.mjs");
const { getSession, missingKeys, missingKeysMessage } = await import("../app/lib/council.mjs");
const { defaultBoard } = await import("../app/lib/seats.mjs");
const { writeRequest, ROUND_FIELDS, deadlineFrom } = await import("../app/lib/inbox.mjs");
const { contextFiles } = await import("../app/lib/seatprompt.mjs");
const watch = await import("../app/lib/watch.mjs");

let port;
before(async () => {
  const srv = await start(0);
  port = srv.address().port;
});
after(async () => {
  await stop();
  fetchMock.restore();
  repo.cleanup();
});

// ---------------------------------------------------------------- helpers
const ok = (p = port) => ({ host: `127.0.0.1:${p}`, origin: `http://127.0.0.1:${p}`, "content-type": "application/json" });
const get = (p, headers = {}) => request(port, { path: p, headers: { host: `127.0.0.1:${port}`, ...headers } });
const post = (p, body, headers = {}) => request(port, { method: "POST", path: p, headers: { ...ok(), ...headers }, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${fn}`);
    await sleep(15);
  }
}
async function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const OPTIONS = [{ id: "A", label: "Raise the price" }, { id: "B", label: "Keep it" }];
const BRIEF = "THE DECISION: raise the price\n\nOPTIONS:\n(A) yes\n(B) no\n";
const good1 = { STANCE: "Conditional yes", "OPTION SCORES": { A: 7, B: 4 }, "THE CALL": "Do A first.", CONFIDENCE: 4, "RUIN RISK": "none", DOOR: "two-way" };
let n = 0;
const uniq = (p) => `2026-10-28-${p}-${++n}`;

/** A skill session folder with one request for Priya in Round 1. */
function pendingSession(name, extra = {}) {
  const dir = makeSession(repo.root, name, {
    "brief.md": BRIEF,
    "round-1.md": "## Bezos\nSEAT: BEZOS\nSTANCE: Yes\n",
    "council.json": { options: OPTIONS },
  });
  writeRequest(dir, {
    seat: "priya", round: 1, prompt: "P", fields: ROUND_FIELDS[1], context: contextFiles(1), options: OPTIONS,
    deadline: deadlineFrom(), status: "pending", ...extra,
  });
  return dir;
}
const waiting = async (name) => (await get("/api/inbox")).json.requests.filter((r) => r.session === name);

const rosterFile = path.join(repo.root, ".claude", "skills", "roast-room", "roster.json");
const rosterOriginal = fs.readFileSync(rosterFile, "utf8");
let bump = 0;
/** Rewrite the roster's board mode for one test (the server reloads the roster when its mtime changes). */
function setRoster(mode) {
  const r = JSON.parse(rosterOriginal);
  if (mode) r.board = mode;
  fs.writeFileSync(rosterFile, JSON.stringify(r, null, 2));
  const at = new Date(Date.now() + (++bump) * 2000);
  fs.utimesSync(rosterFile, at, at);
}

const chairJson = (obj) => ({ json: { content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } });
/** The Chair's setup reply: a small brief and every seat it is offered. */
function setupReply(body) {
  const seats = body.output_config.format.schema.properties.seats.items.enum;
  return chairJson({
    title: "Raise prices", decision: "Raise prices for everyone or only new clients?", brief: "A small studio with 40 clients.",
    options: OPTIONS, assumptions: [],
    weights: seats.map((seat, i) => ({ seat, weight: i === 0 ? 3 : 2, reason: "It touches this pillar." })),
    quick_seats: seats.slice(0, 4), seats,
  });
}
const PROMPT = "Should I raise prices for everyone or only new clients?";

// ---------------------------------------------------------------- guards on a POST
test("POST /api/answer guards", async () => {
  const name = uniq("guards");
  pendingSession(name);
  const body = { session: name, seat: "priya", round: 1, fields: good1 };
  const answer = (headers, b = body) => request(port, { method: "POST", path: "/api/answer", headers: { ...ok(), ...headers }, body: b });

  assert.equal((await answer({ origin: "http://evil.test" })).status, 403);
  assert.equal((await answer({ host: "evil.test:4730" })).status, 403);
  assert.equal((await answer({ "content-type": "text/plain" })).status, 415);
  assert.equal((await answer({}, "x".repeat(70000))).status, 413);
  assert.equal((await answer({}, { session: "../../x", seat: "priya", round: 1, fields: {} })).status, 400);
  assert.equal((await answer({}, { session: "2026-10-28-nope", seat: "priya", round: 1, fields: good1 })).status, 404);
  assert.equal((await waiting(name)).length, 1, "none of the refused requests changed the request");
});

test("guards run in order: Host, then Origin, then content type, then the body", async () => {
  const h = (over) => ({ ...ok(), ...over });
  const send = (headers, body) => request(port, { method: "POST", path: "/api/answer", headers, body });
  const big = "x".repeat(70000);
  // Everything wrong at once: the Host check answers first.
  const host = await send(h({ host: "evil.test", origin: "http://evil.test", "content-type": "text/plain" }), big);
  assert.equal(host.status, 403);
  // Host fine; Origin, content type and body all wrong: the Origin check answers, with its own message.
  const origin = await send(h({ origin: "http://evil.test", "content-type": "text/plain" }), big);
  assert.equal(origin.status, 403);
  assert.notEqual(origin.json.error, host.json.error);
  // Only the content type and the body are wrong: 415, not 413.
  assert.equal((await send(h({ "content-type": "text/plain" }), big)).status, 415);
  // Only the body is wrong: 413.
  assert.equal((await send(h({}), big)).status, 413);
});

test("Host and Origin must match the bound port exactly", async () => {
  const body = { session: "2026-10-28-nope", seat: "priya", round: 1, fields: {} };
  const status = async (over) => (await request(port, { method: "POST", path: "/api/answer", headers: { ...ok(), ...over }, body })).status;
  // Accepted: localhost or 127.0.0.1 on this port, any letter case (a browser lowercases both).
  assert.equal(await status({ host: `localhost:${port}`, origin: `http://localhost:${port}` }), 404);
  assert.equal(await status({ host: `LOCALHOST:${port}`, origin: `http://LOCALHOST:${port}` }), 404);
  // Refused: another port (the usual 4730 included), no port, a lookalike name, an empty or odd value.
  for (const host of ["127.0.0.1:4730", "127.0.0.1", "localhost", `localhost.evil.test:${port}`, `127.0.0.1:${port}.evil.test`, `[::1]:${port}`, `evil.test@127.0.0.1:${port}`, `localhost.:${port}`, `127.0.0.1.:${port}`]) {
    if (host === "127.0.0.1:4730" && port === 4730) continue;
    assert.equal(await status({ host }), 403, `Host ${JSON.stringify(host)}`);
  }
  for (const origin of ["null", "", `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}.evil.test`, `http://127.0.0.1`, `http://evil.test:${port}`, `http://127.0.0.1:${port}/`, `http://127.0.0.1:${port}, http://evil.test`]) {
    assert.equal(await status({ origin }), 403, `Origin ${JSON.stringify(origin)}`);
  }
  const { origin: _drop, ...noOrigin } = ok();
  assert.equal((await request(port, { method: "POST", path: "/api/answer", headers: noOrigin, body })).status, 403, "a missing Origin is refused");
});

test("the content type may carry parameters, and a missing one is refused", async () => {
  const body = { session: "2026-10-28-nope", seat: "priya", round: 1, fields: {} };
  const status = async (headers, b = body) => (await request(port, { method: "POST", path: "/api/answer", headers, body: b })).status;
  const { "content-type": _ct, ...noType } = ok();
  assert.equal(await status({ ...noType, "content-type": "application/json; charset=utf-8" }), 404);
  assert.equal(await status({ ...noType, "content-type": "Application/JSON" }), 404);
  assert.equal(await status(noType, JSON.stringify(body)), 415, "no content type");
  for (const type of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain;charset=UTF-8", "application/jsonx", "application/xml"]) {
    assert.equal(await status({ ...noType, "content-type": type }, JSON.stringify(body)), 415, type);
  }
});

test("body limits: content-length is checked up front, and a stream is cut off while it is read", async () => {
  // Declared too big: refused without reading it.
  const declared = await request(port, { method: "POST", path: "/api/answer", headers: { ...ok(), "content-length": "65537" }, body: "{}" });
  assert.equal(declared.status, 413);
  assert.deepEqual(Object.keys(declared.json), ["error"]);
  // Exactly the limit is not refused for its size: it is just not a JSON object.
  const pad = JSON.stringify({ pad: "x".repeat(65536 - 10) });
  assert.equal(Buffer.byteLength(pad), 65536);
  assert.equal((await post("/api/answer", pad)).status, 400);
  assert.equal((await post("/api/answer", pad + " ")).status, 413, "one byte over");
  // No content-length at all (chunked): the server counts as it reads.
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/answer", headers: { ...ok(), "transfer-encoding": "chunked" }, agent: false }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("request timed out")));
    for (let i = 0; i < 8; i++) req.write("x".repeat(10000));
    req.end();
  });
  assert.equal(chunked.status, 413);
});

test("a bad body is a 400 that never echoes the request", async () => {
  const secret = "sk-leak-me-1234";
  for (const raw of [`{"a": "${secret}"`, `${secret}`, `{"a": ${secret}}`]) {
    const r = await post("/api/answer", raw);
    assert.equal(r.status, 400, raw);
    assert.deepEqual(Object.keys(r.json), ["error"]);
    assert.ok(!r.text.includes(secret), "the body is not repeated");
  }
  // Valid JSON that is not an object.
  for (const raw of ["[]", "null", "5", '"text"']) {
    const r = await post("/api/answer", raw);
    assert.equal(r.status, 400, raw);
    assert.deepEqual(Object.keys(r.json), ["error"]);
  }
  // An empty body is an empty object, so the ids are what is wrong.
  assert.equal((await post("/api/answer", "")).status, 400);
});

// ---------------------------------------------------------------- inbox and answer
test("valid answer is 200, the second is 409, and the inbox empties", async () => {
  const name = uniq("answer");
  pendingSession(name);
  const inbox = await get("/api/inbox");
  assert.equal(inbox.status, 200);
  const mine = inbox.json.requests.filter((r) => r.session === name);
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].seat, mine[0].round, mine[0].source, mine[0].name], ["priya", 1, "skill", "Priya Rao"]);

  const body = { session: name, seat: "priya", round: 1, fields: good1 };
  const first = await post("/api/answer", body);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true });
  const second = await post("/api/answer", body);
  assert.equal(second.status, 409);
  assert.equal(typeof second.json.error, "string");
  assert.deepEqual(await waiting(name), []);
  assert.ok(fs.existsSync(path.join(repo.sessions, name, "inbox", "priya-r1.answer.md")), "the card was written");
});

test("paths that look like the answer route are not it, and write no card", async () => {
  const name = uniq("lookalike");
  pendingSession(name);
  const body = { session: name, seat: "priya", round: 1, fields: good1 };
  // An escaped letter or a doubled slash is not /api/answer. Both fall through to the static handler.
  for (const p of ["/api/%61nswer", "/api//answer", "/api/answer/"]) {
    const r = await post(p, body);
    assert.equal(r.status, 404, p);
    assert.ok(!fs.existsSync(path.join(repo.sessions, name, "inbox", "priya-r1.answer.md")), `${p}: no card was written`);
  }
  assert.equal((await waiting(name)).length, 1, "the request is still open");
  // The route answers POST only.
  assert.equal((await get("/api/answer")).status, 404);
});

test("a bad answer is a 400 with the reasons, and the request stays open", async () => {
  const name = uniq("badfields");
  pendingSession(name);
  const r = await post("/api/answer", { session: name, seat: "priya", round: 1, fields: { ...good1, CONFIDENCE: 9 } });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.json.errors) && r.json.errors.some((e) => /CONFIDENCE/.test(e)));
  assert.equal((await waiting(name)).length, 1);
});

test("a request whose deadline is not a string is not pending and cannot be answered", async () => {
  // Date.parse(12345) reads it as the year 12345, and Date.parse(["2099-01-01"]) as the text inside.
  for (const [tag, deadline] of [["number", 12345], ["array", ["2099-01-01T00:00:00.000Z"]], ["null", null], ["object", {}]]) {
    const name = uniq(`deadline-${tag}`);
    pendingSession(name, { deadline });
    const inbox = await get("/api/inbox");
    assert.equal(inbox.status, 200, tag);
    assert.deepEqual(inbox.json.requests.filter((r) => r.session === name), [], tag);
    const r = await post("/api/answer", { session: name, seat: "priya", round: 1, fields: good1 });
    assert.equal(r.status, 409, tag);
    assert.ok(!fs.existsSync(path.join(repo.sessions, name, "inbox", "priya-r1.answer.md")), `${tag}: no card was written`);
  }
});

// ---------------------------------------------------------------- Host on GET
test("GET /api/inbox with a foreign Host is 403", async () => {
  const r = await request(port, { path: "/api/inbox", headers: { host: "evil.test:4730" } });
  assert.equal(r.status, 403);
  assert.deepEqual(Object.keys(r.json), ["error"]);
  for (const p of ["/api/seats", "/api/usage", "/api/sessions", "/api/sessions/anything", "/api/stream/anything"]) {
    assert.equal((await request(port, { path: p, headers: { host: "evil.test:4730" } })).status, 403, p);
  }
  // A trailing dot names the same machine but is not a name the room answers to.
  assert.equal((await request(port, { path: "/api/inbox", headers: { host: `localhost.:${port}` } })).status, 403);
  assert.equal((await get("/api/inbox")).status, 200);
});

test("static files are served for any Host, as before", async () => {
  const r = await request(port, { path: "/", headers: { host: "evil.test:4730" } });
  assert.equal(r.status, 200);
  assert.match(r.text, /<html/i);
});

// ---------------------------------------------------------------- /api/council
test("POST /api/council without an Origin is 403", async () => {
  const { origin: _drop, ...noOrigin } = ok();
  const calls = fetchMock.calls.length;
  const r = await request(port, { method: "POST", path: "/api/council", headers: noOrigin, body: { prompt: PROMPT } });
  assert.equal(r.status, 403);
  assert.equal(fetchMock.calls.length, calls);
  assert.equal((await post("/api/council", { prompt: PROMPT }, { origin: "http://evil.test" })).status, 403);
  assert.equal((await post("/api/council", { prompt: PROMPT }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await get("/api/sessions")).json.running, null, "no council started");
});

test("POST /api/council reports a missing key before any call", async () => {
  // The default board is Bezos (Anthropic), Buffett (OpenAI) and Priya (a person).
  const calls = fetchMock.calls.length;
  await withEnv({ ANTHROPIC_API_KEY: "sk-test-anthropic", OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined }, async () => {
    const r = await post("/api/council", { prompt: PROMPT });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "Buffett runs on OpenAI but OPENAI_API_KEY is not set." });
    assert.equal(r.json.error, missingKeysMessage(missingKeys(defaultBoard())), "the 400 and the runner share one message");
  });
  await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, async () => {
    const r = await post("/api/council", { prompt: PROMPT });
    assert.equal(r.status, 400);
    // Each seat in board order (Priya needs no key), then the Chair.
    assert.equal(r.json.error, "Bezos runs on Anthropic but ANTHROPIC_API_KEY is not set. Buffett runs on OpenAI but OPENAI_API_KEY is not set. The Chair runs on Anthropic but ANTHROPIC_API_KEY is not set.");
  });
  assert.equal(fetchMock.calls.length, calls, "no call went out");
  assert.equal((await get("/api/sessions")).json.running, null, "no council started");
});

test("a short or odd prompt is a 400 before the key check", async () => {
  for (const body of [{ prompt: "short" }, { prompt: 12345678901234 }, { prompt: ["a long enough prompt in an array"] }, {}]) {
    const r = await post("/api/council", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, /decision/);
  }
});

test("a pick-mode board without ANTHROPIC_API_KEY is refused before any call", async () => {
  // The Chair always runs on Anthropic. Its key is the one key a pick-mode board is sure to need.
  for (const mode of ["auto", "ask"]) {
    setRoster(mode);
    try {
      const calls = fetchMock.calls.length;
      await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined }, async () => {
        const r = await post("/api/council", { prompt: PROMPT });
        assert.equal(r.status, 400, mode);
        assert.deepEqual(r.json, { error: "The Chair runs on Anthropic but ANTHROPIC_API_KEY is not set." }, mode);
      });
      assert.equal(fetchMock.calls.length, calls, `${mode}: no call went out`);
      assert.equal((await get("/api/sessions")).json.running, null, `${mode}: no council started`);
    } finally {
      setRoster();
    }
  }
});

test("a pick-mode board with the Anthropic key has no check on seat keys: the Chair picks only seats that can run", async () => {
  setRoster("auto");
  try {
    const calls = fetchMock.calls.length;
    await withEnv({ ANTHROPIC_API_KEY: "sk-test-anthropic", OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined }, async () => {
      world = async (url) => (url.includes("api.anthropic.com") ? { status: 401, text: "refused" } : { status: 500, text: "unexpected" });
      const r = await post("/api/council", { prompt: PROMPT });
      assert.equal(r.status, 200, "Buffett has no key, but the Chair will not seat him");
      const s = getSession(r.json.id);
      await until(() => s.status !== "running");
      assert.equal(s.status, "error", "the Chair's own call is what failed");
      const urls = fetchMock.calls.slice(calls).map((c) => c.url);
      assert.ok(urls.length >= 1 && urls.every((u) => u.includes("api.anthropic.com")), "only the Chair was called");
    });
  } finally {
    world = async (url) => ({ status: 500, text: `unexpected call to ${url}` });
    setRoster();
  }
});

test("a council that is paused still counts as running, and resume stops it", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "sk-test-anthropic", OPENAI_API_KEY: "sk-test-openai" }, async () => {
    world = async (url, init) => {
      if (url.includes("api.anthropic.com") && JSON.parse(init.body).output_config) return setupReply(JSON.parse(init.body));
      return { status: 500, text: `unexpected call to ${url}` };
    };
    try {
      const started = await post("/api/council", { prompt: PROMPT, mode: "full" });
      assert.equal(started.status, 200);
      const id = started.json.id;
      const s = getSession(id);
      const pause = await until(() => s.events.find((e) => e.type === "pause" && e.kind === "privacy"));
      assert.match(pause.recipients, /OpenAI \(Buffett, via API\)/);

      // Another council while this one waits for the user's answer: refused, as when it was running.
      const second = await post("/api/council", { prompt: PROMPT });
      assert.equal(second.status, 409);
      assert.equal((await get("/api/sessions")).json.running, id);

      // The resume route checks its own input first.
      assert.equal((await post(`/api/council/${id}/resume`, { action: "later" })).status, 400);
      assert.equal((await post(`/api/council/${id}/resume`, {})).status, 400);
      assert.equal((await post(`/api/council/${id}/resume`, { action: "continue" }, { origin: "http://evil.test" })).status, 403);
      assert.equal(s.events.filter((e) => e.type === "resumed").length, 0, "the pause is still open");

      const stopped = await post(`/api/council/${id}/resume`, { action: "stop" });
      assert.equal(stopped.status, 200);
      await until(() => s.status !== "running");
      assert.equal(s.status, "stopped");
      assert.deepEqual(s.events.filter((e) => e.type === "resumed").map((e) => [e.kind, e.action]), [["privacy", "stop"]]);
      assert.equal(fetchMock.calls.filter((c) => !c.url.includes("api.anthropic.com")).length, 0, "nothing went to OpenAI");

      // Nothing is waiting now.
      const again = await post(`/api/council/${id}/resume`, { action: "stop" });
      assert.equal(again.status, 404);
      assert.deepEqual(again.json, { error: "Nothing is waiting for a decision." });
      assert.equal((await get("/api/sessions")).json.running, null);
    } finally {
      world = async (url) => ({ status: 500, text: `unexpected call to ${url}` });
    }
  });
});

test("resume checks the id and the action", async () => {
  const bad = ["-x", ".hidden", "a".repeat(82), "a%20b", "..%2fx", "x%00", "a_b"];
  for (const id of bad) {
    const r = await post(`/api/council/${id}/resume`, { action: "stop" });
    assert.equal(r.status, 400, id);
    assert.deepEqual(Object.keys(r.json), ["error"]);
  }
  assert.equal((await post("/api/council/%E0%A4%A/resume", { action: "stop" })).status, 400, "an undecodable id");
  for (const action of ["pause", "", 1, null, ["stop"], { action: "stop" }]) {
    assert.equal((await post("/api/council/2026-10-28-abc/resume", { action })).status, 400, JSON.stringify(action));
  }
  // A well-formed id with no pause open.
  const none = await post("/api/council/2026-10-28-abc/resume", { action: "continue" });
  assert.equal(none.status, 404);
  assert.deepEqual(none.json, { error: "Nothing is waiting for a decision." });
  assert.equal((await post(`/api/council/${"a".repeat(81)}/resume`, { action: "stop" })).status, 404, "81 characters is the longest id");
});

// ---------------------------------------------------------------- seats and usage
test("/api/seats exposes key presence, not values", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "sk-test-anthropic", OPENAI_API_KEY: "sk-test-openai", GEMINI_API_KEY: undefined }, async () => {
    const r = await get("/api/seats");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.keys, { anthropic: true, openai: true, google: false });
    assert.equal(r.json.hasKey, true);
    assert.ok(!r.text.includes("sk-test"), "no key value in the answer");
    assert.ok(r.json.seats.some((x) => x.key === "priya" && x.provider === "human"));
    assert.equal(r.json.runner, "api");
  });
  await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: "gem-test-secret" }, async () => {
    const r = await get("/api/seats");
    assert.deepEqual(r.json.keys, { anthropic: false, openai: false, google: true });
    assert.equal(r.json.hasKey, false);
    assert.ok(!r.text.includes("gem-test-secret"));
  });
});

test("/api/usage adds a tally for each provider", async () => {
  const r = await get("/api/usage");
  assert.equal(r.status, 200);
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "calls"]) assert.equal(typeof r.json[k], "number", k);
  assert.deepEqual(Object.keys(r.json.providers).sort(), ["google", "openai"]);
  assert.deepEqual(r.json.providers.openai, { input: 0, output: 0, cacheRead: 0, calls: 0 });
});

// ---------------------------------------------------------------- the pieces the server relies on
test("startWatching() returns a function that stops the watcher", () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timers();
  const stopWatching = watch.startWatching();
  assert.equal(typeof stopWatching, "function");
  assert.equal(timers(), before + 1, "one interval started");
  stopWatching();
  assert.equal(timers(), before, "and it is cleared");
  stopWatching(); // a second call is harmless
});

// ---------------------------------------------------------------- start and stop
test("stop() resolves even while an event stream is open", async () => {
  const name = uniq("stream");
  pendingSession(name);
  const res = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/api/stream/${name}`, headers: { host: `127.0.0.1:${port}` }, agent: false }, resolve);
    req.on("error", reject);
  });
  assert.equal(res.statusCode, 200);
  const closed = new Promise((resolve) => { res.on("close", resolve); res.on("error", () => {}); res.resume(); });
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("stop() did not resolve")), 5000); });
  try {
    await Promise.race([stop(), limit]);
    await Promise.race([closed, limit]);
  } finally { clearTimeout(timer); }
});

test("start() reads PORT through env(), listens on 127.0.0.1 only, and stop() frees the port", async () => {
  await stop();
  const srv = await start();
  try {
    const addr = srv.address();
    assert.equal(addr.address, "127.0.0.1");
    assert.equal(addr.port, envPort);
    const r = await request(envPort, { path: "/api/usage", headers: { host: `localhost:${envPort}` } });
    assert.equal(r.status, 200);
    // The allowed Host is the port actually bound, not 4730 and not an earlier server's.
    assert.equal((await request(envPort, { path: "/api/usage", headers: { host: `127.0.0.1:${port}` } })).status, 403);
    await assert.rejects(start(0), /already running/);
  } finally {
    await stop();
  }
  await assert.rejects(request(envPort, { path: "/api/usage", headers: { host: `localhost:${envPort}` } }), /ECONNREFUSED/);
  await stop(); // stopping twice is harmless
});

test("start(0) can run again after stop(), on a new port", async () => {
  const srv = await start(0);
  try {
    assert.notEqual(srv.address().port, 0);
    assert.equal((await request(srv.address().port, { path: "/api/usage", headers: { host: `127.0.0.1:${srv.address().port}` } })).status, 200);
  } finally {
    await stop();
  }
});

test("a port that is taken rejects start() and leaves nothing running", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const taken = blocker.address().port;
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timers();
  try {
    await assert.rejects(start(taken), /EADDRINUSE/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
  await sleep(50);
  assert.equal(timers(), before, "no watcher interval was left behind");
  const srv = await start(0); // the failed attempt did not leave a half-started server
  try {
    assert.equal(srv.address().address, "127.0.0.1");
  } finally {
    await stop();
  }
});

test("a port that cannot exist rejects start() and the next start(0) works", async () => {
  // listen() throws at once for a port above 65535, inside start()'s promise. That must not
  // leave the module thinking a server is running.
  await assert.rejects(start(70000), (e) => e?.code === "ERR_SOCKET_BAD_PORT");
  await assert.rejects(start(-1), (e) => e?.code === "ERR_SOCKET_BAD_PORT");
  const srv = await start(0);
  try {
    assert.equal(srv.address().address, "127.0.0.1");
  } finally {
    await stop();
  }
});

test("node app/server.mjs starts the room when run directly, also through a symlink", async () => {
  const server = fileURLToPath(new URL("../app/server.mjs", import.meta.url));
  const link = path.join(repo.root, "start-link.mjs");
  fs.symlinkSync(server, link);
  for (const entry of [server, link]) {
    const p = await freePort();
    const child = spawn(process.execPath, [entry], {
      env: { PATH: process.env.PATH, ROAST_ROOT: repo.root, PORT: String(p), COUNCIL_RUNNER: "viewer" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const line = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no startup line in 10 s. stdout: ${out} stderr: ${err}`)), 10000);
        child.stdout.on("data", (c) => {
          out += c;
          if (out.includes("\n")) { clearTimeout(t); resolve(out.split("\n")[0]); }
        });
        child.once("exit", (code) => { clearTimeout(t); reject(new Error(`exited ${code} before starting. stdout: ${out} stderr: ${err}`)); });
      });
      assert.equal(line, `Roast Room on http://localhost:${p} (viewer: run /roast-room in Claude Code)`);
      const r = await request(p, { path: "/api/seats", headers: { host: `localhost:${p}` } });
      assert.equal(r.status, 200);
      assert.equal(r.json.runner, "viewer");
      assert.deepEqual(r.json.keys, { anthropic: false, openai: false, google: false });
    } finally {
      child.kill();
      await exited;
    }
  }
});

test("importing the server binds no port and starts no watcher", async () => {
  const server = fileURLToPath(new URL("../app/server.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(server).href)})`], {
    env: { PATH: process.env.PATH, ROAST_ROOT: repo.root, PORT: String(await freePort()) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill(); resolve("still running after 10 s"); }, 10000);
    child.once("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 0, `the process should end by itself. Output: ${out}`);
  assert.equal(out, "");
});

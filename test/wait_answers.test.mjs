// wait_answers.mjs: in the Claude Code path, the Chair runs this in the background when people sit on
// the panel. It writes one request per person into sessions/<id>/inbox/ and waits until each is answered.
// In-process tests use a disposable repo (ROAST_ROOT), small pollMs and deadlineMin values, and the
// real submitAnswer for the answer. A few tests run the script as a real process to check the entry point.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeRepo, makeSession } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", ".claude", "skills", "roast-room", "scripts", "wait_answers.mjs");

const repo = makeRepo({
  seats: [
    { key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos" },
    { key: "priya", name: "Priya Rao", short: "Priya", provider: "human", pillar: "Family and health", dimension: "Family cost" },
    { key: "arjun", name: "Arjun Mehta", short: "Arjun", provider: "human", pillar: "Operations", dimension: "Ops load" },
  ],
});
process.env.ROAST_ROOT = repo.root;
// A short default window (6 s), so that a wait left running by a failing test ends soon. Tests that need
// another window pass deadlineMin or set the variable themselves.
process.env.HUMAN_DEADLINE_MIN = "0.1";
after(() => repo.cleanup());

const { waitAnswers, main } = await import(pathToFileURL(SCRIPT).href);
const { ROUND_FIELDS, SESSION_ID, requestPath, answerPath, writeRequest, submitAnswer, deadlineFrom } = await import("../app/lib/inbox.mjs");
const { contextFiles } = await import("../app/lib/seatprompt.mjs");

const OPTIONS = [{ id: "A", label: "Raise the price" }, { id: "B", label: "Keep it" }];
const BRIEF = "THE DECISION: raise the price from $2,000 to $3,500.\n";
const FIELDS = {
  1: { STANCE: "Yes", "OPTION SCORES": { A: 7, B: 4 }, "THE CALL": "Do A first.", CONFIDENCE: 4, "RUIN RISK": "none", DOOR: "two-way" },
};
const FAST = { pollMs: 10 };
const LONG = 0.1; // minutes (6 s): far longer than any test waits, short enough that a failing test cannot leave a long wait running

let seq = 0;
/** A skill session with council.json, a brief and a Round 1 card. Returns { name, dir }. */
function session(files = {}) {
  const dir = makeSession(repo.root, `wa-${++seq}`, {
    "council.json": { title: "Price", options: OPTIONS, seats: ["bezos", "priya", "arjun"] },
    "brief.md": BRIEF,
    "round-1.md": "## Bezos\nSEAT: BEZOS\nSTANCE: Yes\n",
    ...files,
  });
  return { name: path.basename(dir), dir };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const withEnv = async (key, value, fn) => {
  const old = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
};
// A promise that must settle. If a bug leaves it pending, fail in seconds instead of hanging the run.
function soon(promise, ms = 5000) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error("did not settle in time")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
/** A request as the Chair writes it, for tests that need one on disk before the script runs. */
function request(dir, { seat = "priya", round = 1, deadline = deadlineFrom(), status = "pending", prompt = "OLD PROMPT" } = {}) {
  return writeRequest(dir, { seat, round, prompt, fields: ROUND_FIELDS[round], context: contextFiles(round), options: OPTIONS, deadline, status });
}
/** The person answers through the same function the room's form calls. */
function answer(name, seat, round = 1) {
  const r = submitAnswer({ session: name, seat, round, fields: FIELDS[round] });
  assert.equal(r.code, 200, JSON.stringify(r.body));
}
/** Stream stand-ins for main(). */
function streams() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } },
  };
}
const lines = (s) => s.split("\n").filter(Boolean);

// ---------------------------------------------------------------- requests
test("writes one request per person with the round's fields, context, options, prompt and deadline", async () => {
  const { dir } = session();
  const promptFile = path.join(dir, "prompt.txt");
  fs.writeFileSync(promptFile, "ROUND 1 PROMPT: fill in your card.\n");
  const t0 = Date.now();
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya", "arjun"], promptFile, deadlineMin: 0.002, ...FAST }));
  assert.equal(r.code, 4); // nobody answered: the requests are on disk, which is what this test reads
  for (const seat of ["priya", "arjun"]) {
    const req = readJson(requestPath(dir, seat, 1));
    assert.equal(req.seat, seat);
    assert.equal(req.round, 1);
    assert.equal(req.status, "pending");
    assert.equal(req.prompt, "ROUND 1 PROMPT: fill in your card.\n");
    assert.deepEqual(req.fields, ROUND_FIELDS[1]);
    assert.deepEqual(req.context, contextFiles(1));
    assert.deepEqual(req.options, OPTIONS);
    assert.equal(new Date(req.deadline).toISOString(), req.deadline, "an ISO string");
    const left = Date.parse(req.deadline) - t0;
    assert.ok(left > 0 && left <= 0.002 * 60000 + 2000, `deadline ${left} ms after the start`);
  }
  // Both people got the same deadline: it is worked out once.
  assert.equal(readJson(requestPath(dir, "priya", 1)).deadline, readJson(requestPath(dir, "arjun", 1)).deadline);
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")).sort(), ["arjun-r1.request.json", "priya-r1.request.json"]);
});

test("Round 2 requests carry Round 2's fields and context; no prompt file means an empty prompt", async () => {
  const { dir } = session();
  const r = await soon(waitAnswers({ session: dir, round: 2, seats: ["priya"], deadlineMin: 0.002, ...FAST }));
  assert.equal(r.code, 4);
  const req = readJson(requestPath(dir, "priya", 2));
  assert.deepEqual(req.fields, ROUND_FIELDS[2]);
  assert.deepEqual(req.context, contextFiles(2));
  assert.equal(req.prompt, "");
  assert.equal(fs.existsSync(requestPath(dir, "priya", 1)), false, "only the asked round");
});

test("options come from council.json the way the room reads them: plain strings take A, B, C by position", async () => {
  const { dir } = session({ "council.json": { options: ["Raise it", { id: "b", label: "Keep it" }, { id: "C", text: "Tier it" }] } });
  await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: 0.002, ...FAST }));
  assert.deepEqual(readJson(requestPath(dir, "priya", 1)).options, [
    { id: "A", label: "Raise it" }, { id: "B", label: "Keep it" }, { id: "C", label: "Tier it" },
  ]);
});

test("the deadline is HUMAN_DEADLINE_MIN when no deadlineMin is given, and deadlineMin wins when it is", async () => {
  const windowOf = (s, t0) => Date.parse(readJson(requestPath(s.dir, "priya", 1)).deadline) - t0;
  await withEnv("HUMAN_DEADLINE_MIN", "0.002", async () => {
    const a = session();
    const t0 = Date.now();
    assert.equal((await soon(waitAnswers({ session: a.dir, round: 1, seats: ["priya"], ...FAST }))).code, 4);
    assert.ok(windowOf(a, t0) <= 0.002 * 60000 + 2000, "HUMAN_DEADLINE_MIN set the window");
  });
  await withEnv("HUMAN_DEADLINE_MIN", "1", async () => {
    const c = session();
    const t0 = Date.now();
    assert.equal((await soon(waitAnswers({ session: c.dir, round: 1, seats: ["priya"], deadlineMin: 0.002, ...FAST }))).code, 4);
    assert.ok(windowOf(c, t0) <= 0.002 * 60000 + 2000, "deadlineMin overrides the environment");

    // Without deadlineMin the environment's 1 minute is used. Read the file the script wrote, then answer.
    const d = session();
    const t1 = Date.now();
    const pending = waitAnswers({ session: d.dir, round: 1, seats: ["priya"], ...FAST });
    await sleep(60);
    const left = windowOf(d, t1);
    answer(d.name, "priya"); // before the assertion, so a failure cannot leave the wait running
    assert.equal((await soon(pending)).code, 0);
    assert.ok(left > 59000 && left <= 60000 + 2000, `1 minute from HUMAN_DEADLINE_MIN (${left} ms)`);
  });
});

// ---------------------------------------------------------------- waiting
test("a submitAnswer during the wait gives code 0 and the answer file is there", async () => {
  const { name, dir } = session();
  const pending = waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: LONG, ...FAST });
  await sleep(80);
  answer(name, "priya");
  const r = await soon(pending);
  assert.deepEqual(r, { code: 0, answered: ["priya"], missing: [] });
  assert.match(fs.readFileSync(answerPath(dir, "priya", 1), "utf8"), /^SEAT: PRIYA/);
  assert.equal(readJson(requestPath(dir, "priya", 1)).status, "answered");
});

test("with two people it waits for both, and lists them in the order asked", async () => {
  const { name, dir } = session();
  const t0 = Date.now();
  const pending = waitAnswers({ session: dir, round: 1, seats: ["arjun", "priya"], deadlineMin: LONG, ...FAST });
  await sleep(40);
  answer(name, "priya");
  await sleep(120);
  assert.equal(await Promise.race([pending.then(() => "done"), sleep(30).then(() => "waiting")]), "waiting", "one answer is not enough");
  answer(name, "arjun");
  const r = await soon(pending);
  assert.deepEqual(r, { code: 0, answered: ["arjun", "priya"], missing: [] });
  assert.ok(Date.now() - t0 >= 150);
});

test("no answer by the deadline gives code 4 and names the missing person", async () => {
  const { dir } = session();
  const t0 = Date.now();
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: 0.002, ...FAST }));
  assert.deepEqual(r, { code: 4, answered: [], missing: ["priya"] });
  assert.ok(Date.now() - t0 >= 100, "it waited for the deadline");
  assert.ok(Date.now() - t0 < 3000);
});

test("at the deadline the people who answered are listed apart from the ones who did not", async () => {
  const { name, dir } = session();
  const pending = waitAnswers({ session: dir, round: 1, seats: ["priya", "arjun"], deadlineMin: 0.004, ...FAST });
  await sleep(60);
  answer(name, "arjun");
  assert.deepEqual(await soon(pending), { code: 4, answered: ["arjun"], missing: ["priya"] });
});

test("an answer file alone is not an answer: the request's status decides", async () => {
  const { dir } = session();
  request(dir, { deadline: new Date(Date.now() + 150).toISOString() });
  fs.writeFileSync(answerPath(dir, "priya", 1), "SEAT: PRIYA\nSTANCE: Yes\n"); // written, status not yet set
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], ...FAST }));
  assert.deepEqual(r, { code: 4, answered: [], missing: ["priya"] });
});

test("a request that is answered already gives code 0 at once and the files are left alone", async () => {
  const { name, dir } = session();
  request(dir);
  answer(name, "priya");
  const before = fs.readFileSync(requestPath(dir, "priya", 1), "utf8");
  const t0 = Date.now();
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: 5, pollMs: 2000 }));
  assert.deepEqual(r, { code: 0, answered: ["priya"], missing: [] });
  assert.ok(Date.now() - t0 < 1000, "no poll wait when nothing is missing");
  assert.equal(fs.readFileSync(requestPath(dir, "priya", 1), "utf8"), before);
});

// ---------------------------------------------------------------- a re-run
test("re-running keeps the request, its prompt and its original deadline", async () => {
  const { dir } = session();
  const promptFile = path.join(dir, "prompt.txt");
  fs.writeFileSync(promptFile, "FIRST PROMPT");
  assert.equal((await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], promptFile, deadlineMin: 0.002, ...FAST }))).code, 4);
  const first = fs.readFileSync(requestPath(dir, "priya", 1), "utf8");

  fs.writeFileSync(promptFile, "SECOND PROMPT");
  const t0 = Date.now();
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], promptFile, deadlineMin: 0.05, ...FAST }));
  assert.deepEqual(r, { code: 4, answered: [], missing: ["priya"] });
  assert.ok(Date.now() - t0 < 1500, "the old deadline has passed, so a longer deadlineMin does not make it wait");
  assert.equal(fs.readFileSync(requestPath(dir, "priya", 1), "utf8"), first, "the file is byte for byte the same");
});

test("a re-run writes a request only for the person who has none", async () => {
  const { dir } = session();
  request(dir, { seat: "priya", deadline: new Date(Date.now() - 1000).toISOString() });
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya", "arjun"], deadlineMin: 0.002, ...FAST }));
  assert.equal(r.code, 4);
  assert.equal(readJson(requestPath(dir, "priya", 1)).prompt, "OLD PROMPT");
  assert.equal(readJson(requestPath(dir, "arjun", 1)).prompt, "");
});

test("exit 4 comes at the latest deadline among the unanswered requests", async () => {
  const { dir } = session();
  const t0 = Date.now(); // before the request is made, so the deadline is at least t0 + 400
  request(dir, { seat: "priya", deadline: new Date(Date.now() + 400).toISOString() });
  request(dir, { seat: "arjun", deadline: new Date(Date.now() - 5000).toISOString() });
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["arjun", "priya"], ...FAST }));
  const took = Date.now() - t0;
  assert.deepEqual(r, { code: 4, answered: [], missing: ["arjun", "priya"] });
  assert.ok(took >= 380, `it did not stop at the older deadline (${took} ms)`);
  assert.ok(took < 2000, `it stopped at the later deadline (${took} ms)`);
});

test("a person who has answered no longer counts: exit 4 comes at the earlier deadline of the one still missing", async () => {
  const { name, dir } = session();
  const t0 = Date.now();
  request(dir, { seat: "priya", deadline: new Date(Date.now() + 4000).toISOString() }); // answers, with the later deadline
  request(dir, { seat: "arjun", deadline: new Date(Date.now() + 400).toISOString() }); // never answers
  answer(name, "priya");
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya", "arjun"], ...FAST }));
  const took = Date.now() - t0;
  assert.deepEqual(r, { code: 4, answered: ["priya"], missing: ["arjun"] });
  assert.ok(took >= 380, `it waited for arjun's deadline (${took} ms)`);
  assert.ok(took < 2000, `it did not wait for priya's later deadline (${took} ms)`);
});

test("a missing person whose request cannot be read gets this run's deadline, not an answered person's later one", async () => {
  const { name, dir } = session();
  request(dir, { seat: "priya", deadline: new Date(Date.now() + 4000).toISOString() });
  answer(name, "priya");
  fs.writeFileSync(requestPath(dir, "arjun", 1), '{"seat":"arjun","round":1,"sta'); // cut off
  const t0 = Date.now();
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya", "arjun"], deadlineMin: 0.004, ...FAST }));
  const took = Date.now() - t0;
  assert.deepEqual(r, { code: 4, answered: ["priya"], missing: ["arjun"] });
  assert.ok(took >= 200 && took < 2000, `this run's 0.004-minute window, not 4 s (${took} ms)`);
});

test("a request that was readable and then is cut off keeps the deadline it had", async () => {
  const { dir } = session();
  const t0 = Date.now();
  request(dir, { seat: "priya", deadline: new Date(Date.now() + 500).toISOString() });
  const pending = waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: 0.002, ...FAST });
  await sleep(60); // the script has read the whole request by now
  fs.writeFileSync(requestPath(dir, "priya", 1), '{"seat":"priya","round":1,"sta');
  const r = await soon(pending);
  const took = Date.now() - t0;
  assert.deepEqual(r, { code: 4, answered: [], missing: ["priya"] });
  assert.ok(took >= 480 && took < 2000, `the original +500 ms deadline, not the 120 ms fallback (${took} ms)`);
});

test("only the named people count: another person's request in the inbox does not change the wait", async () => {
  const { dir } = session();
  request(dir, { seat: "priya", deadline: new Date(Date.now() - 1000).toISOString() });
  request(dir, { seat: "arjun", deadline: new Date(Date.now() + 60000).toISOString() });
  const t0 = Date.now();
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], ...FAST }));
  assert.deepEqual(r, { code: 4, answered: [], missing: ["priya"] });
  assert.ok(Date.now() - t0 < 2000);
});

test("the same person named twice is one request", async () => {
  const { dir } = session();
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya", "priya"], deadlineMin: 0.002, ...FAST }));
  assert.deepEqual(r, { code: 4, answered: [], missing: ["priya"] });
});

// ---------------------------------------------------------------- unreadable requests
test("a request that is cut off or not JSON counts as not answered, and the wait goes on to the deadline", async () => {
  for (const text of ['{"seat":"priya","round":1,"sta', "", "not json at all", "[]", "null", "42"]) {
    const { dir } = session();
    fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
    fs.writeFileSync(requestPath(dir, "priya", 1), text);
    const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: 0.002, ...FAST }));
    assert.deepEqual(r, { code: 4, answered: [], missing: ["priya"] }, JSON.stringify(text));
    assert.equal(fs.readFileSync(requestPath(dir, "priya", 1), "utf8"), text, "the file is not rewritten");
  }
});

test("a request that is cut off at first and whole later is read once it is whole", async () => {
  const { name, dir } = session();
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.writeFileSync(requestPath(dir, "priya", 1), '{"seat":"priya","round":1,"sta');
  const pending = waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: LONG, ...FAST });
  await sleep(60);
  fs.unlinkSync(requestPath(dir, "priya", 1));
  request(dir);
  await sleep(40);
  answer(name, "priya");
  assert.deepEqual(await soon(pending), { code: 0, answered: ["priya"], missing: [] });
});

test("a request whose seat or round do not match its file name is not an answer", async () => {
  const { dir } = session();
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  const other = { seat: "arjun", round: 1, prompt: "", fields: ROUND_FIELDS[1], context: [], options: OPTIONS, deadline: deadlineFrom(), status: "answered" };
  fs.writeFileSync(requestPath(dir, "priya", 1), JSON.stringify(other));
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: 0.002, ...FAST }));
  assert.equal(r.code, 4);
});

// ---------------------------------------------------------------- cannot run (exit 2)
const REFUSALS = [
  ["a seat that is not a person", (s) => ({ seats: ["bezos"] })],
  ["a person and then a seat that is not a person", (s) => ({ seats: ["priya", "bezos"] })],
  ["a seat that is not on the roster", (s) => ({ seats: ["nobody"] })],
  ["a seat key that is not a key at all", (s) => ({ seats: ["../priya"] })],
  ["a seat key that is not a string", (s) => ({ seats: [42] })],
  ["no seats", (s) => ({ seats: [] })],
  ["seats that are not a list", (s) => ({ seats: "priya" })],
  ["round 4", (s) => ({ round: 4 })],
  ["round 0", (s) => ({ round: 0 })],
  ["a round that is not a number", (s) => ({ round: "x" })],
  ["a round with a fraction", (s) => ({ round: 1.5 })],
  ["no round", (s) => ({ round: undefined })],
  ["no session", (s) => ({ session: undefined })],
  ["a session folder that is not there", (s) => ({ session: path.join(s.dir, "missing") })],
  ["a deadlineMin of 0", (s) => ({ deadlineMin: 0 })],
  ["a negative deadlineMin", (s) => ({ deadlineMin: -1 })],
  ["a deadlineMin that is not a number", (s) => ({ deadlineMin: NaN })],
  ["a deadlineMin too large for the clock", (s) => ({ deadlineMin: 1e15 })],
  ["a pollMs of 0", (s) => ({ pollMs: 0 })],
  ["a pollMs of 9", (s) => ({ pollMs: 9 })],
  ["a negative pollMs", (s) => ({ pollMs: -10 })],
  ["a pollMs above what a timer can count", (s) => ({ pollMs: 2147483648 })],
  ["an infinite pollMs", (s) => ({ pollMs: Infinity })],
  ["a pollMs that is NaN", (s) => ({ pollMs: NaN })],
  ["a pollMs that is not a number", (s) => ({ pollMs: "fast" })],
  ["a prompt file that is not there", (s) => ({ promptFile: path.join(s.dir, "no-such-prompt.txt") })],
];
for (const [what, change] of REFUSALS) {
  test(`exit 2 for ${what}, and nothing is written`, async () => {
    const s = session();
    const args = { session: s.dir, round: 1, seats: ["priya"], deadlineMin: LONG, ...FAST, ...change(s) };
    const r = await soon(waitAnswers(args), 2000);
    assert.equal(r.code, 2);
    assert.deepEqual([r.answered, r.missing], [[], []]);
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0 && !r.reason.includes("\n"), "one line of reason");
    assert.equal(fs.existsSync(path.join(s.dir, "inbox")), false, "no request was written");
  });
}

// The room only shows a form for a folder directly under sessions/ whose name is a valid session id
// (inbox.mjs). A request written anywhere else is never shown, and the person would be silently absent
// for the whole wait. So the script refuses such a folder up front.
test("exit 2 for a session folder outside sessions/, and nothing is written", async () => {
  const outside = path.join(repo.root, "elsewhere", "wa-outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "council.json"), JSON.stringify({ options: OPTIONS }));
  const nested = session();
  const deeper = path.join(nested.dir, "wa-deeper");
  fs.mkdirSync(deeper);
  fs.writeFileSync(path.join(deeper, "council.json"), JSON.stringify({ options: OPTIONS }));
  const repoRoot = path.join(repo.root, "wa-at-root");
  fs.mkdirSync(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "council.json"), JSON.stringify({ options: OPTIONS }));

  for (const dir of [outside, deeper, repoRoot]) {
    const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: LONG, ...FAST }), 2000);
    assert.equal(r.code, 2, dir);
    assert.deepEqual([r.answered, r.missing], [[], []]);
    assert.match(r.reason, /sessions/);
    assert.ok(!r.reason.includes("\n"), "one line of reason");
    assert.equal(fs.existsSync(path.join(dir, "inbox")), false, `no request was written in ${dir}`);

    const { out, io } = streams();
    assert.equal(await soon(main(["--session", dir, "--round", "1", "--seats", "priya", "--deadline-min", String(LONG), "--poll-ms", "10"], io), 2000), 2);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /^wait_answers: .+\n$/);
    assert.equal(lines(out.stderr).length, 1);
    assert.equal(fs.existsSync(path.join(dir, "inbox")), false);
  }
});

test("exit 2 for a session folder whose name is not a valid session id, and nothing is written", async () => {
  // inbox.mjs accepts a letter or digit first, then letters, digits and hyphens, 81 characters at most.
  const names = ["wa_under", "wa.dot", "-wa-lead", "wa space", `wa-${"x".repeat(80)}`];
  for (const name of names) {
    const dir = makeSession(repo.root, name, { "council.json": { options: OPTIONS }, "brief.md": BRIEF });
    const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: LONG, ...FAST }), 2000);
    assert.equal(r.code, 2, name);
    assert.deepEqual([r.answered, r.missing], [[], []]);
    assert.match(r.reason, /session/);
    assert.equal(fs.existsSync(path.join(dir, "inbox")), false, `no request was written for ${name}`);

    const { out, io } = streams();
    assert.equal(await soon(main(["--session", dir, "--round", "1", "--seats", "priya", "--deadline-min", String(LONG), "--poll-ms", "10"], io), 2000), 2, name);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /^wait_answers: .+\n$/);
    assert.equal(fs.existsSync(path.join(dir, "inbox")), false, name);
  }
});

test("a session id the inbox accepts is accepted here too, and the two use one rule", async () => {
  assert.ok(SESSION_ID instanceof RegExp);
  for (const name of ["2026-10-28-price", "a", "9lives", "wa-A-1", `wa-${"x".repeat(78)}`]) {
    assert.ok(SESSION_ID.test(name), name);
    const dir = makeSession(repo.root, name, { "council.json": { options: OPTIONS }, "brief.md": BRIEF });
    const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: 0.002, ...FAST }), 3000);
    assert.equal(r.code, 4, name); // it ran and waited; nobody answered
    assert.equal(fs.existsSync(requestPath(dir, "priya", 1)), true, name);
  }
});

test("a session path with a trailing slash still works", async () => {
  const { dir } = session();
  const r = await soon(waitAnswers({ session: dir + path.sep, round: 1, seats: ["priya"], deadlineMin: 0.002, ...FAST }));
  assert.equal(r.code, 4);
  assert.equal(fs.existsSync(requestPath(dir, "priya", 1)), true);
});

test("the poll time can be 10 ms or 2147483647 ms; a long one never sleeps past the deadline", async () => {
  const { dir } = session();
  const t0 = Date.now();
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], deadlineMin: 0.002, pollMs: 2147483647 }), 3000);
  assert.deepEqual(r, { code: 4, answered: [], missing: ["priya"] });
  assert.ok(Date.now() - t0 < 2000);
  const low = session();
  assert.equal((await soon(waitAnswers({ session: low.dir, round: 1, seats: ["priya"], deadlineMin: 0.002, pollMs: 10 }))).code, 4);
});

test("exit 2 when council.json is missing or is not a JSON object", async () => {
  const none = session();
  fs.unlinkSync(path.join(none.dir, "council.json"));
  const r = await soon(waitAnswers({ session: none.dir, round: 1, seats: ["priya"], ...FAST }));
  assert.equal(r.code, 2);
  assert.match(r.reason, /council\.json/);
  for (const text of ["{not json", "[]", "null", ""]) {
    const bad = session({ "council.json": text });
    const x = await soon(waitAnswers({ session: bad.dir, round: 1, seats: ["priya"], ...FAST }));
    assert.equal(x.code, 2, JSON.stringify(text));
    assert.equal(fs.existsSync(path.join(bad.dir, "inbox")), false);
  }
});

test("an existing request does not need the prompt file again", async () => {
  const { dir } = session();
  request(dir, { deadline: new Date(Date.now() - 1000).toISOString() });
  const r = await soon(waitAnswers({ session: dir, round: 1, seats: ["priya"], promptFile: path.join(dir, "gone.txt"), ...FAST }));
  assert.equal(r.code, 4);
});

// ---------------------------------------------------------------- the command line
test("main: exit 0 prints one 'answered:' line per person with the absolute answer path", async () => {
  const { name, dir } = session();
  const { out, io } = streams();
  const pending = main(["--session", dir, "--round", "1", "--seats", "arjun, priya", "--deadline-min", String(LONG), "--poll-ms", "10"], io);
  await sleep(60);
  answer(name, "priya");
  answer(name, "arjun");
  assert.equal(await soon(pending), 0);
  assert.deepEqual(lines(out.stdout), [`answered: arjun ${answerPath(dir, "arjun", 1)}`, `answered: priya ${answerPath(dir, "priya", 1)}`]);
  assert.ok(path.isAbsolute(lines(out.stdout)[0].split(" ")[2]));
  assert.equal(out.stderr, "");
});

test("main: exit 4 prints 'missing:' with the keys, then an 'answered:' line for anyone who answered", async () => {
  const { name, dir } = session();
  const { out, io } = streams();
  const pending = main(["--session", dir, "--round", "1", "--seats", "priya,arjun", "--deadline-min", "0.004", "--poll-ms", "10"], io);
  await sleep(60);
  answer(name, "arjun");
  assert.equal(await soon(pending), 4);
  assert.deepEqual(lines(out.stdout), ["missing: priya", `answered: arjun ${answerPath(dir, "arjun", 1)}`]);
  assert.equal(out.stderr, "");

  const again = streams();
  const none = session();
  assert.equal(await soon(main(["--session", none.dir, "--round", "2", "--seats", "priya,arjun", "--deadline-min", "0.002", "--poll-ms", "10"], again.io)), 4);
  assert.deepEqual(lines(again.out.stdout), ["missing: priya,arjun"]);
});

test("main: exit 2 prints one 'wait_answers:' line on stderr and nothing on stdout", async () => {
  const s = session();
  const cases = [
    [],
    ["--session", s.dir],
    ["--session", s.dir, "--round", "1"],
    ["--session", s.dir, "--round", "7", "--seats", "priya"],
    ["--session", s.dir, "--round", "1", "--seats", "bezos"],
    ["--session", s.dir, "--round", "1", "--seats", "priya", "--deadline-min", "soon"],
    ["--session", s.dir, "--round", "1", "--seats", "priya", "--poll-ms", "0"],
    ["--session", s.dir, "--round", "1", "--seats", "priya", "--poll-ms", "9"],
    ["--session", s.dir, "--round", "1", "--seats", "priya", "--poll-ms", "2147483648"],
    ["--session", s.dir, "--round", "1", "--seats", "priya", "--poll-ms", ""],
    ["--session", s.dir, "--round", "1", "--seats", "priya", "--bogus"],
    ["--session", s.dir, "--round", "1", "--seats", "priya", "stray"],
    ["--session", path.join(s.dir, "missing"), "--round", "1", "--seats", "priya"],
    ["--session", s.dir, "--round", "1", "--seats", ","],
  ];
  for (const argv of cases) {
    const { out, io } = streams();
    assert.equal(await soon(main(argv, io), 2000), 2, JSON.stringify(argv));
    assert.equal(out.stdout, "", JSON.stringify(argv));
    assert.equal(lines(out.stderr).length, 1, `${JSON.stringify(argv)}: ${out.stderr}`);
    assert.match(out.stderr, /^wait_answers: .+\n$/);
  }
  assert.equal(fs.existsSync(path.join(s.dir, "inbox")), false);
});

test("main: a relative session path works", async () => {
  const { dir } = session();
  const rel = path.relative(process.cwd(), dir);
  assert.ok(!path.isAbsolute(rel));
  const { out, io } = streams();
  assert.equal(await soon(main(["--session", rel, "--round", "1", "--seats", "priya", "--deadline-min", "0.002", "--poll-ms", "10"], io)), 4);
  assert.deepEqual(lines(out.stdout), ["missing: priya"]);
  assert.equal(fs.existsSync(requestPath(dir, "priya", 1)), true);
});

test("main: an unexpected throw is one line on stderr and exit 2", async () => {
  const { dir } = session();
  fs.writeFileSync(path.join(dir, "inbox"), "this is a file where the inbox folder should be");
  const { out, io } = streams();
  assert.equal(await soon(main(["--session", dir, "--round", "1", "--seats", "priya", "--deadline-min", "0.002", "--poll-ms", "10"], io)), 2);
  assert.equal(out.stdout, "");
  assert.equal(lines(out.stderr).length, 1);
  assert.match(out.stderr, /^wait_answers: .+\n$/);
});

test("the module does not run main() when it is imported", () => {
  assert.equal(process.exitCode, undefined);
});

// ---------------------------------------------------------------- as a real process
function run(args, extraEnv = {}) {
  const env = { ...process.env, ROAST_ROOT: repo.root };
  delete env.HUMAN_DEADLINE_MIN;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 15000 });
}

test("as a process: exit 4 at the deadline, with 'missing:' on stdout", () => {
  const { dir } = session();
  const r = run(["--session", dir, "--round", "1", "--seats", "priya", "--deadline-min", "0.002", "--poll-ms", "20"]);
  assert.equal(r.status, 4, r.stderr);
  assert.equal(r.stdout, "missing: priya\n");
  assert.equal(r.stderr, "");
});

test("as a process: exit 0 when the person has answered, and HUMAN_DEADLINE_MIN is honoured", () => {
  const { name, dir } = session();
  request(dir);
  answer(name, "priya");
  const r = run(["--session", dir, "--round", "1", "--seats", "priya", "--poll-ms", "20"], { HUMAN_DEADLINE_MIN: "0.002" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `answered: priya ${answerPath(dir, "priya", 1)}\n`);

  const fresh = session();
  const late = run(["--session", fresh.dir, "--round", "1", "--seats", "priya", "--poll-ms", "20"], { HUMAN_DEADLINE_MIN: "0.002" });
  assert.equal(late.status, 4, late.stderr);
});

test("as a process: exit 2 for a bad argument, with one line on stderr", () => {
  const r = run(["--round", "1"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^wait_answers: .+\n$/);
  assert.equal(lines(r.stderr).length, 1);
});

test("as a process: a roster that will not load is one line and exit 2", () => {
  const { dir } = session();
  const r = run(["--session", dir, "--round", "1", "--seats", "priya", "--deadline-min", "0.002"], { ROAST_ROOT: path.join(repo.root, "nowhere") });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(lines(r.stderr).length, 1);
  assert.match(r.stderr, /^wait_answers: /);
});

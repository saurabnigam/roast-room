// run_seat.mjs: the Claude Code path's way to get a card from a seat that runs on OpenAI or Google.
// In-process tests use a disposable repo (ROAST_ROOT), a mocked fetch and test/fixtures/fake-delegate.mjs
// in place of delegate.py. A few tests run the script as a real process to check the entry point.
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeRepo, makeSession, mockFetch } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fixtures", "fake-delegate.mjs");
const SCRIPT = path.join(HERE, "..", ".claude", "skills", "roast-room", "scripts", "run_seat.mjs");

const repo = makeRepo({
  seats: [
    { key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos" },
    { key: "graham", name: "Paul Graham", short: "Graham", slug: "paul-graham", model: "claude-opus-5-5" },
    { key: "munger", name: "Charlie Munger", short: "Munger", slug: "charlie-munger", model: "some-future-model" },
    { key: "buffett", name: "Warren Buffett", short: "Buffett", slug: "warren-buffett", provider: "openai", model: "gpt-6.1-sol" },
    { key: "sanchez", name: "Codie Sanchez", short: "Codie", slug: "codie-sanchez", provider: "openai", model: "gpt-6.1-sol", cli_model: "codex-fast" },
    { key: "naval", name: "Naval Ravikant", short: "Naval", slug: null, provider: "google" },
    { key: "dash", name: "Dash Dee", short: "Dash", slug: "dash-dee", provider: "openai", cli_model: "--allow-secrets" },
    { key: "priya", name: "Priya Rao", short: "Priya", provider: "human" },
  ],
});
process.env.ROAST_ROOT = repo.root;
after(() => repo.cleanup());

const { resolveSeat, planSeats, runSeat, main, childEnv, setCliLimits, cliLimits } = await import(pathToFileURL(SCRIPT).href);
const { setSleep } = await import("../app/lib/providers/http.mjs");
const { buildSeatCall } = await import("../app/lib/seatprompt.mjs");

// Values that look like keys and are not.
const KEY = "test-openai-key-7f3a91c2d4";
const GKEY = "test-gemini-key-b81e05a6f9";
const ENV_KEYS = [
  "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "DELEGATE_PY", "DELEGATE_PYTHON",
  "FAKE_DELEGATE_LOG", "FAKE_DELEGATE_EXIT", "FAKE_DELEGATE_STDOUT", "SEAT_MODEL", "OPENAI_SEAT_MODEL", "GEMINI_SEAT_MODEL",
  "KIE_AI_API_KEY", "MY_SERVICE_TOKEN", "DB_PASSWORD", "CODEX_HOME",
];
const use = (vars) => Object.assign(process.env, vars);

let mock = null;
let logSeq = 0;
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  setSleep(async () => {}); // postJson retries without waiting
});
afterEach(() => {
  mock?.restore();
  mock = null;
  setSleep();
  setCliLimits(); // put the real limits back
});

const OPTIONS = [{ id: "A", label: "Raise now" }, { id: "B", label: "Wait" }];
const BRIEF = "THE DECISION: raise the price from $2,000 to $3,500.\n";
let sessionSeq = 0;
function session(files = {}) {
  return makeSession(repo.root, `s-${++sessionSeq}`, {
    "council.json": { title: "Price", options: OPTIONS, seats: ["buffett"] },
    "brief.md": BRIEF,
    "round-1.md": "## Bezos\nSEAT: BEZOS\nSTANCE: Yes\n",
    "cruxes.json": { cruxes: [] },
    ...files,
  });
}
const PROMPT = "ROUND PROMPT: fill in your card.";
function promptFile(text = PROMPT) {
  const file = path.join(repo.root, `prompt-${++sessionSeq}.md`);
  fs.writeFileSync(file, text);
  return file;
}
const cliEnv = (extra = {}) => {
  const log = path.join(repo.root, `delegate-${++logSeq}.log`);
  use({ DELEGATE_PY: FAKE, DELEGATE_PYTHON: process.execPath, FAKE_DELEGATE_LOG: log, ...extra });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
};

const R1_CARD = "SEAT: BUFFETT\nSTANCE: Yes\nOPTION SCORES: A 8 · B 4\nTHE CALL: Do A first.\nCONFIDENCE: 4\nRUIN RISK: none\nDOOR: two-way";
const openai = (text, extra = {}) => ({
  json: {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 10 } },
    ...extra,
  },
});
const google = (text) => ({
  json: { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 } },
});

function io() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// ------------------------------------------------------------------ resolveSeat: transport

test("resolveSeat: an OpenAI seat with a key runs over http", () => {
  use({ OPENAI_API_KEY: KEY });
  const r = resolveSeat({ seat: "buffett" });
  assert.equal(r.seat, "buffett");
  assert.equal(r.provider, "openai");
  assert.equal(r.model, "gpt-6.1-sol");
  assert.equal(r.transport, "http");
  assert.equal(r.agentModel, null);
  assert.equal(r.reason, null);
});

test("resolveSeat: no key and DELEGATE_PY names a file means the CLI", () => {
  use({ DELEGATE_PY: FAKE });
  const r = resolveSeat({ seat: "buffett" });
  assert.equal(r.transport, "cli");
  assert.equal(r.reason, null);
  assert.equal(resolveSeat({ seat: "sanchez" }).cliModel, "codex-fast");
  assert.equal(resolveSeat({ seat: "buffett" }).cliModel, null);
});

test("resolveSeat: a key wins over DELEGATE_PY", () => {
  use({ OPENAI_API_KEY: KEY, DELEGATE_PY: FAKE });
  assert.equal(resolveSeat({ seat: "buffett" }).transport, "http");
});

test("resolveSeat: neither a key nor a CLI is null with the reason, for OpenAI and for Google", () => {
  const o = resolveSeat({ seat: "buffett" });
  assert.equal(o.transport, null);
  assert.equal(o.reason, "no OPENAI_API_KEY and no DELEGATE_PY");
  const g = resolveSeat({ seat: "naval" });
  assert.equal(g.transport, null);
  assert.equal(g.reason, "no GEMINI_API_KEY and no DELEGATE_PY");
});

test("resolveSeat: a DELEGATE_PY that is not an existing file is no CLI", () => {
  use({ DELEGATE_PY: path.join(repo.root, "no-such-delegate.py") });
  assert.equal(resolveSeat({ seat: "buffett" }).transport, null);
  use({ DELEGATE_PY: repo.root }); // a folder is not a file
  assert.equal(resolveSeat({ seat: "buffett" }).transport, null);
});

test("resolveSeat: DELEGATE_PY may start with ~/, because a .env value is not expanded by a shell", () => {
  fs.copyFileSync(FAKE, path.join(repo.root, "home-delegate.py"));
  const home = process.env.HOME;
  try {
    use({ HOME: repo.root, DELEGATE_PY: "~/home-delegate.py" });
    assert.equal(resolveSeat({ seat: "buffett" }).transport, "cli");
    use({ DELEGATE_PY: "~/no-such-file.py" });
    assert.equal(resolveSeat({ seat: "buffett" }).transport, null);
  } finally {
    process.env.HOME = home;
  }
});

test("resolveSeat: a Google seat uses its own key, then the CLI", () => {
  use({ GEMINI_API_KEY: GKEY });
  assert.equal(resolveSeat({ seat: "naval" }).transport, "http");
  assert.equal(resolveSeat({ seat: "naval" }).model, "gemini-3.8-flash");
  delete process.env.GEMINI_API_KEY;
  use({ DELEGATE_PY: FAKE });
  assert.equal(resolveSeat({ seat: "naval" }).transport, "cli");
  // An OpenAI key does not run a Google seat.
  use({ OPENAI_API_KEY: KEY, DELEGATE_PY: "" });
  assert.equal(resolveSeat({ seat: "naval" }).transport, null);
});

test("resolveSeat: an Anthropic seat is a subagent, and a pinned model id maps to the Agent tool alias", () => {
  assert.deepEqual(
    (({ provider, model, transport, agentModel }) => ({ provider, model, transport, agentModel }))(resolveSeat({ seat: "graham" })),
    { provider: "anthropic", model: "claude-opus-5-5", transport: "subagent", agentModel: "opus" },
  );
  // A pinned model that no alias matches: the model is kept, agentModel is null.
  const m = resolveSeat({ seat: "munger" });
  assert.equal(m.model, "some-future-model");
  assert.equal(m.agentModel, null);
  assert.equal(m.transport, "subagent");
});

test("resolveSeat: an Anthropic seat with no explicit model has model null and agentModel null (it runs on the session's model)", () => {
  const d = resolveSeat({ seat: "bezos" });
  assert.equal(d.provider, "anthropic");
  assert.equal(d.transport, "subagent");
  assert.equal(d.model, null);
  assert.equal(d.agentModel, null);
  assert.equal(d.reason, null);
});

test("resolveSeat: SEAT_MODEL does not pin a Claude seat in the Claude Code path", () => {
  use({ SEAT_MODEL: "claude-opus-5-5" });
  const d = resolveSeat({ seat: "bezos" });
  assert.equal(d.model, null);
  assert.equal(d.agentModel, null);
});

test("resolveSeat: an explicit Claude model is an argument, a runners model or the roster model", () => {
  // argument
  const arg = resolveSeat({ seat: "bezos", model: "claude-haiku-5" });
  assert.equal(arg.model, "claude-haiku-5");
  assert.equal(arg.agentModel, "haiku");
  // runners model in council.json
  const dir = session({ "council.json": { options: OPTIONS, runners: { bezos: { provider: "anthropic", model: "claude-opus-5-5" } } } });
  const run = resolveSeat({ seat: "bezos", session: dir });
  assert.equal(run.model, "claude-opus-5-5");
  assert.equal(run.agentModel, "opus");
  // roster model (graham is pinned to opus); the argument still beats it
  assert.equal(resolveSeat({ seat: "graham" }).agentModel, "opus");
  assert.equal(resolveSeat({ seat: "graham", model: "claude-sonnet-5-5" }).agentModel, "sonnet");
});

test("resolveSeat: a runners entry with a null model leaves a Claude seat unpinned", () => {
  const dir = session({ "council.json": { options: OPTIONS, runners: { bezos: { provider: "anthropic", model: null, agentModel: null, transport: "subagent" } } } });
  const d = resolveSeat({ seat: "bezos", session: dir });
  assert.equal(d.model, null);
  assert.equal(d.agentModel, null);
});

test("resolveSeat: a model id written for another provider never pins a Claude seat", () => {
  // buffett is an OpenAI seat with a GPT id in the roster; moved to Claude for this council it is unpinned.
  const dir = session({ "council.json": { options: OPTIONS, runners: { buffett: { provider: "anthropic" } } } });
  const d = resolveSeat({ seat: "buffett", session: dir });
  assert.equal(d.provider, "anthropic");
  assert.equal(d.model, null);
  assert.equal(d.agentModel, null);
});

test("resolveSeat: an Anthropic seat is a subagent even when an API key is set", () => {
  use({ ANTHROPIC_API_KEY: "test-anthropic-key-1" }); // gitleaks:allow (fake test key)
  assert.equal(resolveSeat({ seat: "bezos" }).transport, "subagent");
});

test("resolveSeat: a person is a form, with no model", () => {
  const r = resolveSeat({ seat: "priya" });
  assert.equal(r.provider, "human");
  assert.equal(r.transport, "form");
  assert.equal(r.model, null);
  assert.equal(r.agentModel, null);
});

test("resolveSeat: an unknown seat throws, and an unknown provider cannot run", () => {
  assert.throws(() => resolveSeat({ seat: "nobody" }), /Unknown seat: nobody/);
  assert.throws(() => resolveSeat({ seat: "__proto__" }), /Unknown seat/);
  const r = resolveSeat({ seat: "buffett", provider: "mistral" });
  assert.equal(r.transport, null);
  assert.match(r.reason, /unknown provider "mistral"/);
});

// ------------------------------------------------------------------ resolveSeat: provider and model order

test("resolveSeat: runners in council.json override the roster provider and model", () => {
  const dir = session({
    "council.json": {
      options: OPTIONS,
      runners: {
        buffett: { provider: "anthropic", model: "claude-opus-5-5", transport: "subagent" },
        bezos: { provider: "google", model: "gemini-custom" },
      },
    },
  });
  use({ GEMINI_API_KEY: GKEY });
  const b = resolveSeat({ seat: "buffett", session: dir });
  assert.equal(b.provider, "anthropic");
  assert.equal(b.transport, "subagent");
  assert.equal(b.agentModel, "opus");
  const z = resolveSeat({ seat: "bezos", session: dir });
  assert.equal(z.provider, "google");
  assert.equal(z.model, "gemini-custom");
  assert.equal(z.transport, "http");
  // A seat the runners do not list keeps its roster provider.
  assert.equal(resolveSeat({ seat: "graham", session: dir }).provider, "anthropic");
});

test("resolveSeat: an argument beats runners, and runners beat the roster model", () => {
  const dir = session({
    "council.json": { options: OPTIONS, runners: { buffett: { provider: "openai", model: "gpt-runner" } } },
  });
  use({ OPENAI_API_KEY: KEY, GEMINI_API_KEY: GKEY });
  assert.equal(resolveSeat({ seat: "buffett", session: dir }).model, "gpt-runner");
  const arg = resolveSeat({ seat: "buffett", session: dir, provider: "google", model: "gemini-arg" });
  assert.equal(arg.provider, "google");
  assert.equal(arg.model, "gemini-arg");
  assert.equal(resolveSeat({ seat: "buffett", session: dir, model: "gpt-arg" }).model, "gpt-arg");
});

test("resolveSeat: a model written for another provider is never sent to this one", () => {
  const dir = session({
    "council.json": { options: OPTIONS, runners: { buffett: { provider: "openai", model: "gpt-runner" } } },
  });
  use({ GEMINI_API_KEY: GKEY });
  // Roster model gpt-6.1-sol and the runner model gpt-runner are OpenAI ids; --provider google ignores both.
  assert.equal(resolveSeat({ seat: "buffett", provider: "google" }).model, "gemini-3.8-flash");
  assert.equal(resolveSeat({ seat: "buffett", session: dir, provider: "google" }).model, "gemini-3.8-flash");
});

test("resolveSeat: with no seat model, the provider's env variable and then the default", () => {
  use({ GEMINI_SEAT_MODEL: "gemini-env" });
  assert.equal(resolveSeat({ seat: "naval" }).model, "gemini-env");
  delete process.env.GEMINI_SEAT_MODEL;
  assert.equal(resolveSeat({ seat: "naval" }).model, "gemini-3.8-flash");
});

test("resolveSeat: a council.json that is not valid JSON is an error, not a fallback to the roster", () => {
  const dir = session({ "council.json": "{ not json" });
  assert.throws(() => resolveSeat({ seat: "buffett", session: dir }), /council\.json/);
});

test("resolveSeat: a session folder with no council.json is an error, never a fallback to the roster", () => {
  const dir = makeSession(repo.root, `s-${++sessionSeq}`, { "brief.md": BRIEF });
  assert.throws(() => resolveSeat({ seat: "buffett", session: dir }), (e) => e.message === `no council.json in ${dir}`);
  // A folder that does not exist at all is the same error.
  const missing = path.join(repo.root, "sessions", "not-there");
  assert.throws(() => resolveSeat({ seat: "buffett", session: missing }), /no council\.json in /);
  // No --session at all is still the roster.
  assert.equal(resolveSeat({ seat: "buffett" }).provider, "openai");
});

// ------------------------------------------------------------------ planSeats

test("planSeats: bezos, buffett and priya with only DELEGATE_PY set", () => {
  use({ DELEGATE_PY: FAKE });
  const plan = planSeats({ seats: ["bezos", "buffett", "priya"] });
  assert.equal(plan.recipients, "OpenAI (Buffett, via Codex CLI) and Priya on this screen");
  assert.deepEqual(plan.cannotRun, []);
  assert.deepEqual(plan.runners, {
    bezos: { provider: "anthropic", model: null, agentModel: null, transport: "subagent" },
    buffett: { provider: "openai", model: "gpt-6.1-sol", transport: "cli" },
    priya: { provider: "human", model: null, transport: "form" },
  });
});

test("planSeats: a Claude seat carries agentModel, a pinned one the alias, and other seats carry none", () => {
  use({ OPENAI_API_KEY: KEY });
  const { runners } = planSeats({ seats: ["bezos", "graham", "munger", "buffett", "priya"] });
  assert.deepEqual(runners.bezos, { provider: "anthropic", model: null, agentModel: null, transport: "subagent" });
  assert.deepEqual(runners.graham, { provider: "anthropic", model: "claude-opus-5-5", agentModel: "opus", transport: "subagent" });
  assert.deepEqual(runners.munger, { provider: "anthropic", model: "some-future-model", agentModel: null, transport: "subagent" });
  assert.equal("agentModel" in runners.buffett, false);
  assert.equal("agentModel" in runners.priya, false);
});

test("planSeats: keys says which of the OpenAI key, the Google key and a usable DELEGATE_PY exist", () => {
  assert.deepEqual(planSeats({ seats: ["bezos"] }).keys, { openai: false, google: false, delegate: false });
  use({ OPENAI_API_KEY: KEY });
  assert.deepEqual(planSeats({ seats: ["bezos"] }).keys, { openai: true, google: false, delegate: false });
  use({ GEMINI_API_KEY: GKEY, DELEGATE_PY: FAKE });
  assert.deepEqual(planSeats({ seats: ["bezos"] }).keys, { openai: true, google: true, delegate: true });
  // A DELEGATE_PY that is not a file is not a usable CLI.
  use({ DELEGATE_PY: path.join(repo.root, "no-such-delegate.py") });
  assert.equal(planSeats({ seats: ["bezos"] }).keys.delegate, false);
  // The values never appear in the plan.
  use({ OPENAI_API_KEY: KEY, GEMINI_API_KEY: GKEY, DELEGATE_PY: FAKE });
  const text = JSON.stringify(planSeats({ seats: ["bezos", "buffett", "naval"] }));
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes(GKEY), false);
});

test("planSeats: keys is reported even when every seat is a person, and for a seat that cannot run", () => {
  use({ OPENAI_API_KEY: KEY });
  assert.equal(planSeats({ seats: ["priya"] }).keys.openai, true);
  assert.equal(planSeats({ seats: ["naval"] }).keys.openai, true);
});

test("planSeats: a session folder with no council.json throws instead of planning from the roster", () => {
  const dir = makeSession(repo.root, `s-${++sessionSeq}`, { "brief.md": BRIEF });
  assert.throws(() => planSeats({ seats: ["bezos"], session: dir }), /no council\.json in /);
});

test("planSeats: a mixed board names each recipient and its transport", () => {
  use({ OPENAI_API_KEY: KEY, DELEGATE_PY: FAKE });
  const plan = planSeats({ seats: ["bezos", "buffett", "naval", "priya"] });
  assert.equal(plan.recipients, "OpenAI (Buffett, via API), Google (Naval, via agy CLI), and Priya on this screen");
  assert.equal(plan.runners.naval.transport, "cli");
  assert.equal(plan.runners.buffett.transport, "http");
});

test("planSeats: a seat that cannot run is listed with its reason, and is not a recipient", () => {
  const plan = planSeats({ seats: ["bezos", "buffett", "nobody", "priya"] });
  assert.deepEqual(plan.cannotRun, [
    { seat: "buffett", reason: "no OPENAI_API_KEY and no DELEGATE_PY" },
    { seat: "nobody", reason: "no such seat" },
  ]);
  assert.deepEqual(Object.keys(plan.runners), ["bezos", "priya"]);
  assert.equal(plan.recipients, "Priya on this screen");
});

test("planSeats: an all-Anthropic board has no recipients", () => {
  const plan = planSeats({ seats: ["bezos", "graham"] });
  assert.equal(plan.recipients, "");
  assert.deepEqual(plan.cannotRun, []);
});

test("planSeats: council.json runners change the plan, and a repeated seat counts once", () => {
  const dir = session({ "council.json": { options: OPTIONS, runners: { buffett: { provider: "anthropic", model: "claude-sonnet-5-5" } } } });
  const plan = planSeats({ seats: ["buffett", "buffett"], session: dir });
  assert.equal(plan.runners.buffett.provider, "anthropic");
  assert.equal(plan.recipients, "");
});

// ------------------------------------------------------------------ dry run

test("dry-run for a round 2 OpenAI seat lists the files and makes no fetch call", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => { throw new Error("a dry run must not use the network"); });
  const dir = session();
  const r = await runSeat({ session: dir, seat: "buffett", round: 2, promptFile: promptFile(), dryRun: true });
  assert.equal(r.code, 0);
  assert.equal(r.card, null);
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(r.meta.files, ["brief.md", "round-1.md", "cruxes.json"]);
  const { system, user } = buildSeatCall({ sessionDir: dir, seatKey: "buffett", round: 2, promptText: PROMPT });
  assert.equal(r.meta.systemBytes, Buffer.byteLength(system));
  assert.equal(r.meta.userBytes, Buffer.byteLength(user));
  assert.equal(r.meta.seat, "buffett");
  assert.equal(r.meta.provider, "openai");
  assert.equal(r.meta.model, "gpt-6.1-sol");
  assert.equal(r.meta.transport, "http");
  assert.equal(r.meta.agentModel, null);
  assert.equal("argv" in r.meta, false);
  assert.doesNotMatch(JSON.stringify(r.meta), new RegExp(KEY));
});

test("dry-run for the CLI shows argv without starting a process", async () => {
  const log = cliEnv();
  const r = await runSeat({ session: session(), seat: "sanchez", round: 1, promptFile: promptFile(), dryRun: true });
  assert.equal(r.code, 0);
  assert.equal(r.meta.transport, "cli");
  assert.deepEqual(r.meta.files, ["brief.md"]);
  assert.ok(Array.isArray(r.meta.argv));
  for (const flag of ["run", "codex", "--isolated", "--json", "--task-file"]) assert.ok(r.meta.argv.includes(flag), flag);
  assert.equal(r.meta.argv[r.meta.argv.indexOf("--model") + 1], "codex-fast");
  assert.equal(r.meta.argv.includes("--allow-secrets"), false);
  assert.equal(r.meta.argv.join(" ").includes("gpt-6.1-sol"), false);
  assert.deepEqual(log(), []); // the fake delegate never ran
});

test("dry-run in round 3 shows only the seat's own Round 2 card and the draft", async () => {
  use({ OPENAI_API_KEY: KEY });
  const dir = session({
    "round-2.md": "## Bezos\nSEAT: BEZOS\nSTANCE: Yes\n\n## Buffett\nSEAT: BUFFETT\nSTANCE: No\n",
    "draft-resolution.md": "Go with option A.\n",
  });
  const r = await runSeat({ session: dir, seat: "buffett", round: 3, promptFile: promptFile(), dryRun: true });
  assert.deepEqual(r.meta.files, ["brief.md", "Your Round 2 card", "draft-resolution.md"]);
});

test("dry-run mirrors a run that cannot happen: no key and no CLI is code 2", async () => {
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile(), dryRun: true });
  assert.equal(r.code, 2);
  assert.match(r.meta.error, /no OPENAI_API_KEY and no DELEGATE_PY/);
});

// ------------------------------------------------------------------ the CLI transport

test("CLI run: argv, task file and clean-up", async () => {
  const log = cliEnv();
  const dir = session();
  const r = await runSeat({ session: dir, seat: "buffett", round: 1, promptFile: promptFile(), consult: false });
  assert.equal(r.code, 0);
  assert.match(r.card, /^SEAT: BUFFETT\nSTANCE: Yes\n/);
  assert.equal(r.meta.transport, "cli");
  assert.equal(r.meta.provider, "openai");
  assert.equal(r.meta.model, "gpt-6.1-sol");

  const calls = log();
  assert.equal(calls.length, 1);
  const { argv, task, mode, taskFile } = calls[0];
  assert.deepEqual(argv.slice(0, 2), ["run", "codex"]);
  assert.ok(argv.includes("--isolated"));
  assert.ok(argv.includes("--json"));
  assert.ok(argv.includes("--task-file"));
  assert.equal(argv[argv.indexOf("--timeout") + 1], "570");
  assert.equal(argv.includes("--allow-secrets"), false);
  assert.equal(argv.includes("--model"), false); // the seat has no cli_model
  assert.equal(argv.join(" ").includes("gpt-6.1-sol"), false); // never the API model id

  // One task file: the system text, a divider, then the user text.
  const { system, user } = buildSeatCall({ sessionDir: dir, seatKey: "buffett", round: 1, promptText: PROMPT });
  assert.equal(task, `${system}\n\n===== YOUR TASK =====\n${user}`);
  assert.ok(task.includes(BRIEF.trim()));
  assert.equal(mode, 0o600);
  assert.equal(path.basename(path.dirname(taskFile)).startsWith("rr-seat-"), true);
  assert.equal(fs.existsSync(path.dirname(taskFile)), false, "the temp folder is removed");
});

test("CLI run: --model is passed only from the seat's cli_model", async () => {
  const log = cliEnv();
  const r = await runSeat({ session: session(), seat: "sanchez", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  const { argv } = log()[0];
  assert.equal(argv[argv.indexOf("--model") + 1], "codex-fast");
  assert.equal(argv.join(" ").includes("gpt-6.1-sol"), false);
  // An API model given on the command line is not a CLI model either.
  const r2 = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile(), model: "gpt-9-api-only" });
  assert.equal(r2.code, 0);
  assert.equal(r2.meta.model, "gpt-9-api-only");
  assert.equal(log()[1].argv.join(" ").includes("gpt-9-api-only"), false);
  assert.equal(log()[1].argv.includes("--model"), false);
});

test("CLI run: a Google seat goes to agy", async () => {
  const log = cliEnv();
  const r = await runSeat({ session: session(), seat: "naval", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.deepEqual(log()[0].argv.slice(0, 2), ["run", "agy"]);
  assert.equal(log()[0].argv.join(" ").includes("gemini-3.8-flash"), false);
});

test("CLI run: usage comes from delegate.py when it reports it, and partial is unknown", async () => {
  cliEnv();
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.deepEqual(r.meta.usage, { input: 1200, output: 300, cacheRead: 0 });
  assert.equal(r.meta.partial, null, "a CLI reply cannot say whether it was cut off");
  cliEnv({ FAKE_DELEGATE_STDOUT: JSON.stringify({ status: "ok", reply: R1_CARD }) });
  const r2 = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r2.code, 0);
  assert.equal(r2.meta.usage, null, "no token counts reported is unknown, not zero");
});

test("delegate.py exit 2 is exit 2 at once, with its reason", async () => {
  const log = cliEnv({ FAKE_DELEGATE_EXIT: "2" });
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 2);
  assert.equal(r.card, null);
  assert.match(r.meta.error, /refused, 1 possible secret/);
  assert.equal(log().length, 1, "a refusal is not retried");
});

test("delegate.py exit 3 twice is exit 3 after one retry", async () => {
  const log = cliEnv({ FAKE_DELEGATE_EXIT: "3" });
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 3);
  assert.equal(r.card, null);
  assert.match(r.meta.error, /no answer within 570s/);
  assert.equal(log().length, 2);
  // Both attempts used a task file, and both were removed.
  for (const c of log()) assert.equal(fs.existsSync(path.dirname(c.taskFile)), false);
});

test("delegate.py exit 3 and then success is a card", async () => {
  const log = cliEnv({ FAKE_DELEGATE_EXIT: "3,0" });
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.match(r.card, /^SEAT: BUFFETT/);
  assert.equal(log().length, 2);
});

test("delegate.py that exits 0 without a JSON reply is a provider failure", async () => {
  const log = cliEnv({ FAKE_DELEGATE_STDOUT: "not json at all" });
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 3);
  assert.match(r.meta.error, /reply/i);
  assert.equal(log().length, 2);
  cliEnv({ FAKE_DELEGATE_STDOUT: JSON.stringify({ status: "ok", reply: "   " }) });
  assert.equal((await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() })).code, 3);
});

test("an interpreter that cannot start is exit 2, not a retry loop", async () => {
  cliEnv({ DELEGATE_PYTHON: path.join(repo.root, "no-such-python") });
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 2);
  assert.match(r.meta.error, /could not start/i);
});

// ------------------------------------------------------------------ the HTTP transport

test("HTTP run: the card, the meta and what was sent", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => openai(R1_CARD));
  const dir = session();
  const r = await runSeat({ session: dir, seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.card, R1_CARD);
  assert.equal(r.meta.transport, "http");
  assert.equal(r.meta.provider, "openai");
  assert.equal(r.meta.model, "gpt-6.1-sol");
  assert.equal(r.meta.partial, false);
  assert.deepEqual(r.meta.missing, []);
  assert.deepEqual(r.meta.usage, { input: 100, output: 40, cacheRead: 10 });
  assert.equal(typeof r.meta.ms, "number");
  assert.equal(mock.calls.length, 1);
  const { system, user } = buildSeatCall({ sessionDir: dir, seatKey: "buffett", round: 1, promptText: PROMPT });
  assert.equal(mock.calls[0].body.model, "gpt-6.1-sol");
  assert.equal(mock.calls[0].body.instructions, system);
  assert.equal(mock.calls[0].body.input, user);
  assert.equal(mock.calls[0].body.max_output_tokens, 4000);
  assert.ok(mock.calls[0].init.signal instanceof AbortSignal, "every HTTP call has a timeout signal");
});

test("HTTP run: a Google seat", async () => {
  use({ GEMINI_API_KEY: GKEY });
  mock = mockFetch(() => google(R1_CARD));
  const r = await runSeat({ session: session(), seat: "naval", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.provider, "google");
  assert.equal(r.meta.transport, "http");
  assert.equal(mock.calls[0].body.generationConfig.maxOutputTokens, 4000);
});

test("HTTP run: a reply cut off at the limit is marked partial, with the card still returned", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => openai("SEAT: BUFFETT\nSTANCE: Yes", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.partial, true);
  assert.equal(r.card, "SEAT: BUFFETT\nSTANCE: Yes");
});

test("HTTP 500 every time with a CLI available falls back to the CLI once", async () => {
  use({ OPENAI_API_KEY: KEY });
  const log = cliEnv();
  mock = mockFetch(() => ({ status: 500, text: "upstream is down" }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.transport, "cli");
  assert.match(r.card, /^SEAT: BUFFETT/);
  assert.equal(mock.calls.length, 6, "the provider client's own retries ran first");
  assert.equal(log().length, 1);
  assert.ok(r.meta.notes.some((n) => /CLI/.test(n) && /500/.test(n)), r.meta.notes.join("|"));
});

test("a non-retryable HTTP error (401) also falls back when a CLI is available", async () => {
  use({ OPENAI_API_KEY: KEY });
  const log = cliEnv();
  mock = mockFetch(() => ({ status: 401, text: "invalid api key" }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.transport, "cli");
  assert.equal(mock.calls.length, 1);
  assert.equal(log().length, 1);
});

test("HTTP failure and then a CLI that fails is exit 3 after a single CLI run", async () => {
  use({ OPENAI_API_KEY: KEY });
  const log = cliEnv({ FAKE_DELEGATE_EXIT: "3" });
  mock = mockFetch(() => ({ status: 500, text: "down" }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 3);
  assert.equal(log().length, 1, "the fall-back to the CLI is one attempt");
});

test("HTTP failure and then a CLI refusal is exit 2", async () => {
  use({ OPENAI_API_KEY: KEY });
  cliEnv({ FAKE_DELEGATE_EXIT: "2" });
  mock = mockFetch(() => ({ status: 500, text: "down" }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 2);
  assert.match(r.meta.error, /refused/);
});

test("with no CLI, a retryable HTTP failure is tried once more", async () => {
  use({ OPENAI_API_KEY: KEY });
  let n = 0;
  mock = mockFetch(() => (++n <= 6 ? { status: 503, text: "busy" } : openai(R1_CARD)));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.transport, "http");
  assert.equal(mock.calls.length, 7);
});

test("with no CLI, a retryable HTTP failure twice is exit 3", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => ({ status: 500, text: "down" }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 3);
  assert.equal(mock.calls.length, 12, "two rounds of the client's six attempts");
  assert.match(r.meta.error, /500/);
});

test("with no CLI, a non-retryable HTTP failure is exit 3 at once", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => ({ status: 401, text: "invalid api key" }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 3);
  assert.equal(mock.calls.length, 1);
  // A quota error is a billing problem: not retried either.
  mock.restore();
  mock = mockFetch(() => ({ status: 429, text: '{"error":{"code":"insufficient_quota"}}' }));
  assert.equal((await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() })).code, 3);
  assert.equal(mock.calls.length, 1);
});

test("every HTTP attempt gets a 300 second timeout, and a timeout is read as a failed call", async () => {
  use({ OPENAI_API_KEY: KEY });
  const original = AbortSignal.timeout;
  const asked = [];
  // An already-expired signal: the call fails the way a real timeout does, with no waiting.
  AbortSignal.timeout = (ms) => {
    asked.push(ms);
    return AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
  };
  try {
    mock = mockFetch(() => openai(R1_CARD));
    const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
    assert.equal(r.code, 3);
    assert.match(r.meta.error, /no answer within 300s/);
    assert.deepEqual(asked, [300000, 300000], "the retry gets its own timeout");
    assert.equal(mock.calls.length, 0);
    // With a CLI there, the timeout falls back like any other failure.
    cliEnv();
    const viaCli = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
    assert.equal(viaCli.code, 0);
    assert.equal(viaCli.meta.transport, "cli");
  } finally {
    AbortSignal.timeout = original;
  }
});

test("an error message never holds a key", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => ({ status: 403, text: `denied for ${KEY}` }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 3);
  assert.equal(JSON.stringify(r).includes(KEY), false);
  assert.match(r.meta.error, /\[redacted\]/);
});

// ------------------------------------------------------------------ meta.missing

const missingFor = async (round, text, files = {}) => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => openai(text));
  const r = await runSeat({ session: session(files), seat: "buffett", round, promptFile: promptFile() });
  mock.restore();
  mock = null;
  assert.equal(r.code, 0);
  return r.meta.missing;
};

test("meta.missing lists CONFIDENCE for a card without it", async () => {
  const card = R1_CARD.replace("CONFIDENCE: 4\n", "");
  assert.deepEqual(await missingFor(1, card), ["CONFIDENCE"]);
});

test("meta.missing names every required field the card lacks, in the round's order", async () => {
  assert.deepEqual(await missingFor(1, "SEAT: BUFFETT\nOPTION SCORES: A 8 · B 4"), ["STANCE", "THE CALL", "CONFIDENCE", "RUIN RISK", "DOOR"]);
  assert.deepEqual(await missingFor(1, "just some prose"), ["STANCE", "OPTION SCORES", "THE CALL", "CONFIDENCE", "RUIN RISK", "DOOR"]);
});

test("meta.missing: OPTION SCORES is missing unless every option has a score", async () => {
  assert.deepEqual(await missingFor(1, R1_CARD.replace("A 8 · B 4", "A 8")), ["OPTION SCORES"]);
  assert.deepEqual(await missingFor(1, R1_CARD.replace("OPTION SCORES: A 8 · B 4\n", "")), ["OPTION SCORES"]);
});

test("meta.missing: no known option ids means OPTION SCORES cannot be checked, so it is missing", async () => {
  const noOptions = { "council.json": { title: "t" } };
  assert.deepEqual(await missingFor(1, R1_CARD, noOptions), ["OPTION SCORES"]);
  const strings = { "council.json": { options: ["Raise now", "Wait"] } }; // plain strings take ids A and B
  assert.deepEqual(await missingFor(1, R1_CARD, strings), []);
});

test("meta.missing: round 2 and round 3 fields", async () => {
  const r2 = "STANCE: Conditional yes\nOPTION SCORES: A 7 · B 5\nCONFIDENCE: 3\nRUIN RISK: possible\nI DISAGREE MOST WITH: Bezos, on timing";
  assert.deepEqual(await missingFor(2, r2), []);
  assert.deepEqual(await missingFor(2, r2.replace(/\nI DISAGREE MOST WITH.*/, "")), ["I DISAGREE MOST WITH"]);
  const r3 = "VOTE: Endorse with amendment\nOPTION SCORES: A 7 · B 5\nFINAL SCORE: 7";
  assert.deepEqual(await missingFor(3, r3), []);
  assert.deepEqual(await missingFor(3, "OPTION SCORES: A 7 · B 5"), ["VOTE", "FINAL SCORE"]);
});

test("meta.missing: a markdown-formatted card still parses", async () => {
  const md = "**STANCE:** Yes\n**OPTION SCORES:** A 8 · B 4\n### THE CALL\nDo A first.\n**CONFIDENCE:** 4\n**RUIN RISK:** none\n**DOOR:** two-way";
  assert.deepEqual(await missingFor(1, md), []);
});

// ------------------------------------------------------------------ consult

test("consult with a human seat is code 2 and says so in one line", async () => {
  const r = await runSeat({ seat: "priya", consult: true, promptFile: promptFile("What would you do?") });
  assert.equal(r.code, 2);
  assert.equal(r.meta.error, "Priya is a person. Ask them directly.");
  const streams = io();
  const code = await main(["--consult", "--seat", "priya", "--prompt-file", promptFile("What would you do?")], streams);
  assert.equal(code, 2);
  assert.equal(streams.err(), "Priya is a person. Ask them directly.\n");
  assert.equal(streams.out(), "");
});

test("consult with an AI seat sends only the question and does not ask for a card", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => openai("Raise it, but slowly."));
  const r = await runSeat({ seat: "buffett", consult: true, promptFile: promptFile("Should I raise prices?\n") });
  assert.equal(r.code, 0);
  assert.equal(r.card, "Raise it, but slowly.");
  assert.equal(mock.calls[0].body.input, "Should I raise prices?");
  assert.equal(mock.calls[0].body.instructions, buildSeatCall({ seatKey: "buffett", promptText: "x", consult: true }).system);
  assert.equal("missing" in r.meta, false, "a consult has no required fields");
  assert.equal(r.meta.partial, false);
});

test("consult dry-run attaches no files", async () => {
  use({ OPENAI_API_KEY: KEY });
  const r = await runSeat({ seat: "buffett", consult: true, promptFile: promptFile("Q"), dryRun: true });
  assert.equal(r.code, 0);
  assert.deepEqual(r.meta.files, []);
});

// ------------------------------------------------------------------ seats that run_seat does not run

test("a person cannot be run", async () => {
  const r = await runSeat({ session: session(), seat: "priya", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 2);
  assert.match(r.meta.error, /Priya is a person/);
  assert.match(r.meta.error, /inbox/i);
});

test("an Anthropic seat with no API key is exit 2: use the subagent", async () => {
  const r = await runSeat({ session: session(), seat: "bezos", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 2);
  assert.match(r.meta.error, /use the council-bezos subagent/);
});

test("an Anthropic seat over http with no pinned model still gets one: SEAT_MODEL, then the default", async () => {
  use({ ANTHROPIC_API_KEY: "test-anthropic-key-9" }); // gitleaks:allow (fake test key)
  const dir = session();
  const dry = await runSeat({ session: dir, seat: "bezos", round: 1, promptFile: promptFile(), dryRun: true });
  assert.equal(dry.code, 0);
  assert.equal(dry.meta.transport, "http");
  assert.equal(dry.meta.model, "claude-sonnet-5-5");
  use({ SEAT_MODEL: "claude-opus-5-5" });
  const env = await runSeat({ session: dir, seat: "bezos", round: 1, promptFile: promptFile(), dryRun: true });
  assert.equal(env.meta.model, "claude-opus-5-5");
  // A pinned model still wins.
  const pinned = await runSeat({ session: dir, seat: "graham", round: 1, promptFile: promptFile(), dryRun: true });
  assert.equal(pinned.meta.model, "claude-opus-5-5");
  mock = mockFetch(() => ({
    json: { content: [{ type: "text", text: R1_CARD }], usage: { input_tokens: 90, output_tokens: 30 }, stop_reason: "end_turn" },
  }));
  delete process.env.SEAT_MODEL;
  const r = await runSeat({ session: dir, seat: "bezos", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.model, "claude-sonnet-5-5");
  assert.equal(mock.calls[0].body.model, "claude-sonnet-5-5");
});

test("an Anthropic seat with an API key runs over http", async () => {
  use({ ANTHROPIC_API_KEY: "test-anthropic-key-9" }); // gitleaks:allow (fake test key)
  mock = mockFetch(() => ({
    json: { content: [{ type: "text", text: R1_CARD }], usage: { input_tokens: 90, output_tokens: 30 }, stop_reason: "end_turn" },
  }));
  const r = await runSeat({ session: session(), seat: "bezos", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.provider, "anthropic");
  assert.equal(r.meta.transport, "http");
  assert.match(mock.calls[0].url, /api\.anthropic\.com/);
  assert.equal(mock.calls[0].body.max_tokens, 1400);
});

test("no key and no CLI is exit 2 before any call", async () => {
  mock = mockFetch(() => { throw new Error("no call expected"); });
  const r = await runSeat({ session: session(), seat: "naval", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 2);
  assert.match(r.meta.error, /no GEMINI_API_KEY and no DELEGATE_PY/);
  assert.equal(mock.calls.length, 0);
});

// ------------------------------------------------------------------ bad arguments

test("bad arguments are exit 2 and name the problem", async () => {
  const pf = promptFile();
  const dir = session();
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => { throw new Error("no call expected"); });
  const cases = [
    [{ session: dir, seat: "nobody", round: 1, promptFile: pf }, /Unknown seat: nobody/],
    [{ session: dir, seat: "buffett", round: 4, promptFile: pf }, /round/i],
    [{ session: dir, seat: "buffett", round: "x", promptFile: pf }, /round/i],
    [{ seat: "buffett", round: 1, promptFile: pf }, /session/i],
    [{ session: path.join(repo.root, "sessions", "no-such"), seat: "buffett", round: 1, promptFile: pf }, /session/i],
    [{ session: dir, seat: "buffett", round: 1 }, /prompt/i],
    [{ session: dir, seat: "buffett", round: 1, promptFile: path.join(repo.root, "no-such-prompt.md") }, /prompt/i],
    [{ session: dir, seat: "buffett", round: 1, promptFile: pf, provider: "mistral" }, /provider/i],
    [{ session: session({ "council.json": "{ not json" }), seat: "buffett", round: 1, promptFile: pf }, /council\.json/],
  ];
  for (const [args, pattern] of cases) {
    const r = await runSeat(args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.meta.error, pattern, JSON.stringify(args));
  }
  assert.equal(mock.calls.length, 0);
});

test("an empty prompt file is exit 2", async () => {
  use({ OPENAI_API_KEY: KEY });
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile("  \n") });
  assert.equal(r.code, 2);
  assert.match(r.meta.error, /prompt/i);
});

// ------------------------------------------------------------------ main(): what the Chair sees

test("main: the card is stdout and the last stderr line is RUN_SEAT, with no key anywhere", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => openai(R1_CARD));
  const streams = io();
  const code = await main(["--session", session(), "--seat", "buffett", "--round", "1", "--prompt-file", promptFile()], streams);
  assert.equal(code, 0);
  assert.equal(streams.out(), R1_CARD + "\n");
  const lines = streams.err().trimEnd().split("\n");
  const last = lines[lines.length - 1];
  assert.ok(last.startsWith("RUN_SEAT "), last);
  const meta = JSON.parse(last.slice("RUN_SEAT ".length));
  assert.deepEqual(Object.keys(meta), ["seat", "provider", "model", "transport", "partial", "missing", "ms", "usage"]);
  assert.equal(meta.seat, "buffett");
  assert.equal(meta.transport, "http");
  assert.deepEqual(meta.missing, []);
  assert.equal((streams.out() + streams.err()).includes(KEY), false);
});

test("main: a fall-back is announced on stderr before the RUN_SEAT line", async () => {
  use({ OPENAI_API_KEY: KEY });
  cliEnv();
  mock = mockFetch(() => ({ status: 500, text: "down" }));
  const streams = io();
  const code = await main(["--session", session(), "--seat", "buffett", "--round", "1", "--prompt-file", promptFile()], streams);
  assert.equal(code, 0);
  const lines = streams.err().trimEnd().split("\n");
  assert.ok(lines.length >= 2);
  assert.match(lines[0], /CLI/);
  assert.equal(JSON.parse(lines[lines.length - 1].slice("RUN_SEAT ".length)).transport, "cli");
  assert.equal(streams.err().includes(KEY), false);
});

test("main: a consult RUN_SEAT line has no missing field", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => openai("Raise it."));
  const streams = io();
  const code = await main(["--consult", "--seat", "buffett", "--prompt-file", promptFile("Q")], streams);
  assert.equal(code, 0);
  assert.equal(streams.out(), "Raise it.\n");
  const meta = JSON.parse(streams.err().trimEnd().split("\n").pop().slice("RUN_SEAT ".length));
  assert.equal("missing" in meta, false);
});

test("main: a failed run prints its reason and no RUN_SEAT line", async () => {
  cliEnv({ FAKE_DELEGATE_EXIT: "2" });
  const streams = io();
  const code = await main(["--session", session(), "--seat", "buffett", "--round", "1", "--prompt-file", promptFile()], streams);
  assert.equal(code, 2);
  assert.equal(streams.out(), "");
  assert.match(streams.err(), /refused, 1 possible secret/);
  assert.doesNotMatch(streams.err(), /RUN_SEAT/);
});

test("main: --dry-run prints the JSON and nothing else", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => { throw new Error("no call expected"); });
  const streams = io();
  const code = await main(["--session", session(), "--seat", "buffett", "--round", "2", "--prompt-file", promptFile(), "--dry-run"], streams);
  assert.equal(code, 0);
  const out = JSON.parse(streams.out());
  assert.deepEqual(Object.keys(out), ["seat", "provider", "model", "transport", "agentModel", "systemBytes", "userBytes", "files"]);
  assert.deepEqual(out.files, ["brief.md", "round-1.md", "cruxes.json"]);
  assert.equal(mock.calls.length, 0);
});

test("main: --plan prints the planSeats JSON", async () => {
  use({ DELEGATE_PY: FAKE });
  const streams = io();
  const code = await main(["--plan", "--seats", "bezos, buffett,priya"], streams);
  assert.equal(code, 0);
  const plan = JSON.parse(streams.out());
  assert.deepEqual(Object.keys(plan), ["runners", "cannotRun", "recipients", "keys"]);
  assert.deepEqual(plan.keys, { openai: false, google: false, delegate: true });
  assert.equal(plan.recipients, "OpenAI (Buffett, via Codex CLI) and Priya on this screen");
  // A seat that cannot run is still exit 0: the Chair reads cannotRun.
  delete process.env.DELEGATE_PY;
  const again = io();
  assert.equal(await main(["--plan", "--seats", "buffett"], again), 0);
  assert.equal(JSON.parse(again.out()).cannotRun.length, 1);
});

test("main: --plan reads the session's runners", async () => {
  const dir = session({ "council.json": { options: OPTIONS, runners: { buffett: { provider: "anthropic", model: "claude-opus-5-5" } } } });
  const streams = io();
  assert.equal(await main(["--plan", "--seats", "buffett", "--session", dir], streams), 0);
  assert.equal(JSON.parse(streams.out()).runners.buffett.provider, "anthropic");
});

test("main: --plan with a --session folder that has no council.json is exit 2, with nothing on stdout", async () => {
  const dir = makeSession(repo.root, `s-${++sessionSeq}`, { "brief.md": BRIEF });
  const streams = io();
  assert.equal(await main(["--plan", "--seats", "buffett", "--session", dir], streams), 2);
  assert.equal(streams.out(), "");
  assert.equal(streams.err(), `no council.json in ${dir}\n`);
  // The same for a folder that does not exist.
  const gone = io();
  assert.equal(await main(["--plan", "--seats", "buffett", "--session", path.join(repo.root, "sessions", "not-there")], gone), 2);
  assert.equal(gone.out(), "");
  assert.match(gone.err(), /^no council\.json in .*not-there\n$/);
});

test("a seat run with a --session folder that has no council.json is exit 2, before any call", async () => {
  use({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => { throw new Error("no call expected"); });
  const dir = makeSession(repo.root, `s-${++sessionSeq}`, { "brief.md": BRIEF });
  const r = await runSeat({ session: dir, seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 2);
  assert.equal(r.meta.error, `no council.json in ${dir}`);
  assert.equal(mock.calls.length, 0);
  const streams = io();
  assert.equal(await main(["--session", dir, "--seat", "buffett", "--round", "1", "--prompt-file", promptFile(), "--dry-run"], streams), 2);
  assert.equal(streams.out(), "");
  assert.equal(streams.err(), `no council.json in ${dir}\n`);
});

test("main: bad command lines are exit 2 with a message and no stack trace", async () => {
  const pf = promptFile();
  const cases = [
    [],
    ["--bogus"],
    ["--plan"],
    ["--plan", "--seats", ""],
    ["--seat", "buffett"],
    ["--seat", "buffett", "--session", "x"],
    ["--seat", "buffett", "--session", "x", "--round", "1"],
    ["--seat", "buffett", "--session", "x", "--round", "9", "--prompt-file", pf],
    ["--seat", "buffett", "--session", "x", "--round", "1.5", "--prompt-file", pf],
    ["--consult", "--prompt-file", pf],
    ["--consult", "--seat", "buffett"],
    ["--plan", "--consult", "--seats", "bezos"],
  ];
  for (const argv of cases) {
    const streams = io();
    const code = await main(argv, streams);
    assert.equal(code, 2, JSON.stringify(argv));
    assert.equal(streams.out(), "", JSON.stringify(argv));
    assert.ok(streams.err().trim().length > 0, JSON.stringify(argv));
    assert.doesNotMatch(streams.err(), /\n\s+at /, JSON.stringify(argv));
  }
});

// ------------------------------------------------------------------ the script as a process

const childEnv_ = (extra = {}) => {
  const e = { ...process.env, ROAST_ROOT: repo.root, ...extra };
  for (const k of ENV_KEYS) if (!(k in extra)) delete e[k];
  return e;
};
const node = (args, extra = {}, cwd) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: childEnv_(extra), cwd, encoding: "utf8", timeout: 60000 });

test("importing the script runs nothing", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`], {
    env: childEnv_(), encoding: "utf8", timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("as a process: --plan, and the exit code of a bad argument", () => {
  const ok = node(["--plan", "--seats", "bezos,buffett,priya"], { DELEGATE_PY: FAKE });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).recipients, "OpenAI (Buffett, via Codex CLI) and Priya on this screen");
  const bad = node(["--nonsense"]);
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, "");
});

test("as a process: a CLI run with a session path relative to the current folder", () => {
  makeSession(repo.root, "rel-session", { "council.json": { options: OPTIONS }, "brief.md": BRIEF });
  const log = path.join(repo.root, "proc.log");
  const r = node(["--session", "rel-session", "--seat", "buffett", "--round", "1", "--prompt-file", promptFile()], {
    DELEGATE_PY: FAKE, DELEGATE_PYTHON: process.execPath, FAKE_DELEGATE_LOG: log,
  }, path.join(repo.root, "sessions"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SEAT: BUFFETT\nSTANCE: Yes\n/);
  const last = r.stderr.trimEnd().split("\n").pop();
  assert.ok(last.startsWith("RUN_SEAT "), last);
  const meta = JSON.parse(last.slice("RUN_SEAT ".length));
  assert.equal(meta.transport, "cli");
  assert.deepEqual(meta.missing, []);
  assert.ok(JSON.parse(fs.readFileSync(log, "utf8").trim()).task.includes(BRIEF.trim()), "the brief reached the task file");
});

test("as a process: DELEGATE_PY and DELEGATE_PYTHON are read from .env", () => {
  const other = makeRepo({ seats: [{ key: "buffett", name: "Warren Buffett", short: "Buffett", slug: "warren-buffett", provider: "openai" }] });
  try {
    fs.writeFileSync(path.join(other.root, ".env"), `DELEGATE_PY=${FAKE}\nDELEGATE_PYTHON=${process.execPath}\n`);
    makeSession(other.root, "env-session", { "council.json": { options: OPTIONS }, "brief.md": BRIEF });
    const r = spawnSync(process.execPath, [SCRIPT, "--session", path.join(other.root, "sessions", "env-session"), "--seat", "buffett", "--round", "1", "--prompt-file", promptFile()], {
      env: childEnv_({ ROAST_ROOT: other.root }), encoding: "utf8", timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stderr.trimEnd().split("\n").pop().slice("RUN_SEAT ".length)).transport, "cli");
  } finally {
    other.cleanup();
  }
});

test("as a process: the exit codes of delegate.py come through", () => {
  const dir = session();
  const base = ["--session", dir, "--seat", "buffett", "--round", "1", "--prompt-file", promptFile()];
  const env = (code) => ({ DELEGATE_PY: FAKE, DELEGATE_PYTHON: process.execPath, FAKE_DELEGATE_EXIT: code });
  assert.equal(node(base, env("0")).status, 0);
  const refused = node(base, env("2"));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /possible secret/);
  assert.equal(node(base, env("3")).status, 3);
});

// ------------------------------------------------------------------ the CLI child gets no secrets

const SECRETS = {
  OPENAI_API_KEY: KEY,
  GEMINI_API_KEY: GKEY,
  ANTHROPIC_API_KEY: "test-anthropic-key-5d20", // gitleaks:allow (fake test key)
  KIE_AI_API_KEY: "test-kie-key-83ac",
  MY_SERVICE_TOKEN: "test-token-19ef",
  DB_PASSWORD: "test-password-77b1",
};
const KEPT = { CODEX_HOME: path.join(repo.root, "codex-home") };

test("childEnv drops every key, token, secret, password and credential, and keeps the rest", () => {
  const source = {
    PATH: "/usr/bin", HOME: "/home/me", CODEX_HOME: "/home/me/.codex", DELEGATE_PY: "/x/delegate.py", DELEGATE_PYTHON: "python3", LANG: "C",
    OPENAI_API_KEY: "a", GEMINI_API_KEY: "b", ANTHROPIC_API_KEY: "c", KIE_AI_API_KEY: "d",
    SOME_APIKEY: "e", some_api_key: "f", GITHUB_TOKEN: "g", CLIENT_SECRET: "h", DB_PASSWORD: "i", AWS_CREDENTIALS: "j", GCP_CREDENTIAL: "k",
    TOKEN_COUNT: "kept: the name does not end in a secret word", KEYBOARD: "kept",
  };
  const kept = childEnv(source);
  assert.deepEqual(Object.keys(kept).sort(), ["CODEX_HOME", "DELEGATE_PY", "DELEGATE_PYTHON", "HOME", "KEYBOARD", "LANG", "PATH", "TOKEN_COUNT"]);
  assert.equal(kept.CODEX_HOME, "/home/me/.codex");
  assert.equal("OPENAI_API_KEY" in source, true, "the source object is not changed");
  assert.deepEqual(Object.keys(childEnv({})), []);
});

test("CLI run: the child process gets none of the API keys or secrets from the shell", async () => {
  // Google seat, no Gemini key: it goes to the CLI while the other keys are exported.
  const log = cliEnv({ ...SECRETS, ...KEPT, GEMINI_API_KEY: "" });
  const r = await runSeat({ session: session(), seat: "naval", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.transport, "cli");
  assert.equal(log().length, 1);
  assert.deepEqual(log()[0].secretEnvNames, []);
  for (const name of ["PATH", "CODEX_HOME", "DELEGATE_PY", "DELEGATE_PYTHON"]) assert.ok(log()[0].keptEnvNames.includes(name), name);
  // OpenAI seat, no OpenAI key.
  const log2 = cliEnv({ ...SECRETS, ...KEPT, OPENAI_API_KEY: "" });
  const r2 = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r2.meta.transport, "cli");
  assert.deepEqual(log2()[0].secretEnvNames, []);
  // The parent still has them: only the child's copy was scrubbed.
  assert.equal(process.env.GEMINI_API_KEY, SECRETS.GEMINI_API_KEY);
});

test("HTTP to CLI fall-back: the child process gets none of the API keys or secrets", async () => {
  const log = cliEnv({ ...SECRETS, ...KEPT });
  mock = mockFetch(() => ({ status: 500, text: "down" }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.equal(r.meta.transport, "cli");
  assert.equal(mock.calls[0].init.headers.authorization, `Bearer ${KEY}`, "the API call itself still used the key");
  assert.deepEqual(log()[0].secretEnvNames, []);
  assert.equal(JSON.stringify(log()).includes(KEY), false);
});

// ------------------------------------------------------------------ an outer limit on the CLI child

test("the default outer limit is 30 seconds past delegate.py's own 570", () => {
  assert.deepEqual(cliLimits(), { timeoutMs: 600000, graceMs: 1000 });
  setCliLimits({ timeoutMs: 50, graceMs: 5 });
  assert.deepEqual(cliLimits(), { timeoutMs: 50, graceMs: 5 });
  setCliLimits();
  assert.deepEqual(cliLimits(), { timeoutMs: 600000, graceMs: 1000 });
});

test("a delegate.py that never answers is killed at the outer limit: exit 3, one retry", async () => {
  const log = cliEnv({ FAKE_DELEGATE_EXIT: "sleep" });
  setCliLimits({ timeoutMs: 400, graceMs: 100 });
  const began = Date.now();
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 3);
  assert.equal(r.card, null);
  assert.match(r.meta.error, /did not finish within 0\.4s and was killed/);
  assert.equal(log().length, 2, "the retry is bounded: two attempts, no more");
  assert.ok(Date.now() - began < 15000, "two kills at 0.4 s, not two waits of 60 s");
  for (const c of log()) {
    assert.throws(() => process.kill(c.pid, 0), { code: "ESRCH" }, "the child is gone");
    assert.equal(fs.existsSync(path.dirname(c.taskFile)), false, "the temp folder is removed");
  }
  assert.match(r.meta.notes.join("\n"), /Trying once more/);
});

test("a hang on the first attempt and an answer on the retry is a card", async () => {
  const log = cliEnv({ FAKE_DELEGATE_EXIT: "sleep,0" });
  setCliLimits({ timeoutMs: 400, graceMs: 100 });
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0);
  assert.match(r.card, /^SEAT: BUFFETT/);
  assert.equal(log().length, 2);
});

test("HTTP failure and then a CLI that hangs is exit 3 after a single CLI attempt", async () => {
  use({ OPENAI_API_KEY: KEY });
  const log = cliEnv({ FAKE_DELEGATE_EXIT: "sleep" });
  setCliLimits({ timeoutMs: 400, graceMs: 100 });
  mock = mockFetch(() => ({ status: 500, text: "down" }));
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 3);
  assert.equal(log().length, 1);
  assert.match(r.meta.error, /did not finish/);
});

test("a grandchild that keeps the pipes open does not hold the call up", async () => {
  const log = cliEnv({ FAKE_DELEGATE_EXIT: "orphan" });
  setCliLimits({ timeoutMs: 20000, graceMs: 100 });
  const r = await runSeat({ session: session(), seat: "buffett", round: 1, promptFile: promptFile() });
  assert.equal(r.code, 0, r.meta.error);
  assert.match(r.card, /^SEAT: BUFFETT/);
  assert.equal(log().length, 1);
  assert.ok(r.meta.ms < 2500, `waited ${r.meta.ms} ms: the grandchild keeps the pipes for 3000`);
});

// ------------------------------------------------------------------ cli_model must not look like an option

test("a cli_model that starts with '-' is exit 2 with one message, before any call", async () => {
  use({ OPENAI_API_KEY: KEY });
  const log = cliEnv({ OPENAI_API_KEY: KEY });
  mock = mockFetch(() => { throw new Error("no call expected"); });
  const want = "cli_model for dash must not start with '-'";
  for (const dryRun of [false, true]) {
    const r = await runSeat({ session: session(), seat: "dash", round: 1, promptFile: promptFile(), dryRun });
    assert.equal(r.code, 2);
    assert.equal(r.meta.error, want);
  }
  const c = await runSeat({ seat: "dash", consult: true, promptFile: promptFile("Q") });
  assert.equal(c.code, 2);
  assert.equal(c.meta.error, want);
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(log(), []);
  const streams = io();
  assert.equal(await main(["--session", session(), "--seat", "dash", "--round", "1", "--prompt-file", promptFile()], streams), 2);
  assert.equal(streams.err(), `${want}\n`);
});

test("a cli_model that starts with '-' also keeps the seat out of the plan", () => {
  use({ OPENAI_API_KEY: KEY });
  const r = resolveSeat({ seat: "dash" });
  assert.equal(r.transport, null);
  assert.equal(r.reason, "cli_model for dash must not start with '-'");
  const plan = planSeats({ seats: ["dash", "buffett"] });
  assert.deepEqual(plan.cannotRun, [{ seat: "dash", reason: "cli_model for dash must not start with '-'" }]);
  assert.deepEqual(Object.keys(plan.runners), ["buffett"]);
  assert.equal(plan.recipients, "OpenAI (Buffett, via API)");
});

// ------------------------------------------------------------------ an unexpected failure is exit 3, never 1

const ROSTER_FILE = path.join(repo.root, ".claude", "skills", "roast-room", "roster.json");

test("main: a roster that stops loading is exit 3 with one redacted line, not a stack trace", async () => {
  const original = fs.readFileSync(ROSTER_FILE, "utf8");
  try {
    fs.writeFileSync(ROSTER_FILE, "{ this is not json");
    for (const argv of [["--plan", "--seats", "bezos"], ["--seat", "buffett", "--session", session(), "--round", "1", "--prompt-file", promptFile()]]) {
      const streams = io();
      const code = await main(argv, streams);
      assert.equal(code, 3, JSON.stringify(argv));
      assert.equal(streams.out(), "");
      assert.match(streams.err(), /^run_seat: [^\n]+\n$/, "one line");
      assert.doesNotMatch(streams.err(), /\n\s+at /);
    }
  } finally {
    fs.writeFileSync(ROSTER_FILE, original); // a new mtime, so the next load re-reads it
  }
  assert.equal(planSeats({ seats: ["bezos"] }).runners.bezos.provider, "anthropic");
});

const badRoot = (roster) => {
  const other = makeRepo({ seats: [{ key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos" }] });
  if (roster === null) fs.rmSync(path.join(other.root, ".claude", "skills", "roast-room", "roster.json"));
  else fs.writeFileSync(path.join(other.root, ".claude", "skills", "roast-room", "roster.json"), roster);
  return other;
};

test("as a process: a malformed or missing roster is exit 3 and one line on stderr", () => {
  for (const [roster, why] of [["{ this is not json", /JSON/], [null, /roster not found/]]) {
    const other = badRoot(roster);
    try {
      const r = spawnSync(process.execPath, [SCRIPT, "--plan", "--seats", "bezos"], { env: childEnv_({ ROAST_ROOT: other.root }), encoding: "utf8", timeout: 60000 });
      assert.equal(r.status, 3, r.stderr);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^run_seat: [^\n]+\n$/);
      assert.match(r.stderr, why);
      assert.doesNotMatch(r.stderr, /\n\s+at |node:internal/);
    } finally {
      other.cleanup();
    }
  }
});

test("as a process: that one line never holds a key", () => {
  // The "roster not found" message names the folder, so a key in the folder name must come out redacted.
  const r = spawnSync(process.execPath, [SCRIPT, "--plan", "--seats", "bezos"], {
    env: childEnv_({ ROAST_ROOT: path.join(repo.root, KEY), OPENAI_API_KEY: KEY }), encoding: "utf8", timeout: 60000,
  });
  assert.equal(r.status, 3);
  assert.equal(r.stderr.includes(KEY), false);
  assert.match(r.stderr, /\[redacted\]/);
});

test("importing the script when the roster cannot load still throws, so an importer sees the failure", () => {
  const other = badRoot("{ this is not json");
  try {
    const url = JSON.stringify(pathToFileURL(SCRIPT).href);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `try { await import(${url}); console.log("loaded"); } catch (e) { console.log("threw"); }`], {
      env: childEnv_({ ROAST_ROOT: other.root }), encoding: "utf8", timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "threw");
  } finally {
    other.cleanup();
  }
});

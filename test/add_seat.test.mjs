import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeRepo } from "./helpers.mjs";

// Spawns add_seat.mjs against a disposable repo root (ROAST_ROOT). The real roster is never touched.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SCRIPT = path.join(REPO, ".claude", "skills", "newroaster", "scripts", "add_seat.mjs");
const REAL_ROSTER = path.join(REPO, ".claude", "skills", "roast-room", "roster.json");
const PALETTE = ["#22b8a0", "#e05d9b", "#c9a227", "#5b7cfa", "#ef7d32", "#2fa4d6", "#a3be3c", "#b06ad9", "#d6543f", "#3fb37f"];
// The script wants seven brain files. The shared helper writes five, so add the other two.
const EXTRA_BRAIN_FILES = ["stories.md", "sources.md"];

// Whatever happens, the real roster must come out of this file exactly as it went in.
const realRosterBefore = fs.readFileSync(REAL_ROSTER, "utf8");
const repos = [];
after(() => {
  // Read the real roster before cleanup, and assert in finally, so a throwing cleanup cannot skip the check.
  const realRosterAfter = fs.readFileSync(REAL_ROSTER, "utf8");
  try {
    repos.forEach((r) => r.cleanup());
  } finally {
    assert.equal(realRosterAfter, realRosterBefore, "add_seat.test.mjs changed the real roster.json");
  }
});

function fixture(seats) {
  const repo = makeRepo({
    seats: seats || [
      { key: "bezos", name: "Jeff Bezos", short: "Bezos", initials: "JB", slug: "jeff-bezos", color: "#e8a33d" },
      { key: "graham", name: "Paul Graham", short: "Graham", initials: "PG", slug: "paul-graham", color: "#f06b3f" },
    ],
  });
  repos.push(repo);
  for (const s of JSON.parse(fs.readFileSync(rosterPath(repo), "utf8")).seats) {
    if (!s.slug) continue;
    for (const f of EXTRA_BRAIN_FILES) fs.writeFileSync(path.join(repo.root, ".claude", "skills", "roast-room", "brains", s.slug, f), "# test\n");
  }
  return repo;
}
const rosterPath = (repo) => path.join(repo.root, ".claude", "skills", "roast-room", "roster.json");
const readRoster = (repo) => JSON.parse(fs.readFileSync(rosterPath(repo), "utf8"));
const rawRoster = (repo) => fs.readFileSync(rosterPath(repo), "utf8");
const seatOf = (repo, key) => readRoster(repo).seats.find((s) => s.key === key);

// Preflight: never spawn the script unless the root is a disposable rr-* folder made directly in the
// OS temp dir. An earlier version of this file wrote to the real roster; this makes that impossible.
function assertDisposableRoot(root) {
  const refuse = (why) => { throw new Error(`refusing to spawn add_seat.mjs: ${why} (root: ${JSON.stringify(root)})`); };
  if (typeof root !== "string" || root === "") refuse("root is empty");
  let real;
  try { real = fs.realpathSync(root); } catch { refuse("root does not exist"); }
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir())) refuse("root is not directly inside the OS temp dir");
  if (!path.basename(real).startsWith("rr-")) refuse("root name does not start with rr-");
}

function run(repo, args) {
  assertDisposableRoot(repo?.root);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, ROAST_ROOT: repo.root },
    encoding: "utf8",
    timeout: 20000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The flags a seat needs on every run today, for an existing fixture seat.
const BEZOS = [
  "--key", "bezos", "--name", "Jeff Bezos", "--short", "Bezos", "--slug", "jeff-bezos",
  "--pillar", "Pillar of bezos", "--question", "What does Bezos want to know?", "--dimension", "Dimension of bezos",
];
const PRIYA = ["--key", "priya", "--name", "Priya Rao", "--short", "Priya", "--pillar", "Operations", "--question", "Can we run this?"];

test("--human adds a person: provider human, slug null, initials from the name, a palette colour", () => {
  const repo = fixture();
  const r = run(repo, [...PRIYA, "--human"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seatOf(repo, "priya"), {
    key: "priya", name: "Priya Rao", short: "Priya", initials: "PR", slug: null,
    pillar: "Operations", question: "Can we run this?", dimension: "Operations", // dimension defaults to the pillar
    color: "#22b8a0", provider: "human",
  });
  assert.ok(PALETTE.includes(seatOf(repo, "priya").color));
  assert.match(r.out, /Added Priya Rao \(priya\)/);
  // ROAST_ROOT kept the run off the real repo, and no agent file or brain was made for the person.
  assert.equal(fs.readFileSync(REAL_ROSTER, "utf8"), realRosterBefore);
  assert.equal(fs.existsSync(path.join(repo.root, ".claude", "agents", "council-priya.md")), false);
  assert.equal(fs.existsSync(path.join(repo.root, ".claude", "skills", "roast-room", "brains", "priya")), false);
});

test("--provider human is the same as --human, and --dimension is kept when given", () => {
  const a = fixture();
  const b = fixture();
  assert.equal(run(a, [...PRIYA, "--human"]).code, 0);
  assert.equal(run(b, [...PRIYA, "--provider", "human"]).code, 0);
  assert.deepEqual(seatOf(b, "priya"), seatOf(a, "priya"));
  const c = fixture();
  assert.equal(run(c, [...PRIYA, "--human", "--dimension", "Run readiness"]).code, 0);
  assert.equal(seatOf(c, "priya").dimension, "Run readiness");
});

test("a second person does not clash on the null slug, and takes the next palette colour", () => {
  const repo = fixture();
  assert.equal(run(repo, [...PRIYA, "--human"]).code, 0);
  const r = run(repo, ["--key", "arjun", "--name", "Arjun Mehta", "--short", "Arjun", "--pillar", "Sales", "--question", "Will it sell?", "--human"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(seatOf(repo, "arjun").slug, null);
  assert.equal(seatOf(repo, "arjun").initials, "AM");
  assert.equal(seatOf(repo, "arjun").color, "#e05d9b");
});

test("a person needs key, name, short, pillar and question, and takes no slug, model or cli-model", () => {
  for (const missing of ["key", "name", "short", "pillar", "question"]) {
    const repo = fixture();
    const args = [];
    for (let i = 0; i < PRIYA.length; i += 2) if (PRIYA[i] !== `--${missing}`) args.push(PRIYA[i], PRIYA[i + 1]);
    const r = run(repo, [...args, "--human"]);
    assert.equal(r.code, 1, `missing --${missing}`);
    assert.match(r.err, new RegExp(`add_seat: --${missing} is required`));
  }
  for (const extra of [["--slug", "priya-rao"], ["--model", "gpt-6.1-sol"], ["--cli-model", "sonnet"]]) {
    const repo = fixture();
    const before = rawRoster(repo);
    const r = run(repo, [...PRIYA, "--human", ...extra]);
    assert.equal(r.code, 1, extra[0]);
    assert.match(r.err, /^add_seat: a human seat takes no --slug, --model or --cli-model/);
    assert.equal(rawRoster(repo), before);
  }
});

test("--human with a different --provider is refused", () => {
  const repo = fixture();
  const before = rawRoster(repo);
  const r = run(repo, [...PRIYA, "--human", "--provider", "openai"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^add_seat: --human cannot be combined with --provider openai/);
  assert.equal(rawRoster(repo), before);
});

test("a person can join the default board", () => {
  const repo = fixture();
  assert.equal(run(repo, [...PRIYA, "--human", "--default"]).code, 0);
  assert.deepEqual(readRoster(repo).default, ["bezos", "graham", "priya"]);
});

test("--provider openai --model gpt-6.1-sol on an existing seat keeps its other fields", () => {
  const repo = fixture();
  const before = seatOf(repo, "bezos");
  const r = run(repo, [...BEZOS, "--provider", "openai", "--model", "gpt-6.1-sol"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Updated Jeff Bezos \(bezos\)/);
  assert.deepEqual(seatOf(repo, "bezos"), { ...before, provider: "openai", model: "gpt-6.1-sol" });
  assert.equal("cli_model" in seatOf(repo, "bezos"), false);
  // The other seat and the board are untouched.
  assert.equal(seatOf(repo, "graham").color, "#f06b3f");
  assert.deepEqual(readRoster(repo).default, ["bezos", "graham"]);
});

test("an update keeps the colour and the initials that were not passed", () => {
  const repo = fixture();
  const r = run(repo, BEZOS); // no --color, no --initials
  assert.equal(r.code, 0, r.err);
  assert.equal(seatOf(repo, "bezos").color, "#e8a33d");
  assert.equal(seatOf(repo, "bezos").initials, "JB");
  // A colour or initials that are passed win.
  assert.equal(run(repo, [...BEZOS, "--color", "#112233", "--initials", "JPB"]).code, 0);
  assert.equal(seatOf(repo, "bezos").color, "#112233");
  assert.equal(seatOf(repo, "bezos").initials, "JPB");
});

test("re-running a seat without --provider keeps openai, model and cli_model", () => {
  const repo = fixture();
  assert.equal(run(repo, [...BEZOS, "--provider", "openai", "--model", "gpt-6.1-sol"]).code, 0);
  assert.equal(run(repo, BEZOS).code, 0);
  assert.equal(seatOf(repo, "bezos").provider, "openai");
  assert.equal(seatOf(repo, "bezos").model, "gpt-6.1-sol");
  // Passing only --cli-model adds it and keeps the other two.
  assert.equal(run(repo, [...BEZOS, "--cli-model", "gpt-6.1-sol-cli"]).code, 0);
  const s = seatOf(repo, "bezos");
  assert.deepEqual([s.provider, s.model, s.cli_model], ["openai", "gpt-6.1-sol", "gpt-6.1-sol-cli"]);
  // A new --model replaces only the model.
  assert.equal(run(repo, [...BEZOS, "--model", "gpt-6.2"]).code, 0);
  const t = seatOf(repo, "bezos");
  assert.deepEqual([t.provider, t.model, t.cli_model], ["openai", "gpt-6.2", "gpt-6.1-sol-cli"]);
  // Passing the same provider again keeps both fields.
  assert.equal(run(repo, [...BEZOS, "--provider", "openai"]).code, 0);
  const same = seatOf(repo, "bezos");
  assert.deepEqual([same.provider, same.model, same.cli_model], ["openai", "gpt-6.2", "gpt-6.1-sol-cli"]);
  // A different provider with no new model drops both: model ids belong to one provider.
  assert.equal(run(repo, [...BEZOS, "--provider", "google"]).code, 0);
  const moved = seatOf(repo, "bezos");
  assert.equal(moved.provider, "google");
  assert.equal("model" in moved, false);
  assert.equal("cli_model" in moved, false);
});

test("a provider change with a new --model keeps only the new model; the stored cli_model is dropped", () => {
  const repo = fixture();
  assert.equal(run(repo, [...BEZOS, "--provider", "openai", "--model", "gpt-6.1-sol", "--cli-model", "gpt-cli"]).code, 0);
  assert.equal(run(repo, [...BEZOS, "--provider", "google", "--model", "gemini-3.8-flash"]).code, 0);
  const s = seatOf(repo, "bezos");
  assert.deepEqual([s.provider, s.model], ["google", "gemini-3.8-flash"]);
  assert.equal("cli_model" in s, false);
  // And the other way: a new --cli-model alone keeps only the new cli_model.
  assert.equal(run(repo, [...BEZOS, "--provider", "openai", "--cli-model", "gpt-cli-2"]).code, 0);
  const t = seatOf(repo, "bezos");
  assert.deepEqual([t.provider, t.cli_model], ["openai", "gpt-cli-2"]);
  assert.equal("model" in t, false);
});

test("a seat with no provider counts as anthropic when the provider changes", () => {
  const seats = [{ key: "bezos", name: "Jeff Bezos", short: "Bezos", initials: "JB", slug: "jeff-bezos", color: "#e8a33d", model: "claude-sonnet-5-5", cli_model: "sonnet" }];
  // Moving to openai drops the stored Claude model and cli_model.
  const moved = fixture(seats);
  assert.equal(run(moved, [...BEZOS, "--provider", "openai"]).code, 0);
  const s = seatOf(moved, "bezos");
  assert.equal(s.provider, "openai");
  assert.equal("model" in s, false);
  assert.equal("cli_model" in s, false);
  // Passing anthropic is not a change, so both fields stay (and anthropic is now written).
  const same = fixture(seats);
  assert.equal(run(same, [...BEZOS, "--provider", "anthropic"]).code, 0);
  const t = seatOf(same, "bezos");
  assert.deepEqual([t.provider, t.model, t.cli_model], ["anthropic", "claude-sonnet-5-5", "sonnet"]);
  // With no --provider at all they stay as well.
  const plain = fixture(seats);
  assert.equal(run(plain, BEZOS).code, 0);
  assert.deepEqual([seatOf(plain, "bezos").model, seatOf(plain, "bezos").cli_model], ["claude-sonnet-5-5", "sonnet"]);
});

test("--human on an existing AI seat is refused, and the seat keeps its slug, model and cli_model", () => {
  const AS_PERSON = ["--key", "bezos", "--name", "Jeff Bezos", "--short", "Bezos", "--pillar", "Strategy", "--question", "Is it reversible?"];
  const refused = "add_seat: bezos is an AI seat; pick another key for the person";

  // An openai seat with a model and a cli_model, then both ways of asking for a person.
  const repo = fixture();
  assert.equal(run(repo, [...BEZOS, "--provider", "openai", "--model", "gpt-6.1-sol", "--cli-model", "gpt-cli"]).code, 0);
  const before = rawRoster(repo);
  for (const how of [["--human"], ["--provider", "human"]]) {
    const r = run(repo, [...AS_PERSON, ...how]);
    assert.equal(r.code, 1, how.join(" "));
    assert.equal(r.err.trim(), refused);
    assert.equal(rawRoster(repo), before, `${how.join(" ")} must not touch the roster`);
  }
  const s = seatOf(repo, "bezos");
  assert.deepEqual([s.provider, s.slug, s.model, s.cli_model], ["openai", "jeff-bezos", "gpt-6.1-sol", "gpt-cli"]);

  // A seat with no provider counts as anthropic, so it is an AI seat too.
  const plain = fixture();
  const plainBefore = rawRoster(plain);
  const r = run(plain, [...AS_PERSON, "--human"]);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), refused);
  assert.equal(rawRoster(plain), plainBefore);
  assert.equal(seatOf(plain, "bezos").slug, "jeff-bezos");

  // A different key for the person works, and a person can still be re-run as a person.
  assert.equal(run(plain, [...PRIYA, "--human"]).code, 0);
  assert.equal(run(plain, [...PRIYA, "--human"]).code, 0);
  assert.equal(seatOf(plain, "bezos").slug, "jeff-bezos");
});

test("a person re-run without --dimension keeps the dimension it has; a new person gets the pillar", () => {
  const repo = fixture();
  assert.equal(run(repo, [...PRIYA, "--human", "--dimension", "Run readiness"]).code, 0);
  assert.equal(run(repo, [...PRIYA, "--human"]).code, 0);
  assert.equal(seatOf(repo, "priya").dimension, "Run readiness");
  // A passed --dimension still wins.
  assert.equal(run(repo, [...PRIYA, "--human", "--dimension", "Capacity"]).code, 0);
  assert.equal(seatOf(repo, "priya").dimension, "Capacity");
  // A new person with no --dimension takes the pillar.
  assert.equal(run(repo, ["--key", "arjun", "--name", "Arjun Mehta", "--short", "Arjun", "--pillar", "Sales", "--question", "Will it sell?", "--human"]).code, 0);
  assert.equal(seatOf(repo, "arjun").dimension, "Sales");
});

test("run() refuses to spawn unless the root is an rr-* folder directly in the OS temp dir", () => {
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "other-"));
  try {
    for (const root of [REPO, "", undefined, path.join(os.tmpdir(), "rr-does-not-exist"), stranger, path.join(REPO, "..")]) {
      assert.throws(() => run({ root }, [...PRIYA, "--human"]), /refusing to spawn add_seat\.mjs/, String(root));
    }
    assert.throws(() => run(undefined, [...PRIYA, "--human"]), /refusing to spawn add_seat\.mjs/);
    // Nothing was written anywhere it was pointed at.
    assert.deepEqual(fs.readdirSync(stranger), []);
    assert.equal(fs.readFileSync(REAL_ROSTER, "utf8"), realRosterBefore);
  } finally {
    fs.rmdirSync(stranger);
  }
});

test("an explicit --provider anthropic is written; with no provider flag none is written", () => {
  const repo = fixture();
  assert.equal(run(repo, [...BEZOS, "--provider", "anthropic"]).code, 0);
  assert.equal(seatOf(repo, "bezos").provider, "anthropic");
  const plain = fixture();
  assert.equal(run(plain, BEZOS).code, 0);
  for (const k of ["provider", "model", "cli_model"]) assert.equal(k in seatOf(plain, "bezos"), false, k);
});

test("an unknown --provider fails with exit 1 and the exact message, and the roster is unchanged", () => {
  const repo = fixture();
  const before = rawRoster(repo);
  const r = run(repo, [...BEZOS, "--provider", "carrier-pigeon"]);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), "add_seat: --provider must be one of anthropic, openai, google, human");
  assert.equal(rawRoster(repo), before);
  // Wrong case and a missing value are unknown too.
  assert.equal(run(repo, [...BEZOS, "--provider", "OpenAI"]).code, 1);
  assert.equal(run(repo, [...BEZOS, "--provider"]).code, 1);
  assert.equal(rawRoster(repo), before);
});

test("an AI seat still needs its slug, agent file and brain", () => {
  const repo = fixture();
  const noSlug = run(repo, ["--key", "naval", "--name", "Naval Ravikant", "--short", "Naval", "--pillar", "p", "--question", "q", "--dimension", "d", "--provider", "openai"]);
  assert.equal(noSlug.code, 1);
  assert.match(noSlug.err, /add_seat: --slug is required/);
  const noAgent = run(repo, ["--key", "naval", "--name", "Naval Ravikant", "--short", "Naval", "--slug", "naval-ravikant", "--pillar", "p", "--question", "q", "--dimension", "d", "--provider", "openai"]);
  assert.equal(noAgent.code, 1);
  assert.match(noAgent.err, /missing agent file/);
});

test("a person who is re-run without a provider flag stays a person", () => {
  const repo = fixture();
  assert.equal(run(repo, [...PRIYA, "--human"]).code, 0);
  const r = run(repo, ["--key", "priya", "--name", "Priya Rao", "--short", "Priya", "--pillar", "Operations", "--question", "Can we run it without you?"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seatOf(repo, "priya"), {
    key: "priya", name: "Priya Rao", short: "Priya", initials: "PR", slug: null,
    pillar: "Operations", question: "Can we run it without you?", dimension: "Operations",
    color: "#22b8a0", provider: "human",
  });
});

test("the roster stays one seat per line with a stable key order", () => {
  const repo = fixture();
  assert.equal(run(repo, [...BEZOS, "--provider", "openai", "--model", "m1", "--cli-model", "c1"]).code, 0);
  assert.equal(run(repo, [...PRIYA, "--human"]).code, 0);
  const lines = rawRoster(repo).split("\n");
  const keysOf = (key) => {
    const l = lines.find((x) => x.includes(`"key": "${key}"`));
    return [...l.matchAll(/"([a-z_]+)": /g)].map((m) => m[1]);
  };
  assert.deepEqual(keysOf("bezos"), ["key", "name", "short", "initials", "slug", "pillar", "question", "dimension", "color", "provider", "model", "cli_model"]);
  assert.deepEqual(keysOf("priya"), ["key", "name", "short", "initials", "slug", "pillar", "question", "dimension", "color", "provider"]);
  assert.match(lines.find((l) => l.includes('"key": "priya"')), /"slug": null,/);
  assert.equal(lines.filter((l) => l.includes('"key": ')).length, 3); // one seat per line
});

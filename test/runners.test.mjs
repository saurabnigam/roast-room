import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { makeRepo } from "./helpers.mjs";

// council.mjs loads the roster when it is imported, so point it at a disposable repo first.
const repo = makeRepo({ seats: [{ key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos" }] });
process.env.ROAST_ROOT = repo.root;
after(() => repo.cleanup());

const R = await import("../app/public/runners.js");
const {
  PROVIDERS, agentAlias, providerName, companyName, badgeFor, seatDisclaimer, DISCLAIMER,
  councilDisclaimer, recipientsLine, ROUND_FIELDS, CHOICES, MULTILINE,
} = R;

test("PROVIDERS lists the four providers in order", () => {
  assert.deepEqual(PROVIDERS, ["anthropic", "openai", "google", "human"]);
});

test("agentAlias finds the first alias word in a model id", () => {
  assert.equal(agentAlias("claude-opus-5-5"), "opus");
  assert.equal(agentAlias("claude-sonnet-5-5"), "sonnet");
  assert.equal(agentAlias("claude-haiku-4"), "haiku");
  assert.equal(agentAlias("claude-fable-1"), "fable");
  assert.equal(agentAlias("Claude-Opus-5-5"), "opus");
  assert.equal(agentAlias("claude-sonnet-opus-mix"), "sonnet", "earliest in the id wins");
  assert.equal(agentAlias("gpt-6.1-sol"), null);
  assert.equal(agentAlias(""), null);
  assert.equal(agentAlias(null), null);
  assert.equal(agentAlias(undefined), null);
});

test("providerName and companyName", () => {
  assert.deepEqual(PROVIDERS.map(providerName), ["Claude", "GPT", "Gemini", "Human"]);
  assert.deepEqual(PROVIDERS.map(companyName), ["Anthropic", "OpenAI", "Google", ""]);
  assert.equal(providerName(undefined), "Claude", "no provider means anthropic");
  assert.equal(companyName(undefined), "Anthropic");
});

test("an unknown provider is shown as itself, never as Claude", () => {
  assert.equal(providerName("carrier-pigeon"), "carrier-pigeon");
  assert.equal(companyName("carrier-pigeon"), "");
  assert.equal(badgeFor({ provider: "carrier-pigeon", transport: "http" }), "carrier-pigeon");
});

test("badgeFor", () => {
  assert.equal(badgeFor({ provider: "anthropic", model: "claude-sonnet-5-5", transport: "subagent" }), "Claude Sonnet");
  assert.equal(badgeFor({ provider: "anthropic", model: "claude-opus-5-5", transport: "http" }), "Claude Opus");
  assert.equal(badgeFor({ provider: "anthropic", model: null, transport: "subagent" }), "Claude");
  assert.equal(badgeFor({ provider: "anthropic", model: "some-other-model", transport: "subagent" }), "Claude");
  assert.equal(badgeFor({ provider: "openai", model: "gpt-6.1-sol", transport: "http" }), "GPT via API");
  assert.equal(badgeFor({ provider: "openai", transport: "cli" }), "GPT via Codex");
  assert.equal(badgeFor({ provider: "google", transport: "http" }), "Gemini via API");
  assert.equal(badgeFor({ provider: "google", transport: "cli" }), "Gemini via agy");
  assert.equal(badgeFor({ provider: "human", transport: "form" }), "Human");
  assert.equal(badgeFor(undefined), "Claude");
  assert.equal(badgeFor(null), "Claude");
  assert.equal(badgeFor({}), "Claude");
  // no transport known: the provider name alone, not a guess at how it runs
  assert.equal(badgeFor({ provider: "openai" }), "GPT");
  assert.equal(badgeFor({ provider: "google" }), "Gemini");
});

test("seatDisclaimer", () => {
  assert.equal(seatDisclaimer({ name: "Priya Rao" }, { provider: "human" }), "Real person, answered live.");
  assert.equal(seatDisclaimer({ name: "Warren Buffett" }, { provider: "openai" }), "Simulated from Warren Buffett's public work, run on GPT.");
  assert.equal(seatDisclaimer({ name: "Naval Ravikant" }, { provider: "google" }), "Simulated from Naval Ravikant's public work, run on Gemini.");
  assert.equal(seatDisclaimer({ name: "Jeff Bezos" }, undefined), "Simulated from Jeff Bezos's public work, run on Claude.");
  // a human seat is human even when only the roster entry says so
  assert.equal(seatDisclaimer({ name: "Priya Rao", provider: "human" }, undefined), "Real person, answered live.");
  // with no runner, the roster entry's own provider decides
  assert.equal(seatDisclaimer({ name: "Warren Buffett", provider: "openai" }, undefined), "Simulated from Warren Buffett's public work, run on GPT.");
});

test("DISCLAIMER is today's sentence and matches council.mjs", async () => {
  assert.equal(DISCLAIMER, "Simulated advisors built from each person's public work. They are not the people and do not speak for them.");
  const council = await import("../app/lib/council.mjs");
  assert.equal(DISCLAIMER, council.DISCLAIMER);
});

test("councilDisclaimer", () => {
  const bezos = { key: "bezos", name: "Jeff Bezos" };
  const priya = { key: "priya", name: "Priya Rao" };
  const sam = { key: "sam", name: "Sam Lee" };
  const kai = { key: "kai", name: "Kai Chen" };
  const human = { provider: "human" };
  assert.equal(councilDisclaimer([bezos], {}), DISCLAIMER);
  assert.equal(councilDisclaimer([bezos], undefined), DISCLAIMER);
  assert.equal(councilDisclaimer([], {}), DISCLAIMER);
  assert.equal(councilDisclaimer([bezos, priya], { priya: human }), DISCLAIMER + " Real people on this panel, answering live: Priya Rao.");
  assert.equal(councilDisclaimer([priya, bezos, sam], { priya: human, sam: human }), DISCLAIMER + " Real people on this panel, answering live: Priya Rao and Sam Lee.");
  assert.equal(
    councilDisclaimer([priya, sam, kai], { priya: human, sam: human, kai: human }),
    DISCLAIMER + " Real people on this panel, answering live: Priya Rao, Sam Lee, and Kai Chen.",
  );
  // the seat's own provider counts, with or without a runner
  assert.equal(councilDisclaimer([{ ...priya, provider: "human" }, bezos], {}), DISCLAIMER + " Real people on this panel, answering live: Priya Rao.");
  // an AI seat on another provider is not a person
  assert.equal(councilDisclaimer([bezos, { key: "buffett", name: "Warren Buffett" }], { buffett: { provider: "openai" } }), DISCLAIMER);
});

const seats = [
  { key: "bezos", name: "Jeff Bezos", short: "Bezos" },
  { key: "buffett", name: "Warren Buffett", short: "Buffett" },
  { key: "graham", name: "Ben Graham", short: "Graham" },
  { key: "naval", name: "Naval Ravikant", short: "Naval" },
  { key: "priya", name: "Priya Rao", short: "Priya" },
  { key: "sam", name: "Sam Lee", short: "Sam" },
];
const openai = (transport) => ({ provider: "openai", transport });
const google = (transport) => ({ provider: "google", transport });
const human = { provider: "human", transport: "form" };

test("recipientsLine names who gets the question outside Anthropic", () => {
  assert.equal(
    recipientsLine(seats, { buffett: openai("http"), naval: google("cli"), priya: human }),
    "OpenAI (Buffett, via API), Google (Naval, via agy CLI), and Priya on this screen",
  );
  assert.equal(recipientsLine(seats, { bezos: { provider: "anthropic", transport: "subagent" } }), "");
});

test("recipientsLine is empty when nothing leaves Anthropic", () => {
  assert.equal(recipientsLine(seats, {}), "");
  assert.equal(recipientsLine(seats, undefined), "");
  assert.equal(recipientsLine([], { buffett: openai("http") }), "");
  assert.equal(recipientsLine(seats, { bezos: { provider: "anthropic" }, graham: { provider: "anthropic", transport: "http" } }), "");
});

test("recipientsLine joins shorts inside a group like an English list", () => {
  assert.equal(recipientsLine(seats, { buffett: openai("http"), graham: openai("http") }), "OpenAI (Buffett and Graham, via API)");
  assert.equal(recipientsLine(seats, { buffett: openai("http"), graham: openai("http"), naval: openai("http") }), "OpenAI (Buffett, Graham, and Naval, via API)");
  assert.equal(recipientsLine(seats, { priya: human, sam: human }), "Priya and Sam on this screen");
  assert.equal(recipientsLine(seats, { bezos: human, priya: human, sam: human }), "Bezos, Priya, and Sam on this screen");
  assert.equal(recipientsLine(seats, { priya: human }), "Priya on this screen");
});

test("recipientsLine groups by provider and transport, in the order openai, google, human", () => {
  // seat order puts naval (google) and priya (human) before buffett, graham (openai)
  const reordered = [seats[3], seats[4], seats[1], seats[2]];
  const runners = { naval: google("http"), priya: human, buffett: openai("cli"), graham: openai("http") };
  assert.equal(
    recipientsLine(reordered, runners),
    "OpenAI (Buffett, via Codex CLI), OpenAI (Graham, via API), Google (Naval, via API), and Priya on this screen",
  );
  // two groups: " and "
  assert.equal(
    recipientsLine(seats, { buffett: openai("http"), graham: openai("cli") }),
    "OpenAI (Buffett, via API) and OpenAI (Graham, via Codex CLI)",
  );
  assert.equal(recipientsLine(seats, { buffett: google("cli"), naval: google("cli") }), "Google (Buffett and Naval, via agy CLI)");
});

test("recipientsLine leaves out seats with no runner and keeps unknown providers visible", () => {
  assert.equal(recipientsLine(seats, { buffett: openai("http"), ghost: openai("http") }), "OpenAI (Buffett, via API)");
  // transport not known: no transport words, and no guess
  assert.equal(recipientsLine(seats, { buffett: { provider: "openai" } }), "OpenAI (Buffett)");
  // an unknown provider is a recipient we cannot name: it must not read as "nothing leaves"
  assert.equal(recipientsLine(seats, { naval: { provider: "carrier-pigeon", transport: "http" } }), "carrier-pigeon (Naval, via API)");
  assert.equal(recipientsLine(seats, { naval: { provider: "carrier-pigeon", transport: "cli" } }), "carrier-pigeon (Naval, via CLI)");
  assert.equal(
    recipientsLine(seats, { naval: { provider: "carrier-pigeon", transport: "http" }, buffett: openai("http") }),
    "OpenAI (Buffett, via API) and carrier-pigeon (Naval, via API)",
  );
});

test("recipientsLine does not fail open: a seat with no runner uses its own roster provider", () => {
  const roster = [
    { key: "bezos", short: "Bezos" }, // no provider: anthropic
    { key: "graham", short: "Graham", provider: "anthropic" },
    { key: "buffett", short: "Buffett", provider: "openai" },
    { key: "naval", short: "Naval", provider: "google" },
    { key: "priya", short: "Priya", provider: "human" },
  ];
  // no runners at all: the roster alone says who gets the question
  assert.equal(recipientsLine(roster, {}), "OpenAI (Buffett, via API), Google (Naval, via API), and Priya on this screen");
  assert.equal(recipientsLine(roster, undefined), "OpenAI (Buffett, via API), Google (Naval, via API), and Priya on this screen");
  assert.notEqual(recipientsLine([{ key: "buffett", short: "Buffett", provider: "openai" }], {}), "");
  assert.equal(recipientsLine([{ key: "priya", short: "Priya", provider: "human" }], {}), "Priya on this screen");
  // a runner entry wins over the roster: its transport is known
  assert.equal(
    recipientsLine(roster, { buffett: { provider: "openai", transport: "cli" } }),
    "OpenAI (Buffett, via Codex CLI), Google (Naval, via API), and Priya on this screen",
  );
  // seats listed in runners and seats that fell back share a group when provider and transport match
  assert.equal(
    recipientsLine([roster[2], { key: "sam", short: "Sam", provider: "openai" }], { sam: { provider: "openai", transport: "http" } }),
    "OpenAI (Buffett and Sam, via API)",
  );
  // an all-anthropic roster with no runners is still empty
  assert.equal(recipientsLine(roster.slice(0, 2), {}), "");
  // an unknown roster provider stays visible too
  assert.equal(recipientsLine([{ key: "x", short: "X", provider: "carrier-pigeon" }], {}), "carrier-pigeon (X)");
});

test("ROUND_FIELDS, CHOICES and MULTILINE are the answer-form lists", () => {
  assert.deepEqual(ROUND_FIELDS, {
    1: {
      required: ["STANCE", "OPTION SCORES", "THE CALL", "CONFIDENCE", "RUIN RISK", "DOOR"],
      optional: ["PILLAR SCORE", "WHY", "THE RISK I SEE", "WHAT WOULD CHANGE MY MIND", "WHAT I'D DO THIS WEEK", "QUESTION FOR THE FOUNDER"],
    },
    2: {
      required: ["STANCE", "OPTION SCORES", "CONFIDENCE", "RUIN RISK", "I DISAGREE MOST WITH"],
      optional: ["I CONCEDE", "ON THE CRUXES", "PILLAR SCORE", "MOVED", "MY CONDITIONS FOR YES"],
    },
    3: {
      required: ["VOTE", "OPTION SCORES", "FINAL SCORE"],
      optional: ["FINAL PILLAR SCORE", "AMENDMENT OR DISSENT", "ONE LINE FOR THE FOUNDER"],
    },
  });
  assert.deepEqual(CHOICES, {
    STANCE: ["Strong yes", "Yes", "Conditional yes", "No", "Strong no"],
    "RUIN RISK": ["none", "possible", "likely"],
    DOOR: ["one-way", "two-way"],
    VOTE: ["Endorse", "Endorse with amendment", "Dissent"],
  });
  assert.deepEqual(MULTILINE, ["WHY", "ON THE CRUXES", "MY CONDITIONS FOR YES"]);
});

test("runners.js imports nothing and touches no Node or DOM API", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("../app/public/runners.js", import.meta.url)), "utf8");
  assert.ok(!/^\s*import\b/m.test(src), "no import statement");
  assert.ok(!/\bimport\s*\(/.test(src), "no dynamic import");
  assert.ok(!/\brequire\s*\(/.test(src), "no require");
  for (const api of ["process", "Buffer", "document", "window", "fetch", "localStorage", "globalThis"]) {
    assert.ok(!new RegExp(`\\b${api}\\b`).test(src), `${api} is not used`);
  }
});

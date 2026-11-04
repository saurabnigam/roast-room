import test, { after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, makeSession } from "./helpers.mjs";

const repo = makeRepo({
  seats: [
    { key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos" },
    { key: "buffett", name: "Warren Buffett", short: "Buffett", slug: "warren-buffett", provider: "openai" },
    { key: "naval", name: "Naval Ravikant", short: "Naval", slug: null, provider: "google" },
  ],
});
process.env.ROAST_ROOT = repo.root;
after(() => repo.cleanup());

const { CARD_ONLY, contextFiles, readContext, buildUser, buildSeatCall } = await import("../app/lib/seatprompt.mjs");
const { systemText } = await import("../app/lib/seats.mjs");

const BRIEF = "THE DECISION: raise the price\n\nOPTIONS:\n(A) yes\n(B) no\n";
const R1 = "## Bezos\nSEAT: BEZOS (Customer)\nSTANCE: Yes\nSECRET-R1-BEZOS\n\n## Buffett\nSEAT: BUFFETT (Value)\nSTANCE: No\nSECRET-R1-BUFFETT\n";
const R2 = "## Bezos\nSEAT: BEZOS\nSTANCE: Yes\nOTHER-SEATS-R2-CARD\n\n## Buffett\nSEAT: BUFFETT\nSTANCE: Conditional yes\nBUFFETT-OWN-R2-CARD\n";
const CRUXES = '{ "cruxes": [ { "question": "Will churn rise?" } ] }\n';
const DRAFT = "Recommendation: GO WITH CONDITIONS on option A.\n";

const full = () =>
  makeSession(repo.root, `full-${Math.random().toString(36).slice(2, 8)}`, {
    "brief.md": BRIEF, "round-1.md": R1, "round-2.md": R2, "cruxes.json": CRUXES, "draft-resolution.md": DRAFT,
  });

test("CARD_ONLY is the exact sentence", () => {
  assert.equal(CARD_ONLY, "Reply with the card only, in the exact field format above. No preamble and no closing remarks.");
});

test("contextFiles lists what each round may see", () => {
  assert.deepEqual(contextFiles(1), ["brief.md"]);
  assert.deepEqual(contextFiles(2), ["brief.md", "round-1.md", "cruxes.json"]);
  assert.deepEqual(contextFiles(3), ["brief.md", "round-2.md#own", "draft-resolution.md"]);
});

test("contextFiles returns a fresh list and refuses an unknown round", () => {
  contextFiles(2).push("secrets.txt");
  assert.deepEqual(contextFiles(2), ["brief.md", "round-1.md", "cruxes.json"]);
  for (const bad of [0, 4, undefined, null, "constructor", "__proto__"]) assert.throws(() => contextFiles(bad), /round/i, String(bad));
});

test("buildUser: prompt, then each item under a header, then CARD_ONLY", () => {
  const context = [{ name: "brief.md", text: "BRIEF" }, { name: "Your Round 2 card", text: "CARD" }];
  assert.equal(
    buildUser({ promptText: "PROMPT", context }),
    `PROMPT\n\n===== brief.md =====\nBRIEF\n\n===== Your Round 2 card =====\nCARD\n\n${CARD_ONLY}`,
  );
  assert.equal(buildUser({ promptText: "PROMPT", context, cardOnly: true }), buildUser({ promptText: "PROMPT", context }));
  assert.equal(buildUser({ promptText: "PROMPT", context: [], cardOnly: false }), "PROMPT");
  assert.equal(buildUser({ promptText: "PROMPT", context: [] }), `PROMPT\n\n${CARD_ONLY}`);
});

test("readContext returns each file as written, under its file name", () => {
  const dir = full();
  assert.deepEqual(readContext(dir, 1, "buffett"), [{ name: "brief.md", text: BRIEF }]);
  assert.deepEqual(readContext(dir, 2, "buffett"), [
    { name: "brief.md", text: BRIEF }, { name: "round-1.md", text: R1 }, { name: "cruxes.json", text: CRUXES },
  ]);
});

test("readContext skips a missing file and keeps the rest", () => {
  const dir = makeSession(repo.root, "partial", { "brief.md": BRIEF, "round-1.md": R1 }); // no cruxes.json
  assert.deepEqual(readContext(dir, 2, "bezos").map((c) => c.name), ["brief.md", "round-1.md"]);
  assert.deepEqual(readContext(makeSession(repo.root, "empty-dir", {}), 1, "bezos"), []);
});

test("readContext round 3 gives the seat's own Round 2 card only", () => {
  const dir = full();
  const ctx = readContext(dir, 3, "buffett");
  assert.deepEqual(ctx.map((c) => c.name), ["brief.md", "Your Round 2 card", "draft-resolution.md"]);
  const own = ctx[1].text;
  assert.ok(own.startsWith("SEAT: BUFFETT"), own);
  assert.ok(own.includes("BUFFETT-OWN-R2-CARD"));
  assert.ok(!own.includes("OTHER-SEATS-R2-CARD"));
  assert.ok(!own.includes("## "), "the heading is not part of the card");
});

test("readContext round 3 skips the own-card item when the seat has no Round 2 card", () => {
  const dir = makeSession(repo.root, "no-own", {
    "brief.md": BRIEF, "draft-resolution.md": DRAFT,
    "round-2.md": "## Bezos\nSEAT: BEZOS\nSTANCE: Yes\n",
  });
  assert.deepEqual(readContext(dir, 3, "buffett").map((c) => c.name), ["brief.md", "draft-resolution.md"]);
  const noFile = makeSession(repo.root, "no-r2", { "brief.md": BRIEF });
  assert.deepEqual(readContext(noFile, 3, "buffett").map((c) => c.name), ["brief.md"]);
});

test("buildSeatCall round 3: own card only, the draft, ends with CARD_ONLY, no round-1.md", () => {
  const dir = full();
  const call = buildSeatCall({ sessionDir: dir, seatKey: "buffett", round: 3, promptText: "ROUND 3 PROMPT" });
  assert.ok(call.user.startsWith("ROUND 3 PROMPT"));
  const at = call.user.indexOf("===== Your Round 2 card =====");
  assert.ok(at > 0);
  assert.ok(call.user.slice(at).includes("BUFFETT-OWN-R2-CARD"));
  assert.ok(!call.user.includes("OTHER-SEATS-R2-CARD"));
  assert.ok(!call.user.includes("SECRET-R1"));
  assert.ok(call.user.includes("===== draft-resolution.md ====="));
  assert.ok(call.user.endsWith(CARD_ONLY));
  assert.ok(!call.user.includes("round-1.md"));
  assert.ok(!call.user.includes("cruxes.json"));
  assert.deepEqual(call.files, ["brief.md", "Your Round 2 card", "draft-resolution.md"]);
});

test("buildSeatCall round 1: the brief only, so no seat sees another Round 1 card first", () => {
  const dir = full(); // round-1.md and round-2.md exist on disk and must stay out
  const call = buildSeatCall({ sessionDir: dir, seatKey: "bezos", round: 1, promptText: "ROUND 1 PROMPT" });
  assert.equal((call.user.match(/^===== .* =====$/gm) || []).length, 1);
  assert.ok(call.user.includes("===== brief.md ====="));
  assert.ok(!call.user.includes("SECRET-R1"));
  assert.ok(!call.user.includes("OTHER-SEATS-R2-CARD"));
  assert.ok(call.user.endsWith(CARD_ONLY));
  assert.deepEqual(call.files, ["brief.md"]);
});

test("buildSeatCall round 2: brief, every Round 1 card and the cruxes, in that order", () => {
  const dir = full();
  const { user, files } = buildSeatCall({ sessionDir: dir, seatKey: "naval", round: 2, promptText: "P2" });
  const heads = [...user.matchAll(/^===== (.*) =====$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, ["brief.md", "round-1.md", "cruxes.json"]);
  assert.deepEqual(files, heads);
  assert.ok(user.includes("SECRET-R1-BEZOS") && user.includes("SECRET-R1-BUFFETT"));
  assert.ok(!user.includes("BUFFETT-OWN-R2-CARD"), "Round 2 cards are not a Round 2 input");
});

test("buildSeatCall system is the seat's systemText (agent, runtime note, brain)", () => {
  const dir = full();
  const a = buildSeatCall({ sessionDir: dir, seatKey: "buffett", round: 1, promptText: "x" });
  assert.equal(a.system, systemText("buffett"));
  assert.ok(a.system.includes("brains/warren-buffett/_hot.md"));
  const b = buildSeatCall({ sessionDir: dir, seatKey: "naval", round: 1, promptText: "x" }); // slug null
  assert.equal(b.system, systemText("naval"));
  assert.ok(!b.system.includes("brains/"));
  // byte-identical across rounds, so provider prompt caches can hit
  const r3 = buildSeatCall({ sessionDir: dir, seatKey: "buffett", round: 3, promptText: "y" });
  assert.equal(r3.system, a.system);
});

test("buildSeatCall consult: no context, no header, no CARD_ONLY", () => {
  const dir = full();
  const call = buildSeatCall({ sessionDir: dir, seatKey: "buffett", promptText: "What do you think of moats?", consult: true });
  assert.ok(!call.user.includes("====="));
  assert.ok(!call.user.includes(CARD_ONLY));
  assert.equal(call.user, "What do you think of moats?");
  assert.deepEqual(call.files, []);
  assert.equal(call.system, systemText("buffett"));
  // a consult takes no round, and a stray one does not add context
  assert.equal(buildSeatCall({ sessionDir: dir, seatKey: "buffett", round: 2, promptText: "q", consult: true }).user, "q");
});

test("buildSeatCall refuses an unknown seat and an unknown round instead of sending less", () => {
  const dir = full();
  assert.throws(() => buildSeatCall({ sessionDir: dir, seatKey: "nobody", round: 1, promptText: "x" }), /nobody/);
  for (const bad of [0, 4, undefined]) {
    assert.throws(() => buildSeatCall({ sessionDir: dir, seatKey: "bezos", round: bad, promptText: "x" }), /round/i, String(bad));
  }
});

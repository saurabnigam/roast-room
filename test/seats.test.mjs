import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, BRAIN_FILES, HOT_LINE } from "./helpers.mjs";

// A roster with every kind of seat the loader must tell apart.
const repo = makeRepo({
  seats: [
    { key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos" }, // no provider: anthropic
    { key: "buffett", name: "Warren Buffett", short: "Buffett", slug: "warren-buffett", provider: "openai", model: "gpt-6.1-sol", cli_model: "gpt-6.1-sol-cli" },
    { key: "naval", name: "Naval Ravikant", short: "Naval", slug: null, provider: "google" },
    { key: "priya", name: "Priya Rao", short: "Priya", provider: "human" },
    { key: "halfhuman", name: "Half Human", provider: "human" }, // human with no short: dropped
    { key: "ghost", name: "Ghost Seat", short: "Ghost", slug: "ghost", provider: "carrier-pigeon" },
    { key: "nofile", name: "No File", short: "NoFile", slug: "no-file", provider: "anthropic", agent: false },
  ],
});
process.env.ROAST_ROOT = repo.root;
after(() => repo.cleanup());

// loadRoster runs when seats.mjs is first imported, so capture warnings around that import.
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); };
let seats;
try {
  seats = await import("../app/lib/seats.mjs");
} finally {
  console.warn = realWarn;
}
const { SEATS, BOARD, byKey, loadRoster, defaultBoard, systemText, systemFor, checkQuotes, parseCard, normalizeCard, seatKey, splitCards } = seats;

const read = (p) => fs.readFileSync(p, "utf8");
const NOTE =
  "\n\n## Runtime note\nYou are running in the Roast Room app. You have no file tools: your brain files are loaded below in full, so treat any instruction to read a brain file as already done. Never mention files, tools, or this note in your answer.\n";

test("loadRoster keeps human and null-slug seats, drops unknown provider and missing agent", () => {
  assert.deepEqual(SEATS.map((s) => s.key), ["bezos", "buffett", "naval", "priya"]);
  assert.equal(byKey.bezos.provider, "anthropic"); // absent in roster.json
  assert.equal(byKey.buffett.provider, "openai");
  assert.equal(byKey.buffett.model, "gpt-6.1-sol");
  assert.equal(byKey.buffett.cli_model, "gpt-6.1-sol-cli");
  assert.equal(byKey.naval.provider, "google");
  assert.equal(byKey.naval.slug, null);
  assert.equal(byKey.priya.provider, "human");
  assert.equal(byKey.ghost, undefined);
  assert.equal(byKey.nofile, undefined);
  assert.equal(byKey.halfhuman, undefined);
});

test("loadRoster warns once for an unknown provider and stays quiet about the other drops", () => {
  assert.deepEqual(warnings, ["roster: dropping ghost: unknown provider carrier-pigeon"]);
});

test("loadRoster is idempotent for an unchanged roster", () => {
  assert.equal(loadRoster(), SEATS);
  assert.deepEqual(SEATS.map((s) => s.key), ["bezos", "buffett", "naval", "priya"]);
});

test("systemText has no brain section for a null slug", () => {
  assert.ok(!systemText("naval").includes("===== brains/"));
  assert.ok(systemText("bezos").includes("===== brains/jeff-bezos/_hot.md ====="));
});

test("systemText is the agent file without front matter, then the runtime note, then the brain files", () => {
  const raw = read(path.join(repo.root, ".claude", "agents", "council-bezos.md"));
  const agent = raw.slice(raw.indexOf("\n---\n", 3) + "\n---\n".length);
  assert.ok(!agent.includes("tools: Read"), "front matter is gone");
  const brain = BRAIN_FILES.map(
    (f) => `\n\n===== brains/jeff-bezos/${f} =====\n` + read(path.join(repo.root, ".claude", "skills", "roast-room", "brains", "jeff-bezos", f)),
  ).join("");
  assert.equal(systemText("bezos"), agent + NOTE + brain);
  // a seat with no brain gets the agent text and the note, nothing after
  const navalRaw = read(path.join(repo.root, ".claude", "agents", "council-naval.md"));
  assert.equal(systemText("naval"), navalRaw.slice(navalRaw.indexOf("\n---\n", 3) + 5) + NOTE);
});

test("systemFor keeps its shape: one cached ephemeral text block", () => {
  const sys = systemFor("bezos");
  assert.deepEqual(sys, [{ type: "text", text: systemText("bezos"), cache_control: { type: "ephemeral" } }]);
  assert.equal(systemFor("bezos"), sys, "second call returns the cached value");
  assert.deepEqual(systemFor("naval"), [{ type: "text", text: systemText("naval"), cache_control: { type: "ephemeral" } }]);
});

test("checkQuotes returns [] for seats without a brain", () => {
  assert.deepEqual(checkQuotes("naval", `"${HOT_LINE}" (S001)`), []);
});

test("checkQuotes still verifies a quote against a seat's brain", () => {
  assert.deepEqual(checkQuotes("bezos", `"${HOT_LINE}" (S001)`), [{ quote: HOT_LINE, source: "S001", verified: true }]);
  const bad = checkQuotes("bezos", '"Never pay more than you have to for anything at all." (S002)');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].verified, false);
});

// ---------- card parsing ----------
const PLAIN = `SEAT: BUFFETT (Value)
STANCE: Conditional yes
OPTION SCORES: A 7/10 · B 4/10 · C 2/10
PILLAR SCORE: 8/10
CONFIDENCE: 4/5
RUIN RISK: possible
DOOR: two-way

THE CALL: Do B first, then A.
WHY:
1. Margin of safety (Margin of Safety, S014)
2. Cash beats hope
THE RISK I SEE: Cash runs out in month nine.
WHAT WOULD CHANGE MY MIND: Churn under 3%.
WHAT I'D DO THIS WEEK: Call five customers.
QUESTION FOR THE FOUNDER: What is your runway today?
I DISAGREE MOST WITH: Bezos. Speed is not a strategy.
I CONCEDE: Bezos is right about reversibility.
MOVED: yes, from A to B, because of cash.
VOTE: Endorse with amendment
FINAL SCORE: 6/10
AMENDMENT OR DISSENT: Add a kill date.
ONE LINE FOR THE FOUNDER: Protect the downside.`;

const PLAIN_EXPECTED = {
  stance: "Conditional yes",
  call: "Do B first, then A.",
  optionScores: { A: 7, B: 4, C: 2 },
  pillar: 8,
  finalScore: 6,
  confidence: 4,
  ruin: "possible",
  door: "two-way",
  disagreeWith: "bezos",
  disagreeLine: "Bezos. Speed is not a strategy.",
  concede: "Bezos is right about reversibility.",
  moved: "yes, from A to B, because of cash.",
  vote: "amend",
  amendment: "Add a kill date.",
  oneLine: "Protect the downside.",
  question: "What is your runway today?",
  risk: "Cash runs out in month nine.",
  thisWeek: "Call five customers.",
};

test("parseCard reads bold and heading-wrapped fields", () => {
  const p = parseCard("SEAT: BEZOS\n### STANCE: Yes\n**OPTION SCORES:** A 7/10 · B 4/10\n**CONFIDENCE**: 4/5\n## THE CALL\nDo B first.", ["A", "B"]);
  assert.equal(p.stance, "Yes");
  assert.deepEqual(p.optionScores, { A: 7, B: 4 });
  assert.equal(p.confidence, 4);
  assert.equal(p.call, "Do B first.");
});

test("parseCard reads option ids written in brackets, as the round template shows them", () => {
  // Found in the first live council: every seat copied "[A] 2/10" from the template, and no score was read.
  const p = parseCard("SEAT: BUFFETT\nOPTION SCORES: [A] 2/10 · [B] 9/10 · (C) 4/10 · D 5/10\nCONFIDENCE: 4/5", ["A", "B", "C", "D"]);
  assert.deepEqual(p.optionScores, { A: 2, B: 9, C: 4, D: 5 });
});

test("parseCard on today's plain format is unchanged", () => {
  assert.deepEqual(parseCard(PLAIN, ["A", "B", "C"]), PLAIN_EXPECTED);
  assert.equal(normalizeCard(PLAIN), PLAIN, "a plain card passes through normalizeCard untouched");
});

test("parseCard on a plain round 3 card falls back to FINAL PILLAR SCORE", () => {
  const p = parseCard("SEAT: BEZOS\nVOTE: Dissent\nOPTION SCORES: A 3/10 · B 9/10\nFINAL SCORE: 2/10\nFINAL PILLAR SCORE: 5/10\nAMENDMENT OR DISSENT: Too slow.\nONE LINE FOR THE FOUNDER: Ship.", ["A", "B"]);
  assert.equal(p.vote, "dissent");
  assert.deepEqual(p.optionScores, { A: 3, B: 9 });
  assert.equal(p.finalScore, 2);
  assert.equal(p.pillar, 5);
  assert.equal(p.amendment, "Too slow.");
  assert.equal(p.oneLine, "Ship.");
  assert.equal(p.stance, "");
  assert.equal(p.confidence, null);
});

// Every wrapping style must give the same parse as the plain card.
const WRAPS = {
  "bold label with the colon inside": (l, v) => `**${l}:** ${v}`,
  "bold label with the colon outside": (l, v) => `**${l}**: ${v}`,
  "underscore label": (l, v) => `__${l}:__ ${v}`,
  "heading with the value": (l, v) => `## ${l}: ${v}`,
  "block quote": (l, v) => `> ${l}: ${v}`,
  "quoted heading, bold label": (l, v) => `> ### **${l}:** ${v}`,
  "heading label, value on the next line": (l, v) => `### ${l}\n${v}`,
  "label with an empty value, value on the next line": (l, v) => `${l}:\n${v}`,
  "bold label with an empty value, value on the next line": (l, v) => `**${l}:**\n${v}`,
  "bold heading label, value on the next line": (l, v) => `## **${l}**\n${v}`,
  "heading label, one blank line, then the value": (l, v) => `### ${l}\n\n${v}`,
  "label with an empty value, one blank line, then the value": (l, v) => `${l}:\n\n${v}`,
};
for (const [name, wrap] of Object.entries(WRAPS)) {
  test(`parseCard gives the plain result when fields are wrapped: ${name}`, () => {
    const wrapped = PLAIN.split("\n")
      .map((line) => {
        const m = line.match(/^([A-Z][A-Z' ]+): (.+)$/);
        return m && m[1] !== "SEAT" ? wrap(m[1], m[2]) : line;
      })
      .join("\n");
    assert.notEqual(wrapped, PLAIN);
    assert.deepEqual(parseCard(wrapped, ["A", "B", "C"]), PLAIN_EXPECTED);
  });
}

test("normalizeCard step 1 strips heading and quote markers", () => {
  assert.equal(normalizeCard("### STANCE: Yes"), "STANCE: Yes");
  assert.equal(normalizeCard("###### STANCE: Yes"), "STANCE: Yes");
  assert.equal(normalizeCard("> STANCE: Yes"), "STANCE: Yes");
  assert.equal(normalizeCard(">STANCE: Yes"), "STANCE: Yes");
  assert.equal(normalizeCard("> ## STANCE: Yes"), "STANCE: Yes");
  assert.equal(normalizeCard("#STANCE: Yes"), "#STANCE: Yes", "a # with no space after it is not a heading marker");
});

test("normalizeCard step 2 rewrites bold and underscore labels", () => {
  assert.equal(normalizeCard("**STANCE:** Yes"), "STANCE: Yes");
  assert.equal(normalizeCard("**STANCE**: Yes"), "STANCE: Yes");
  assert.equal(normalizeCard("__STANCE:__ Yes"), "STANCE: Yes");
  assert.equal(normalizeCard("### **STANCE:** Yes"), "STANCE: Yes");
  assert.equal(normalizeCard("**WHAT I'D DO THIS WEEK:** Call five customers."), "WHAT I'D DO THIS WEEK: Call five customers.");
});

test("normalizeCard step 3 joins a bare known label with the next line", () => {
  assert.equal(normalizeCard("## THE CALL\nDo B first."), "THE CALL: Do B first.");
  assert.equal(normalizeCard("### Confidence\n4/5\nDOOR: two-way"), "Confidence: 4/5\nDOOR: two-way");
  assert.equal(normalizeCard("> ## OPTION SCORES\n> A 7/10 · B 4/10"), "OPTION SCORES: A 7/10 · B 4/10");
});

test("normalizeCard step 3 joins an empty label with the next non-empty line, in four shapes", () => {
  const joined = "THE CALL: Do B first.";
  assert.equal(normalizeCard("THE CALL:\nDo B first."), joined, "LABEL: alone");
  assert.equal(normalizeCard("**THE CALL:**\nDo B first."), joined, "**LABEL:** alone");
  assert.equal(normalizeCard("**THE CALL**:\nDo B first."), joined, "**LABEL**: alone");
  assert.equal(normalizeCard("__THE CALL:__\nDo B first."), joined, "__LABEL:__ alone");
  assert.equal(normalizeCard("## **THE CALL**\nDo B first."), joined, "heading with a bold bare label");
  assert.equal(normalizeCard("## THE CALL\n\nDo B first."), joined, "bare label, blank line, value");
  assert.equal(normalizeCard("THE CALL:\n\nDo B first."), joined, "LABEL: alone, blank line, value");
  assert.equal(normalizeCard("> ## THE CALL\n>\n> Do B first."), joined, "a quoted card, blank quoted line, value");
  // the line after the value is untouched
  assert.equal(normalizeCard("## THE CALL\n\nDo B first.\nDOOR: two-way"), `${joined}\nDOOR: two-way`);
});

test("normalizeCard step 3 never touches a label that already has its value", () => {
  for (const card of [
    "THE CALL: Do B first.\nIt is cheap.",
    "STANCE: Yes\n1. A numbered line.",
    "**THE CALL:** Do B first.\n\nA paragraph after a blank line.",
    "DOOR: two-way\nsome trailing note",
  ]) {
    assert.equal(normalizeCard(card).split("\n").length, card.split("\n").length, card);
  }
  assert.equal(normalizeCard("THE CALL: Do B first.\nIt is cheap."), "THE CALL: Do B first.\nIt is cheap.");
  assert.equal(normalizeCard("**THE CALL:** Do B first.\n\nA paragraph."), "THE CALL: Do B first.\n\nA paragraph.");
});

test("normalizeCard step 3 leaves an empty label alone when no value follows", () => {
  assert.equal(normalizeCard("## THE CALL"), "THE CALL");
  assert.equal(normalizeCard("THE CALL:"), "THE CALL:");
  assert.equal(normalizeCard("THE CALL:\n"), "THE CALL:\n");
  assert.equal(normalizeCard("THE CALL:\n\n"), "THE CALL:\n\n");
  assert.equal(normalizeCard("## THE CALL\n\n\nDo B first."), "THE CALL\n\n\nDo B first.", "two blank lines are too many");
  // a word that is not a label is never joined
  assert.equal(normalizeCard("## Notes\nSomething."), "Notes\nSomething.");
  assert.equal(normalizeCard("Notes:\nSomething."), "Notes:\nSomething.");
});

test("normalizeCard does not swallow the next field into an empty one", () => {
  assert.equal(normalizeCard("## STANCE\nCONFIDENCE: 4/5"), "STANCE\nCONFIDENCE: 4/5");
  assert.equal(normalizeCard("## STANCE\n## CONFIDENCE\n4/5"), "STANCE\nCONFIDENCE: 4/5");
  assert.equal(normalizeCard("STANCE:\nCONFIDENCE: 4/5"), "STANCE:\nCONFIDENCE: 4/5");
  assert.equal(normalizeCard("STANCE:\n\nCONFIDENCE: 4/5"), "STANCE:\n\nCONFIDENCE: 4/5", "also across a blank line");
  assert.equal(normalizeCard("**STANCE:**\n**CONFIDENCE:** 4/5"), "STANCE:\nCONFIDENCE: 4/5");
  assert.equal(normalizeCard("## **STANCE**\n## **CONFIDENCE**\n4/5"), "**STANCE**\nCONFIDENCE: 4/5");
  // a label the parser does not read still ends the field above it
  assert.equal(normalizeCard("THE CALL:\nWHY:\n1. Because."), "THE CALL:\nWHY:\n1. Because.");
  assert.equal(normalizeCard("THE CALL:\n\nWHAT WOULD CHANGE MY MIND: a number."), "THE CALL:\n\nWHAT WOULD CHANGE MY MIND: a number.");
  const p = parseCard("## STANCE\nCONFIDENCE: 4/5", ["A"]);
  assert.equal(p.stance, "");
  assert.equal(p.confidence, 4);
  const q = parseCard("THE CALL:\n\nSTANCE: Yes\nDOOR: two-way", ["A"]);
  assert.equal(q.call, "");
  assert.equal(q.stance, "Yes");
  assert.equal(q.door, "two-way");
});

test("normalizeCard stays fast on a whitespace-heavy line", () => {
  // These shapes made an earlier label pattern backtrack for tens of seconds.
  const lines = [
    "** " + " ".repeat(3000) + "x",
    "__" + " a".repeat(1500) + " ".repeat(3000) + "x",
    "THE CALL" + " ".repeat(3000) + "x",
    "THE CALL" + " ".repeat(3000) + ":" + " ".repeat(3000),
    "## " + " ".repeat(3000),
    "THE CALL\n" + " ".repeat(3000) + "\nDo B first.",
  ];
  for (const text of lines) {
    const t0 = performance.now();
    normalizeCard(text + "\nnext line");
    assert.ok(performance.now() - t0 < 500, `normalizeCard took ${(performance.now() - t0).toFixed(0)} ms on ${JSON.stringify(text.slice(0, 20))}`);
  }
});

test("parseCard reads a card with Windows line endings", () => {
  const p = parseCard("## STANCE\r\nYes\r\n**CONFIDENCE:** 3/5\r\n", ["A"]);
  assert.equal(p.stance, "Yes");
  assert.equal(p.confidence, 3);
});

// ---------- moved: seatKey and splitCards ----------
test("seatKey resolves keys, short names, full names and decorated names", () => {
  assert.equal(seatKey("bezos"), "bezos");
  assert.equal(seatKey("Buffett"), "buffett");
  assert.equal(seatKey("WARREN BUFFETT (Value)"), "buffett");
  assert.equal(seatKey("Priya Rao"), "priya");
  assert.equal(seatKey("nobody here"), null);
  assert.equal(seatKey(""), null);
});

test("splitCards still splits ## headings and SEAT: lines", () => {
  const heads = splitCards("# Round 1\n\n## Bezos\nSTANCE: Yes\nTHE CALL: Go.\n\n---\n\n## Buffett\nSTANCE: No\n\n## The Chair\nIgnore this.\n");
  assert.deepEqual(heads.map((c) => c.key), ["bezos", "buffett"]);
  assert.equal(heads[0].text, "STANCE: Yes\nTHE CALL: Go.");
  assert.equal(heads[1].text, "STANCE: No");

  const lines = splitCards("SEAT: BEZOS (Customer)\nSTANCE: Yes\n\nSEAT: PRIYA\nSTANCE: No\n\n## Chair notes\nIgnore this.\n");
  assert.deepEqual(lines.map((c) => c.key), ["bezos", "priya"]);
  assert.ok(lines[0].text.startsWith("SEAT: BEZOS (Customer)\nSTANCE: Yes"));
  assert.ok(!lines[1].text.includes("Ignore"));

  assert.deepEqual(splitCards("no cards here"), []);
});

test("watch.mjs re-exports the same seatKey and splitCards", async () => {
  const watch = await import("../app/lib/watch.mjs");
  assert.equal(watch.seatKey, seatKey);
  assert.equal(watch.splitCards, splitCards);
});

// ---------- default board ----------
// These tests rewrite the fixture's roster.json, so they run last.
const rosterFile = path.join(repo.root, ".claude", "skills", "roast-room", "roster.json");
const original = JSON.parse(read(rosterFile));
const extra = Array.from({ length: 8 }, (_, i) => ({
  key: `a${i + 1}`, name: `Advisor ${i + 1}`, short: `A${i + 1}`, slug: null, pillar: "P", question: "Q?", dimension: "D", color: "#888888",
}));
for (const e of extra) fs.writeFileSync(path.join(repo.root, ".claude", "agents", `council-${e.key}.md`), `---\nname: council-${e.key}\n---\n\nExtra seat.\n`);
let bump = 0;
function reloadWith(def, seatList = [...original.seats, ...extra]) {
  fs.writeFileSync(rosterFile, JSON.stringify({ ...original, default: def, seats: seatList }, null, 2));
  const t = new Date(Date.now() + 60000 * ++bump); // a new mtime, so loadRoster reads the file again
  fs.utimesSync(rosterFile, t, t);
  const realWarn = console.warn;
  console.warn = () => {};
  try { loadRoster(); } finally { console.warn = realWarn; }
}

test("BOARD.default keeps the valid keys of a saved default and drops the rest", () => {
  // ghost (unknown provider) and nofile (no agent file) are dropped by the loader
  reloadWith(["naval", "ghost", "bezos", "nofile", "priya"]);
  assert.deepEqual(BOARD.default, ["naval", "bezos", "priya"], "order kept; google and human seats stay when named");
  assert.deepEqual(defaultBoard(), ["naval", "bezos", "priya"]);
  assert.notEqual(defaultBoard(), BOARD.default, "defaultBoard returns a copy");
});

test("BOARD.default falls back to anthropic seats only when the saved default is empty after filtering", () => {
  const expected = ["bezos", "a1", "a2", "a3", "a4", "a5", "a6"]; // first seven anthropic seats
  for (const def of [["ghost", "nofile", "halfhuman"], [], undefined]) {
    reloadWith(def);
    assert.ok(SEATS.length > 7 && SEATS.some((s) => s.provider !== "anthropic"), "the roster has other providers to skip");
    assert.deepEqual(BOARD.default, expected, `saved default ${JSON.stringify(def)}`);
    assert.ok(BOARD.default.every((k) => byKey[k].provider === "anthropic"));
  }
});

test("BOARD.default is empty, not a person or another provider, when no anthropic seat exists", () => {
  reloadWith(["ghost"], original.seats.filter((s) => s.provider === "openai" || s.provider === "google" || s.provider === "human"));
  assert.deepEqual(SEATS.map((s) => s.key), ["buffett", "naval", "priya"]);
  assert.deepEqual(BOARD.default, []);
});

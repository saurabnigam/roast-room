import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, makeSession } from "./helpers.mjs";

const repo = makeRepo({
  seats: [
    { key: "bezos", name: "Jeff Bezos", short: "Bezos", slug: "jeff-bezos" },
    { key: "buffett", name: "Warren Buffett", short: "Buffett", slug: "warren-buffett" },
    { key: "priya", name: "Priya Rao", short: "Priya", provider: "human", pillar: "Family and health", dimension: "Family cost" },
    { key: "arjun", name: "Arjun Mehta", short: "Arjun", provider: "human", pillar: "Operations", dimension: "Ops load" },
  ],
});
process.env.ROAST_ROOT = repo.root;
delete process.env.HUMAN_DEADLINE_MIN;
after(() => repo.cleanup());

const inbox = await import("../app/lib/inbox.mjs");
const {
  ROUND_FIELDS, CHOICES, MULTILINE, validateAnswer, cardText, deadlineFrom, requestPath, answerPath,
  readRequests, writeRequest, listPending, submitAnswer, openApiRequest, dropApiSession,
} = inbox;
const runners = await import("../app/public/runners.js");
const { byKey, parseCard, splitCards } = await import("../app/lib/seats.mjs");
const { contextFiles } = await import("../app/lib/seatprompt.mjs");
const { SESSIONS_DIR } = await import("../app/lib/env.mjs");

const ids = ["A", "B", "C"];
const options = [{ id: "A", label: "Raise the price" }, { id: "B", label: "Keep it" }, { id: "C", label: "Tier it" }];
const scores = { A: 7, B: 4, C: 2 };
const good1 = { STANCE: "Conditional yes", "OPTION SCORES": scores, "THE CALL": "Do A first.", CONFIDENCE: 4, "RUIN RISK": "none", DOOR: "two-way" };
const good2 = { STANCE: "Yes", "OPTION SCORES": { A: 8, B: 3, C: 2 }, CONFIDENCE: 3, "RUIN RISK": "possible", "I DISAGREE MOST WITH": "Bezos. He wants to wait." };
const good3 = { VOTE: "Endorse", "OPTION SCORES": { A: 8, B: 3, C: 2 }, "FINAL SCORE": 8 };
const GOOD = { 1: good1, 2: good2, 3: good3 };

const full1 = {
  ...good1,
  "PILLAR SCORE": 6,
  WHY: "It pays for itself.\nThe family can absorb a bad month.",
  "THE RISK I SEE": "Churn.",
  "WHAT WOULD CHANGE MY MIND": "Churn above 8 percent.",
  "WHAT I'D DO THIS WEEK": "Email ten customers.",
  "QUESTION FOR THE FOUNDER": "What is your runway?",
};
const full2 = {
  ...good2,
  "I CONCEDE": "Churn is real.",
  "ON THE CRUXES": "Crux 1: yes.\nCrux 2: no.",
  "PILLAR SCORE": 7,
  MOVED: "no",
  "MY CONDITIONS FOR YES": "Churn under 5 percent.\nA written refund policy.",
};
const full3 = {
  ...good3,
  VOTE: "Endorse with amendment",
  "FINAL PILLAR SCORE": 7,
  "AMENDMENT OR DISSENT": "Add a refund policy.",
  "ONE LINE FOR THE FOUNDER": "Protect the family first.",
};
const FULL = { 1: full1, 2: full2, 3: full3 };

const BRIEF = "THE DECISION: raise the price\n\nOPTIONS:\n(A) yes\n(B) no\n";
const DEADLINE_MSG = "The deadline for this round has passed. The council moved on without this answer.";
let n = 0;
const uniq = (p) => `${p}-${++n}`;

/** A skill session folder with council.json, a brief and one pending request. */
function skillSession(name, { seat = "priya", round = 1, deadline = deadlineFrom(), status = "pending", council = true } = {}) {
  const files = { "brief.md": BRIEF, "round-1.md": "## Bezos\nSEAT: BEZOS\nSTANCE: Yes\n" };
  if (council) files["council.json"] = { options };
  const dir = makeSession(repo.root, name, files);
  writeRequest(dir, { seat, round, prompt: "P", fields: ROUND_FIELDS[round], context: contextFiles(round), options, deadline, status });
  return dir;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const withEnv = async (key, value, fn) => {
  const old = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
};
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
// A promise that must settle. If a bug leaves it pending, fail in seconds instead of hanging the run.
function soon(promise, ms = 3000) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error("did not settle in time")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
// API session ids are tracked so a failing test cannot leave a 30-minute timer holding the process open.
const apiIds = new Set();
const apiId = (prefix) => { const id = uniq(prefix); apiIds.add(id); return id; };
after(() => { for (const id of apiIds) dropApiSession(id); });

// ---------------------------------------------------------------- constants
test("ROUND_FIELDS, CHOICES and MULTILINE are re-exported from runners.js, not copied", () => {
  assert.equal(ROUND_FIELDS, runners.ROUND_FIELDS);
  assert.equal(CHOICES, runners.CHOICES);
  assert.equal(MULTILINE, runners.MULTILINE);
});

// ---------------------------------------------------------------- validateAnswer
test("validateAnswer: required, ranges, choices, unknown fields", () => {
  assert.deepEqual(validateAnswer(1, good1, ids), []);
  assert.deepEqual(validateAnswer(2, good2, ids), []);
  assert.deepEqual(validateAnswer(3, good3, ids), []);
  assert.ok(validateAnswer(1, { ...good1, CONFIDENCE: 6 }, ids).some((e) => /CONFIDENCE/.test(e)));
  assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": { A: 7, B: 11, C: 2 } }, ids).length);
  assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": { A: 7, B: 4 } }, ids).length); // C missing
  assert.ok(validateAnswer(1, { ...good1, DOOR: "sideways" }, ids).length);
  assert.ok(validateAnswer(1, { ...good1, HACK: "x" }, ids).length);
});

test("validateAnswer: every full card is valid, and every field name is allowed once", () => {
  for (const r of [1, 2, 3]) {
    assert.deepEqual(validateAnswer(r, FULL[r], ids), [], `round ${r}`);
    const names = [...ROUND_FIELDS[r].required, ...ROUND_FIELDS[r].optional];
    assert.deepEqual(Object.keys(FULL[r]).sort(), [...names].sort(), `round ${r} fixture covers every field`);
  }
});

test("validateAnswer: a missing or blank required field is named", () => {
  for (const r of [1, 2, 3]) {
    for (const f of ROUND_FIELDS[r].required) {
      const { [f]: _gone, ...rest } = GOOD[r];
      assert.ok(validateAnswer(r, rest, ids).some((e) => e.includes(f)), `${f} absent`);
      if (typeof GOOD[r][f] === "string") {
        assert.ok(validateAnswer(r, { ...rest, [f]: "   " }, ids).some((e) => e.includes(f)), `${f} blank`);
      }
    }
  }
});

test("validateAnswer: a required text field that is only # marks counts as empty", () => {
  for (const v of ["#", "## ", " # # ", "###\n##"]) assert.ok(validateAnswer(1, { ...good1, "THE CALL": v }, ids).some((e) => /THE CALL/.test(e)), JSON.stringify(v));
});

test("validateAnswer: an optional field may be absent, null or blank, never invalid", () => {
  assert.deepEqual(validateAnswer(1, { ...good1, "PILLAR SCORE": "", WHY: null, "THE RISK I SEE": "  " }, ids), []);
  assert.ok(validateAnswer(1, { ...good1, "PILLAR SCORE": 11 }, ids).some((e) => /PILLAR SCORE/.test(e)));
  assert.ok(validateAnswer(3, { ...good3, "FINAL PILLAR SCORE": -1 }, ids).some((e) => /FINAL PILLAR SCORE/.test(e)));
  assert.deepEqual(validateAnswer(1, { ...good1, "PILLAR SCORE": 0 }, ids), [], "0 is a score, not an absent field");
});

test("validateAnswer: scores are whole numbers in range, confidence is 1 to 5", () => {
  const bad = [5.5, -1, 11, NaN, Infinity, true, [], {}, "x", "4.5", "-1", "1e1", " 4", "٤"];
  for (const v of bad) {
    assert.ok(validateAnswer(1, { ...good1, CONFIDENCE: v }, ids).some((e) => /CONFIDENCE/.test(e)), `CONFIDENCE ${String(v)}`);
  }
  for (const v of [0, 6, 10]) assert.ok(validateAnswer(1, { ...good1, CONFIDENCE: v }, ids).length, `CONFIDENCE ${v}`);
  for (const v of [1, 5, "1", "5"]) assert.deepEqual(validateAnswer(1, { ...good1, CONFIDENCE: v }, ids), [], `CONFIDENCE ${v}`);
  for (const v of [0, 10, "0", "10"]) assert.deepEqual(validateAnswer(3, { ...good3, "FINAL SCORE": v }, ids), [], `FINAL SCORE ${v}`);
  for (const v of [-1, 11, 7.5, null, "ten"]) {
    assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": { A: 7, B: v, C: 2 } }, ids).some((e) => /OPTION SCORES/.test(e)), `option ${String(v)}`);
  }
});

test("validateAnswer: OPTION SCORES needs a plain object with exactly the option ids", () => {
  for (const v of ["A 7 B 4 C 2", [7, 4, 2], null, 7]) {
    assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": v }, ids).some((e) => /OPTION SCORES/.test(e)), JSON.stringify(v));
  }
  assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": { ...scores, Z: 5 } }, ids).some((e) => /Z/.test(e)), "an id that is not an option");
  assert.deepEqual(validateAnswer(1, { ...good1, "OPTION SCORES": { A: 7, B: 4 } }, ["A", "B"]), []);
  assert.deepEqual(validateAnswer(1, { ...good1, "OPTION SCORES": { A: 1, B: 2, C: 3, D: 4 } }, ["A", "B", "C", "D"]), []);
  assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": { A: 7, B: 4, C: 2 } }, []).length, "a request with no options cannot be scored");
  assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": {} }, undefined).length);
});

test("validateAnswer: choices must be exact, text is capped at 2000 characters", () => {
  for (const [f, list] of Object.entries(CHOICES)) {
    const round = f === "VOTE" ? 3 : 1;
    for (const v of list) assert.deepEqual(validateAnswer(round, { ...GOOD[round], [f]: v }, ids), [], `${f}=${v}`);
    for (const v of [list[0].toLowerCase() === list[0] ? list[0].toUpperCase() : list[0].toLowerCase(), `${list[0]} `, "", 3, null]) {
      assert.ok(validateAnswer(round, { ...GOOD[round], [f]: v }, ids).some((e) => e.includes(f)), `${f}=${JSON.stringify(v)}`);
    }
  }
  assert.deepEqual(validateAnswer(1, { ...good1, WHY: "x".repeat(2000) }, ids), []);
  assert.ok(validateAnswer(1, { ...good1, WHY: "x".repeat(2001) }, ids).some((e) => /WHY/.test(e)));
  assert.ok(validateAnswer(1, { ...good1, "THE CALL": "x".repeat(2001) }, ids).some((e) => /THE CALL/.test(e)));
  assert.ok(validateAnswer(1, { ...good1, "THE CALL": 5 }, ids).some((e) => /THE CALL/.test(e)), "text must be text");
  assert.ok(validateAnswer(1, { ...good1, WHY: { a: 1 } }, ids).some((e) => /WHY/.test(e)));
});

test("validateAnswer: a field from another round is unknown, and so is a prototype key", () => {
  assert.ok(validateAnswer(1, { ...good1, VOTE: "Endorse" }, ids).some((e) => /VOTE/.test(e)));
  assert.ok(validateAnswer(3, { ...good3, STANCE: "Yes" }, ids).some((e) => /STANCE/.test(e)));
  const withProto = Object.assign(JSON.parse('{"__proto__": 1}'), good1);
  assert.ok(validateAnswer(1, withProto, ids).some((e) => /__proto__/.test(e)));
});

test("validateAnswer: bad round or bad fields container is an error, never a throw", () => {
  for (const r of [0, 4, "1", undefined, null, 1.5, "constructor"]) assert.ok(validateAnswer(r, good1, ids).length, String(r));
  for (const f of [null, undefined, "text", 5, [], [good1]]) assert.ok(validateAnswer(1, f, ids).length, JSON.stringify(f));
});

// ---------------------------------------------------------------- cardText
const LABEL = /^([A-Z][A-Z' ]*[A-Z]):/;
const labels = (text) => text.split("\n").map((l) => l.match(LABEL)?.[1]).filter(Boolean);

test("cardText prints the exact card for each round", () => {
  assert.equal(
    cardText({ seat: byKey.priya, round: 1, fields: full1, optionIds: ids }),
    [
      "SEAT: PRIYA (Family and health)",
      "STANCE: Conditional yes",
      "OPTION SCORES: A 7/10 · B 4/10 · C 2/10",
      "PILLAR SCORE: 6/10",
      "CONFIDENCE: 4/5",
      "RUIN RISK: none",
      "DOOR: two-way",
      "",
      "THE CALL: Do A first.",
      "WHY:",
      "It pays for itself.",
      "The family can absorb a bad month.",
      "THE RISK I SEE: Churn.",
      "WHAT WOULD CHANGE MY MIND: Churn above 8 percent.",
      "WHAT I'D DO THIS WEEK: Email ten customers.",
      "QUESTION FOR THE FOUNDER: What is your runway?",
    ].join("\n"),
  );
  assert.equal(
    cardText({ seat: byKey.priya, round: 2, fields: full2, optionIds: ids }),
    [
      "SEAT: PRIYA",
      "I DISAGREE MOST WITH: Bezos. He wants to wait.",
      "I CONCEDE: Churn is real.",
      "ON THE CRUXES:",
      "Crux 1: yes.",
      "Crux 2: no.",
      "STANCE: Yes",
      "OPTION SCORES: A 8/10 · B 3/10 · C 2/10",
      "PILLAR SCORE: 7/10",
      "CONFIDENCE: 3/5",
      "RUIN RISK: possible",
      "MOVED: no",
      "MY CONDITIONS FOR YES:",
      "Churn under 5 percent.",
      "A written refund policy.",
    ].join("\n"),
  );
  assert.equal(
    cardText({ seat: byKey.priya, round: 3, fields: full3, optionIds: ids }),
    [
      "SEAT: PRIYA",
      "VOTE: Endorse with amendment",
      "OPTION SCORES: A 8/10 · B 3/10 · C 2/10",
      "FINAL SCORE: 8/10",
      "FINAL PILLAR SCORE: 7/10",
      "AMENDMENT OR DISSENT: Add a refund policy.",
      "ONE LINE FOR THE FOUNDER: Protect the family first.",
    ].join("\n"),
  );
});

test("cardText leaves out absent optional fields and has no trailing newline", () => {
  assert.equal(
    cardText({ seat: byKey.priya, round: 1, fields: good1, optionIds: ids }),
    [
      "SEAT: PRIYA (Family and health)",
      "STANCE: Conditional yes",
      "OPTION SCORES: A 7/10 · B 4/10 · C 2/10",
      "CONFIDENCE: 4/5",
      "RUIN RISK: none",
      "DOOR: two-way",
      "",
      "THE CALL: Do A first.",
    ].join("\n"),
  );
  const sparse = cardText({ seat: byKey.priya, round: 3, fields: { ...good3, "FINAL PILLAR SCORE": "", "AMENDMENT OR DISSENT": "  \n " }, optionIds: ids });
  assert.equal(sparse, "SEAT: PRIYA\nVOTE: Endorse\nOPTION SCORES: A 8/10 · B 3/10 · C 2/10\nFINAL SCORE: 8/10");
  for (const r of [1, 2, 3]) assert.ok(!/\s$/.test(cardText({ seat: byKey.priya, round: r, fields: GOOD[r], optionIds: ids })), `round ${r}`);
});

test("cardText field order follows the prompts in council.mjs, and covers every form field", () => {
  const src = fs.readFileSync(new URL("../app/lib/council.mjs", import.meta.url), "utf8");
  for (const r of [1, 2, 3]) {
    const body = src.slice(src.indexOf(`function round${r}Prompt`)).split("\n}\n")[0];
    const shape = body.slice(body.indexOf("in exactly this shape:"));
    const expected = labels(shape);
    assert.ok(expected.length >= 7, `round ${r} template parsed: ${expected}`);
    const card = cardText({ seat: byKey.priya, round: r, fields: FULL[r], optionIds: ids });
    assert.deepEqual(labels(card), expected, `round ${r}`);
    assert.deepEqual(labels(card).slice(1).sort(), [...ROUND_FIELDS[r].required, ...ROUND_FIELDS[r].optional].sort());
  }
});

test("cardText round-trips through parseCard for every round", () => {
  const c1 = parseCard(cardText({ seat: byKey.priya, round: 1, fields: full1, optionIds: ids }), ids);
  assert.equal(c1.stance, "Conditional yes");
  assert.deepEqual(c1.optionScores, scores);
  assert.equal(c1.pillar, 6);
  assert.equal(c1.confidence, 4);
  assert.equal(c1.ruin, "none");
  assert.equal(c1.door, "two-way");
  assert.equal(c1.call, "Do A first.");
  assert.equal(c1.risk, "Churn.");
  assert.equal(c1.thisWeek, "Email ten customers.");
  assert.equal(c1.question, "What is your runway?");

  const c2 = parseCard(cardText({ seat: byKey.priya, round: 2, fields: full2, optionIds: ids }), ids);
  assert.equal(c2.stance, "Yes");
  assert.deepEqual(c2.optionScores, { A: 8, B: 3, C: 2 });
  assert.equal(c2.confidence, 3);
  assert.equal(c2.ruin, "possible");
  assert.equal(c2.pillar, 7);
  assert.equal(c2.disagreeWith, "bezos");
  assert.equal(c2.concede, "Churn is real.");
  assert.equal(c2.moved, "no");

  const c3 = parseCard(cardText({ seat: byKey.priya, round: 3, fields: full3, optionIds: ids }), ids);
  assert.equal(c3.vote, "amend");
  assert.deepEqual(c3.optionScores, { A: 8, B: 3, C: 2 });
  assert.equal(c3.finalScore, 8);
  assert.equal(c3.pillar, 7);
  assert.equal(c3.amendment, "Add a refund policy.");
  assert.equal(c3.oneLine, "Protect the family first.");
  assert.equal(parseCard(cardText({ seat: byKey.priya, round: 3, fields: { ...good3, VOTE: "Dissent" }, optionIds: ids }), ids).vote, "dissent");
});

test("cardText works for two and four options", () => {
  const two = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, "OPTION SCORES": { A: 9, B: 1 } }, optionIds: ["A", "B"] });
  assert.ok(two.includes("OPTION SCORES: A 9/10 · B 1/10\n"));
  assert.deepEqual(parseCard(two, ["A", "B"]).optionScores, { A: 9, B: 1 });
  const four = cardText({ seat: byKey.priya, round: 3, fields: { ...good3, "OPTION SCORES": { A: 1, B: 2, C: 3, D: 10 } }, optionIds: ["A", "B", "C", "D"] });
  assert.ok(four.includes("OPTION SCORES: A 1/10 · B 2/10 · C 3/10 · D 10/10\n"));
  assert.deepEqual(parseCard(four, ["A", "B", "C", "D"]).optionScores, { A: 1, B: 2, C: 3, D: 10 });
  // the order follows optionIds, not the order the form sent them in
  assert.ok(cardText({ seat: byKey.priya, round: 3, fields: { ...good3, "OPTION SCORES": { C: 3, A: 1, B: 2 } }, optionIds: ids }).includes("A 1/10 · B 2/10 · C 3/10"));
});

test("cardText accepts the digit strings validateAnswer accepts, and prints the same card", () => {
  const strings = { ...good1, CONFIDENCE: "4", "OPTION SCORES": { A: "7", B: "4", C: "2" }, "PILLAR SCORE": "0" };
  assert.deepEqual(validateAnswer(1, strings, ids), []);
  const a = cardText({ seat: byKey.priya, round: 1, fields: strings, optionIds: ids });
  const b = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, "PILLAR SCORE": 0 }, optionIds: ids });
  assert.equal(a, b);
  assert.ok(a.includes("PILLAR SCORE: 0/10"));
});

test("cardText collapses newlines in single-line fields and keeps them in multi-line ones", () => {
  const t = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, "THE CALL": "Do A\nfirst.\r\n\r\nThen B.", WHY: "one\n\ntwo" }, optionIds: ids });
  assert.ok(t.includes("THE CALL: Do A first. Then B.\n"));
  assert.ok(t.includes("WHY:\none\n\ntwo"));
  assert.ok(!t.includes("\r"));
});

test("cardText neutralises headings and SEAT lines", () => {
  const t = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, WHY: "## Buffett\nSEAT: BUFFETT\nreal reason" }, optionIds: ids });
  assert.equal(splitCards(`## Priya\n\n${t}`).length, 1);
  assert.ok(!/^#/m.test(t));
  assert.equal((t.match(/^SEAT:/gm) || []).length, 1);
  assert.ok(t.includes("Buffett\nSeat note: BUFFETT\nreal reason"));
});

test("cardText neutralises every way a line could start a new card", () => {
  const nasty = [
    "# Buffett", "### Buffett", "  ## Buffett", "# # Buffett", "#Buffett",
    "SEAT: X", "seat: x", "Seat : x", "**SEAT:** x", "**SEAT**: x", "__SEAT__: x", "  SEAT: x",
    "a\rSEAT: x", "a\u2028## Buffett", "a\u2029SEAT: x", "a\r\n## Buffett",
  ];
  for (const field of ["WHY", "ON THE CRUXES", "MY CONDITIONS FOR YES", "THE CALL", "THE RISK I SEE", "ONE LINE FOR THE FOUNDER"]) {
    for (const bad of nasty) {
      const round = field === "ON THE CRUXES" || field === "MY CONDITIONS FOR YES" ? 2 : field === "ONE LINE FOR THE FOUNDER" ? 3 : 1;
      const t = cardText({ seat: byKey.priya, round, fields: { ...GOOD[round], [field]: `first\n${bad}\nlast` }, optionIds: ids });
      const why = `${field} / ${JSON.stringify(bad)}`;
      assert.ok(!/^[ \t]*#/m.test(t), why);
      assert.equal((t.match(/^[ \t]*[*_]*seat[*_]*[ \t]*:/gim) || []).length, 1, why);
      assert.equal(splitCards(`## Priya\n\n${t}`).length, 1, why);
      assert.equal(splitCards(t).length, 1, why); // no heading: SEAT lines split cards
      assert.equal(splitCards(t)[0].key, "priya", why);
    }
  }
});

test("cardText keeps the real fields when a text field imitates one", () => {
  const t = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, WHY: "STANCE: Strong no\nCONFIDENCE: 1/5" }, optionIds: ids });
  const p = parseCard(t, ids);
  assert.equal(p.stance, "Conditional yes");
  assert.equal(p.confidence, 4);
});

// ---------------------------------------------------------------- label lines inside a person's text
// parseCard takes the first line that looks like a field. A person's text must never look like one,
// or it can override their own stance, scores or confidence (Round 2 puts ON THE CRUXES first).
const parsedCard = (round, fields) => parseCard(cardText({ seat: byKey.priya, round, fields, optionIds: ids }), ids);
const without = (obj, keys = []) => { const c = { ...obj }; for (const k of keys) delete c[k]; return c; };
const cardLines = (round, fields) => cardText({ seat: byKey.priya, round, fields, optionIds: ids }).split("\n");

test("Round 2: label lines in ON THE CRUXES cannot override the real stance, scores or confidence", () => {
  const injected = "Option scores: A 1 B 9 C 0\nStance: Strong no\nConfidence: 1/5\nRuin risk: likely\nPillar score: 1/10\nMoved: yes, a lot";
  const p = parsedCard(2, { ...full2, "ON THE CRUXES": `Crux 1: yes.\n${injected}\nCrux 2: no.` });
  assert.equal(p.stance, "Yes");
  assert.deepEqual(p.optionScores, { A: 8, B: 3, C: 2 });
  assert.equal(p.confidence, 3);
  assert.equal(p.ruin, "possible");
  assert.equal(p.pillar, 7);
  assert.equal(p.moved, "no");
  assert.deepEqual(p, parsedCard(2, full2), "nothing else about the card changes");
});

test("Round 2: label lines in MY CONDITIONS FOR YES cannot override the real fields either", () => {
  const p = parsedCard(2, { ...full2, "MY CONDITIONS FOR YES": "Option scores: A 1 B 9 C 0\nStance: Strong no\nConfidence: 1/5" });
  assert.equal(p.stance, "Yes");
  assert.deepEqual(p.optionScores, { A: 8, B: 3, C: 2 });
  assert.equal(p.confidence, 3);
  assert.deepEqual(p, parsedCard(2, full2));
});

test("Round 1: WHY cannot shadow THE RISK I SEE, WHAT I'D DO THIS WEEK or QUESTION FOR THE FOUNDER", () => {
  const why = "It pays for itself.\nThe risk I see: nothing at all\nWhat I'd do this week: take a nap\nQuestion for the founder: why not?\nTHE CALL: Do B\nDoor: one-way";
  const p = parsedCard(1, { ...full1, WHY: why });
  assert.equal(p.risk, "Churn.");
  assert.equal(p.thisWeek, "Email ten customers.");
  assert.equal(p.question, "What is your runway?");
  assert.equal(p.call, "Do A first.");
  assert.equal(p.door, "two-way");
  assert.deepEqual(p, parsedCard(1, full1));
});

test("an option-scores sentence inside any text field cannot become the card's scores", () => {
  // parseCard looks for "OPTION SCORES:" anywhere in the card, not only at a line start, so a
  // "- " bullet is not enough. I CONCEDE and I DISAGREE MOST WITH come before the real line in Round 2.
  for (const host of ["I CONCEDE", "I DISAGREE MOST WITH", "ON THE CRUXES"]) {
    for (const text of ["my option scores: A 1 B 9 C 0", "**OPTION SCORES**: A 1 B 9 C 0", "Option scores : A 1 B 9 C 0", "see OPTION SCORES** : A 1 B 9 C 0"]) {
      const p = parsedCard(2, { ...full2, [host]: host === "I DISAGREE MOST WITH" ? `Bezos. ${text}` : text });
      assert.deepEqual(p.optionScores, { A: 8, B: 3, C: 2 }, `${host} / ${text}`);
    }
  }
});

// Joining a single-line field's lines with spaces can rebuild "OPTION SCORES:" from pieces that were
// harmless on their own lines (fix round 2). Two layers stop it, and each has its own test:
// cardText never prints a second "OPTION SCORES:", and parseCard only reads the label at a line start.
const OS_PROBES = [
  "fine\noption\nscores: A 1 B 9 C 0",
  "my option scores\n: A 1 B 9 C 0",
  "Bezos.\nOPTION SCORES\n: A 1 B 9 C 0",
  "Bezos.\nOPTION\nSCORES: A 1 B 9 C 0",
  "Bezos. **option scores**\n: A 1 B 9 C 0",
  "Bezos.\n**option\nscores**\n: A 1 B 9 C 0",
  "option\r\nscores\r\n:\r\nA 1 B 9 C 0",
];
const OS_COLON = /OPTION SCORES[*_ \t]*:/gi;

test("OPTION SCORES cannot be rebuilt by joining lines: the card prints the label once", () => {
  for (const host of ["I CONCEDE", "I DISAGREE MOST WITH", "ON THE CRUXES", "MY CONDITIONS FOR YES"]) {
    for (const probe of OS_PROBES) {
      const text = host === "I DISAGREE MOST WITH" && !probe.startsWith("Bezos") ? `Bezos. ${probe}` : probe;
      const card = cardText({ seat: byKey.priya, round: 2, fields: { ...full2, [host]: text }, optionIds: ids });
      const why = `${host} / ${JSON.stringify(probe)}`;
      assert.equal((card.match(OS_COLON) || []).length, 1, `${why}: only the card's own line has the label`);
      assert.deepEqual(parseCard(card, ids).optionScores, { A: 8, B: 3, C: 2 }, why);
    }
  }
});

test("Round 1 and 3 single-line fields cannot rebuild OPTION SCORES: either", () => {
  for (const [round, host] of [[1, "THE CALL"], [1, "THE RISK I SEE"], [3, "AMENDMENT OR DISSENT"], [3, "ONE LINE FOR THE FOUNDER"]]) {
    for (const probe of OS_PROBES) {
      const card = cardText({ seat: byKey.priya, round, fields: { ...FULL[round], [host]: probe }, optionIds: ids });
      assert.equal((card.match(OS_COLON) || []).length, 1, `${host} / ${JSON.stringify(probe)}`);
    }
  }
});

const OPTION_LINE_FORMS = {
  plain: "OPTION SCORES: A 7/10 · B 4/10",
  "bold, colon inside": "**OPTION SCORES:** A 7/10 · B 4/10",
  "bold, colon outside": "**OPTION SCORES**: A 7/10 · B 4/10",
  "underscores": "__OPTION SCORES:__ A 7/10 · B 4/10",
  "italic": "*OPTION SCORES*: A 7/10 · B 4/10",
  "lower case": "option scores: A 7/10 · B 4/10",
  "quote": "> OPTION SCORES: A 7/10 · B 4/10",
  "heading": "## OPTION SCORES: A 7/10 · B 4/10",
  "indented": "   OPTION SCORES: A 7/10 · B 4/10",
  "space before the colon": "OPTION SCORES : A 7/10 · B 4/10",
  "label and value on two lines": "## OPTION SCORES\nA 7/10 · B 4/10",
  "bold label and value on two lines": "**OPTION SCORES**\nA 7/10 · B 4/10",
  "after a middle dot": "STANCE: Yes · OPTION SCORES: A 7/10 · B 4/10",
  "after a pipe": "STANCE: Yes | OPTION SCORES: A 7/10 · B 4/10",
  "value ends before CONFIDENCE": "OPTION SCORES: A 7/10 · B 4/10 CONFIDENCE: 4/5",
};

test("parseCard: a mid-sentence 'option scores:' before the real line does not win", () => {
  const real = "OPTION SCORES: A 7/10 · B 4/10";
  const parse = (before) => parseCard(`SEAT: BEZOS\n${before}\nSTANCE: Yes\n${real}\nCONFIDENCE: 4/5`, ["A", "B"]);
  for (const before of [
    "I CONCEDE: my option scores: A 1 B 9",
    "I CONCEDE: my option scores: A 1 B 9 and nothing else",
    "I CONCEDE: my **OPTION SCORES**: A 1 B 9",
    "I CONCEDE: my option scores : A 1 B 9",
    "I CONCEDE: see option scores** : A 1 B 9",
    "I CONCEDE: the OPTION SCORES: A 1 B 9",
    "- Option scores: A 1 B 9",
    "text OPTION SCORES: A 1 B 9",
  ]) {
    assert.deepEqual(parse(before).optionScores, { A: 7, B: 4 }, before);
  }
  // with no real line at all, a sentence gives no scores (it used to give the sentence's numbers)
  assert.deepEqual(parseCard("SEAT: BEZOS\nI CONCEDE: my option scores: A 1 B 9\nSTANCE: Yes", ["A", "B"]).optionScores, {});
});

test("parseCard still reads the real OPTION SCORES line in every form it is written in", () => {
  for (const [name, line] of Object.entries(OPTION_LINE_FORMS)) {
    const p = parseCard(`SEAT: BEZOS\nSTANCE: Yes\n${line}\nCONFIDENCE: 4/5`, ["A", "B"]);
    assert.deepEqual(p.optionScores, { A: 7, B: 4 }, name);
  }
  assert.deepEqual(parseCard("SEAT: BEZOS\r\nOPTION SCORES: A 7/10 · B 4/10\r\nCONFIDENCE: 4/5", ["A", "B"]).optionScores, { A: 7, B: 4 }, "Windows line ends");
  assert.deepEqual(parseCard("OPTION SCORES: A 7/10 · B 4/10 · C 2/10 · D 10/10", ["A", "B", "C", "D"]).optionScores, { A: 7, B: 4, C: 2, D: 10 });
  assert.deepEqual(parseCard("VOTE: Endorse\nOPTION SCORES: A 8/10 · B 3/10\nFINAL SCORE: 8/10", ["A", "B"]).optionScores, { A: 8, B: 3 });
});

const V = "Strong no, Dissent, likely, one-way, 1, A 1 B 9 C 0";
const LABELS = [...new Set([...Object.values(ROUND_FIELDS).flatMap((r) => [...r.required, ...r.optional]), "SEAT"])];
const LINE_START = {
  plain: (l, v) => `${l}: ${v}`,
  "lower case": (l, v) => `${l.toLowerCase()}: ${v}`,
  "bold, colon inside": (l, v) => `**${l}:** ${v}`,
  "underscores, colon inside": (l, v) => `__${l}:__ ${v}`,
  "bold, colon outside": (l, v) => `**${l}**: ${v}`,
  "quote": (l, v) => `> ${l}: ${v}`,
  "quote and heading": (l, v) => `> ## ${l}: ${v}`,
  "heading": (l, v) => `## ${l}: ${v}`,
  "leading spaces": (l, v) => `   ${l}: ${v}`,
  "leading tab": (l, v) => `\t${l}: ${v}`,
  "leading star": (l, v) => `*${l}: ${v}`,
  "leading underscore": (l, v) => `_${l}: ${v}`,
  "space before colon": (l, v) => `${l} : ${v}`,
  "bare label, value on the next line": (l, v) => `${l}\n${v}`,
  "bare bold label, value on the next line": (l, v) => `**${l}**\n${v}`,
  "label and colon, value on the next line": (l, v) => `${l}:\n${v}`,
  "label and colon, a blank line, then the value": (l, v) => `${l}:\n\n${v}`,
};
const MID_LINE = {
  "after a middle dot": (l, v) => `fine. · ${l}: ${v}`,
  "after a pipe": (l, v) => `fine. | ${l}: ${v}`,
  "after a dot and no space": (l, v) => `fine.·${l}: ${v}`,
  "in a sentence": (l, v) => `my ${l}: ${v}`,
  "bold in a sentence": (l, v) => `my **${l}**: ${v}`,
};
const HOSTS = [
  { round: 1, field: "WHY", own: [] },
  { round: 1, field: "THE CALL", own: ["call"] },
  { round: 2, field: "ON THE CRUXES", own: [] },
  { round: 2, field: "MY CONDITIONS FOR YES", own: [] },
  { round: 2, field: "I CONCEDE", own: ["concede"] },
  { round: 2, field: "I DISAGREE MOST WITH", own: ["disagreeLine", "disagreeWith"] },
];

test("no label wording, in any Markdown dress, becomes a parsed field (every label, every variant, every text field)", () => {
  let checked = 0;
  for (const { round, field, own } of HOSTS) {
    const baseline = without(parsedCard(round, FULL[round]), own);
    for (const label of LABELS) {
      const v = label === "SEAT" ? "Bezos" : V;
      for (const [name, make] of [...Object.entries(LINE_START), ...Object.entries(MID_LINE)]) {
        const line = make(label, v);
        const text = field === "I DISAGREE MOST WITH" ? `Bezos. He wants to wait.\n${line}\nend` : `first\n${line}\nlast`;
        const fields = { ...FULL[round], [field]: text };
        const why = `${field} / ${label} / ${name}`;
        const card = cardText({ seat: byKey.priya, round, fields, optionIds: ids });
        assert.deepEqual(without(parseCard(card, ids), own), baseline, why);
        assert.equal(splitCards(card).length, 1, `${why}: splits into one card`);
        assert.equal(splitCards(`## Priya\n\n${card}`).length, 1, `${why}: splits into one card under a heading`);
        checked++;
      }
    }
  }
  assert.ok(checked > 2000, `swept ${checked} cases`);
});

test("the label list covers every label parseCard reads", () => {
  const src = fs.readFileSync(new URL("../app/lib/seats.mjs", import.meta.url), "utf8");
  const read = [...src.matchAll(/const (?:CARD_LABELS|OTHER_LABELS) = new Set\(\[([\s\S]*?)\]\)/g)]
    .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.ok(read.length >= 20 && read.includes("STANCE") && read.includes("MY CONDITIONS FOR YES"), `found ${read.length} labels in seats.mjs`);
  for (const label of read.filter((l) => l !== "SEAT")) {
    const t = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, WHY: `${label}: value` }, optionIds: ids });
    // OPTION SCORES also loses its colon: parseCard finds that one anywhere in a line, bullet or not.
    assert.ok(t.includes(label === "OPTION SCORES" ? "\n- OPTION SCORES - value" : `\n- ${label}: value`), label);
  }
  const seatLine = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, WHY: "SEAT: X" }, optionIds: ids });
  assert.ok(seatLine.includes("\nSeat note: X"));
  // SEAT is in the label list too (the ruling names it), so the forms the SEAT-line rule misses are bulleted
  const quoted = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, WHY: "> SEAT: X\nSEAT" }, optionIds: ids });
  assert.ok(quoted.includes("\n- > SEAT: X\n- SEAT"));
});

test("ordinary text is left alone: bullets, sentences, words that only start like a label", () => {
  const text = "- Stance: already a bullet\nChurn under 5 percent: yes\nConfidence in the plan: high\nStances differ: yes\nWe need more data: ask ten customers\n1. Vote: later\nThe door: closed";
  const t = cardText({ seat: byKey.priya, round: 2, fields: { ...full2, "ON THE CRUXES": text }, optionIds: ids });
  assert.ok(t.includes(`ON THE CRUXES:\n${text}\nSTANCE: Yes`));
});

test("a label line is shown as a bullet, in the person's words, in a multi-line field", () => {
  const t = cardText({ seat: byKey.priya, round: 2, fields: { ...full2, "ON THE CRUXES": "Stance: wait\n**Confidence:** low\nstance" }, optionIds: ids });
  assert.ok(t.includes("ON THE CRUXES:\n- Stance: wait\n- **Confidence:** low\n- stance\nSTANCE: Yes"));
});

test("· and | in a person's text become , and /, so they cannot start a field mid-line", () => {
  const p = parsedCard(1, { ...good1, "THE CALL": "Do A · then B" });
  assert.equal(p.call, "Do A , then B"); // was cut to "Do A"
  const split = parsedCard(1, { ...full1, "THE CALL": "Do A · STANCE: Strong no · CONFIDENCE: 1 | RUIN RISK: likely" });
  assert.equal(split.stance, "Conditional yes");
  assert.equal(split.confidence, 4);
  assert.equal(split.ruin, "none");
  assert.equal(split.call, "Do A , STANCE: Strong no , CONFIDENCE: 1 / RUIN RISK: likely");
  for (const [round, f, field] of [[1, full1, "WHY"], [1, full1, "THE RISK I SEE"], [2, full2, "ON THE CRUXES"], [2, full2, "I CONCEDE"], [3, full3, "AMENDMENT OR DISSENT"], [3, full3, "ONE LINE FOR THE FOUNDER"]]) {
    const lines = cardLines(round, { ...f, [field]: "a · b | c\nd · e | f" });
    const other = lines.filter((l) => !l.startsWith("OPTION SCORES:"));
    assert.ok(!other.some((l) => /[·|]/.test(l)), `${field}: ${other.filter((l) => /[·|]/.test(l))}`);
    assert.ok(lines.find((l) => l.startsWith("OPTION SCORES:")).includes(" · "), "the card's own score line keeps its separators");
    assert.ok(lines.join("\n").includes("a , b / c"), field);
  }
  assert.deepEqual(parsedCard(1, { ...good1, "THE CALL": "Do A · then B" }).optionScores, scores);
});

// ---------------------------------------------------------------- deadlineFrom
test("deadlineFrom: 30 minutes by default, HUMAN_DEADLINE_MIN when valid, read on every call", async () => {
  const t0 = Date.UTC(2026, 9, 28, 12, 0, 0);
  const min = (v) => withEnv("HUMAN_DEADLINE_MIN", v, () => (Date.parse(deadlineFrom(t0)) - t0) / 60000);
  assert.equal(await min(undefined), 30);
  assert.equal(await min("5"), 5);
  assert.equal(await min("0.5"), 0.5);
  assert.equal(await min("0.002"), 0.002);
  assert.equal(await min("10"), 10); // the value changes between calls: it is not frozen at import
  for (const bad of ["", "abc", "0", "-5", "NaN", "Infinity", "1e400", "99999999999999999"]) assert.equal(await min(bad), 30, `HUMAN_DEADLINE_MIN=${bad}`);
  assert.equal(deadlineFrom(t0), new Date(t0 + 30 * 60000).toISOString());
  assert.ok(Math.abs(Date.parse(deadlineFrom()) - Date.now() - 30 * 60000) < 5000, "now defaults to the clock");
});

// ---------------------------------------------------------------- paths, requests
test("requestPath and answerPath sit in inbox/ and refuse ids that are not ids", () => {
  const dir = path.join(repo.root, "sessions", "p");
  assert.equal(requestPath(dir, "priya", 2), path.join(dir, "inbox", "priya-r2.request.json"));
  assert.equal(answerPath(dir, "priya", 2), path.join(dir, "inbox", "priya-r2.answer.md"));
  for (const [seat, round] of [["../x", 1], ["Priya", 1], ["p", 1], ["priya", 4], ["priya", "1"], ["a/b", 1], ["", 1]]) {
    assert.throws(() => requestPath(dir, seat, round), undefined, `${seat}/${round}`);
    assert.throws(() => answerPath(dir, seat, round), undefined, `${seat}/${round}`);
  }
});

test("writeRequest writes inbox/<seat>-r<n>.request.json whole, with no temp file left", () => {
  const dir = makeSession(repo.root, uniq("wr"), {});
  const req = { seat: "priya", round: 2, prompt: "P", fields: ROUND_FIELDS[2], context: contextFiles(2), options, deadline: deadlineFrom(), status: "pending" };
  writeRequest(dir, req);
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")), ["priya-r2.request.json"]);
  const text = fs.readFileSync(requestPath(dir, "priya", 2), "utf8");
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text), req);
  writeRequest(dir, { ...req, prompt: "P2" }); // replaces
  assert.equal(readJson(requestPath(dir, "priya", 2)).prompt, "P2");
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")), ["priya-r2.request.json"]);
  assert.throws(() => writeRequest(dir, { ...req, seat: "../evil" }));
  assert.throws(() => writeRequest(dir, { ...req, round: 9 }));
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")), ["priya-r2.request.json"]);
});

test("readRequests reads every request file, skips unreadable ones and anything else", () => {
  const dir = makeSession(repo.root, uniq("rr"), {});
  assert.deepEqual(readRequests(dir), [], "no inbox folder");
  assert.deepEqual(readRequests(path.join(dir, "missing")), [], "no session folder");
  const base = { prompt: "", fields: ROUND_FIELDS[1], context: [], options, deadline: deadlineFrom(), status: "pending" };
  writeRequest(dir, { ...base, seat: "priya", round: 1 });
  writeRequest(dir, { ...base, seat: "arjun", round: 1 });
  const inboxDir = path.join(dir, "inbox");
  fs.writeFileSync(path.join(inboxDir, "broken-r1.request.json"), "{ not json");
  fs.writeFileSync(path.join(inboxDir, "null-r1.request.json"), "null");
  fs.writeFileSync(path.join(inboxDir, "list-r1.request.json"), "[1]");
  fs.writeFileSync(path.join(inboxDir, "priya-r1.answer.md"), "SEAT: PRIYA\n");
  fs.writeFileSync(path.join(inboxDir, "priya-r2.request.json.123-1.tmp"), JSON.stringify({ seat: "priya", round: 2 }));
  fs.mkdirSync(path.join(inboxDir, "dir-r1.request.json"));
  assert.deepEqual(readRequests(dir).map((r) => r.seat), ["arjun", "priya"]); // file name order
});

// ---------------------------------------------------------------- submitAnswer
test("submitAnswer: 400 path-like ids, 404 unknown, 200 writes card, 409 second answer", () => {
  const S = uniq("sub");
  const dir = skillSession(S);
  assert.equal(submitAnswer({ session: "../etc", seat: "priya", round: 1, fields: good1 }).code, 400);
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 2, fields: good2 }).code, 404);
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 200);
  assert.ok(fs.readFileSync(answerPath(dir, "priya", 1), "utf8").startsWith("SEAT: PRIYA (Family and health)"));
  assert.equal(JSON.parse(fs.readFileSync(requestPath(dir, "priya", 1))).status, "answered");
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 409);
});

test("submitAnswer 200: the answer file is cardText plus one newline, the request keeps its fields", () => {
  const S = uniq("sub-ok");
  const dir = skillSession(S);
  const now = Date.now();
  const res = submitAnswer({ session: S, seat: "priya", round: 1, fields: full1 }, { now });
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  const card = fs.readFileSync(answerPath(dir, "priya", 1), "utf8");
  assert.equal(card, cardText({ seat: byKey.priya, round: 1, fields: full1, optionIds: ids }) + "\n");
  assert.deepEqual(parseCard(card, ids).optionScores, scores);
  const req = readJson(requestPath(dir, "priya", 1));
  assert.equal(req.status, "answered");
  assert.equal(req.answeredAt, new Date(now).toISOString());
  assert.equal(req.prompt, "P");
  assert.deepEqual(req.options, options);
  assert.deepEqual(req.fields, ROUND_FIELDS[1]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")).sort(), ["priya-r1.answer.md", "priya-r1.request.json"], "no temp file left");
});

test("submitAnswer answers every round, and a wrong round stays 404", () => {
  for (const r of [1, 2, 3]) {
    const S = uniq(`sub-r${r}`);
    const dir = skillSession(S, { round: r });
    assert.equal(submitAnswer({ session: S, seat: "priya", round: r === 3 ? 1 : r + 1, fields: GOOD[r] }).code, 404);
    assert.equal(submitAnswer({ session: S, seat: "priya", round: r, fields: GOOD[r] }).code, 200, `round ${r}`);
    const card = fs.readFileSync(answerPath(dir, "priya", r), "utf8");
    assert.ok(card.startsWith(r === 1 ? "SEAT: PRIYA (Family and health)\n" : "SEAT: PRIYA\n"));
  }
});

test("submitAnswer 400: bad ids, round or input, with { error, errors }", () => {
  const S = uniq("sub-400");
  skillSession(S);
  const bad = [
    { session: "../etc", seat: "priya", round: 1 },
    { session: "a/b", seat: "priya", round: 1 },
    { session: "..", seat: "priya", round: 1 },
    { session: "-lead", seat: "priya", round: 1 },
    { session: "x".repeat(82), seat: "priya", round: 1 },
    { session: "", seat: "priya", round: 1 },
    { session: 5, seat: "priya", round: 1 },
    { session: S, seat: "../priya", round: 1 },
    { session: S, seat: "Priya", round: 1 },
    { session: S, seat: "p", round: 1 },
    { session: S, seat: "a".repeat(17), round: 1 },
    { session: S, seat: "", round: 1 },
    { session: S, seat: 7, round: 1 },
    { session: S, seat: "priya", round: 0 },
    { session: S, seat: "priya", round: 4 },
    { session: S, seat: "priya", round: "1" },
    { session: S, seat: "priya", round: 1.5 },
    { session: S, seat: "priya" },
    {},
  ];
  for (const b of bad) {
    const res = submitAnswer({ fields: good1, ...b });
    assert.equal(res.code, 400, JSON.stringify(b));
    assert.equal(typeof res.body.error, "string");
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length, JSON.stringify(b));
  }
  for (const nothing of [null, undefined, "x", 5, []]) assert.equal(submitAnswer(nothing).code, 400, String(nothing));
});

test("submitAnswer 400 for invalid fields lists the errors and changes nothing", () => {
  const S = uniq("sub-fields");
  const dir = skillSession(S);
  const res = submitAnswer({ session: S, seat: "priya", round: 1, fields: { ...good1, CONFIDENCE: 9, HACK: "x" } });
  assert.equal(res.code, 400);
  assert.ok(res.body.errors.some((e) => /CONFIDENCE/.test(e)) && res.body.errors.some((e) => /HACK/.test(e)));
  assert.ok(!fs.existsSync(answerPath(dir, "priya", 1)));
  assert.equal(readJson(requestPath(dir, "priya", 1)).status, "pending");
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 200, "the person can fix it and send again");
});

test("submitAnswer 400 uses the request's own option ids", () => {
  const S = uniq("sub-opts");
  const two = [{ id: "A", label: "Yes" }, { id: "B", label: "No" }];
  const dir = makeSession(repo.root, S, { "council.json": { options: two } });
  writeRequest(dir, { seat: "priya", round: 1, prompt: "", fields: ROUND_FIELDS[1], context: [], options: two, deadline: deadlineFrom(), status: "pending" });
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 400); // C is not an option here
  const res = submitAnswer({ session: S, seat: "priya", round: 1, fields: { ...good1, "OPTION SCORES": { A: 9, B: 1 } } });
  assert.equal(res.code, 200);
  assert.ok(fs.readFileSync(answerPath(dir, "priya", 1), "utf8").includes("OPTION SCORES: A 9/10 · B 1/10\n"));
});

test("submitAnswer 404: no request, no session, no council.json, not a person", () => {
  const S = uniq("sub-404");
  skillSession(S);
  const noCouncil = uniq("nocouncil");
  skillSession(noCouncil, { council: false });
  const no = (r) => { assert.equal(r.code, 404, JSON.stringify(r)); assert.equal(typeof r.body.error, "string"); };
  no(submitAnswer({ session: S, seat: "arjun", round: 1, fields: good1 })); // a person with no request
  no(submitAnswer({ session: "2026-10-28-nope", seat: "priya", round: 1, fields: good1 }));
  no(submitAnswer({ session: noCouncil, seat: "priya", round: 1, fields: good1 })); // folder without council.json
  no(submitAnswer({ session: S, seat: "nobody", round: 1, fields: good1 })); // not in the roster
  no(submitAnswer({ session: S, seat: "constructor", round: 1, fields: good1 })); // an Object.prototype name
  // an AI seat, even with a request file on disk
  const dir = skillSession(uniq("ai-seat"), { seat: "bezos" });
  no(submitAnswer({ session: path.basename(dir), seat: "bezos", round: 1, fields: good1 }));
  assert.ok(!fs.existsSync(answerPath(dir, "bezos", 1)));
  // a request file that cannot be read
  const bad = skillSession(uniq("corrupt"));
  fs.writeFileSync(requestPath(bad, "priya", 1), "{ not json");
  no(submitAnswer({ session: path.basename(bad), seat: "priya", round: 1, fields: good1 }));
  // a session id that is a file, not a folder
  fs.writeFileSync(path.join(SESSIONS_DIR, "afile"), "x");
  no(submitAnswer({ session: "afile", seat: "priya", round: 1, fields: good1 }));
});

test("submitAnswer 409: a second answer is refused with the first still in place", () => {
  const S = uniq("sub-409");
  const dir = skillSession(S);
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 200);
  const first = fs.readFileSync(answerPath(dir, "priya", 1), "utf8");
  const res = submitAnswer({ session: S, seat: "priya", round: 1, fields: { ...good1, STANCE: "Strong no" } });
  assert.equal(res.code, 409);
  assert.equal(res.body.error, "This round is already answered.");
  assert.equal(fs.readFileSync(answerPath(dir, "priya", 1), "utf8"), first);
  // already answered wins over invalid fields: there is nothing left to fix
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: { HACK: 1 } }).code, 409);
});

test("submitAnswer after the deadline is 409", () => {
  const S = uniq("sub-late");
  const dir = skillSession(S);
  const deadline = Date.parse(readJson(requestPath(dir, "priya", 1)).deadline);
  const res = submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }, { now: deadline + 1 });
  assert.equal(res.code, 409);
  assert.equal(res.body.error, DEADLINE_MSG);
  assert.ok(!fs.existsSync(answerPath(dir, "priya", 1)));
  assert.equal(readJson(requestPath(dir, "priya", 1)).status, "pending");
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }, { now: deadline }).code, 409, "the deadline moment itself is closed");
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }, { now: deadline - 1 }).code, 200);
  // a request already past its deadline by the real clock
  const old = skillSession(uniq("sub-old"), { deadline: new Date(Date.now() - 1000).toISOString() });
  assert.equal(submitAnswer({ session: path.basename(old), seat: "priya", round: 1, fields: good1 }).body.error, DEADLINE_MSG);
});

test("submitAnswer: a request with no usable deadline or status is closed, not open for ever", () => {
  const nodl = skillSession(uniq("sub-nodl"), { deadline: null });
  assert.equal(submitAnswer({ session: path.basename(nodl), seat: "priya", round: 1, fields: good1 }).code, 409);
  const junk = skillSession(uniq("sub-junk"), { deadline: "soon" });
  assert.equal(submitAnswer({ session: path.basename(junk), seat: "priya", round: 1, fields: good1 }).code, 409);
  const odd = skillSession(uniq("sub-odd"), { status: "weird" });
  assert.equal(submitAnswer({ session: path.basename(odd), seat: "priya", round: 1, fields: good1 }).code, 404);
  assert.deepEqual(fs.readdirSync(path.join(nodl, "inbox")), ["priya-r1.request.json"]);
});

test("submitAnswer 500 when the answer cannot be written, and the request stays open", () => {
  const S = uniq("sub-500");
  const dir = skillSession(S);
  fs.mkdirSync(answerPath(dir, "priya", 1)); // a folder where the answer file must go
  const res = submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 });
  assert.equal(res.code, 500);
  assert.ok(!JSON.stringify(res.body).includes(repo.root), "no path in the message");
  assert.equal(readJson(requestPath(dir, "priya", 1)).status, "pending");
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")).filter((f) => f.endsWith(".tmp")), [], "no temp file left");
  fs.rmdirSync(answerPath(dir, "priya", 1));
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 200);
});

test("submitAnswer 500 when the request cannot be marked answered: the answer file is removed too", () => {
  const S = uniq("sub-500b");
  const dir = skillSession(S);
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { // the answer lands; the status write fails
    if (String(to).endsWith(".request.json")) throw new Error(`disk full at ${to}`);
    return realRename(from, to);
  };
  let res;
  try { res = submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }); } finally { fs.renameSync = realRename; }
  assert.equal(res.code, 500);
  assert.ok(!JSON.stringify(res.body).includes(repo.root) && !/disk full/.test(JSON.stringify(res.body)), "no path or system text in the reply");
  assert.ok(!fs.existsSync(answerPath(dir, "priya", 1)), "no answer file without an answered request");
  assert.equal(readJson(requestPath(dir, "priya", 1)).status, "pending");
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")), ["priya-r1.request.json"], "no temp file or answer left");
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 200, "the person can send it again");
  assert.ok(fs.existsSync(answerPath(dir, "priya", 1)));
  assert.equal(readJson(requestPath(dir, "priya", 1)).status, "answered");
});

// ---------------------------------------------------------------- listPending
test("listPending reads disk requests on a fresh import", async () => {
  const S = uniq("list-fresh");
  const dir = skillSession(S);
  const fresh = await import("../app/lib/inbox.mjs?fresh=restart"); // a new module: empty memory, as after a restart
  assert.notEqual(fresh.listPending, listPending);
  const deadline = readJson(requestPath(dir, "priya", 1)).deadline;
  const mine = fresh.listPending().filter((r) => r.session === S);
  assert.deepEqual(mine, [{
    session: S, source: "skill", seat: "priya", name: "Priya Rao", short: "Priya", round: 1, deadline, prompt: "P",
    fields: ROUND_FIELDS[1], options, context: [{ name: "brief.md", text: BRIEF }],
  }]);
  assert.equal(fresh.submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 200, "and the fresh module can answer it");
});

test("listPending: context comes from readContext, so round 2 shows the brief, Round 1 cards and cruxes", () => {
  const S = uniq("list-ctx");
  const dir = skillSession(S, { round: 2 });
  fs.writeFileSync(path.join(dir, "cruxes.json"), '{"cruxes":[]}\n');
  const [r] = listPending().filter((x) => x.session === S);
  assert.deepEqual(r.context.map((c) => c.name), ["brief.md", "round-1.md", "cruxes.json"]);
  assert.deepEqual(r.fields, ROUND_FIELDS[2]);
});

test("listPending never reads a file that a request names", () => {
  const S = uniq("list-names");
  const dir = skillSession(S);
  const secret = path.join(repo.root, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET");
  const req = readJson(requestPath(dir, "priya", 1));
  writeRequest(dir, { ...req, context: ["../../secret.txt", secret, "brief.md"] });
  const [r] = listPending().filter((x) => x.session === S);
  assert.deepEqual(r.context.map((c) => c.name), ["brief.md"]);
  assert.ok(!JSON.stringify(r).includes("TOP-SECRET"));
});

test("listPending hides answered and expired requests", () => {
  const live = uniq("list-live");
  const done = uniq("list-done");
  const late = uniq("list-late");
  skillSession(live);
  skillSession(done);
  skillSession(late, { deadline: new Date(Date.now() - 60000).toISOString() });
  assert.equal(submitAnswer({ session: done, seat: "priya", round: 1, fields: good1 }).code, 200);
  const sessions = (list) => list.map((r) => r.session);
  const now = listPending();
  assert.ok(sessions(now).includes(live));
  assert.ok(!sessions(now).includes(done));
  assert.ok(!sessions(now).includes(late));
  const deadline = Date.parse(listPending().find((r) => r.session === live).deadline);
  assert.ok(sessions(listPending({ now: deadline - 1 })).includes(live));
  assert.ok(!sessions(listPending({ now: deadline })).includes(live), "closed at the deadline moment, as submitAnswer closes it");
  assert.ok(!sessions(listPending({ now: deadline + 1 })).includes(live));
});

test("listPending skips what the form could not answer", () => {
  const nocouncil = uniq("list-nocouncil");
  skillSession(nocouncil, { council: false });
  const ai = uniq("list-ai");
  skillSession(ai, { seat: "bezos" });
  const nodl = uniq("list-nodl");
  skillSession(nodl, { deadline: null });
  const junk = uniq("list-junk");
  skillSession(junk, { deadline: "soon" });
  const mismatch = uniq("list-mismatch");
  const dir = skillSession(mismatch);
  fs.renameSync(requestPath(dir, "priya", 1), path.join(dir, "inbox", "priya-r2.request.json")); // says round 1, named round 2
  const corrupt = uniq("list-corrupt");
  fs.writeFileSync(requestPath(skillSession(corrupt), "priya", 1), "{ no");
  const there = new Set(listPending().map((r) => r.session));
  for (const s of [nocouncil, ai, nodl, junk, mismatch, corrupt]) assert.ok(!there.has(s), s);
  for (const s of [nocouncil, ai, nodl, junk, mismatch, corrupt]) {
    assert.notEqual(submitAnswer({ session: s, seat: s === ai ? "bezos" : "priya", round: 1, fields: good1 }).code, 200, `${s} cannot be answered either`);
  }
});

test("listPending lists several people and rounds in a stable order, and survives odd folders", () => {
  fs.mkdirSync(path.join(SESSIONS_DIR, ".hidden"), { recursive: true });
  fs.mkdirSync(path.join(SESSIONS_DIR, "bad name"), { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, "not-a-folder.md"), "x");
  const S = uniq("list-multi");
  const dir = skillSession(S, { seat: "priya", round: 3 });
  writeRequest(dir, { seat: "arjun", round: 3, prompt: "", fields: ROUND_FIELDS[3], context: [], options, deadline: deadlineFrom(), status: "pending" });
  const mine = listPending().filter((r) => r.session === S);
  assert.deepEqual(mine.map((r) => [r.seat, r.short, r.name]), [["arjun", "Arjun", "Arjun Mehta"], ["priya", "Priya", "Priya Rao"]]);
  const z = skillSession("zzz-order");
  const a = skillSession("aaa-order");
  assert.deepEqual(listPending().filter((r) => /-order$/.test(r.session)).map((r) => r.session), ["aaa-order", "zzz-order"]);
  assert.ok(z && a);
});

test("listPending is empty when the sessions folder is missing", () => {
  fs.renameSync(SESSIONS_DIR, `${SESSIONS_DIR}.away`);
  try { assert.deepEqual(listPending(), []); } finally { fs.renameSync(`${SESSIONS_DIR}.away`, SESSIONS_DIR); }
});

// ---------------------------------------------------------------- API runner (memory)
test("openApiRequest resolves with the card text on a valid submit", async () => {
  const id = apiId("api-ok");
  const before = timers();
  const context = [{ name: "brief.md", text: BRIEF }];
  const p = openApiRequest(id, { seat: "priya", round: 1, prompt: "P", options, context });
  assert.equal(timers(), before + 1, "one deadline timer while pending");
  const [r] = listPending().filter((x) => x.session === id);
  assert.deepEqual(r, {
    session: id, source: "api", seat: "priya", name: "Priya Rao", short: "Priya", round: 1, deadline: r.deadline, prompt: "P",
    fields: ROUND_FIELDS[1], options, context,
  });
  const ms = Date.parse(r.deadline) - Date.now();
  assert.ok(ms > 29 * 60000 && ms <= 30 * 60000, `deadline is about 30 minutes away: ${ms}`);
  const res = submitAnswer({ session: id, seat: "priya", round: 1, fields: full1 });
  assert.equal(res.code, 200);
  assert.equal(await soon(p), cardText({ seat: byKey.priya, round: 1, fields: full1, optionIds: ids }));
  assert.equal(timers(), before, "the deadline timer is cleared once answered");
  assert.deepEqual(listPending().filter((x) => x.session === id), []);
  assert.equal(submitAnswer({ session: id, seat: "priya", round: 1, fields: good1 }).code, 409);
  assert.ok(!fs.existsSync(path.join(SESSIONS_DIR, id)), "an API session writes no files");
  dropApiSession(id);
});

test("openApiRequest rejects at the deadline, and a late submit is 409", async () => {
  await withEnv("HUMAN_DEADLINE_MIN", "0.002", async () => {
    const id = apiId("api-late");
    const before = timers();
    const p = openApiRequest(id, { seat: "priya", round: 1, prompt: "", options, context: [] });
    const t0 = Date.now();
    await assert.rejects(soon(p), { message: "deadline" });
    assert.ok(Date.now() - t0 >= 100, "waited for the deadline");
    assert.equal(timers(), before, "the timer is gone");
    assert.deepEqual(listPending().filter((x) => x.session === id), []);
    const res = submitAnswer({ session: id, seat: "priya", round: 1, fields: good1 });
    assert.equal(res.code, 409);
    assert.equal(res.body.error, DEADLINE_MSG);
    dropApiSession(id);
  });
});

test("an API request past its deadline refuses a submit even before the timer fires", async () => {
  const id = apiId("api-clock");
  const p = openApiRequest(id, { seat: "priya", round: 1, prompt: "", options, context: [] });
  const deadline = Date.parse(listPending().find((x) => x.session === id).deadline);
  assert.equal(submitAnswer({ session: id, seat: "priya", round: 1, fields: good1 }, { now: deadline + 1 }).code, 409);
  assert.equal(submitAnswer({ session: id, seat: "priya", round: 1, fields: { ...good1, CONFIDENCE: 9 } }).code, 400);
  dropApiSession(id);
  await assert.rejects(soon(p), { message: "session ended" });
});

test("API requests are checked like disk ones: 400 fields, 404 other round or person, 409 repeat", async () => {
  const id = apiId("api-codes");
  const p = openApiRequest(id, { seat: "priya", round: 2, prompt: "", options, context: [] });
  assert.equal(submitAnswer({ session: id, seat: "priya", round: 2, fields: { ...good2, CONFIDENCE: 0 } }).code, 400);
  assert.equal(submitAnswer({ session: id, seat: "priya", round: 1, fields: good1 }).code, 404, "other round");
  assert.equal(submitAnswer({ session: id, seat: "arjun", round: 2, fields: good2 }).code, 404, "other person");
  assert.equal(submitAnswer({ session: id, seat: "bezos", round: 2, fields: good2 }).code, 404, "not a person");
  assert.equal(submitAnswer({ session: id, seat: "priya", round: 2, fields: good2 }).code, 200);
  assert.equal(await soon(p), cardText({ seat: byKey.priya, round: 2, fields: good2, optionIds: ids }));
  assert.equal(submitAnswer({ session: id, seat: "priya", round: 2, fields: good2 }).code, 409);
  dropApiSession(id);
});

test("an API session id never falls back to a folder of the same name", async () => {
  const id = apiId("api-vs-disk");
  skillSession(id, { seat: "arjun", round: 1 }); // a skill-style folder with a pending request for arjun
  const p = openApiRequest(id, { seat: "priya", round: 1, prompt: "", options, context: [] });
  const mine = listPending().filter((x) => x.session === id);
  assert.deepEqual(mine.map((r) => [r.source, r.seat]), [["api", "priya"]], "memory wins; the folder is not listed twice");
  assert.equal(submitAnswer({ session: id, seat: "arjun", round: 1, fields: good1 }).code, 404);
  dropApiSession(id);
  await assert.rejects(soon(p));
  assert.equal(submitAnswer({ session: id, seat: "arjun", round: 1, fields: good1 }).code, 200, "once the API session is gone the folder answers");
});

test("dropApiSession rejects and clears that session's pending requests only", async () => {
  const a = apiId("api-drop-a");
  const b = apiId("api-drop-b");
  const before = timers();
  const outcome = (p) => p.then(() => "resolved", (e) => e.message); // attaches a handler at once
  const pa1 = outcome(openApiRequest(a, { seat: "priya", round: 1, prompt: "", options, context: [] }));
  const pa2 = outcome(openApiRequest(a, { seat: "arjun", round: 1, prompt: "", options, context: [] }));
  const pb = openApiRequest(b, { seat: "priya", round: 1, prompt: "", options, context: [] });
  assert.equal(timers(), before + 3);
  dropApiSession(a);
  assert.deepEqual(await soon(Promise.all([pa1, pa2])), ["session ended", "session ended"]);
  assert.equal(timers(), before + 1, "only b's timer is left");
  assert.deepEqual(listPending().filter((x) => x.session === a), []);
  assert.equal(submitAnswer({ session: a, seat: "priya", round: 1, fields: good1 }).code, 404);
  assert.equal(listPending().filter((x) => x.session === b).length, 1);
  assert.equal(submitAnswer({ session: b, seat: "priya", round: 1, fields: good1 }).code, 200);
  await soon(pb);
  dropApiSession(a); // dropping again, or an unknown session, is harmless
  dropApiSession("never-opened");
  dropApiSession(b);
  assert.equal(submitAnswer({ session: b, seat: "priya", round: 1, fields: good1 }).code, 404, "answered entries are cleared too");
  assert.equal(timers(), before);
});

test("openApiRequest replaces an open request for the same seat and round", async () => {
  const id = apiId("api-twice");
  const first = openApiRequest(id, { seat: "priya", round: 1, prompt: "one", options, context: [] }).then(() => "resolved", (e) => e.message);
  const second = openApiRequest(id, { seat: "priya", round: 1, prompt: "two", options, context: [] });
  assert.equal(await soon(first), "replaced");
  assert.deepEqual(listPending().filter((x) => x.session === id).map((x) => x.prompt), ["two"]);
  assert.equal(submitAnswer({ session: id, seat: "priya", round: 1, fields: good1 }).code, 200);
  await soon(second);
  dropApiSession(id);
});

test("openApiRequest refuses ids that are not ids and seats that are not people", async () => {
  const req = { seat: "priya", round: 1, prompt: "", options, context: [] };
  const before = timers();
  for (const [id, over] of [["../x", {}], ["", {}], ["a/b", {}], ["ok-id", { seat: "Priya" }], ["ok-id", { seat: "bezos" }], ["ok-id", { seat: "nobody" }], ["ok-id", { round: 4 }], ["ok-id", { round: "1" }]]) {
    await assert.rejects(openApiRequest(id, { ...req, ...over }), /invalid|person/i, JSON.stringify([id, over]));
  }
  assert.equal(timers(), before, "a refused request leaves no timer");
  assert.deepEqual(listPending().filter((x) => x.session === "ok-id"), []);
});

test("a huge HUMAN_DEADLINE_MIN neither expires the request at once nor trips the timer overflow warning", async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on("warning", onWarning);
  try {
    await withEnv("HUMAN_DEADLINE_MIN", "100000", async () => { // longer than setTimeout can count
      const id = apiId("api-huge");
      const p = openApiRequest(id, { seat: "priya", round: 1, prompt: "", options, context: [] });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(listPending().filter((x) => x.session === id).length, 1, "still open");
      assert.equal(submitAnswer({ session: id, seat: "priya", round: 1, fields: good1 }).code, 200);
      await soon(p);
    });
  } finally {
    process.off("warning", onWarning);
  }
  assert.deepEqual(warnings, []);
});

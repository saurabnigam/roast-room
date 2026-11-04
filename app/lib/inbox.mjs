// The inbox: how a person (a "human" seat) answers a round.
//
// A request says "this person owes a card for round N". Two kinds of session keep it differently:
//   skill session  (the Chair runs in Claude Code): a file, sessions/<id>/inbox/<seat>-r<N>.request.json.
//                  The room's form posts the answer; submitAnswer writes <seat>-r<N>.answer.md in the
//                  exact card format and marks the request "answered". The Chair's wait script and the
//                  watcher read those files. A request on disk survives a restart of the room.
//   API session    (the app's own runner): memory only, keyed "<session>/<seat>/<round>". The runner
//                  awaits openApiRequest; submitAnswer resolves it with the card text.
//
// The card text is the same plain text an AI seat writes, so the watcher, scoring and verdict code
// read it with no change. A person's words are neutralised first, so a line that looks like a
// heading or a "SEAT:" line cannot split one card into two.
//
// submitAnswer and listPending are synchronous on purpose. The server runs on one thread, so a
// request is checked and written with nothing else running between the steps.
import fs from "node:fs";
import path from "node:path";
import { env, SESSIONS_DIR } from "./env.mjs";
import { byKey, loadRoster } from "./seats.mjs";
import { readContext } from "./seatprompt.mjs";
// The form fields live in app/public/runners.js, so the browser form and this validation share one copy.
import { ROUND_FIELDS, CHOICES, MULTILINE } from "../public/runners.js";

export { ROUND_FIELDS, CHOICES, MULTILINE };

// The rule for a session folder name. The room shows a form only for a folder named like this directly
// under sessions/, and wait_answers.mjs refuses any other folder, so both use this one expression.
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/;
const SEAT_KEY = /^[a-z][a-z0-9]{1,15}$/;
const ROUNDS = [1, 2, 3];
const MAX_TEXT = 2000;
const DEFAULT_DEADLINE_MIN = 30;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout fires at once for anything longer
const SCORE_FIELDS = new Set(["PILLAR SCORE", "FINAL SCORE", "FINAL PILLAR SCORE"]);

const MSG = {
  none: "No such request.",
  answered: "This round is already answered.",
  late: "The deadline for this round has passed. The council moved on without this answer.",
  badIds: "The session, seat or round is not valid.",
  badFields: "Some answers need fixing.",
  notSaved: "The answer could not be saved. Try again.",
};
const reply = (code, body) => ({ code, body });
const fail = (code, error, errors = [error]) => reply(code, { error, errors });

// ---------------------------------------------------------------- the person's words
// parseCard reads a card by finding lines that look like "LABEL: value", and it takes the first
// one it finds. A person's text sits inside the card, so it must never look like a field, a
// heading or a "SEAT:" line, or it can split the card or override the person's own answers
// (Round 2 puts ON THE CRUXES before STANCE, OPTION SCORES and CONFIDENCE). Each line of a
// person's text is cleaned like this, in this order:
//   1. "·" becomes "," and "|" becomes "/". parseCard accepts either as a separator before a
//      label in the middle of a line, and cuts a value at "·".
//   2. Leading "#" characters are removed (a heading would start a new card).
//   3. A line that starts with "SEAT:" (any case, with or without Markdown emphasis) becomes
//      "Seat note:" (a SEAT line would start a new card).
//   4. A line that starts with a card label gets "- " in front, so it reads as a bullet. "Starts
//      with" allows the ways parseCard looks through Markdown: spaces, tabs, ">", "#", "*" and "_"
//      before the label, bold around it, a space before the colon, and a bare label with no colon
//      (parseCard joins a bare label to the next line).
//   5. "OPTION SCORES:" anywhere in a line loses its colon. This is a second layer: parseCard now reads
//      the label only at a line start or after a separator, but older cards and other parsers may not.
//      A single-line field is joined from several lines, so the colon is stripped again after the join.
// Lines split on every line break JavaScript's "^" honours, not only "\n".
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;
const LEADING_HASHES = /^[ \t]*#[# \t]*/;
const SEAT_LINE = /^[ \t]*(?:[*_]{1,2}[ \t]*)?seat[ \t]*(?:[*_]{1,2}[ \t]*)?:(?:[*_]{1,2})?/i;
// Every field name on any card, plus SEAT. seats.mjs does not export its label sets, so a test
// reads them from the source and checks that this list covers them.
const CARD_LABELS = [...new Set([...Object.values(ROUND_FIELDS).flatMap((r) => [...r.required, ...r.optional]), "SEAT"])]
  .sort((a, b) => b.length - a.length);
const STARTS_WITH_LABEL = new RegExp(`^[\\s>#*_]*(?:${CARD_LABELS.join("|")})[*_ \\t]*(?::|$)`, "i");
const OPTION_SCORES_COLON = /(OPTION SCORES[*_ \t]*):/gi;
function cleanLine(line) {
  let out = line.replace(/·/g, ",").replace(/\|/g, "/").replace(LEADING_HASHES, "").replace(SEAT_LINE, "Seat note:");
  if (STARTS_WITH_LABEL.test(out)) out = `- ${out}`;
  return out.replace(OPTION_SCORES_COLON, "$1 -").trimEnd();
}
const cleanLines = (value) => String(value).split(LINE_BREAK).map(cleanLine);
// Joining lines with a space can put the pieces of "OPTION SCORES" and its colon side by side
// ("option" / "scores: ..."), so the colon is stripped again on the joined text.
const oneLine = (value) => cleanLines(value).map((l) => l.trim()).filter(Boolean).join(" ").replace(OPTION_SCORES_COLON, "$1 -");
const manyLines = (value) => cleanLines(value).join("\n").trim();
// Nothing there: absent, null, or text that is empty once cleaned (what is printed is what is checked).
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && manyLines(v) === "");

// A whole number, from a number or from plain digits (a form sends strings). Else null.
function whole(v) {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}
const inRange = (v, lo, hi) => {
  const n = whole(v);
  return n !== null && n >= lo && n <= hi ? n : null;
};
const shown = (name) => JSON.stringify(String(name).slice(0, 40));

// ---------------------------------------------------------------- validation
function checkScores(value, optionIds) {
  if (!Array.isArray(optionIds) || !optionIds.length) return "OPTION SCORES cannot be checked: this request has no options.";
  if (!value || typeof value !== "object" || Array.isArray(value)) return "OPTION SCORES must give a score for each option.";
  const problems = [];
  for (const id of optionIds) {
    if (!Object.hasOwn(value, id)) problems.push(`needs a score for option ${id}`);
    else if (inRange(value[id], 0, 10) === null) problems.push(`option ${id} must be a whole number from 0 to 10`);
  }
  for (const id of Object.keys(value)) if (!optionIds.includes(id)) problems.push(`option ${shown(id)} does not exist`);
  return problems.length ? `OPTION SCORES ${problems.join("; ")}.` : null;
}

function checkField(name, value, optionIds) {
  if (name === "OPTION SCORES") return checkScores(value, optionIds);
  if (Object.hasOwn(CHOICES, name)) {
    return typeof value === "string" && CHOICES[name].includes(value) ? null : `${name} must be one of: ${CHOICES[name].join(", ")}.`;
  }
  if (name === "CONFIDENCE") return inRange(value, 1, 5) === null ? "CONFIDENCE must be a whole number from 1 to 5." : null;
  if (SCORE_FIELDS.has(name)) return inRange(value, 0, 10) === null ? `${name} must be a whole number from 0 to 10.` : null;
  if (typeof value !== "string") return `${name} must be text.`;
  if (value.length > MAX_TEXT) return `${name} is too long. The limit is ${MAX_TEXT} characters.`;
  return null;
}

/** The problems with an answer, in plain words. An empty list means it is valid.
 * `fields` maps field name to value; OPTION SCORES is { [optionId]: 0 to 10 }. */
export function validateAnswer(round, fields, optionIds) {
  if (!ROUNDS.includes(round)) return ["The round must be 1, 2 or 3."];
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return ["The answer has no fields."];
  const { required, optional } = ROUND_FIELDS[round];
  const errors = [];
  for (const name of Object.keys(fields)) {
    if (!required.includes(name) && !optional.includes(name)) errors.push(`${shown(name)} is not a field on this card.`);
  }
  for (const name of [...required, ...optional]) {
    const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (isBlank(value)) {
      if (required.includes(name)) errors.push(`${name} is required.`);
      continue;
    }
    const problem = checkField(name, value, optionIds);
    if (problem) errors.push(problem);
  }
  return errors;
}

// ---------------------------------------------------------------- the card
// Field order follows round1Prompt, round2Prompt and round3Prompt in council.mjs. null is a blank line.
const LAYOUT = {
  1: ["STANCE", "OPTION SCORES", "PILLAR SCORE", "CONFIDENCE", "RUIN RISK", "DOOR", null, "THE CALL", "WHY", "THE RISK I SEE", "WHAT WOULD CHANGE MY MIND", "WHAT I'D DO THIS WEEK", "QUESTION FOR THE FOUNDER"],
  2: ["I DISAGREE MOST WITH", "I CONCEDE", "ON THE CRUXES", "STANCE", "OPTION SCORES", "PILLAR SCORE", "CONFIDENCE", "RUIN RISK", "MOVED", "MY CONDITIONS FOR YES"],
  3: ["VOTE", "OPTION SCORES", "FINAL SCORE", "FINAL PILLAR SCORE", "AMENDMENT OR DISSENT", "ONE LINE FOR THE FOUNDER"],
};

function scoreOf(name, value, outOf) {
  const n = whole(value);
  if (n === null) throw new RangeError(`${name} is not a whole number`);
  return `${n}/${outOf}`;
}

/** The card a person's answer becomes, in the same text an AI seat writes. Call it with fields that
 * passed validateAnswer. It ends without a newline. Absent optional fields are left out. */
export function cardText({ seat, round, fields, optionIds }) {
  if (!Object.hasOwn(LAYOUT, round)) throw new RangeError(`round must be 1, 2 or 3, not ${String(round)}`);
  const head = `SEAT: ${seat.short.toUpperCase()}`;
  const lines = [round === 1 ? `${head} (${seat.pillar})` : head];
  for (const name of LAYOUT[round]) {
    if (name === null) { lines.push(""); continue; }
    const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (isBlank(value)) continue;
    if (name === "OPTION SCORES") {
      const parts = optionIds.filter((id) => Object.hasOwn(value, id)).map((id) => `${id} ${scoreOf(name, value[id], 10)}`);
      if (parts.length) lines.push(`${name}: ${parts.join(" · ")}`);
    } else if (name === "CONFIDENCE") {
      lines.push(`${name}: ${scoreOf(name, value, 5)}`);
    } else if (SCORE_FIELDS.has(name)) {
      lines.push(`${name}: ${scoreOf(name, value, 10)}`);
    } else if (MULTILINE.includes(name)) {
      lines.push(`${name}:`, manyLines(value));
    } else {
      lines.push(`${name}: ${oneLine(value)}`);
    }
  }
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------- deadlines and paths
/** When a request made at `now` closes. HUMAN_DEADLINE_MIN is read on every call. It may be a
 * fraction. Anything that is not a positive number of minutes the clock can hold means 30. */
export function deadlineFrom(now = Date.now()) {
  const asked = Number(env("HUMAN_DEADLINE_MIN"));
  for (const minutes of [asked, DEFAULT_DEADLINE_MIN]) {
    if (!(Number.isFinite(minutes) && minutes > 0)) continue;
    const at = new Date(now + minutes * 60000);
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }
  return new Date(now + DEFAULT_DEADLINE_MIN * 60000).toISOString();
}

function inboxFile(sessionDir, seat, round, ext) {
  if (typeof seat !== "string" || !SEAT_KEY.test(seat) || !ROUNDS.includes(round)) {
    throw new TypeError("An inbox file needs a seat key and a round of 1, 2 or 3.");
  }
  return path.join(sessionDir, "inbox", `${seat}-r${round}.${ext}`);
}
export const requestPath = (sessionDir, seat, round) => inboxFile(sessionDir, seat, round, "request.json");
export const answerPath = (sessionDir, seat, round) => inboxFile(sessionDir, seat, round, "answer.md");

// Write a whole file or none of it: a temp file in the same folder, then a rename. A reader never
// sees half a file. The temp name ends in ".tmp", so it matches neither "*.request.json" nor "*.answer.md".
let tmpCount = 0;
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${++tmpCount}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

// ---------------------------------------------------------------- request files
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function readRequestFiles(sessionDir) {
  let names;
  try { names = fs.readdirSync(path.join(sessionDir, "inbox")); } catch { return []; }
  const out = [];
  for (const name of names.filter((f) => f.endsWith(".request.json")).sort()) {
    try {
      const req = JSON.parse(fs.readFileSync(path.join(sessionDir, "inbox", name), "utf8"));
      if (isObject(req)) out.push({ name, req });
    } catch { /* unreadable: skipped */ }
  }
  return out;
}

/** Every request in sessions/<id>/inbox, parsed, in file-name order. Unreadable files are skipped. */
export const readRequests = (sessionDir) => readRequestFiles(sessionDir).map((f) => f.req);

/** Write a request file, whole or not at all. Returns its path. The caller supplies the full request:
 * { seat, round, prompt, fields, context, options, deadline, status: "pending" }. */
export function writeRequest(sessionDir, req) {
  const file = requestPath(sessionDir, req?.seat, req?.round);
  writeAtomic(file, JSON.stringify(req, null, 2) + "\n");
  return file;
}

// ---------------------------------------------------------------- which session, which person
const humanSeat = (key) => (Object.hasOwn(byKey, key) && byKey[key].provider === "human" ? byKey[key] : null);

// A skill session is a folder with council.json in it.
function skillDir(id) {
  const dir = path.join(SESSIONS_DIR, id);
  try { return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "council.json")) ? dir : null; } catch { return null; }
}

// API-runner requests, in memory. Entry: { session, seat, round, prompt, options, context, deadline,
// deadlineMs, status: "pending"|"answered"|"expired"|"dropped", timer, resolve, reject }.
const apiRequests = new Map();
const apiKey = (session, seat, round) => `${session}/${seat}/${round}`;
function hasApiSession(id) {
  const prefix = `${id}/`;
  for (const key of apiRequests.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

function arm(entry) {
  const left = Math.max(entry.deadlineMs - Date.now(), 0);
  entry.timer = setTimeout(() => {
    if (entry.status !== "pending") return;
    if (Date.now() < entry.deadlineMs) { arm(entry); return; } // the timer ran short or was capped
    entry.status = "expired";
    entry.reject(new Error("deadline"));
  }, Math.min(left, MAX_TIMER_MS));
}
function endPending(entry, status, reason) {
  entry.status = status;
  clearTimeout(entry.timer);
  entry.reject(new Error(reason));
}

/** Ask a person for a card in an API session. Resolves with the card text when a valid answer
 * arrives. Rejects with Error("deadline") when time runs out. It never writes a file. */
export function openApiRequest(sessionId, { seat, round, prompt, options, context } = {}) {
  return new Promise((resolve, reject) => {
    loadRoster();
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || typeof seat !== "string" || !SEAT_KEY.test(seat) || !ROUNDS.includes(round)) {
      throw new Error("invalid request: the session, seat or round is not valid");
    }
    if (!humanSeat(seat)) throw new Error(`invalid request: ${seat} is not a person on this roster`);
    const key = apiKey(sessionId, seat, round);
    const old = apiRequests.get(key);
    if (old?.status === "pending") endPending(old, "dropped", "replaced");
    const deadline = deadlineFrom();
    const entry = {
      session: sessionId, seat, round, prompt: typeof prompt === "string" ? prompt : "", options, context,
      deadline, deadlineMs: Date.parse(deadline), status: "pending", timer: null, resolve, reject,
    };
    apiRequests.set(key, entry);
    arm(entry);
  });
}

/** The session is over: reject what is still waiting, and forget every request it had. */
export function dropApiSession(sessionId) {
  const prefix = `${sessionId}/`;
  for (const [key, entry] of [...apiRequests]) {
    if (!key.startsWith(prefix)) continue;
    apiRequests.delete(key);
    clearTimeout(entry.timer); // whatever state it is in, no timer may outlive its entry
    if (entry.status === "pending") endPending(entry, "dropped", "session ended");
  }
}

// ---------------------------------------------------------------- listing and answering
/** Requests that wait for a person now: still "pending" and before their deadline. */
export function listPending({ now = Date.now() } = {}) {
  loadRoster();
  const out = [];
  const add = (source, session, req, context) => {
    const seat = byKey[req.seat];
    out.push({
      session, source, seat: req.seat, name: seat.name, short: seat.short, round: req.round, deadline: req.deadline,
      prompt: typeof req.prompt === "string" ? req.prompt : "", fields: ROUND_FIELDS[req.round],
      options: Array.isArray(req.options) ? req.options : [], context,
    });
  };

  let folders = [];
  try { folders = fs.readdirSync(SESSIONS_DIR).sort(); } catch { /* no sessions folder yet */ }
  for (const id of folders) {
    if (!SESSION_ID.test(id) || hasApiSession(id)) continue;
    const dir = skillDir(id);
    if (!dir) continue;
    for (const { name, req } of readRequestFiles(dir)) {
      if (req.status !== "pending" || typeof req.deadline !== "string" || !(Date.parse(req.deadline) > now)) continue;
      if (typeof req.seat !== "string" || !SEAT_KEY.test(req.seat) || !ROUNDS.includes(req.round)) continue;
      if (name !== `${req.seat}-r${req.round}.request.json` || !humanSeat(req.seat)) continue;
      let context;
      try { context = readContext(dir, req.round, req.seat); } catch { continue; }
      add("skill", id, req, context);
    }
  }
  for (const entry of apiRequests.values()) {
    if (entry.status === "pending" && entry.deadlineMs > now && humanSeat(entry.seat)) {
      add("api", entry.session, entry, Array.isArray(entry.context) ? entry.context : []);
    }
  }
  return out;
}

// The request a submit is aimed at, wherever it lives. An API session id uses memory only.
function findRequest(session, seat, round) {
  if (hasApiSession(session)) {
    const entry = apiRequests.get(apiKey(session, seat, round));
    return entry ? { entry, options: entry.options, deadlineMs: entry.deadlineMs, status: entry.status } : null;
  }
  const dir = skillDir(session);
  if (!dir) return null;
  let req;
  try { req = JSON.parse(fs.readFileSync(requestPath(dir, seat, round), "utf8")); } catch { return null; }
  if (!isObject(req) || req.seat !== seat || req.round !== round || (req.status !== "pending" && req.status !== "answered")) return null;
  // A deadline that is not text is no deadline: Date.parse would read 12345 as a year.
  return { dir, req, options: req.options, deadlineMs: typeof req.deadline === "string" ? Date.parse(req.deadline) : NaN, status: req.status };
}

/** Check a person's answer and hand it on. Returns { code, body }:
 *   400 the ids or the fields are not valid ({ error, errors })   404 no such request
 *   409 already answered, or past its deadline                     200 accepted
 * Skill session: writes <seat>-r<N>.answer.md, then marks the request "answered".
 * API session: resolves the promise openApiRequest returned. */
export function submitAnswer(input, { now = Date.now() } = {}) {
  const { session, seat, round, fields } = isObject(input) ? input : {};
  if (typeof session !== "string" || !SESSION_ID.test(session) || typeof seat !== "string" || !SEAT_KEY.test(seat) || !ROUNDS.includes(round)) {
    return fail(400, MSG.badIds);
  }
  loadRoster();
  const person = humanSeat(seat);
  const found = person && findRequest(session, seat, round);
  if (!found) return fail(404, MSG.none);
  if (found.status === "answered") return fail(409, MSG.answered);
  if (found.status !== "pending" || !(found.deadlineMs > now)) return fail(409, MSG.late); // expired, or no usable deadline

  const optionIds = Array.isArray(found.options) ? found.options.map((o) => o?.id).filter((id) => typeof id === "string") : [];
  const errors = validateAnswer(round, fields, optionIds);
  if (errors.length) return fail(400, MSG.badFields, errors);

  const card = cardText({ seat: person, round, fields, optionIds });
  if (found.entry) {
    found.entry.status = "answered";
    clearTimeout(found.entry.timer);
    found.entry.resolve(card);
    return reply(200, { ok: true });
  }
  // The answer file first, then the status, so anyone who sees "answered" finds the answer. If the
  // status write fails, take the answer file back (best effort): an answer with a request still
  // "pending" is a half-saved answer, and a retry writes both again. Replies carry no path or system text.
  const answerFile = answerPath(found.dir, seat, round);
  try {
    writeAtomic(answerFile, card + "\n");
  } catch {
    return fail(500, MSG.notSaved);
  }
  try {
    writeAtomic(requestPath(found.dir, seat, round), JSON.stringify({ ...found.req, status: "answered", answeredAt: new Date(now).toISOString() }, null, 2) + "\n");
  } catch {
    try { fs.unlinkSync(answerFile); } catch { /* best effort */ }
    return fail(500, MSG.notSaved);
  }
  return reply(200, { ok: true });
}

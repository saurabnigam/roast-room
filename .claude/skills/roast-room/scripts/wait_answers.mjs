#!/usr/bin/env node
// wait_answers.mjs: in the Claude Code path, the Chair runs this in the background when people (human
// seats) sit on the panel. Node 20 or newer, no dependencies.
//
//   node wait_answers.mjs --session <dir> --round <1|2|3> --seats a,b [--prompt-file f] [--deadline-min 30] [--poll-ms 2000]
//
// For each named person with no request for the round, it writes sessions/<id>/inbox/<key>-r<N>.request.json:
// { seat, round, prompt, fields, context, options, deadline, status: "pending" }. The room on this Mac shows
// that person a form. The server writes <key>-r<N>.answer.md and sets the request's status to "answered".
// This script polls the requests until every one is answered or the deadline passes.
//
// Exit codes:
//   0  every person has answered. One line each on stdout:   answered: <key> <absolute answer path>
//   4  the deadline passed. On stdout:  missing: <comma-separated keys>,  then an "answered:" line for
//      each person who did answer.
//   2  it cannot run: a bad argument, a seat that is not a person, no council.json, a session folder that
//      is not directly under sessions/ or has a name that is not a valid session id (the room would never
//      show the form), or an unexpected failure. One line on stderr:  wait_answers: <reason>
//
// A request is answered when its JSON says status "answered". The answer file is written before that
// status, and is taken back if the status cannot be written, so the file alone proves nothing.
// A request file that is cut off, empty, not JSON or not an object counts as not answered yet. It is never
// rewritten, and it never crashes the wait.
// An existing request is kept as it is, deadline included, so a re-run does not extend the wait.
// The deadline for exit 4 is the latest deadline among the requests still unanswered. A person who has
// answered no longer counts: their deadline cannot keep the wait open for someone whose form has closed. A
// request that cannot be read now keeps its last readable deadline. When no unanswered request has ever had a
// readable deadline, it is the one this run would give a new request.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// The app modules load here, not in import statements, so that a failure while loading them can be
// reported as one line and exit 2 when this is run as a script. An importer still sees the failure:
// it is rethrown at the bottom.
let byKey, loadRoster, contextFiles, ROUND_FIELDS, SESSION_ID, deadlineFrom, requestPath, answerPath, writeRequest, SESSIONS_DIR;
let startupError = null;
try {
  ({ SESSIONS_DIR } = await import("../../../../app/lib/env.mjs"));
  ({ byKey, loadRoster } = await import("../../../../app/lib/seats.mjs"));
  ({ contextFiles } = await import("../../../../app/lib/seatprompt.mjs"));
  ({ ROUND_FIELDS, SESSION_ID, deadlineFrom, requestPath, answerPath, writeRequest } = await import("../../../../app/lib/inbox.mjs"));
} catch (e) {
  startupError = e;
}

const SEAT_KEY = /^[a-z][a-z0-9]{1,15}$/; // the same rule the inbox applies to a file name
const MAX_REASON_CHARS = 300;
const MIN_POLL_MS = 10; // below this the loop would read the inbox in a tight spin
const MAX_POLL_MS = 2 ** 31 - 1; // the longest time setTimeout can count

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const firstLine = (e) => String(e instanceof Error ? e.message : e).split(/\r?\n/)[0].slice(0, MAX_REASON_CHARS) || "unexpected error";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A refusal: exit 2. Nothing was waited on, so `answered` and `missing` are empty and mean nothing. */
const refuse = (reason) => ({ code: 2, answered: [], missing: [], reason });

// ---------------------------------------------------------------- reading the session

/** Why this folder is not a session the room can show a form for, or "" when it is one. The room reads
 * only a folder directly under sessions/ whose name is a valid session id (the inbox's own rule). A
 * request written anywhere else would never be shown, and the person would be absent for the whole wait. */
function placeProblem(dir) {
  if (!SESSION_ID.test(path.basename(dir))) {
    return "the session folder name is not a valid session id: use letters, digits and hyphens, starting with a letter or digit, 81 characters at most";
  }
  try {
    if (fs.realpathSync(path.dirname(dir)) === fs.realpathSync(SESSIONS_DIR)) return "";
  } catch { /* a folder that is not there is not the sessions folder */ }
  return "the session folder must sit directly inside the sessions folder (sessions/<id>), or the room cannot show the form";
}

/** council.json as an object, or a reason string. */
function readCouncil(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, "council.json"), "utf8");
  } catch (e) {
    return { reason: e?.code === "ENOENT" || e?.code === "ENOTDIR" ? `no council.json in ${dir}` : `cannot read council.json in ${dir}: ${e?.code ?? firstLine(e)}` };
  }
  let council;
  try {
    council = JSON.parse(raw);
  } catch {
    return { reason: `council.json in ${dir} is not valid JSON` };
  }
  return isObject(council) ? { council } : { reason: `council.json in ${dir} is not a JSON object` };
}

/** The options as the room reads them (watch.mjs): a plain string takes A, B, C, D by position; an object
 * keeps its id, upper-cased, and its label (or text). */
const optionsOf = (council) =>
  (Array.isArray(council.options) ? council.options : []).map((o, i) =>
    typeof o === "string"
      ? { id: "ABCD"[i], label: o }
      : { id: String(o?.id || "ABCD"[i]).toUpperCase(), label: o?.label || o?.text || "" },
  );

/** One request file: { exists, req }. `req` is null when the file cannot be read as a JSON object (cut off,
 * empty, not JSON, a list...). Missing means the file, or the folder above it, is not there. */
function readRequestFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { exists: !(e?.code === "ENOENT" || e?.code === "ENOTDIR"), req: null };
  }
  try {
    const req = JSON.parse(text);
    return { exists: true, req: isObject(req) ? req : null };
  } catch {
    return { exists: true, req: null };
  }
}

/** Where one person stands. A request counts only if it names this seat and this round, as the inbox
 * itself checks. `deadlineMs` is null when there is nothing usable. */
function look(dir, round, seat) {
  const { req } = readRequestFile(requestPath(dir, seat, round));
  if (!req || req.seat !== seat || req.round !== round) return { answered: false, deadlineMs: null };
  const at = typeof req.deadline === "string" ? Date.parse(req.deadline) : NaN;
  return { answered: req.status === "answered", deadlineMs: Number.isFinite(at) ? at : null };
}

// ---------------------------------------------------------------- the wait

/**
 * Write a request for each person who has none, then wait for every request to be answered.
 *   session     the session folder (absolute or relative to the working folder); it needs council.json, and it
 *               must sit directly in sessions/ with a valid session id as its name
 *   round       1, 2 or 3
 *   seats       keys of people (provider "human") on the roster
 *   promptFile  a file with the round prompt shown on the form; read only when a request is written. Default "".
 *   deadlineMin minutes a NEW request stays open. Default: HUMAN_DEADLINE_MIN, else 30.
 *   pollMs      how often the requests are read, from 10 to 2147483647 ms. Default 2000. It never sleeps past the deadline.
 * Resolves { code, answered, missing }: 0 every person answered; 4 the deadline passed; 2 it cannot run
 * (nothing is written, and `reason` says why). `answered` and `missing` are keys, in the order asked.
 * It throws on an unexpected failure, such as a folder it cannot write to.
 */
export async function waitAnswers({ session, round, seats, promptFile, deadlineMin, pollMs = 2000 } = {}) {
  if (startupError) throw startupError;

  // ---- arguments
  if (!(Number.isInteger(round) && round >= 1 && round <= 3)) return refuse("the round must be 1, 2 or 3");
  if (!Array.isArray(seats) || !seats.length) return refuse("name at least one seat");
  if (!seats.every((s) => typeof s === "string" && SEAT_KEY.test(s))) return refuse("a seat key is not valid");
  const people = [...new Set(seats)];
  if (typeof session !== "string" || !session.trim()) return refuse("a session folder is needed");
  if (deadlineMin !== undefined && deadlineMin !== null && !(typeof deadlineMin === "number" && Number.isFinite(deadlineMin) && deadlineMin > 0)) {
    return refuse("the deadline must be a number of minutes above 0");
  }
  if (!(typeof pollMs === "number" && pollMs >= MIN_POLL_MS && pollMs <= MAX_POLL_MS)) {
    return refuse(`the poll time must be a number of milliseconds from ${MIN_POLL_MS} to ${MAX_POLL_MS}`);
  }

  const dir = path.resolve(session);
  const misplaced = placeProblem(dir);
  if (misplaced) return refuse(misplaced);
  const { council, reason } = readCouncil(dir);
  if (reason) return refuse(reason);

  loadRoster(); // a seat added since this process started
  for (const key of people) {
    if (!Object.hasOwn(byKey, key)) return refuse(`${key} is not a seat on the roster`);
    if (byKey[key].provider !== "human") return refuse(`${key} is not a person: only a human seat takes a form`);
  }

  // ---- the deadline a new request gets, worked out once, so everyone in this run shares it
  const started = Date.now();
  let freshDeadline;
  if (deadlineMin === undefined || deadlineMin === null) {
    freshDeadline = deadlineFrom(started);
  } else {
    const at = new Date(started + deadlineMin * 60000);
    if (Number.isNaN(at.getTime())) return refuse("the deadline is too far away for the clock");
    freshDeadline = at.toISOString();
  }

  // ---- requests: keep what is there, write what is not
  const toWrite = people.filter((key) => !readRequestFile(requestPath(dir, key, round)).exists);
  let prompt = "";
  if (toWrite.length && promptFile) {
    try {
      prompt = fs.readFileSync(path.resolve(promptFile), "utf8");
    } catch (e) {
      return refuse(`cannot read the prompt file: ${e?.code ?? firstLine(e)}`);
    }
  }
  const options = optionsOf(council);
  for (const key of toWrite) {
    writeRequest(dir, {
      seat: key, round, prompt, fields: ROUND_FIELDS[round], context: contextFiles(round),
      options, deadline: freshDeadline, status: "pending",
    });
  }

  // ---- poll
  // `lastDeadline` holds each person's last readable deadline, so a request that is cut off or goes missing
  // mid-wait keeps the deadline it had. The wait ends at the latest of those among the people still missing.
  const lastDeadline = new Map();
  for (;;) {
    const states = people.map((key) => look(dir, round, key));
    people.forEach((key, i) => { if (states[i].deadlineMs !== null) lastDeadline.set(key, states[i].deadlineMs); });
    const answered = people.filter((_, i) => states[i].answered);
    const missing = people.filter((_, i) => !states[i].answered);
    if (!missing.length) return { code: 0, answered, missing };

    const known = missing.filter((key) => lastDeadline.has(key)).map((key) => lastDeadline.get(key));
    const closes = known.length ? Math.max(...known) : Date.parse(freshDeadline);
    const left = closes - Date.now();
    if (left <= 0) return { code: 4, answered, missing };
    await sleep(Math.max(1, Math.min(pollMs, left)));
  }
}

// ---------------------------------------------------------------- command line

const OPTIONS = {
  session: { type: "string" },
  round: { type: "string" },
  seats: { type: "string" },
  "prompt-file": { type: "string" },
  "deadline-min": { type: "string" },
  "poll-ms": { type: "string" },
};

// A number from a command-line string. Blank, or anything that is not a number, is NaN (which waitAnswers refuses).
const number = (text) => (text.trim() === "" ? NaN : Number(text));

/**
 * Run the command line. Returns the exit code; the caller sets it. `streams` is for tests.
 * An unexpected throw is one line on stderr and exit 2.
 */
export async function main(argv = process.argv.slice(2), { stdout, stderr } = { stdout: process.stdout, stderr: process.stderr }) {
  const stop = (why) => {
    stderr.write(`wait_answers: ${why}\n`);
    return 2;
  };
  try {
    if (startupError) throw startupError;
    let a;
    try {
      a = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values;
    } catch (e) {
      return stop(`bad argument: ${firstLine(e)}`);
    }
    if (!a.session) return stop("bad argument: --session is needed");
    if (a.round === undefined) return stop("bad argument: --round is needed");
    if (a.seats === undefined) return stop("bad argument: --seats is needed");

    const dir = path.resolve(a.session);
    const round = /^[123]$/.test(a.round) ? Number(a.round) : NaN;
    const seats = a.seats.split(",").map((s) => s.trim()).filter(Boolean);
    const r = await waitAnswers({
      session: dir, round, seats, promptFile: a["prompt-file"],
      deadlineMin: a["deadline-min"] === undefined ? undefined : number(a["deadline-min"]),
      pollMs: a["poll-ms"] === undefined ? undefined : number(a["poll-ms"]),
    });
    if (r.code === 2) return stop(r.reason);

    const answeredLines = r.answered.map((key) => `answered: ${key} ${answerPath(dir, key, round)}\n`);
    if (r.code === 4) stdout.write(`missing: ${r.missing.join(",")}\n`);
    stdout.write(answeredLines.join(""));
    return r.code;
  } catch (e) {
    return stop(firstLine(e));
  }
}

// Run only when started as a script, not when a test imports the functions above. The real path is
// compared, because import.meta.url is already resolved through symbolic links.
function startedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (startedDirectly()) process.exitCode = await main();
else if (startupError) throw startupError; // an importer must see a failed load, not a half-built module

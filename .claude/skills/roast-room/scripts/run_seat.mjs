#!/usr/bin/env node
// run_seat.mjs: in the Claude Code path, the Chair runs this to get a card from a seat that does not
// run as a Claude subagent. Node 20 or newer, no dependencies. It is outside app/, so it may start a process.
//
//   node run_seat.mjs --session <dir> --seat <key> --round <1|2|3> --prompt-file <f> [--provider p] [--model m] [--dry-run]
//   node run_seat.mjs --consult --seat <key> --prompt-file <f> [--provider p] [--model m] [--dry-run]
//   node run_seat.mjs --plan --seats a,b,c [--session <dir>]
//
// --plan prints { runners, cannotRun, recipients, keys } as JSON (see planSeats). A --session folder must hold
// a council.json: its runners change the plan. With none, any command that takes --session exits 2 with
// "no council.json in <dir>". It never falls back to the roster.
// A run prints the card on stdout. The last stderr line is `RUN_SEAT {json}`: seat, provider, model,
// transport, partial, missing, ms, usage. `partial` and `usage` are null when the transport cannot say
// (the CLI does not report a cut-off). A consult has no `missing`. A failed run prints its reason on
// stderr, with no RUN_SEAT line.
// Exit codes: 0 ok. 2 cannot run: a person, an Anthropic seat with no API key, no key and no CLI,
// delegate.py refused, or a bad argument. 3 provider failure.
//
// Transport, chosen at run time (spec section 3):
//   openai / google  http if the provider's key is set, else the codex / agy CLI through delegate.py
//                    (DELEGATE_PY), run with --isolated, else the seat cannot run.
//   anthropic        a Claude subagent. This script runs it over HTTP only when ANTHROPIC_API_KEY is set.
//   human            a form in the room. Not run here.
// Failure policy:
//   http   on any failure, run the CLI once if there is one (even for a 401 or a quota error: the CLI has
//          its own login). With no CLI, try HTTP once more, but only for a retryable error.
//   cli    exit 3 from delegate.py is tried once more. Exit 2 (refused) is final.
// delegate.py is never given --allow-secrets and never the API model id. Its environment holds no API key,
// token, secret or password (see childEnv).
// Time: one HTTP attempt is at most 300 s. One CLI attempt is at most 600 s (plus 1 s for output left in
// the pipes): delegate.py stops itself at 570 s, and this script kills it 30 s later if it has not.
// Worst cases: HTTP twice, 600 s; HTTP then the CLI once, 900 s; the CLI with its one retry, 1200 s.
// That is longer than a foreground Bash call (10 minutes), so the Chair runs this script as a background
// call (spec section 6).
// An unexpected failure (a roster that will not load, a bug) is one redacted line on stderr and exit 3.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// The app modules load here, not in import statements, so that a failure while loading them (the roster
// is read as soon as seats.mjs loads) can be caught and reported as exit 3 when this is run as a script.
// An importer still sees the failure: it is rethrown at the bottom. http.mjs comes before seats.mjs so
// that redact() is there if seats.mjs fails.
let env, redact, byKey, loadRoster, parseCard, complete, hasKey, resolveModel, MAX_TOKENS, KEY_ENV;
let buildSeatCall, ROUND_FIELDS, PROVIDERS, agentAlias, recipientsLine;
let startupError = null;
try {
  ({ env } = await import("../../../../app/lib/env.mjs"));
  ({ redact } = await import("../../../../app/lib/providers/http.mjs"));
  ({ byKey, loadRoster, parseCard } = await import("../../../../app/lib/seats.mjs"));
  ({ complete, hasKey, resolveModel, MAX_TOKENS, KEY_ENV } = await import("../../../../app/lib/providers/index.mjs"));
  ({ buildSeatCall } = await import("../../../../app/lib/seatprompt.mjs"));
  ({ ROUND_FIELDS } = await import("../../../../app/lib/inbox.mjs"));
  ({ PROVIDERS, agentAlias, recipientsLine } = await import("../../../../app/public/runners.js"));
} catch (e) {
  startupError = e;
}

const HTTP_TIMEOUT_MS = 300_000;
const CLI_TIMEOUT_S = 570; // handed to delegate.py as --timeout
const CLI_KILL_AFTER_S = 30; // this script's own limit is delegate.py's plus this
const MAX_ERROR_CHARS = 1000;
const TASK_DIVIDER = "\n\n===== YOUR TASK =====\n";

const CLI_NAME = { openai: "codex", google: "agy" };
const CLI_LABEL = { openai: "Codex", google: "agy" };
const COMPANY = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const cap = (s) => (s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}...` : s);
const message = (e) => cap(redact(e instanceof Error ? e.message : String(e)));

// The names that look like a credential. Anything ending in one of these words is kept from the child.
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;

/**
 * The environment for delegate.py (and so for codex or agy): a copy of `source` without the three
 * provider keys, KIE_AI_API_KEY, or any name that ends in API_KEY, APIKEY, TOKEN, SECRET, PASSWORD,
 * CREDENTIAL or CREDENTIALS. Everything else (PATH, HOME, CODEX_HOME, DELEGATE_* ...) is kept, so the CLI
 * keeps its own login. A provider that is reached through the CLI needs no key from us.
 */
export function childEnv(source = process.env) {
  const drop = new Set([...Object.values(KEY_ENV ?? {}), "KIE_AI_API_KEY"]);
  return Object.fromEntries(Object.entries(source).filter(([name]) => !drop.has(name) && !SECRET_NAME.test(name)));
}

/** The first line of an unexpected error, cut short and scrubbed of every key it could hold. This
 * works even when the app modules did not load, so it does not rely on them. */
function oneLine(e) {
  let text = String(e instanceof Error ? e.message : e);
  try {
    text = redact(text);
  } catch { /* redact did not load: the scrub below still runs */ }
  for (const [name, value] of Object.entries(process.env)) {
    if (SECRET_NAME.test(name) && value && value.length >= 8) text = text.split(value).join("[redacted]");
  }
  return text.split(/\r?\n/)[0].slice(0, 300) || "unexpected error";
}

// ---------------------------------------------------------------- reading the session

/** The session's council.json, or {} when no --session was given. A --session folder with no
 * council.json (or a file that is there but unreadable) is an error: falling back to the roster could
 * send the brief to a provider the user moved the seat away from for this council. */
function councilOf(session) {
  if (!session) return {};
  const dir = path.resolve(session);
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, "council.json"), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") throw new Error(`no council.json in ${dir}`);
    throw new Error(`cannot read council.json in ${dir}: ${e?.code ?? e?.message}`);
  }
  let council;
  try {
    council = JSON.parse(raw);
  } catch {
    throw new Error(`council.json in ${dir} is not valid JSON`);
  }
  if (!isObject(council)) throw new Error(`council.json in ${dir} is not a JSON object`);
  return council;
}

/** Option ids as the room reads them: an object's `id` upper-cased, a plain string takes A, B, C, D by position. */
function optionIdsOf(council) {
  const options = Array.isArray(council.options) ? council.options : [];
  const ids = options.map((o, i) => (typeof o === "string" || !o?.id ? "ABCD"[i] : String(o.id).toUpperCase())).filter(Boolean);
  return [...new Set(ids)];
}

// ---------------------------------------------------------------- the CLI bridge

/** The delegate.py path from DELEGATE_PY (environment or .env), or null when it is unset or is not a file. */
function delegateScript() {
  let p = env("DELEGATE_PY");
  if (!p) return null;
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1)); // a .env value is not expanded by a shell
  const abs = path.resolve(p);
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** The full command line. `--model` comes only from the seat's cli_model, never from the API model id. */
function delegateArgv({ script, cli, taskFile, cliModel }) {
  return [
    env("DELEGATE_PYTHON") || "python3", script, "run", cli,
    "--isolated", "--json", "--timeout", String(CLI_TIMEOUT_S), "--task-file", taskFile,
    ...(cliModel ? ["--model", cliModel] : []),
  ];
}

/** Why this seat's cli_model cannot be used, or null. A value that starts with "-" would be read by
 * delegate.py as an option, not as a model name. */
function cliModelProblem(seat) {
  return str(seat.cli_model).startsWith("-") ? `cli_model for ${seat.key} must not start with '-'` : null;
}

// ---------------------------------------------------------------- resolveSeat and planSeats

/**
 * Who produces this seat's card, on which model, over which transport.
 * Provider order: argument, council.json runners, roster. Model order: argument, council.json runners,
 * roster, then for OpenAI and Google the provider's env default and the built-in default. A model written
 * for another provider is skipped, so --provider google never sends the seat's GPT id to Gemini.
 * A Claude seat with no model of its own (none of the three above) has model null and agentModel null: the
 * Chair leaves the Agent tool's `model` out and the sub-agent runs on the session's model, as it always did.
 * SEAT_MODEL does not pin a Claude seat here; it is the API runner's default, and the default for a Claude
 * seat this script runs itself over HTTP (see runSeat).
 * transport is null (with a reason) when the seat cannot run. Throws for an unknown seat, or for a
 * council.json that is missing or unreadable when a session is given.
 */
export function resolveSeat({ seat, provider, model, session } = {}) {
  loadRoster(); // a seat added since this process started
  if (typeof seat !== "string" || !Object.hasOwn(byKey, seat)) throw new Error(`Unknown seat: ${String(seat)}`);
  const s = byKey[seat];
  const rosterProvider = s.provider ?? "anthropic";
  const runners = councilOf(session).runners;
  const runner = isObject(runners) && Object.hasOwn(runners, seat) && isObject(runners[seat]) ? runners[seat] : null;
  const chosen = str(provider) || str(runner?.provider) || rosterProvider;

  const out = { seat, provider: chosen, model: null, transport: null, agentModel: null, cliModel: null, reason: null };
  if (!PROVIDERS.includes(chosen)) return { ...out, reason: `unknown provider ${JSON.stringify(chosen)}` };
  if (chosen === "human") return { ...out, transport: "form" };

  const runnerModel = (str(runner?.provider) || rosterProvider) === chosen ? str(runner?.model) : "";
  const seatModel = rosterProvider === chosen ? str(s.model) : "";

  if (chosen === "anthropic") {
    const pinned = str(model) || runnerModel || seatModel; // no env default: an unpinned seat inherits the session model
    return { ...out, model: pinned || null, transport: "subagent", agentModel: pinned ? agentAlias(pinned) : null };
  }
  out.model = resolveModel(chosen, { override: str(model) || runnerModel, seatModel });

  const problem = cliModelProblem(s); // checked even for a seat on HTTP: the CLI is its fall-back
  if (problem) return { ...out, reason: problem };
  out.cliModel = str(s.cli_model) || null;
  if (hasKey(chosen)) return { ...out, transport: "http" };
  if (delegateScript()) return { ...out, transport: "cli" };
  return { ...out, reason: `no ${KEY_ENV[chosen]} and no DELEGATE_PY` };
}

/**
 * The plan for a board, for the Chair: { runners, cannotRun, recipients, keys }.
 * runners: { key: { provider, model, transport } } for each seat that can run, ready for council.json.
 *   A Claude seat also carries agentModel: the Agent tool alias (opus, sonnet, haiku, fable) of its pinned
 *   model, or null. An unpinned Claude seat has model null and agentModel null (see resolveSeat).
 * cannotRun: [{ seat, reason }]. recipients: the privacy line (who besides Anthropic receives the
 * brief), over the seats that can run. A seat that cannot run receives nothing.
 * keys: { openai, google, delegate } booleans. Whether an OpenAI key, a Google key and a usable DELEGATE_PY
 *   exist. Never a value. It says whether a seat could be moved to OpenAI or Google, whatever the board is.
 */
export function planSeats({ seats, session } = {}) {
  loadRoster();
  const runners = {};
  const cannotRun = [];
  const running = [];
  for (const key of [...new Set(seats ?? [])]) {
    if (typeof key !== "string" || !Object.hasOwn(byKey, key)) {
      cannotRun.push({ seat: String(key), reason: "no such seat" });
      continue;
    }
    const r = resolveSeat({ seat: key, session });
    if (!r.transport) {
      cannotRun.push({ seat: key, reason: r.reason });
      continue;
    }
    runners[key] = r.provider === "anthropic"
      ? { provider: r.provider, model: r.model, agentModel: r.agentModel, transport: r.transport }
      : { provider: r.provider, model: r.model, transport: r.transport };
    running.push(byKey[key]);
  }
  const keys = { openai: hasKey("openai"), google: hasKey("google"), delegate: Boolean(delegateScript()) };
  return { runners, cannotRun, recipients: recipientsLine(running, runners), keys };
}

// ---------------------------------------------------------------- reading a card

// What it means for parseCard to have read each required field. OPTION SCORES is handled apart.
const READ = {
  "STANCE": (c) => Boolean(c.stance),
  "THE CALL": (c) => Boolean(c.call),
  "CONFIDENCE": (c) => c.confidence !== null,
  "RUIN RISK": (c) => Boolean(c.ruin),
  "DOOR": (c) => Boolean(c.door),
  "I DISAGREE MOST WITH": (c) => Boolean(c.disagreeLine),
  "VOTE": (c) => Boolean(c.vote),
  "FINAL SCORE": (c) => c.finalScore !== null,
};

/** The round's required fields that parseCard could not read, in the round's order. OPTION SCORES is
 * missing unless every option has a score. With no known option ids it cannot be checked, so it counts
 * as missing. A required field with no reader here counts as missing too, never as present. */
function missingFields(round, text, optionIds) {
  const card = parseCard(text, optionIds);
  return ROUND_FIELDS[round].required.filter((label) => {
    if (label === "OPTION SCORES") return optionIds.length === 0 || optionIds.some((id) => !Object.hasOwn(card.optionScores, id));
    return !(READ[label]?.(card) ?? false);
  });
}

// ---------------------------------------------------------------- one attempt, by transport
// An attempt returns { ok: true, text, usage, partial } or { ok: false, code, error, retryable }.

async function attemptHttp({ provider, model, system, user }) {
  try {
    const r = await complete(provider, { model, system, user, maxTokens: MAX_TOKENS[provider], signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return { ok: true, text: r.text, usage: r.usage, partial: r.stopReason === "max_tokens" };
  } catch (e) {
    const error = e?.name === "TimeoutError" ? `no answer within ${HTTP_TIMEOUT_MS / 1000}s` : message(e);
    // Only a ProviderError that says retryable === false is final. Anything else may be tried again.
    return { ok: false, code: 3, error, retryable: e?.retryable !== false };
  }
}

// The outer limits on the delegate.py child. delegate.py stops itself at CLI_TIMEOUT_S; this is the backstop.
//   timeoutMs  kill the child with SIGKILL when it has not exited by then.
//   graceMs    after the child exits (or is killed), wait this long for output still in the pipes, then close
//              them. A grandchild that keeps a pipe open (a CLI left running) cannot hold the call up.
const DEFAULT_LIMITS = { timeoutMs: (CLI_TIMEOUT_S + CLI_KILL_AFTER_S) * 1000, graceMs: 1000 };
let limits = { ...DEFAULT_LIMITS };
/** Tests only: change the outer limits. Call with no argument to put the real ones back. */
export function setCliLimits(next) {
  limits = { ...DEFAULT_LIMITS, ...(next ?? {}) };
}
/** The limits in force. */
export const cliLimits = () => ({ ...limits });

function exec(cmd, args) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    const { timeoutMs, graceMs } = limits;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    } catch (e) {
      resolve({ spawnError: e });
      return;
    }
    let settled = false;
    let timedOut = false;
    let exited = null;
    let killTimer = null;
    let graceTimer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    const finish = () =>
      settle({
        code: exited?.code ?? null, signal: exited?.signal ?? (timedOut ? "SIGKILL" : null), timedOut, limitMs: timeoutMs,
        stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
      });

    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    // No pid means the process never started (a missing interpreter). Any later error is ignored.
    child.on("error", (e) => {
      if (child.pid === undefined) settle({ spawnError: e });
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      clearTimeout(killTimer);
      graceTimer ??= setTimeout(finish, graceMs);
    });
    child.on("close", finish); // every pipe is closed: nothing more can arrive
    killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      graceTimer ??= setTimeout(finish, graceMs); // settle even if the exit event never comes
    }, timeoutMs);
  });
}

const parseJson = (text) => {
  try {
    const j = JSON.parse(text);
    return isObject(j) ? j : null;
  } catch {
    return null;
  }
};

/** Turn a finished delegate.py process into an attempt. Exit 0 needs a JSON object with a non-empty reply. */
function readDelegate(res, python) {
  if (res.spawnError) {
    return { ok: false, code: 2, error: message(`could not start ${python}: ${res.spawnError.code ?? res.spawnError.message}`) };
  }
  if (res.timedOut) {
    return { ok: false, code: 3, retryable: true, error: `delegate.py did not finish within ${+(res.limitMs / 1000).toFixed(1)}s and was killed` };
  }
  const json = parseJson(res.stdout);
  if (res.code === 2) return { ok: false, code: 2, error: cap(redact(res.stderr.trim())) || "delegate.py refused the task" };
  if (res.code === 0) {
    if (typeof json?.reply === "string" && json.reply.trim()) {
      const input = finite(json.input_tokens);
      const output = finite(json.output_tokens);
      const cacheRead = finite(json.cached_input_tokens);
      const known = input !== null || output !== null || cacheRead !== null;
      return { ok: true, text: json.reply, usage: known ? { input, output, cacheRead } : null, partial: null };
    }
    return { ok: false, code: 3, retryable: true, error: "delegate.py printed no JSON reply" };
  }
  const why = typeof json?.error === "string" && json.error ? json.error : res.stderr.trim() || `delegate.py exited with ${res.code ?? res.signal}`;
  return { ok: false, code: 3, retryable: true, error: cap(redact(why)) };
}

async function attemptCli({ script, cli, cliModel, system, user }) {
  let dir = null;
  try {
    let taskFile;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-seat-"));
      taskFile = path.join(dir, "task.md");
      fs.writeFileSync(taskFile, `${system}${TASK_DIVIDER}${user}`, { mode: 0o600 });
    } catch (e) {
      return { ok: false, code: 2, error: message(`could not write the task file: ${e?.code ?? e?.message}`) };
    }
    const [python, ...args] = delegateArgv({ script, cli, taskFile, cliModel });
    return readDelegate(await exec(python, args), python);
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true }); // only the folder made above
  }
}

// ---------------------------------------------------------------- runSeat

function roundOf(round) {
  const text = String(round ?? "").trim();
  return typeof round === "number" ? (Number.isInteger(round) && round >= 1 && round <= 3 ? round : NaN) : /^[1-3]$/.test(text) ? Number(text) : NaN;
}

/**
 * Get one card. Returns { code, card, meta }.
 *   code 0: card is the text, meta is { seat, provider, model, transport, partial, missing?, ms, usage, notes }.
 *           A dry run has card null and meta { seat, provider, model, transport, agentModel, systemBytes,
 *           userBytes, files, argv? }: nothing is sent and no process starts.
 *   code 2 or 3: card is null, meta.error says why and meta.notes lists any fall-back that was tried.
 * `session` is a folder path, absolute or relative to the current folder. A consult needs neither a
 * session nor a round and attaches no context.
 */
export async function runSeat({ session, seat, round, promptFile, consult = false, provider, model, dryRun = false } = {}) {
  const started = Date.now();
  const notes = [];
  let base = { seat };
  const fail = (code, error) => ({ code, card: null, meta: { ...base, error: cap(redact(error)), notes } });

  loadRoster();
  if (typeof seat !== "string" || !Object.hasOwn(byKey, seat)) return fail(2, `Unknown seat: ${String(seat)}`);
  if (str(provider) && !PROVIDERS.includes(str(provider))) return fail(2, `bad argument: unknown provider ${JSON.stringify(str(provider))}`);

  let roundNo = null;
  let sessionDir;
  if (consult) {
    sessionDir = session ? path.resolve(session) : undefined;
  } else {
    roundNo = roundOf(round);
    if (Number.isNaN(roundNo)) return fail(2, `bad argument: round must be 1, 2 or 3, not ${String(round)}`);
    if (!session) return fail(2, "bad argument: --session is needed unless this is a --consult");
    sessionDir = path.resolve(session);
    if (!fs.existsSync(sessionDir) || !fs.statSync(sessionDir).isDirectory()) return fail(2, `bad argument: session folder not found: ${sessionDir}`);
  }
  if (!promptFile) return fail(2, "bad argument: --prompt-file is needed");

  let r;
  try {
    r = resolveSeat({ seat, provider, model, session: sessionDir });
  } catch (e) {
    return fail(2, message(e));
  }
  base = { seat, provider: r.provider, model: r.model, transport: r.transport };
  const name = byKey[seat].short || byKey[seat].name || seat;

  if (r.provider === "human") {
    return fail(2, consult ? `${name} is a person. Ask them directly.` : `${name} is a person. Use an inbox request, not run_seat.mjs.`);
  }
  if (CLI_NAME[r.provider]) {
    const problem = cliModelProblem(byKey[seat]);
    if (problem) return fail(2, problem);
  }
  let transport = r.transport;
  let callModel = r.model; // the model this call uses; null for an unpinned Claude seat until the HTTP branch picks one
  if (r.provider === "anthropic") {
    if (!hasKey("anthropic")) return fail(2, `${name} runs on Anthropic and there is no ${KEY_ENV.anthropic}: use the council-${seat} subagent.`);
    transport = "http"; // the key is set, so this script can make the call itself
    base.transport = transport;
    // Over HTTP a call needs a model. A seat with none of its own takes SEAT_MODEL, then the default.
    callModel ??= resolveModel("anthropic", {});
    base.model = callModel;
  }
  if (!transport) {
    const hint = env("DELEGATE_PY") ? " (DELEGATE_PY is set but is not a file)" : "";
    return fail(2, `${name} cannot run: ${r.reason}${hint}`);
  }

  let promptText;
  try {
    promptText = fs.readFileSync(promptFile, "utf8").trimEnd();
  } catch (e) {
    return fail(2, `bad argument: cannot read the prompt file (${e?.code ?? e?.message})`);
  }
  if (!promptText.trim()) return fail(2, "bad argument: the prompt file is empty");

  let council;
  let call;
  try {
    council = consult ? {} : councilOf(sessionDir);
    call = buildSeatCall({ sessionDir, seatKey: seat, round: roundNo, promptText, consult });
  } catch (e) {
    return fail(2, message(e));
  }
  const { system, user, files } = call;
  const script = CLI_NAME[r.provider] ? delegateScript() : null;

  if (dryRun) {
    const dry = {
      seat, provider: r.provider, model: callModel, transport, agentModel: r.agentModel,
      systemBytes: Buffer.byteLength(system), userBytes: Buffer.byteLength(user), files,
    };
    if (transport === "cli") dry.argv = delegateArgv({ script, cli: CLI_NAME[r.provider], taskFile: "<task-file>", cliModel: r.cliModel });
    return { code: 0, card: null, meta: dry };
  }

  const http = { provider: r.provider, model: callModel, system, user };
  const cliArgs = { script, cli: CLI_NAME[r.provider], cliModel: r.cliModel, system, user };
  const company = COMPANY[r.provider] ?? r.provider;
  let outcome;
  if (transport === "http") {
    outcome = await attemptHttp(http);
    if (!outcome.ok) {
      if (script) {
        notes.push(`${company} API failed (${outcome.error}). Trying the ${CLI_LABEL[r.provider]} CLI instead.`);
        transport = "cli";
        outcome = await attemptCli(cliArgs); // once
      } else if (outcome.retryable) {
        notes.push(`${company} API failed (${outcome.error}). Trying once more.`);
        outcome = await attemptHttp(http);
      }
    }
  } else {
    outcome = await attemptCli(cliArgs);
    if (!outcome.ok && outcome.code === 3) {
      notes.push(`The ${CLI_LABEL[r.provider]} CLI failed (${outcome.error}). Trying once more.`);
      outcome = await attemptCli(cliArgs);
    }
  }
  base.transport = transport;
  if (!outcome.ok) return fail(outcome.code, outcome.error);

  const meta = {
    seat, provider: r.provider, model: callModel, transport, partial: outcome.partial,
    ...(consult ? {} : { missing: missingFields(roundNo, outcome.text, optionIdsOf(council)) }),
    ms: Date.now() - started, usage: outcome.usage, notes,
  };
  return { code: 0, card: outcome.text, meta };
}

// ---------------------------------------------------------------- command line

const USAGE = [
  "usage:",
  "  run_seat.mjs --session <dir> --seat <key> --round <1|2|3> --prompt-file <f> [--provider p] [--model m] [--dry-run]",
  "  run_seat.mjs --consult --seat <key> --prompt-file <f> [--provider p] [--model m] [--dry-run]",
  "  run_seat.mjs --plan --seats a,b,c [--session <dir>]",
].join("\n");

const OPTIONS = {
  session: { type: "string" },
  seat: { type: "string" },
  seats: { type: "string" },
  round: { type: "string" },
  "prompt-file": { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  consult: { type: "boolean" },
  plan: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

/** The last stderr line of a good run: the fields the Chair needs, never a key. */
function runLine(meta) {
  const line = { seat: meta.seat, provider: meta.provider, model: meta.model, transport: meta.transport, partial: meta.partial };
  if (meta.missing !== undefined) line.missing = meta.missing;
  line.ms = meta.ms;
  line.usage = meta.usage;
  return `RUN_SEAT ${JSON.stringify(line)}`;
}

/**
 * Run the command line. Returns the exit code; the caller sets it. `streams` is for tests.
 * An unexpected throw (a roster that will not load, a bug) is one redacted line on stderr and exit 3.
 */
export async function main(argv = process.argv.slice(2), streams = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    if (startupError) throw startupError;
    return await runCommand(argv, streams);
  } catch (e) {
    streams.stderr.write(`run_seat: ${oneLine(e)}\n`);
    return 3;
  }
}

async function runCommand(argv, { stdout, stderr }) {
  const bad = (why) => {
    stderr.write(`${why}\n${USAGE}\n`);
    return 2;
  };

  let a;
  try {
    a = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    return bad(`bad argument: ${e.message}`);
  }
  loadRoster(); // a roster that will not load is not a bad argument: it throws to main(), which exits 3

  if (a.plan) {
    const extra = ["seat", "round", "prompt-file", "provider", "model", "consult", "dry-run"].filter((k) => a[k] !== undefined);
    if (extra.length) return bad(`bad argument: --plan takes only --seats and --session, not --${extra[0]}`);
    const seats = (a.seats ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!seats.length) return bad("bad argument: --plan needs --seats a,b,c");
    try {
      stdout.write(`${JSON.stringify(planSeats({ seats, session: a.session }), null, 2)}\n`);
      return 0;
    } catch (e) {
      stderr.write(`${message(e)}\n`);
      return 2;
    }
  }

  if (a.seats !== undefined) return bad("bad argument: --seats belongs to --plan");
  if (!a.seat) return bad("bad argument: --seat is needed");
  if (!a["prompt-file"]) return bad("bad argument: --prompt-file is needed");
  if (a.consult && a.round !== undefined) return bad("bad argument: a --consult takes no --round");
  if (!a.consult && a.round === undefined) return bad("bad argument: --round is needed unless this is a --consult");

  const r = await runSeat({
    session: a.session, seat: a.seat, round: a.round, promptFile: a["prompt-file"],
    consult: Boolean(a.consult), provider: a.provider, model: a.model, dryRun: Boolean(a["dry-run"]),
  });
  for (const note of r.meta.notes ?? []) stderr.write(`${note}\n`);
  if (r.code !== 0) {
    stderr.write(`${r.meta.error}\n`);
    return r.code;
  }
  if (a["dry-run"]) {
    stdout.write(`${JSON.stringify(r.meta, null, 2)}\n`);
    return 0;
  }
  stdout.write(r.card.endsWith("\n") ? r.card : `${r.card}\n`);
  stderr.write(`${runLine(r.meta)}\n`);
  return 0;
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

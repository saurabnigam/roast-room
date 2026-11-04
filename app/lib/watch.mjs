// Viewer mode: /roast-room runs in Claude Code and writes its session folder as it
// goes. This watches the sessions folder and turns those files into the same events the
// API runner emits, so the room plays a Claude Code council live without calling any API.
//
// Files the Chair writes, in order (spec: .claude/skills/roast-room/references/live-room.md):
//   council.json  -> setup        round-1.md -> Round 1 cards   cruxes.json -> fault lines
//   round-2.md    -> debate cards  draft.json -> proposal       round-3.md  -> votes
//   verdict.json  -> the verdict
// A person on this Mac answers in the room's form. Each request waits in inbox/<seat>-r<N>.request.json.
// The watcher never reads inbox/ as cards. It only reports who is being waited on (waiting, waiting_done)
// and keeps the session alive while an answer is still due.
import fs from "node:fs";
import path from "node:path";
import { SEATS, byKey, parseCard, checkQuotes, loadRoster, defaultBoard, seatKey, splitCards } from "./seats.mjs";
import { SESSIONS_DIR } from "./env.mjs";
import { optionScores, finalNumbers, verdictSeats } from "./council.mjs";
import { readRequests } from "./inbox.mjs";
import { councilDisclaimer } from "../public/runners.js";

const live = new Map(); // folder name -> session
const STALE_MS = 3 * 60 * 60 * 1000; // a folder untouched this long is an abandoned council

const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const parseJson = (t) => { if (!t) return null; try { return JSON.parse(t); } catch { return null; } };
const readJson = (p) => parseJson(readText(p));

// seatKey and splitCards live in seats.mjs; re-exported so existing importers keep working.
export { seatKey, splitCards };

function emit(x, type, data = {}) {
  const ev = { type, t: Date.now() - x.started, ...data };
  x.events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of x.subs) res.write(line);
}

function finish(x, status) {
  x.status = status;
  for (const res of x.subs) res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);
  x.subs.clear();
}

// How a seat runs when council.json does not say. Same words as the runner the API app reports,
// except that Claude Code runs an Anthropic seat as a subagent, not over HTTP.
const TRANSPORT = { anthropic: "subagent", openai: "http", google: "http", human: "form" };

/** { [seatKey]: { provider, model, transport } } for the seats at the table. A seat that council.json
 * lists under `runners` is taken as written (a missing provider comes from the roster, a missing transport
 * from the provider's usual one). Any other seat runs as its roster entry says. */
function normalizeRunners(c, seats) {
  const given = {};
  if (c.runners && typeof c.runners === "object" && !Array.isArray(c.runners)) {
    for (const [name, r] of Object.entries(c.runners)) {
      const k = seatKey(name);
      if (k && r && typeof r === "object" && !Array.isArray(r)) given[k] = r;
    }
  }
  const out = {};
  for (const k of seats) {
    const seat = byKey[k];
    const r = given[k];
    const provider = r?.provider ?? seat?.provider ?? "anthropic";
    out[k] = r
      ? { provider, model: r.model ?? null, transport: r.transport ?? TRANSPORT[provider] ?? null }
      : { provider, model: seat?.model ?? null, transport: TRANSPORT[provider] ?? null };
  }
  return out;
}

function normalizeSetup(c) {
  const options = (c.options || []).map((o, i) => (typeof o === "string" ? { id: "ABCD"[i], label: o } : { id: String(o.id || "ABCD"[i]).toUpperCase(), label: o.label || o.text || "" }));
  loadRoster(); // pick up a seat added since the room started
  const weights = Object.fromEntries(SEATS.map((s) => [s.key, { weight: 1, reason: "" }]));
  const wl = Array.isArray(c.weights) ? c.weights : Object.entries(c.weights || {}).map(([seat, w]) => (typeof w === "number" ? { seat, weight: w } : { seat, ...w }));
  for (const w of wl) { const k = seatKey(w.seat); if (k) weights[k] = { weight: Math.max(1, Math.min(3, Number(w.weight) || 1)), reason: w.reason || "" }; }
  const seats = (c.seats || []).map(seatKey).filter(Boolean);
  const mode = c.mode === "quick" ? "quick" : "full";
  const table = seats.length ? [...new Set(seats)] : defaultBoard();
  return {
    title: c.title || "Roast Room", decision: c.decision || "", brief: c.brief || "", mode,
    options, assumptions: c.assumptions || [], weights,
    seats: table, runners: normalizeRunners(c, table),
  };
}

// `at` is when the step began (the mtime of the file that started it), so a viewer who
// opens the room halfway through a round still sees how long the room has been waiting.
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return Date.now(); } };

function startRound(x, r, label, at) {
  const st = x.st;
  st.rounds.push(r);
  x.round = r;
  emit(x, "phase", { phase: `round${r}`, label, at });
  emit(x, "round_start", { round: r, at });
  for (const k of st.seats) emit(x, "seat_start", { round: r, seat: k });
}

/** Emit the cards in a round file that have not been emitted yet. Returns true once the round is complete. */
function readRound(x, r, force) {
  const st = x.st;
  const md = readText(path.join(x.dir, `round-${r}.md`));
  if (!md) return false;
  // The room seals this round's cards while a person is being waited on, so say so before the first card.
  // (A room opened mid-round, or a restart, reads a round file that is already on disk.)
  checkWaiting(x);
  for (const c of splitCards(md)) {
    if (!st.seats.includes(c.key) || st.cards[r][c.key]) continue;
    const parsed = parseCard(c.text, st.options.map((o) => o.id));
    const quotes = checkQuotes(c.key, c.text);
    st.cards[r][c.key] = { text: c.text, parsed, quotes };
    emit(x, "seat_done", { round: r, seat: c.key, text: c.text, parsed, quotes, name: byKey[c.key].name });
  }
  const have = st.seats.filter((k) => st.cards[r][k]).length;
  if (have === st.seats.length || (force && have > 0)) {
    // The Chair moved on without these seats (a person who missed the deadline, a model that failed).
    // Say so once, as the API runner does. Scoring already skips a seat that has no card.
    for (const k of st.seats) if (!st.cards[r][k]) emit(x, "seat_absent", { round: r, seat: k, reason: "no card" });
    // The room opens the sealed cards at waiting_done or round_done. Send waiting_done first, so it never
    // arrives after the round it belongs to has closed.
    if (x.waiting?.round === r) { emit(x, "waiting_done", { round: r }); x.waiting = null; }
    st.scores[r] = optionScores(st, r);
    emit(x, "round_done", { round: r, scores: st.scores[r] });
    return true;
  }
  return false;
}

function advance(x) {
  const f = (n) => path.join(x.dir, n);
  const has = (n) => fs.existsSync(f(n));
  const st = x.st;

  if (x.step === "setup") {
    const raw = readText(f("council.json"));
    const c = parseJson(raw);
    if (!c) return;
    Object.assign(st, normalizeSetup(c));
    x.councilRaw = raw;
    x.title = st.title;
    x.mode = st.mode;
    emit(x, "phase", { phase: "setup", label: "The Chair is reading your question", at: mtime(f("council.json")) });
    emit(x, "setup", { title: st.title, decision: st.decision, brief: st.brief, options: st.options, assumptions: st.assumptions, weights: st.weights, seats: st.seats, mode: st.mode, runners: st.runners });
    startRound(x, 1, "Round 1: opening positions", mtime(f("council.json")));
    x.step = "r1";
  }
  if (x.step === "r1") {
    if (!readRound(x, 1, has("cruxes.json"))) return;
    emit(x, "phase", { phase: "cruxes", label: "The Chair is finding the fault lines", at: mtime(f("round-1.md")) });
    x.step = "cruxes";
  }
  if (x.step === "cruxes") {
    const c = readJson(f("cruxes.json"));
    if (!c) return;
    const cruxes = (c.cruxes || []).map((q) => ({ question: q.question || "", sides: (q.sides || []).map((sd) => ({ position: sd.position || "", seats: (sd.seats || []).map(seatKey).filter(Boolean) })) }));
    emit(x, "cruxes", { cruxes, unanimous: Boolean(c.unanimous), note: c.note || "", pressure: {} });
    startRound(x, 2, "Round 2: the debate", mtime(f("cruxes.json")));
    x.step = "r2";
  }
  if (x.step === "r2") {
    if (!readRound(x, 2, has("draft.json") || has("verdict.json"))) return;
    emit(x, "phase", { phase: "draft", label: "The Chair is weighing the debate", at: mtime(f("round-2.md")) });
    x.step = "draft";
  }
  if (x.step === "draft") {
    const d = readJson(f("draft.json"));
    if (d) {
      st.draft = { option: d.option || "", label: d.label || "", recommendation: d.recommendation || "", conditions: d.conditions || [], next_steps: d.next_steps || [], cheapest_test: d.cheapest_test || "", kill_criteria: d.kill_criteria || "" };
      emit(x, "draft", { draft: st.draft });
      startRound(x, 3, "Round 3: the vote", mtime(f("draft.json")));
      x.step = "r3";
    } else if (has("verdict.json")) {
      emit(x, "phase", { phase: "skip3", label: "Quick mode: the vote round is skipped", at: mtime(f("round-2.md")) });
      x.step = "verdict";
    } else return;
  }
  if (x.step === "r3") {
    if (!readRound(x, 3, has("verdict.json"))) return;
    emit(x, "phase", { phase: "verdict", label: "The Chair is writing the verdict", at: mtime(f("round-3.md")) });
    x.step = "verdict";
  }
  if (x.step === "verdict") {
    const v = readJson(f("verdict.json"));
    if (!v) return;
    const { last, finalScores, recommended, spreadF, confidence, support, votes } = finalNumbers(st);
    const verdict = {
      label: v.label || "RESHAPE", call: v.call || "", override_note: v.override_note || "",
      why: v.why || [], fights: v.fights || [], minority: v.minority || { seat: "", quote: "", would_have_to_be_true: "" },
      amendments: v.amendments || [], conditions: v.conditions || [],
      next_steps: (v.next_steps || []).map((n) => (typeof n === "string" ? { when: "", action: n } : n)),
      cheapest_test: v.cheapest_test || "", kill_criteria: v.kill_criteria || "", revisit: v.revisit || "",
      recommended: v.recommended || recommended, scores: finalScores, spread: spreadF, confidence, support, votes,
      disclaimer: councilDisclaimer(st.seats.map((k) => byKey[k]).filter(Boolean), st.runners),
    };
    emit(x, "verdict", { verdict, seats: verdictSeats(st, last) });
    x.step = "done";
    finish(x, "done");
  }
}

// A request waits for a person while it says "pending" and its deadline, written as text, is still ahead.
// A request file is anything a person or a script put there, so a deadline of any other type is not trusted.
const isPending = (q, now) => q.status === "pending" && typeof q.deadline === "string" && Date.parse(q.deadline) > now;

/** The pending requests for the round the watcher is on: still "pending" and before their deadline,
 * as [{ key, deadline }] in a fixed order, so two reads of the same files compare equal.
 * A round that has closed (round_done sent) is not waited on, so a request left "pending" for it is
 * not announced again after the room has opened its cards. */
function pendingNow(x, now) {
  if (!x.round || x.st.scores[x.round]) return [];
  return readRequests(x.dir)
    .filter((q) => isPending(q, now) && q.round === x.round && typeof q.seat === "string")
    .map((q) => ({ key: q.seat, deadline: q.deadline }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0));
}

/** Does any request in this session, from any round, still wait for a person? */
const anyPending = (dir, now) => readRequests(dir).some((q) => isPending(q, now));

// Tell the room when the people being waited on change. x.waiting is what the room was last told:
// { round, seats } or null. `waiting` goes out when the list changes and is not empty. `waiting_done`
// goes out once when it empties, or when the room moves to another round (that round's requests no
// longer count). A deadline that passes empties the list on the next scan, with no file change.
function checkWaiting(x) {
  const seats = pendingNow(x, Date.now());
  const told = x.waiting;
  if (told && (!seats.length || told.round !== x.round)) {
    emit(x, "waiting_done", { round: told.round });
    x.waiting = null;
  }
  if (seats.length && JSON.stringify(seats) !== JSON.stringify(x.waiting?.seats)) {
    emit(x, "waiting", { round: x.round, seats });
    x.waiting = { round: x.round, seats };
  }
}

// council.json can change after setup: the Chair updates a transport when a seat falls back. The
// table stays as set up. A file that does not parse (half written) is read again on the next scan.
function checkRunners(x) {
  if (x.step === "setup") return;
  const raw = readText(path.join(x.dir, "council.json"));
  if (raw === null || raw === x.councilRaw) return;
  const c = parseJson(raw);
  if (!c) return;
  x.councilRaw = raw;
  loadRoster();
  const runners = normalizeRunners(c, x.st.seats);
  if (JSON.stringify(runners) === JSON.stringify(x.st.runners)) return;
  x.st.runners = runners;
  emit(x, "runners", { runners });
}

function sync(x) {
  checkRunners(x);
  advance(x);
  if (x.status === "running") checkWaiting(x);
}

// When the session last changed: the newest file in the folder, and in inbox/. A folder's own time
// is not counted: it also moves when a file is deleted or renamed, which is not progress.
function lastTouched(dir) {
  const newest = (d) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return 0; } // no such folder (inbox/ is optional)
    let t = 0;
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(d, n));
        if (st.isFile()) t = Math.max(t, st.mtimeMs);
      } catch { /* removed since the listing */ }
    }
    return t;
  };
  return Math.max(newest(dir), newest(path.join(dir, "inbox")));
}

function load(name) {
  const dir = path.join(SESSIONS_DIR, name);
  let x = live.get(name);
  if (!x) {
    x = { id: name, dir, events: [], subs: new Set(), status: "running", started: Date.now(), step: "setup", title: "", mode: "full",
      st: { cards: { 1: {}, 2: {}, 3: {} }, scores: {}, rounds: [] } };
    live.set(name, x);
  }
  if (x.status === "running") {
    sync(x);
    // A folder untouched for hours is abandoned, unless a person still has time to answer.
    if (x.status === "running" && Date.now() - lastTouched(dir) > STALE_MS && !anyPending(dir, Date.now())) finish(x, "stopped");
  }
  return x;
}

/** Folders written by the skill (council.json, no events.json from the API runner). */
function skillFolders() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR).filter((d) => fs.existsSync(path.join(SESSIONS_DIR, d, "council.json")) && !fs.existsSync(path.join(SESSIONS_DIR, d, "events.json")));
}

export function scan() {
  // setInterval calls this with nothing to catch an error, and one unreadable folder must not hide the others.
  for (const name of skillFolders()) {
    try { load(name); } catch (e) { console.error(`watch: ${name}: ${e?.message ?? e}`); }
  }
}

export function getLive(id) {
  return skillFolders().includes(id) ? load(id) : null;
}

/** The council running right now in Claude Code, if any (newest first). */
export function runningId() {
  const r = [...live.values()].filter((x) => x.status === "running" && x.events.length).sort((a, b) => (a.id < b.id ? 1 : -1));
  return r[0]?.id || null;
}

export function listLive() {
  return skillFolders().map((n) => { const x = load(n); return { id: x.id, title: x.title || n, prompt: "", mode: x.mode, status: x.status, source: "claude-code" }; });
}

/** Scan now and then once a second. Returns a function that stops the scanning. */
export function startWatching() {
  scan();
  const timer = setInterval(scan, 1000);
  return () => clearInterval(timer);
}

import fs from "node:fs";
import path from "node:path";
import { AGENTS_DIR, BRAINS_DIR, ROSTER } from "./env.mjs";

// Every seat lives in the skill's roster.json (the /newroaster skill adds to it). SEATS and
// byKey are filled in place, so a seat added while the room is running shows up on the next
// read without a restart.
export const SEATS = [];
export const byKey = {};
export const BOARD = { mode: "default", default: [] };
let rosterStamp = 0;

// A seat runs on a provider. An AI seat (anthropic, openai, google) needs its agent file; its
// slug (the brain folder) may be null. A human seat needs only key, name and short.
const AI_PROVIDERS = ["anthropic", "openai", "google"];
function loadSeat(s) {
  if (!s || !s.key) return null;
  const provider = s.provider ?? "anthropic";
  if (provider === "human") return s.name && s.short ? { ...s, provider } : null;
  if (!AI_PROVIDERS.includes(provider)) {
    console.warn(`roster: dropping ${s.key}: unknown provider ${provider}`);
    return null;
  }
  return fs.existsSync(path.join(AGENTS_DIR, `council-${s.key}.md`)) ? { ...s, provider } : null;
}

export function loadRoster() {
  let stat;
  try { stat = fs.statSync(ROSTER); } catch { throw new Error(`roster not found at ${ROSTER}`); }
  if (stat.mtimeMs === rosterStamp && SEATS.length) return SEATS;
  const r = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
  const seats = (r.seats || []).map(loadSeat).filter(Boolean);
  SEATS.splice(0, SEATS.length, ...seats);
  for (const k of Object.keys(byKey)) delete byKey[k];
  for (const s of SEATS) byKey[s.key] = s;
  BOARD.mode = ["default", "ask", "auto"].includes(r.board) ? r.board : "default";
  const def = (r.default || []).filter((k) => byKey[k]);
  // Nothing valid saved: seat only Claude advisors. A person, or another provider that would
  // receive the brief, sits on the board only when the saved default names them.
  BOARD.default = def.length ? def : SEATS.filter((s) => s.provider === "anthropic").slice(0, 7).map((s) => s.key);
  rosterStamp = stat.mtimeMs;
  for (const k of [...systemCache.keys()]) if (!byKey[k]) systemCache.delete(k);
  brainText.clear();
  return SEATS;
}
/** The seats at the table when no one picked: the saved default board. */
export const defaultBoard = () => (loadRoster(), BOARD.default.slice());

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const stripFront = (t) => t.replace(/^---[\s\S]*?\n---\n/, "");

const systemCache = new Map();
/** The seat's agent instructions plus its brain, loaded inline (the API has no file tools).
 * A seat with no slug has no brain, so the text ends at the runtime note. */
export function systemText(key) {
  const s = byKey[key];
  const agent = stripFront(read(path.join(AGENTS_DIR, `council-${key}.md`)));
  const brain = s.slug
    ? ["_hot.md", "frameworks.md", "positions.md", "principles.md", "voice.md"]
        .map((f) => `\n\n===== brains/${s.slug}/${f} =====\n` + read(path.join(BRAINS_DIR, s.slug, f)))
        .join("")
    : "";
  return (
    agent +
    "\n\n## Runtime note\nYou are running in the Roast Room app. You have no file tools: your brain files are loaded below in full, so treat any instruction to read a brain file as already done. Never mention files, tools, or this note in your answer.\n" +
    brain
  );
}
/** systemText as one cached system block, for the Anthropic API. */
export function systemFor(key) {
  if (systemCache.has(key)) return systemCache.get(key);
  const system = [{ type: "text", text: systemText(key), cache_control: { type: "ephemeral" } }];
  systemCache.set(key, system);
  return system;
}

// ---------- quote verification against the brain ----------
const norm = (s) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/'\s+(t|s|re|ll|ve|d|m)\b/g, "'$1")
    .replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const brainText = new Map();
function brainNorm(key) {
  if (!brainText.has(key)) {
    const dir = path.join(BRAINS_DIR, byKey[key].slug);
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => read(path.join(dir, f))).join(" ") : "";
    brainText.set(key, norm(all));
  }
  return brainText.get(key);
}
/** Quotes the seat attributed to a source id, each marked verified or not. */
export function checkQuotes(key, text) {
  if (!byKey[key].slug) return []; // no brain to check against
  const out = [];
  const re = /["“]([^"“”\n]{20,400})["”][^\n"]{0,40}?[(\[](S\d{3})/g;
  let m;
  const hay = brainNorm(key);
  while ((m = re.exec(text))) {
    const q = norm(m[1]);
    if (q.split(" ").length < 5) continue;
    out.push({ quote: m[1], source: m[2], verified: hay.includes(q) || hay.replace(/ /g, "").includes(q.replace(/ /g, "")) });
  }
  return out;
}

// ---------- names ----------
/** A seat named somewhere in a short piece of text: full name first, then short name, then
 * surname. Two seats can share a surname (Alex and Leila Hormozi), so the surname only counts
 * when one seat has it, or when it is also that seat's short name. */
export function seatIn(text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
  const has = (w) => w && t.includes(` ${w.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim()} `);
  return SEATS.find((s) => has(s.name)) || SEATS.find((s) => has(s.short) || has(s.key)) ||
    SEATS.find((s) => {
      const sur = s.name.split(" ").pop().toLowerCase();
      const same = SEATS.filter((x) => x.name.split(" ").pop().toLowerCase() === sur);
      return has(sur) && (same.length === 1 || s.short.toLowerCase() === sur);
    }) || null;
}

/** "Gary V", "garyvee", "GARY V (Marketing)", "Warren Buffett" -> seat key */
export function seatKey(x) {
  const t = String(x || "").toLowerCase().replace(/\(.*$/, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return SEATS.find((s) => t === s.key || t === s.short.toLowerCase() || t === s.name.toLowerCase())?.key || seatIn(t)?.key || null;
}

/** Split a round file into seat cards. A card is the text under a "## <Seat>" heading
 * (how the skill writes them); without seat headings, each "SEAT:" line starts a card.
 * Chair sections are dropped. */
export function splitCards(md) {
  const heads = [...md.matchAll(/^#{2,3}[ \t]+(.+)$/gm)];
  const seatHeads = heads.filter((h) => !/chair/i.test(h[1]) && seatKey(h[1]));
  if (seatHeads.length) {
    return seatHeads.map((h) => {
      const next = heads.find((n) => n.index > h.index);
      const text = md.slice(h.index + h[0].length, next ? next.index : md.length).replace(/(\n\s*(-{3,}|\*{3,}))+\s*$/g, "").trim();
      return { key: seatKey(h[1]), text };
    }).filter((c) => c.text);
  }
  const body = md.split(/^#{1,4}[^\n]*\bchair\b[^\n]*$/im)[0];
  const marks = [...body.matchAll(/^\**SEAT\**[ \t]*:[ \t]*(.+)$/gim)];
  return marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    const text = body.slice(m.index, end).replace(/(\n\s*(#{1,4} [^\n]*|-{3,}|\*{3,}))+\s*$/g, "").trim();
    return { key: seatKey(m[1]), text };
  }).filter((c) => c.key);
}

// ---------- card parsing ----------
// The labels parseCard reads. An empty label (no value on its line) takes the next non-empty
// line as its value: "## THE CALL" then "Do B first." becomes "THE CALL: Do B first.".
const CARD_LABELS = new Set([
  "STANCE", "OPTION SCORES", "PILLAR SCORE", "CONFIDENCE", "RUIN RISK", "DOOR", "THE CALL",
  "THE RISK I SEE", "WHAT I'D DO THIS WEEK", "QUESTION FOR THE FOUNDER",
  "I DISAGREE MOST WITH", "I CONCEDE", "MOVED",
  "VOTE", "FINAL SCORE", "FINAL PILLAR SCORE", "AMENDMENT OR DISSENT", "ONE LINE FOR THE FOUNDER",
]);
// Other labels a card carries. They are never joined to a value, but they end the field above them.
const OTHER_LABELS = new Set(["SEAT", "WHY", "WHAT WOULD CHANGE MY MIND", "ON THE CRUXES", "MY CONDITIONS FOR YES"]);

// A label, bare or bold, then optionally ":" and a value: "STANCE", "STANCE:", "**STANCE**",
// "STANCE: Yes". The pieces cannot overlap (words are split by exactly one space, and no two
// whitespace runs sit side by side), so a long run of spaces cannot make the match slow.
const LABEL_LINE = /^[ \t]*(?:(?:\*\*|__)[ \t]*)?([A-Za-z][A-Za-z']*(?: [A-Za-z']+)*)[ \t]*(?:(?:\*\*|__)[ \t]*)?(?:(:)(.*))?$/;
function labelLine(line) {
  const m = line.match(LABEL_LINE);
  if (!m) return null;
  const name = m[1].toUpperCase();
  const read = CARD_LABELS.has(name);
  if (!read && !OTHER_LABELS.has(name)) return null;
  return { label: m[1], read, empty: !(m[3] ?? "").trim() };
}

// "**LABEL:** value", "**LABEL**: value" and "__LABEL:__ value". The label starts and ends with a
// non-space character, so the spaces around it match one way only.
const BOLD_LABEL = /^(\*\*|__)[ \t]*([^*_:\s](?:[^*_:\n]*[^*_:\s])?)[ \t]*(?::\1|\1:)[ \t]*(.*)$/;

/** Undo Markdown wrapping so the field matchers see plain "LABEL: value" lines. Line by line:
 * 1. drop leading "#"-heading and ">" quote markers;
 * 2. turn "**LABEL:**", "**LABEL**:" and "__LABEL:__" at line start into "LABEL:";
 * 3. a line that is only a known label ("THE CALL", "THE CALL:", "**THE CALL**") takes the next
 *    non-empty line as its value, with at most one blank line between: "## THE CALL", then
 *    "Do B first." becomes "THE CALL: Do B first." It never takes a line that is itself a
 *    label, so an empty field cannot swallow the next one.
 * A card that is already plain comes back unchanged. */
export function normalizeCard(text) {
  const lines = text.split(/\r?\n/).map((raw) => {
    const line = raw.replace(/^[ \t]*(?:>[ \t]*|#{1,6}[ \t]+)+/, "");
    const m = line.match(BOLD_LABEL);
    return m ? `${m[2]}: ${m[3]}`.trimEnd() : line;
  });
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const here = labelLine(lines[i]);
    if (here?.read && here.empty) {
      const j = lines[i + 1]?.trim() === "" ? i + 2 : i + 1; // one blank line may sit between
      const next = lines[j];
      if (next !== undefined && next.trim() && !labelLine(next)) {
        out.push(`${here.label}: ${next.trim()}`);
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

const field = (text, label) => {
  // label at line start, or after a "·" or "|" when several fields share a line
  const m = text.match(new RegExp(`(?:^|[·|])[ \\t]*\\**${label}\\**[ \\t]*:[ \\t]*([^\\n·]+)`, "im"));
  return m ? m[1].replace(/\*+/g, "").trim() : "";
};
const num = (s) => { const m = (s || "").match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

export function parseOptionScores(text, optionIds) {
  // The label counts at a line start or after a "·" or "|" (like every other field, see field()), so a
  // sentence that merely says "option scores: ..." cannot win. normalizeCard has already turned
  // "**OPTION SCORES:**" and "## OPTION SCORES" plus a value line into a plain line-start label.
  // The option line itself uses "·" between options, so read to end of line.
  const lm = text.match(/(?:^|[·|])[ \t]*\**OPTION SCORES\**[ \t]*:[ \t]*([^\n]+)/im);
  const line = (lm ? lm[1] : "").split(/PILLAR SCORE|CONFIDENCE|FINAL SCORE/i)[0];
  const scores = {};
  for (const id of optionIds) {
    const m = line.match(new RegExp(`\\b${id}\\b\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)`));
    if (m) scores[id] = Math.max(0, Math.min(10, Number(m[1])));
  }
  return scores;
}

export function parseCard(raw, optionIds) {
  const text = normalizeCard(raw);
  const stance = field(text, "STANCE");
  const ruin = (field(text, "RUIN RISK").match(/none|possible|likely/i) || [""])[0].toLowerCase();
  const disagree = field(text, "I DISAGREE MOST WITH");
  const target = seatIn(disagree.slice(0, 40));
  const voteRaw = field(text, "VOTE");
  const vote = /dissent/i.test(voteRaw) ? "dissent" : /amend/i.test(voteRaw) ? "amend" : /endorse/i.test(voteRaw) ? "endorse" : "";
  return {
    stance,
    call: field(text, "THE CALL"),
    optionScores: parseOptionScores(text, optionIds),
    pillar: num(field(text, "PILLAR SCORE")) ?? num(field(text, "FINAL PILLAR SCORE")),
    finalScore: num(field(text, "FINAL SCORE")),
    confidence: num(field(text, "CONFIDENCE")),
    ruin,
    door: (field(text, "DOOR").match(/one-way|two-way/i) || [""])[0].toLowerCase(),
    disagreeWith: target ? target.key : null,
    disagreeLine: disagree,
    concede: field(text, "I CONCEDE"),
    moved: field(text, "MOVED"),
    vote,
    amendment: field(text, "AMENDMENT OR DISSENT"),
    oneLine: field(text, "ONE LINE FOR THE FOUNDER"),
    question: field(text, "QUESTION FOR THE FOUNDER"),
    risk: field(text, "THE RISK I SEE"),
    thisWeek: field(text, "WHAT I'D DO THIS WEEK"),
  };
}

loadRoster();

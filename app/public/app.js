import { downloadVerdictPdf } from "./pdf.js";
import { badgeFor, seatDisclaimer, ROUND_FIELDS, CHOICES, MULTILINE } from "/runners.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SAMPLES = [
  ["Raise my prices?", "I run a coaching business doing $30k a month with 15 active clients at $2,000 each. I want to raise the price to $3,500. Options: raise for everyone now, raise for new clients only, or keep $2,000. Close rate is about 50% on sales calls. I'm leaning toward raising for everyone because I'm underpaid."],
  ["First salesperson?", "I'm a solo founder of a B2B SaaS at $25k MRR growing 5% a month. I do every sales call myself (about 20 hours a week) and I'm burning out. Should I hire a full-time account executive at $120k base, hire a part-time commission-only closer, or keep selling myself for six more months? I have $150k in the bank."],
  ["Second product?", "My agency makes $80k a month building AI automations for dentists. A few clients asked for an AI receptionist product. Should I build the receptionist as a separate SaaS, offer it as an add-on to existing clients only, or stay focused on the agency? Team of 6, about $200k cash."],
  ["Quit my job?", "I make $180k a year at a tech company. My side business (a paid newsletter) makes $6k a month and grew 8% a month this year. I have 9 months of expenses saved. Should I quit now, quit in 6 months, or keep both and hire a writer?"],
];

const EXAMPLE = "I run a coaching business at $30k a month with 15 clients at $2,000 each. Should I raise to $3,500 for everyone, raise for new clients only, or keep $2,000? Close rate is about 50% and I have $40k in the bank. Success is $45k a month by March. I'm leaning toward raising for everyone because I'm underpaid.";

// The how-to, shown in the side panel while the room is empty and in "How it works".
const GUIDE = `
  <div class="guide">
    <div class="guide-sec">
      <h4>How to use the Roast Room</h4>
      <ol>
        <li><span>Open Claude Code in this folder.</span></li>
        <li><span>Type <code>/roast-room</code> and your decision.</span></li>
        <li><span>Pick your advisors (the Chair recommends a board) and answer its questions. Then watch the council argue it out here.</span></li>
        <li><span>When the verdict lands, download it as a PDF.</span></li>
      </ol>
    </div>
    <div class="guide-sec">
      <h4>What to put in your question</h4>
      <ul>
        <li><span><b>The decision</b> in one line.</span></li>
        <li><span><b>Your options.</b> Two or three. "Keep doing what I do now" counts.</span></li>
        <li><span><b>Your numbers.</b> Revenue, cash, and team size.</span></li>
        <li><span><b>Your limits.</b> Deadline, hours, and budget.</span></li>
        <li><span><b>What success looks like</b>, and by when.</span></li>
        <li><span><b>Which way you're leaning</b>, and why. The council tests it.</span></li>
      </ul>
      <p class="note" style="margin-top:8px">Left something out? The Chair asks before the council starts.</p>
    </div>
    <div class="guide-sec">
      <h4>Example</h4>
      <div class="example">
        <p><code>/roast-room</code> ${EXAMPLE.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>
        <button class="ghost" type="button" data-copy-example>Copy this example</button>
      </div>
    </div>
    <div class="guide-sec">
      <h4>Good to know</h4>
      <ul>
        <li><span><b>Pick your council:</b> the Chair recommends the advisors that fit your question and asks you to confirm. Add or drop anyone.</span></li>
        <li><span><b>Full council:</b> 5 to 7 advisors, 3 rounds. For big calls that are hard to undo.</span></li>
        <li><span><b>Quick:</b> add <code>--quick</code> for 4 advisors and 2 rounds. Uses far less of your plan.</span></li>
        <li><span><b>Every council is saved.</b> Open Past sessions to replay one or download its PDF.</span></li>
        <li><span><b>Add an advisor:</b> type <code>/newroaster</code> and a name. Change your default board with <code>/roast-room board</code>.</span></li>
      </ul>
    </div>
  </div>`;

const SHAPES = ["base", "open", "mid", "blink"];
// A seat's cartoon frames live in /portraits/<key>-<shape>.webp (or .png, .jpg). A seat added with /newroaster
// may have only a base frame, or none: missing frames fall back to the base frame, then to a
// drawn bust in the seat's color whose mouth and eyes still move.
const portrait = (key, shape = "base") => {
  const have = state.byKey[key]?.portraits || {};
  return have[shape] || have.base || drawnBust(key, shape);
};
const bustCache = new Map();
function drawnBust(key, shape) {
  const id = `${key}-${shape}`;
  if (bustCache.has(id)) return bustCache.get(id);
  const s = state.byKey[key] || {};
  const c = /^#[0-9a-f]{6}$/i.test(s.color || "") ? s.color : "#37bdf8";
  const initials = esc((s.initials || s.short || key).slice(0, 3).toUpperCase());
  const eyes = shape === "blink"
    ? `<path d="M226 250h30M304 250h30" stroke="#1d2733" stroke-width="7" stroke-linecap="round"/>`
    : `<circle cx="241" cy="250" r="11" fill="#1d2733"/><circle cx="319" cy="250" r="11" fill="#1d2733"/><circle cx="245" cy="246" r="3.5" fill="#fff"/><circle cx="323" cy="246" r="3.5" fill="#fff"/>`;
  const mouth = shape === "open" ? `<ellipse cx="280" cy="318" rx="24" ry="17" fill="#5a2430"/>`
    : shape === "mid" ? `<ellipse cx="280" cy="316" rx="20" ry="8" fill="#5a2430"/>`
    : `<path d="M256 312q24 16 48 0" fill="none" stroke="#5a2430" stroke-width="7" stroke-linecap="round"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 560"><g transform="translate(-14 -64) scale(1.05)">
    <path d="M70 640c0-160 86-250 210-250s210 90 210 250z" fill="${c}"/>
    <path d="M232 384h96l-48 58z" fill="#e9eef3"/>
    <rect x="248" y="330" width="64" height="70" rx="22" fill="#d9b49a"/>
    <ellipse cx="280" cy="250" rx="112" ry="128" fill="#e8c4a8"/>
    <path d="M168 236c0-90 50-122 112-122s112 32 112 122c-20-46-60-64-112-64s-92 18-112 64z" fill="#3a4654"/>
    ${eyes}${mouth}
    <text x="280" y="540" text-anchor="middle" font-family="Montserrat, Arial, sans-serif" font-weight="800" font-size="54" fill="rgba(255,255,255,.92)">${initials}</text>
  </g></svg>`;
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  bustCache.set(id, url);
  return url;
}
const ROUND_NAME = ["", "Opening", "Debate", "Vote"];

const state = {
  seats: [], byKey: {}, board: [], table: [], session: null, options: [], weights: {}, active: [], round: 0,
  cards: { 1: {}, 2: {}, 3: {} }, replaying: false, verdict: null, links: [], geo: {}, setup: null, wait: null,
  // who runs each seat: { key: { provider, model, transport } }
  runners: {},
  // A person is answering round `sealed`: other seats' cards for that round wait in `held` until it closes.
  sealed: null, held: [], waitingSeats: [],
  // seat_absent reasons by round, for the card dialog
  absentLog: { 1: {}, 2: {}, 3: {} },
  // the open privacy or quorum pause: { session, kind, busy } or null
  pause: null, pauseHid: null,
  // requests from GET /api/inbox, and what the room knows is over: "<session>" or "<session>#<round>"
  inbox: [], shut: new Set(),
};

// ------------------------------------------------------------- boot
async function boot() {
  const r = await refreshSeats();
  state.runner = r.runner;
  if (r.runner === "api" && !r.hasKey) toast("No ANTHROPIC_API_KEY found in .env. Add it and restart the server.");
  renderSeats(state.board);
  renderSamples();
  bindUI();
  new ResizeObserver(() => { layoutStage(); drawLinks(); }).observe($("#stage"));
  startBlinking();
  reset();
  typeIn($("#composer h2"));
  typeIn($("#waiting h2"));
  const ss = await fetch("/api/sessions").then((x) => x.json());
  if (ss.running) attach(ss.running);
  else if (ss.live) attach(ss.live);
  refreshUsage();
  setInterval(watchForLive, 2500);
  setInterval(tickWait, 1000);
  setInterval(pollInbox, 2000);
  setInterval(tickAnswer, 1000);
  pollInbox();
}

// The roster (every seat, plus the default board) comes from the skill's roster.json.
async function refreshSeats() {
  const r = await fetch("/api/seats").then((x) => x.json());
  state.seats = r.seats;
  state.byKey = Object.fromEntries(r.seats.map((s) => [s.key, s]));
  state.board = (r.board?.default || []).filter((k) => state.byKey[k]);
  if (!state.board.length) state.board = r.seats.slice(0, 7).map((s) => s.key);
  bustCache.clear();
  return r;
}

// a council started in Claude Code shows up here on its own
const seenLive = new Set();
async function watchForLive() {
  const ss = await fetch("/api/sessions").then((x) => x.json()).catch(() => null);
  const id = ss?.live || ss?.running;
  if (!id || seenLive.has(id) || id === state.session) return;
  seenLive.add(id);
  attach(id);
}

// AIS arrival: a heading types in a character at a time, blur to sharp
function typeIn(el) {
  if (!el) return;
  const text = el.textContent;
  el.classList.add("typein");
  // characters sit inside a nowrap span per word, so lines only break between words
  let i = 0;
  el.innerHTML = text.split(" ").map((word) => `<span class="wd">${[...word].map((c) => `<span class="ch" style="animation-delay:${i++ * 22}ms">${esc(c)}</span>`).join("")}</span>`).join(" ");
  el.setAttribute("aria-label", text);
}

function renderSamples() {
  $("#samples").innerHTML = SAMPLES.map(([t], i) => `<button type="button" data-i="${i}">${esc(t)}</button>`).join("");
  $("#samples").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("#prompt").value = SAMPLES[b.dataset.i][1];
    $("#prompt").focus();
  });
}

const MAX_TABLE = 9; // the most busts the table can seat and still read

/** Seat these keys at the table (roster order). Does nothing when they are already seated. */
function renderSeats(keys) {
  const order = state.seats.map((s) => s.key);
  const want = order.filter((k) => keys.includes(k)).slice(0, MAX_TABLE);
  if (want.join() === state.table.join() && $("#seats").children.length) return;
  state.table = want;
  const seats = want.map((k) => state.byKey[k]);
  $("#seats").innerHTML = seats.map((s, i) => `
    <div class="seat" id="seat-${s.key}" data-seat="${s.key}" style="--d:-${(i * 1.7) % 6}s" tabindex="0" role="button" aria-label="${esc(s.name)}, ${esc(s.pillar)}. Open card.">
      <div class="think" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="bust" data-shape="base">${SHAPES.map((sh) => `<img class="${sh}" src="${portrait(s.key, sh)}" alt="" draggable="false">`).join("")}</div>
    </div>`).join("");
  $("#plates").innerHTML = seats.map((s) => `
    <div class="nameplate" id="plate-${s.key}" data-seat="${s.key}">
      <b>${esc(s.short === "Gary V" ? "Gary V" : s.name)}</b>
      <span class="prov"></span>
      <small>${esc(s.pillar)}</small>
      <div class="meta"><span class="pips" title="Weight on this decision"></span><span class="chip" hidden></span><span class="score" hidden></span></div>
    </div>`).join("");
  updateBadges();
  layoutStage();
  startBlinking();
}

/** The runner for a seat. A seat the council did not describe runs as its roster entry says. */
const runnerOf = (key) => state.runners[key] ?? (state.byKey[key]?.provider && state.byKey[key].provider !== "anthropic" ? { provider: state.byKey[key].provider } : undefined);

/** Put "Claude Sonnet", "GPT via API", "Human" and so on on each nameplate. No runner reads "Claude". */
function updateBadges() {
  for (const k of state.table) {
    const el = $(`#plate-${k} .prov`);
    if (!el) continue;
    el.textContent = badgeFor(runnerOf(k));
    el.dataset.p = runnerOf(k)?.provider || "anthropic";
  }
}

// The table is an ellipse seen from the front. Seats sit along its far edge: the
// middle seat is farthest (higher, smaller), the end seats nearest (lower, bigger).
function layoutStage() {
  const stage = $("#stage");
  const W = stage.clientWidth;
  const narrow = matchMedia("(max-width: 820px)").matches;
  const H = narrow ? Math.round(W * 0.62) : stage.clientHeight;
  const cx = W / 2, cy = H * (narrow ? 0.98 : 0.9), rx = W * 0.48, ry = H * (narrow ? 0.46 : 0.42);
  const t = $("#table");
  Object.assign(t.style, { left: `${cx - rx}px`, top: `${cy - ry}px`, width: `${rx * 2}px`, height: `${ry * 2}px` });
  const edge = (x) => cy - ry * Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2));
  // seats spread evenly along the far edge; past seven they shrink to fit
  const n = state.table.length;
  const xs = n === 1 ? [0.5] : state.table.map((_, i) => 0.085 + (0.83 * i) / (n - 1));
  const fit = Math.min(1, 6 / Math.max(1, n - 1));
  state.geo = {};
  state.table.forEach((k, i) => {
    const s = state.byKey[k];
    const x = W * xs[i];
    const d = ((x - cx) / rx) ** 2;
    const size = H * (narrow ? 0.5 + 0.08 * d : 0.37 + 0.07 * d) * fit;
    const bottom = edge(x) + size * 0.2;
    const el = $(`#seat-${s.key}`);
    Object.assign(el.style, { left: `${x - size / 2}px`, top: `${bottom - size}px`, width: `${size}px`, height: `${size}px`, zIndex: 10 + Math.round(d * 10) });
    const pl = $(`#plate-${s.key}`);
    pl.style.left = `${x}px`;
    pl.style.top = `${edge(x) + H * 0.01}px`; // straddles the table edge, over the chest
    state.geo[s.key] = { x, head: bottom - size * 0.72, top: bottom - size * 0.9, size };
  });
  const c = $("#center");
  if (narrow) {
    stage.style.paddingTop = `${H}px`; // the scene sits on top; captions flow below it
  } else {
    stage.style.paddingTop = "";
    // the captions start below the lowest nameplate they could collide with
    const inner = (n > 2 ? state.table.slice(1, -1) : state.table).map((k) => $(`#plate-${k}`));
    const top = Math.max(...inner.map((p) => p.offsetTop + p.offsetHeight / 2)) + H * 0.035;
    Object.assign(c.style, { left: `${W * 0.2}px`, width: `${W * 0.6}px`, top: `${top}px`, height: `${H - top - H * 0.09}px` });
  }
  const sp = state.speaking ? state.geo[state.speaking] : null;
  if (sp) moveSpot(state.speaking);
}

function moveSpot(key) {
  const g = state.geo[key]; const spot = $("#spot");
  if (!g) { spot.classList.remove("on"); return; }
  spot.style.left = `${g.x}px`;
  spot.style.top = `${g.head}px`;
  spot.style.width = spot.style.height = `${g.size * 1.9}px`;
  spot.classList.add("on");
}

function bindUI() {
  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = $("#prompt").value.trim();
    if (prompt.length < 10) return toast("Give the council a real decision, at least a sentence.");
    const mode = $('input[name="mode"]:checked').value;
    $("#convene").disabled = true;
    const r = await fetch("/api/council", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, mode }) });
    const j = await r.json();
    $("#convene").disabled = false;
    if (!r.ok) return toast(j.error || "Could not start the council.");
    attach(j.id);
  });
  const openFrom = (e) => { const b = e.target.closest("[data-seat]"); if (b) openCard(b.dataset.seat); };
  $("#seats").addEventListener("click", openFrom);
  $("#plates").addEventListener("click", openFrom);
  $("#seats").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFrom(e); } });
  $("#feed").addEventListener("click", (e) => { const c = e.target.closest(".feed-card"); if (c) openCard(c.dataset.seat, Number(c.dataset.round)); });
  $("#waitHistory").addEventListener("click", openHistory);
  $("#waitGuide").addEventListener("click", openGuide);
  $("#guideBtn").addEventListener("click", openGuide);
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-copy-example]")) {
      try { await navigator.clipboard.writeText("/roast-room " + EXAMPLE); toast("Copied. Paste it into Claude Code."); }
      catch { toast("Copy didn't work here. Select the text and copy it."); }
    }
    if (e.target.closest("[data-pdf]")) savePdf(e.target.closest("[data-pdf]"));
  });
  $("#historyBtn").addEventListener("click", openHistory);
  $("#newBtn").addEventListener("click", reset);
  $("#verdictSheet").addEventListener("click", (e) => { if (e.target.id === "verdictSheet" || e.target.closest("[data-close]")) $("#verdictSheet").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#verdictSheet").hidden = true; });
  // Clicking the dimmed backdrop around a card, the guide, or past sessions closes it (Escape already does).
  // Both press and release must land outside the box, so a text selection dragged out of it never closes it.
  $$("dialog.card-dialog").forEach((d) => {
    const outside = (e) => {
      const r = d.getBoundingClientRect();
      return e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    };
    let pressedOutside = false;
    d.addEventListener("pointerdown", (e) => { pressedOutside = outside(e); });
    d.addEventListener("click", (e) => { if (pressedOutside && outside(e)) d.close(); pressedOutside = false; });
  });
  $$(".speed button").forEach((b) => b.addEventListener("click", () => {
    player.speed = Number(b.dataset.speed);
    $$(".speed button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("#skipBtn").addEventListener("click", () => player.skip());
  $("#pcGo").addEventListener("click", () => answerPause("continue"));
  $("#pcStop").addEventListener("click", () => answerPause("stop"));
  $("#yourTurn").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    const req = b && state.inbox.find((r) => reqKey(r) === b.dataset.key);
    if (req) openAnswer(req);
  });
  $("#answerForm").addEventListener("submit", sendAnswer);
  // Enter in a one-line field would submit the form, and a send is final (409 after). Textareas keep Enter;
  // the Send button still submits.
  $("#answerForm").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") e.preventDefault(); });
  $("#answerForm").addEventListener("input", onFormEdit);
  $("#answerForm").addEventListener("change", onFormEdit);
  $("#ansClose").addEventListener("click", () => $("#answerDialog").close());
  $("#answerDialog").addEventListener("close", () => { saveDraft(); answer = null; });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollInbox(); });
}

// ------------------------------------------------------------- the player
// Every event goes through one ordered queue. Seats speak one at a time, at a
// readable pace, even though the API answers them in parallel. Skip ahead drains
// whatever is queued instantly; new events after that animate again.
const player = {
  q: [], busy: false, epoch: 0, speed: 1, fast: false, timers: new Set(),
  push(ev) { this.q.push(ev); this.info(); this.pump(); },
  async pump() {
    if (this.busy) return;
    this.busy = true;
    const my = this.epoch;
    while (this.q.length && my === this.epoch) {
      const ev = this.q.shift();
      this.info();
      hideWait();
      try { await handle(ev); } catch (e) { console.error(e); }
    }
    if (my === this.epoch) { this.busy = false; this.fast = false; this.info(); }
  },
  sleep(ms) {
    if (this.fast || ms <= 0) return Promise.resolve();
    return new Promise((res) => { const t = setTimeout(() => { this.timers.delete(o); res(); }, ms / this.speed); const o = { t, res }; this.timers.add(o); });
  },
  flushTimers() { for (const o of this.timers) { clearTimeout(o.t); o.res(); } this.timers.clear(); },
  skip() { this.fast = true; this.flushTimers(); },
  reset() { this.epoch++; this.q.length = 0; this.fast = true; this.flushTimers(); this.busy = false; this.fast = false; this.info(); },
  info() {
    const waiting = this.q.filter((e) => e.type === "seat_done").length;
    $("#queueInfo").textContent = waiting ? `${waiting} lines up next` : "";
  },
};

// ------------------------------------------------------------- session wiring
function reset() {
  state.es?.close();
  player.reset();
  Object.assign(state, {
    session: null, options: [], weights: {}, active: [], round: 0, cards: { 1: {}, 2: {}, 3: {} }, replaying: false, verdict: null, links: [], speaking: null, setup: null, wait: null,
    runners: {}, sealed: null, held: [], waitingSeats: [], absentLog: { 1: {}, 2: {}, 3: {} }, pause: null, pauseHid: null, shut: new Set(),
  });
  hideWait();
  $("#pausecard").hidden = true;
  $("#stage").classList.remove("live");
  $("#topic").hidden = true;
  $("#composer").hidden = state.runner !== "api";
  $("#waiting").hidden = state.runner === "api";
  $("#caption").hidden = true;
  $("#cruxes").hidden = true;
  $("#plate").hidden = true;
  $("#playbar").hidden = true;
  $("#newBtn").hidden = true;
  $("#verdictSheet").hidden = true;
  $("#panelHead").textContent = "Getting started";
  $("#feed").innerHTML = GUIDE;
  $$(".vote").forEach((b) => b.remove());
  renderSeats(state.board);
  $$(".seat").forEach((el) => { el.classList.remove("absent", "speaking", "thinking", "addressed"); $(".bust", el).dataset.shape = "base"; });
  $$(".seat").forEach((el) => el.classList.remove("absent-round"));
  $$(".nameplate").forEach((el) => { el.classList.remove("absent", "speaking", "absent-round"); const chip = $(".chip", el); chip.hidden = true; chip.className = "chip"; delete chip.dataset.mark; $(".score", el).hidden = true; $(".pips", el).innerHTML = ""; });
  updateBadges();
  $("#spot").classList.remove("on");
  $$(".stepper li").forEach((li) => li.classList.remove("active", "done"));
  drawLinks();
  renderYourTurn();
}

function begin(id) {
  reset();
  state.session = id;
  $("#composer").hidden = true;
  $("#waiting").hidden = true;
  $("#newBtn").hidden = false;
  $("#playbar").hidden = false;
  $("#panelHead").textContent = "Key points";
  $("#feed").innerHTML = '<div class="empty">One line per seat as the council talks. Click a seat to read its full card.</div>';
  $("#stage").classList.add("live");
  chairSays("The council is taking their seats", { dots: true });
}

function attach(id) {
  begin(id);
  const es = new EventSource(`/api/stream/${id}`);
  state.es = es;
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "end") { es.close(); refreshUsage(); player.push(ev); return; } // the queue clears the seal, the pause and the buttons in order
    if (ev.type === "delta") return; // seats speak from their finished cards
    if (ev.type === "usage") return refreshUsage();
    if (ev.type === "seat_error") return toast(`${state.byKey[ev.seat]?.short || ev.seat} hit an error: ${ev.error}`);
    player.push(ev);
  };
  es.onerror = () => { /* the browser retries; the server replays from the start */ };
}

// ------------------------------------------------------------- event handling
const STEP_OF = { setup: "setup", round1: "round1", cruxes: "cruxes", round2: "round2", draft: "round3", round3: "round3", skip3: "round3", verdict: "verdict" };
const ORDER = ["setup", "round1", "cruxes", "round2", "round3", "verdict"];

function setStep(step) {
  const idx = ORDER.indexOf(step);
  $$(".stepper li").forEach((li) => {
    const i = ORDER.indexOf(li.dataset.step);
    li.classList.toggle("done", i < idx);
    li.classList.toggle("active", i === idx);
  });
}

async function handle(ev) {
  switch (ev.type) {
    case "phase": {
      state.wait = { phase: ev.phase, at: ev.at || Date.now() };
      setStep(STEP_OF[ev.phase] || "setup");
      feedPhase(ev.label);
      const thinking = ["setup", "cruxes", "draft", "verdict"].includes(ev.phase);
      if (thinking || ev.phase === "skip3") {
        chairSays(ev.label.replace(/^The Chair is /, "").replace(/^./, (c) => c.toUpperCase()), { dots: thinking });
        await player.sleep(1400);
      }
      break;
    }
    case "setup": state.setup = ev; await onSetup(ev); await player.sleep(1800); break;
    case "runners": state.runners = ev.runners || {}; updateBadges(); break;
    case "round_start": onRoundStart(ev.round); break;
    case "seat_start": $(`#seat-${ev.seat}`)?.classList.add("thinking"); break;
    case "seat_done":
      // While a person answers this round, no one else's card is read out. It waits in state.held.
      if (state.sealed !== null && ev.round === state.sealed) holdSeat(ev);
      else await onSeatDone(ev);
      break;
    case "seat_absent": onSeatAbsent(ev); break;
    case "waiting": await onWaiting(ev); break;
    case "waiting_done": await closeRound(ev.round); break;
    case "round_done": {
      const epoch = player.epoch;
      await closeRound(ev.round);
      if (player.epoch !== epoch) break; // the room moved to another council meanwhile
      state.wait = null; updateOptions(ev.scores); break;
    }
    case "cruxes": await onCruxes(ev); break;
    case "draft": await onDraft(ev.draft); break;
    case "pause": showPause(ev); break;
    case "resumed": hidePause(); break;
    // finishSession returns early when the room is reset while it plays held cards. The verdict and the
    // error then belong to the council the room left, so they must not show against the new one.
    case "verdict": {
      const epoch = player.epoch;
      await finishSession();
      if (player.epoch !== epoch) break;
      state.wait = null; onVerdict(ev); break;
    }
    case "error": {
      const epoch = player.epoch;
      await finishSession();
      if (player.epoch !== epoch) break;
      state.wait = null; toast(`The council stopped: ${ev.error}`); chairSays(`The council stopped: ${ev.error}`); break;
    }
    case "end": await finishSession(); break;
  }
}

async function onSetup(ev) {
  if (ev.seats.some((k) => !state.byKey[k])) await refreshSeats(); // a seat added since the page loaded
  // seat the default board plus anyone this council called in; past the table's limit, only this council
  const both = [...new Set([...state.board, ...ev.seats])];
  renderSeats(both.length <= MAX_TABLE ? both : ev.seats);
  state.options = ev.options;
  state.weights = ev.weights;
  state.active = ev.seats;
  state.runners = ev.runners || {};
  updateBadges();
  $("#topic").hidden = false;
  $("#topicTitle").textContent = ev.title;
  typeIn($("#topicTitle"));
  $("#options").innerHTML = ev.options.map((o) => `
    <div class="opt" data-opt="${o.id}"><span class="id">${o.id}</span><span class="label">${esc(o.label)}</span><span class="val">-</span><span class="bar"><i></i></span></div>`).join("");
  for (const s of state.table.map((k) => state.byKey[k])) {
    const absent = !ev.seats.includes(s.key);
    $(`#seat-${s.key}`).classList.toggle("absent", absent);
    const pl = $(`#plate-${s.key}`);
    pl.classList.toggle("absent", absent);
    const w = ev.weights[s.key]?.weight || 1;
    pl.title = `Weight ${w} of 3: ${ev.weights[s.key]?.reason || ""}`;
  }
  chairSays(ev.title, { tag: ev.mode === "quick" ? "Quick council" : "Full council" });
}

function updateOptions(scores) {
  const best = Object.entries(scores).sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0))[0]?.[0];
  for (const [id, v] of Object.entries(scores)) {
    const el = $(`.opt[data-opt="${id}"]`); if (!el) continue;
    $(".val", el).textContent = v.score ?? "-";
    $(".bar i", el).style.width = `${(v.score || 0) * 10}%`;
    el.classList.toggle("lead", id === best);
    el.title = v.math;
  }
}

function onRoundStart(round) {
  state.round = round;
  $$(".seat.absent-round").forEach((el) => markAbsent(el.dataset.seat, false)); // absent for one round, not for the council
  state.links = [];
  drawLinks();
  $("#cruxes").hidden = true;
  chairSays(`${["", "Round 1: opening positions", "Round 2: the debate", "Round 3: the vote"][round]}`, { dots: true, tag: "The floor is open" });
}

// ------------------------------------------------------------- talking
const clean = (t) => String(t || "").replace(/\s*\((?:S\d+|source[^)]*)[^)]*\)/gi, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

function firstSentences(t, max) {
  const parts = t.match(/[^.!?]+[.!?]+["”)]?\s*|[^.!?]+$/g) || [t];
  let out = "";
  for (const p of parts) { if (out && (out + p).length > max) break; out += p; }
  return shorten(out.trim(), max + 40);
}

/** The line a seat says out loud: the headline of its card, not the whole card. */
function lineFor(round, p, max = 170) {
  if (round === 1) return firstSentences(clean(p.call || p.stance), max);
  if (round === 2) {
    let t = clean(p.disagreeLine || p.stance);
    // "Graham. His argument..." reads as talking to him: "Graham, his argument..."
    t = t.replace(/^([A-Za-z][\w.' ]{0,24})[.:,]\s+(\S+)/, (m, name, next) => !seatKey(name) ? m : `${state.byKey[seatKey(name)].short}, ${/^I('|$)/.test(next) ? next : next[0].toLowerCase() + next.slice(1)}`);
    return firstSentences(t, max);
  }
  return firstSentences(clean(p.oneLine || p.amendment), max);
}

function shapesFor(word) {
  const out = [];
  for (const ch of word.toLowerCase()) {
    const s = "aei".includes(ch) ? "open" : "ouwy".includes(ch) ? "mid" : "mbpf".includes(ch) ? "base" : null;
    if (s && s !== out[out.length - 1]) out.push(s);
  }
  return out.length ? out : ["mid"];
}

function setShape(key, shape) { const b = $(`#seat-${key} .bust`); if (b) b.dataset.shape = shape; }

function setSpeaker(key, target) {
  state.speaking = key;
  $$(".seat").forEach((el) => { el.classList.toggle("speaking", el.dataset.seat === key); el.classList.toggle("addressed", el.dataset.seat === target); });
  $$(".nameplate").forEach((el) => el.classList.toggle("speaking", el.dataset.seat === key));
  const el = key && $(`#seat-${key}`);
  if (el) {
    el.classList.remove("thinking");
    // lean toward whoever they're answering
    const g = state.geo[key], tg = target && state.geo[target];
    el.style.transform = tg ? `translateX(${Math.sign(tg.x - g.x) * g.size * 0.04}px) rotate(${Math.sign(tg.x - g.x) * 2.5}deg) scale(1.05)` : "scale(1.05)";
    moveSpot(key);
  } else $("#spot").classList.remove("on");
  $$(".seat").forEach((s) => { if (s.dataset.seat !== key) s.style.transform = ""; });
}

function captionFor(who) {
  $("#cruxes").hidden = true;
  $("#plate").hidden = true;
  const c = $("#caption");
  c.hidden = false;
  c.style.animation = "none"; void c.offsetWidth; c.style.animation = "";
  const s = state.byKey[who];
  $("#capAv").className = `cap-av${s ? "" : " chair"}`;
  $("#capAv").innerHTML = `<img src="${s ? portrait(who) : "/brand/ais-symbol.png"}" alt="">`;
  $("#capWho").textContent = s ? s.name : "The Chair";
}

function chairSays(text, { dots = false, tag = "" } = {}) {
  setSpeaker(null);
  captionFor(null);
  $("#capTag").textContent = tag;
  const p = $("#capText");
  p.className = "cap-text chair";
  p.innerHTML = esc(text) + (dots ? '<span class="dots"><i></i><i></i><i></i></span>' : "");
  $("#capSub").textContent = "";
}

async function speak(key, text, { tag = "", target = null, sub = "" } = {}) {
  setSpeaker(key, target);
  captionFor(key);
  $("#capTag").textContent = tag;
  $("#capSub").textContent = "";
  const p = $("#capText");
  p.className = "cap-text";
  const words = text.split(" ").filter(Boolean);
  p.innerHTML = words.map((w) => `<span class="w">${esc(w)}</span> `).join("");
  const spans = $$(".w", p);
  for (let i = 0; i < words.length; i++) {
    if (player.fast) break;
    const w = words[i];
    spans[i].classList.add("on");
    const shapes = shapesFor(w.replace(/[^a-z]/gi, ""));
    const dur = Math.max(170, w.length * 52);
    const per = dur / (shapes.length + 1);
    for (const sh of shapes) { setShape(key, sh); await player.sleep(per); }
    setShape(key, "base");
    await player.sleep(per + (/[.!?]["”)]?$/.test(w) ? 340 : /[,;:]$/.test(w) ? 170 : 25));
  }
  spans.forEach((s) => s.classList.add("on"));
  setShape(key, "base");
  $("#capSub").innerHTML = sub;
  await player.sleep(1300);
}

// idle blinking for everyone, so the room feels alive between lines
const blinking = new Set();
function startBlinking() {
  const blink = (key) => {
    const b = $(`#seat-${key} .bust`);
    if (b && b.dataset.shape === "base") {
      b.dataset.shape = "blink";
      setTimeout(() => { if (b.dataset.shape === "blink") b.dataset.shape = "base"; }, 130);
    }
    setTimeout(() => blink(key), 2400 + Math.random() * 4200);
  };
  state.table.filter((k) => !blinking.has(k)).forEach((k, i) => { blinking.add(k); setTimeout(() => blink(k), 600 + i * 530); });
}

async function onSeatDone(ev) {
  const { round, seat, text, parsed, quotes } = ev;
  state.cards[round][seat] = { text, parsed, quotes, partial: ev.partial === true };
  markAbsent(seat, false); // a seat that answers is not absent
  const s = state.byKey[seat];
  const top = topOption(parsed.optionScores);
  const line = lineFor(round, parsed);
  let tag = ROUND_NAME[round], sub = "", target = null;
  if (round === 1) {
    tag = `${stanceWord(parsed.stance)}${top ? ` · backs ${top.id} (${top.v}/10)` : ""}`;
  } else if (round === 2) {
    const tgt = parsed.disagreeWith ? state.byKey[parsed.disagreeWith] : null;
    if (tgt) {
      target = tgt.key;
      tag = `Pushes back on ${tgt.short}`;
      state.links = state.links.filter((l) => l.from !== seat);
      state.links.push({ from: seat, to: tgt.key });
      drawLinks();
    }
    sub = /^yes/i.test(parsed.moved) ? "Changed position" : "";
  } else {
    tag = parsed.vote ? `Votes ${parsed.vote}` : "No vote"; // a missing vote is not an endorsement
  }
  feedCard(round, seat, parsed, ev.partial === true);
  await speak(seat, line || "I'll put it in my card.", { tag, target, sub });

  const pl = $(`#plate-${seat}`);
  const chip = $(".chip", pl);
  chip.hidden = round === 3; // the vote stamp says it
  chip.className = "chip";
  delete chip.dataset.mark;
  if (round === 3) {
    const v = parsed.vote || "no vote";
    const vc = /^[a-z]+$/.test(v) ? v : "novote"; // "no vote" has a space, and a class name cannot
    chip.textContent = v;
    chip.classList.add(vc);
    $(`#seat-${seat} .vote`)?.remove();
    const stamp = document.createElement("div");
    stamp.className = `vote ${vc}`;
    stamp.textContent = v.toUpperCase();
    $(`#seat-${seat}`).appendChild(stamp);
  } else chip.textContent = stanceWord(parsed.stance);
  if (top) { const sc = $(".score", pl); sc.hidden = false; sc.textContent = `${top.id} ${top.v}`; sc.title = `Highest score: option ${top.id}`; }
  setSpeaker(null);
  void s;
}

function stanceWord(t = "") {
  const m = t.match(/strong yes|conditional yes|strong no|yes|no/i);
  if (!m) return "Spoke";
  const w = m[0].toLowerCase();
  return w === "conditional yes" ? "Yes, if" : w[0].toUpperCase() + w.slice(1);
}

function topOption(scores = {}) {
  const e = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return e ? { id: e[0], v: e[1] } : null;
}
const shorten = (t, n) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t);
const face = (k) => `<img src="${portrait(k)}" alt="${esc(state.byKey[k]?.short || k)}" title="${esc(state.byKey[k]?.short || k)}">`;

async function onCruxes(ev) {
  setSpeaker(null);
  $("#caption").hidden = true;
  const c = $("#cruxes");
  c.hidden = false;
  c.innerHTML = `<div class="head">${ev.unanimous ? "Too much agreement. The Chair pushes back." : "What they're fighting about"}</div>` +
    ev.cruxes.map((x, i) => `<div class="crux" style="animation-delay:${i * 0.18}s"><b>${esc(x.question)}</b><div class="sides">${x.sides.map((sd) => `<span class="side"><span class="faces">${sd.seats.filter((k) => state.byKey[k]).map(face).join("")}</span>${esc(shorten(sd.position, 48))}</span>`).join("")}</div></div>`).join("");
  const f = document.createElement("div");
  f.className = "feed-note";
  f.innerHTML = `<b>The fight:</b> ${ev.cruxes.map((x) => esc(x.question)).join(" ")}`;
  feedAppend(f);
  await player.sleep(3500 + 1800 * ev.cruxes.length);
}

async function onDraft(d) {
  chairSays(`Proposal: ${d.label} on option ${d.option}. ${firstSentences(clean(d.recommendation), 140)}`, { tag: "Up for a vote" });
  const f = document.createElement("div");
  f.className = "feed-note";
  f.innerHTML = `<b>Up for a vote:</b> ${esc(d.label)} on option ${esc(d.option)}.`;
  feedAppend(f);
  await player.sleep(4200);
}

// ------------------------------------------------------------- rebuttal arcs
function drawLinks() {
  const svg = $("#links");
  const stage = $("#stage");
  const w = stage.clientWidth, h = stage.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const links = state.links || [];
  const col = "#38bdf8";
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${col}"/></marker></defs>` +
    links.map(({ from, to }, i) => {
      const a = state.geo[from], b = state.geo[to];
      if (!a || !b) return "";
      const y1 = a.top - 6, y2 = b.top - 6;
      const mx = (a.x + b.x) / 2, my = Math.min(y1, y2) - Math.min(90, Math.abs(a.x - b.x) * 0.22) - 10;
      return `<path class="${i < links.length - 1 ? "old" : ""}" d="M${a.x},${y1} Q${mx},${my} ${b.x},${y2}" stroke="${col}" marker-end="url(#arrow)"/>`;
    }).join("");
}

// ------------------------------------------------------------- feed + cards
function feedAppend(node) {
  const feed = $("#feed");
  $(".empty", feed)?.remove();
  feed.appendChild(node);
  feed.scrollTop = feed.scrollHeight;
}
function feedPhase(label) {
  const d = document.createElement("div");
  d.className = "feed-phase";
  d.textContent = label.replace(/^The Chair is /, "Chair: ");
  feedAppend(d);
}
function feedCard(round, seat, parsed, partial = false) {
  const s = state.byKey[seat];
  const d = document.createElement("div");
  d.className = "feed-card";
  d.dataset.seat = seat;
  d.dataset.round = round;
  const top = topOption(parsed.optionScores);
  const tgt = parsed.disagreeWith ? state.byKey[parsed.disagreeWith]?.short : "";
  const what = round === 1 ? `${stanceWord(parsed.stance)}${top ? `, backs ${top.id}` : ""}` : round === 2 ? (tgt ? `vs ${tgt}` : "Debate") : (parsed.vote ? `Votes ${parsed.vote}` : "No vote");
  const cut = partial ? `<span class="cut" title="This card hit the length limit and ended early.">cut off</span>` : "";
  d.innerHTML = `<img class="av" src="${portrait(seat)}" alt=""><div><div class="h">${esc(s.short)}<span class="r">${esc(what)}</span>${cut}</div><p>${esc(lineFor(round, parsed, 105))}</p></div>`;
  feedAppend(d);
}

function openCard(seat, round) {
  const s = state.byKey[seat];
  const rounds = [3, 2, 1].filter((r) => state.cards[r][seat]);
  const r = round || rounds[0];
  const c = state.cards[r]?.[seat];
  // With no card to show, say why: sealed while a person answers, absent, or simply not yet.
  const held = state.held.some((e) => e.seat === seat && (!round || e.round === round));
  const goneRound = round || [3, 2, 1].find((x) => state.absentLog[x]?.[seat] !== undefined);
  const empty = held ? `<p class="muted">${esc(s.short)} has answered. The card opens when the round closes.</p>`
    : goneRound && state.absentLog[goneRound]?.[seat] !== undefined ? `<p class="muted">${esc(s.short)} did not answer Round ${goneRound} (${esc(state.absentLog[goneRound][seat])}).</p>`
    : `<p class="muted">This seat has not spoken yet.</p>`;
  $("#cardBody").innerHTML = `
    <div class="card-head"><img src="${portrait(seat)}" alt=""><div><div class="label">${esc(s.pillar)}</div><h3>${esc(s.name)}</h3><p class="muted" style="margin:0">Owns the question: ${esc(s.question)}</p></div></div>
    ${rounds.length > 1 ? `<p style="margin:0 0 6px">${rounds.slice().reverse().map((x) => `<button class="ghost" data-r="${x}" style="margin-right:6px">${ROUND_NAME[x]}</button>`).join("")}</p>` : ""}
    ${c ? `<pre>${esc(c.text)}</pre>${c.partial ? `<p class="cutoff">Cut off: this card hit the length limit and ended early.</p>` : ""}${c.quotes.length ? `<ul class="qcheck">${c.quotes.map((q) => `<li class="${q.verified ? "" : "bad"}">"${esc(shorten(q.quote, 110))}" (${q.source}) ${q.verified ? "verified in the brain" : "not found in the brain"}</li>`).join("")}</ul>` : ""}` : empty}
    <p class="muted" style="font-size:12px">${esc(seatDisclaimer(s, state.runners[seat]))}</p>`;
  $$("#cardBody [data-r]").forEach((b) => b.addEventListener("click", () => openCard(seat, Number(b.dataset.r))));
  const dlg = $("#cardDialog");
  if (!dlg.open) dlg.showModal();
}

// ------------------------------------------------------------- verdict
// the Chair should write display names; map any raw seat key just in case
const seatKey = (x) => { const k = String(x).toLowerCase().replace(/\s+/g, ""); return state.byKey[k] ? k : state.seats.find((s) => s.short.toLowerCase() === String(x).toLowerCase() || s.name.toLowerCase() === String(x).toLowerCase())?.key; };
const seatName = (x) => state.byKey[seatKey(x)]?.short || x;

/** "7 amend" or "5 endorse, 1 dissent": only the votes that were cast, in the order of the vote round. */
function voteLine(votes) {
  const order = ["endorse", "amend", "dissent"];
  const keys = [...order.filter((k) => votes[k]), ...Object.keys(votes).filter((k) => !order.includes(k) && votes[k])];
  return keys.length ? keys.map((k) => `${votes[k]} ${k}`).join(", ") : "No votes cast";
}

function labelClass(l) { return /DON'T/.test(l) ? "dont" : /RESHAPE/.test(l) ? "reshape" : /WAIT/.test(l) ? "wait" : "go"; }

function onVerdict(ev) {
  const v = ev.verdict;
  state.verdict = ev;
  setStep("verdict");
  setSpeaker(null);
  $("#caption").hidden = true;
  $("#cruxes").hidden = true;
  state.links = [];
  drawLinks();
  $("#stage").classList.remove("live");
  updateOptions(v.scores);
  const opt = (id) => state.options.find((o) => o.id === id)?.label || id;
  const seats = ev.seats;
  const mk = seatKey(v.minority.seat);
  const short = (t, n) => esc(shorten(clean(t || ""), n));
  const html = `
    <div class="v-top">
      <div><div class="label">The council's verdict</div><span class="v-label ${labelClass(v.label)}">${esc(v.label)}</span></div>
      <div class="actions"><button class="pill" type="button" data-pdf>Download PDF</button><button class="ghost" data-close>Back to the table</button></div>
    </div>
    <p class="v-call">${esc(v.call)}</p>
    <div class="v-grid">
      <div class="v-sec"><h3>Scores</h3><div class="v-opts">${state.options.map((o) => `
        <div class="opt ${o.id === v.recommended ? "lead" : ""}"><span class="id">${o.id}</span><span class="label">${esc(o.label)}</span><span class="val">${v.scores[o.id]?.score ?? "-"}</span><span class="bar"><i style="width:${(v.scores[o.id]?.score || 0) * 10}%"></i></span></div>`).join("")}</div>
        <p class="v-meta">Confidence ${v.confidence ?? "-"}/10${v.votes ? ` · ${esc(voteLine(v.votes))}` : ""}</p>
      </div>
      <div class="v-sec"><h3>Why</h3><ul class="v-why">${v.why.slice(0, 3).map((w) => { const k = seatKey(w.seat); return `<li>${k ? `<img class="av" src="${portrait(k)}" alt="">` : ""}<span>${short(w.point, 150)}</span></li>`; }).join("")}</ul></div>
      <div class="v-sec"><h3>Watch out</h3><div class="minority"><div class="who">${mk ? `<img class="av" src="${portrait(mk)}" alt="">` : ""}${esc(seatName(v.minority.seat))}</div><q>${short(v.minority.quote, 170)}</q></div></div>
      <div class="v-sec"><h3>Next steps</h3><ul class="v-steps">${v.next_steps.slice(0, 3).map((n) => `<li><b>${esc(n.when)}</b> ${short(n.action, 120)}</li>`).join("")}</ul>
        <p class="v-meta"><b>Kill it if:</b> ${short(v.kill_criteria, 140)}</p></div>
    </div>
    <details class="v-more"><summary>Full detail</summary>
      <div class="v-grid">
        <div class="v-sec"><h3>Where they fought</h3><ul>${v.fights.map((f) => `<li><b>${esc(f.crux)}</b> ${esc(f.story)}</li>`).join("")}</ul></div>
        <div class="v-sec"><h3>Conditions</h3><ol>${v.conditions.map((c) => `<li>${esc(c)}</li>`).join("")}</ol></div>
        <div class="v-sec v-wide"><h3>Scorecard</h3>
          <table class="scorecard"><thead><tr><th>Seat</th><th>Weight</th>${state.options.map((o) => `<th>${o.id}</th>`).join("")}<th>Their line</th></tr></thead><tbody>
          ${seats.map((x) => { const s = state.byKey[x.key]; return `<tr${x.absent ? ' class="gone"' : ""}><td><span class="who"><img class="av" src="${portrait(x.key)}" alt="">${esc(s.short)}${x.absent ? '<span class="tag-absent">Absent</span>' : ""}</span></td><td class="n">${x.weight}</td>${state.options.map((o) => `<td class="n">${x.absent ? "-" : x.optionScores?.[o.id] ?? "-"}</td>`).join("")}<td class="line">${x.absent ? "" : short(x.oneLine, 150)}</td></tr>`; }).join("")}
          </tbody></table>
          <p class="muted" style="font-size:11.5px;margin-top:8px">Weighted by how much each pillar matters here. ${state.options.map((o) => `${o.id}: ${esc(v.scores[o.id]?.math || "")}`).join(" · ")}</p></div>
        <div class="v-sec"><h3>Cheapest test</h3><p>${esc(v.cheapest_test)}</p><h3>Revisit</h3><p>${esc(v.revisit)}</p></div>
        <div class="v-sec"><h3>The strongest objection in full</h3><p>${esc(v.minority.quote)}</p><p class="muted">For this to be right: ${esc(v.minority.would_have_to_be_true)}</p></div>
        ${v.amendments?.length ? `<div class="v-sec v-wide"><h3>Amendments</h3><ul>${v.amendments.map((a) => `<li><b>${esc(seatName(a.seat))}:</b> ${esc(a.amendment)} <span class="tag">${a.adopted ? "Adopted" : "Not adopted"}: ${esc(a.reason)}</span></li>`).join("")}</ul></div>` : ""}
      </div>
    </details>
    <div class="v-foot"><span class="muted">${esc(v.disclaimer)}</span><button class="ghost" data-close>Back to the table</button></div>`;
  $("#verdictBody").innerHTML = html;
  for (const x of seats) if (x.absent) markAbsent(x.key, true); // no answer in the last round: no score on the table
  const plate = $("#plate");
  plate.hidden = false;
  plate.innerHTML = `<div class="label">The council's verdict</div><span class="v-label ${labelClass(v.label)}">${esc(v.label)}</span><p>${esc(firstSentences(clean(v.call), 150))}</p><div class="row"><button type="button" id="plateOpen">Read the verdict</button><button type="button" data-pdf>Download PDF</button><button type="button" class="alt" id="plateReplay">Replay this council</button></div>`;
  $("#plateOpen").addEventListener("click", () => ($("#verdictSheet").hidden = false));
  $("#plateReplay").addEventListener("click", () => replay(state.session));
  $("#playbar").hidden = true;
  const f = document.createElement("div");
  f.className = "feed-note";
  f.innerHTML = `<b>Verdict: ${esc(v.label)}.</b> ${esc(firstSentences(clean(v.call), 160))}`;
  feedAppend(f);
  setTimeout(() => { if (state.verdict === ev) $("#verdictSheet").hidden = false; }, 1600);
}

// ------------------------------------------------------------- history + replay
async function openHistory() {
  const { sessions } = await fetch("/api/sessions").then((x) => x.json());
  $("#historyList").innerHTML = sessions.length
    ? sessions.map((s) => `<li><button data-id="${esc(s.id)}"><b>${esc(s.title)}</b><small>${esc(s.id.slice(0, 10))} · ${esc(s.mode)} · ${esc(s.status)}</small></button>${s.status === "done" ? `<button class="pdf" type="button" data-pdf="${esc(s.id)}" title="Download the verdict as a PDF">PDF</button>` : ""}</li>`).join("")
    : '<li class="muted">No sessions yet. Convene the council once and it shows up here.</li>';
  $$("#historyList button[data-id]").forEach((b) => b.addEventListener("click", () => { $("#historyDialog").close(); replay(b.dataset.id); }));
  $("#historyDialog").showModal();
}

async function replay(id) {
  const j = await fetch(`/api/sessions/${encodeURIComponent(id)}`).then((x) => x.json());
  begin(id);
  state.replaying = true;
  for (const ev of j.events) {
    if (["delta", "usage", "seat_error", "end"].includes(ev.type)) continue;
    player.push(ev);
  }
  // A saved council is over, so nothing in it can still be waiting: this clears a seal, a pause or a
  // button that the saved events left open. A council still running keeps them.
  if (j.status && j.status !== "running") player.push({ type: "end" });
}

// ------------------------------------------------------------- waiting on Claude Code
// A live council goes quiet for minutes while the seats write in parallel. Instead of a
// frozen table, say what is happening, how long it has been, and what each seat is weighing.
const SAME_TIME = "The advisors all write at the same time in Claude Code. Their lines play here as soon as the round is in.";
function waitCopy(phase) {
  const n = state.setup?.mode === "quick" ? 2 : 3;
  return {
    setup: ["Setting the table", "The Chair is seating the council.", ""],
    round1: ["Round 1 of " + n, "The advisors are writing their opening positions.", SAME_TIME],
    round2: ["Round 2 of " + n, "The advisors are reading each other's openings and firing back.", SAME_TIME],
    round3: ["Round 3 of " + n, "The advisors are voting on the Chair's proposal.", SAME_TIME],
    cruxes: ["Between rounds", "The Chair is reading the openings and finding where they disagree.", "The fight shows up here next, then the debate starts."],
    draft: ["Between rounds", "The Chair is turning the debate into a proposal for the vote.", "Next, every advisor votes on it."],
    skip3: ["Last step", "The Chair is scoring the room and writing the verdict.", "When it lands, you can download it as a PDF."],
    verdict: ["Last step", "The Chair is scoring the room and writing the verdict.", "When it lands, you can download it as a PDF."],
  }[phase] || ["Working", "The council is working.", ""];
}
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

function hideWait() {
  const w = $("#waitcard");
  if (w.hidden) return;
  w.hidden = true;
  $$(".seat.musing").forEach((e) => e.classList.remove("musing"));
  if (state.capWasShown) $("#caption").hidden = false;
  if (state.playbarWasShown) $("#playbar").hidden = false;
}

function tickWait() {
  const w = state.wait;
  const idle = !player.busy && !player.q.length;
  if (!w || !idle || state.replaying || !state.session || state.verdict || state.pause) return hideWait();
  const card = $("#waitcard");
  if (card.hidden) {
    state.capWasShown = !$("#caption").hidden;
    $("#caption").hidden = true;
    $("#cruxes").hidden = true;
    // speed controls do nothing while the room waits, and they would cover the card
    state.playbarWasShown = !$("#playbar").hidden;
    $("#playbar").hidden = true;
    card.hidden = false;
    state.museAt = 0;
  }
  let [step, head, sub] = waitCopy(w.phase);
  const elapsed = Date.now() - w.at;
  const round = Number((w.phase.match(/^round(\d)$/) || [])[1]) || 0;
  // A person is answering this round: say who, instead of "the advisors are writing in Claude Code".
  const people = round && state.sealed === round ? state.waitingSeats.map((x) => state.byKey[x.key]?.short).filter(Boolean) : [];
  if (people.length) { head = `Waiting for ${joinList(people)} to answer.`; sub = "The other cards stay sealed until the round closes."; }
  $("#wcStep").textContent = step;
  $("#wcTime").textContent = clock(elapsed);
  $("#wcHead").textContent = head;
  $("#wcSub").textContent = sub;
  $("#wcNudge").hidden = elapsed < 4 * 60 * 1000 || people.length > 0;
  const bar = $("#wcBar").parentElement;
  const muse = $("#wcMuse");
  if (round) {
    const seats = state.active.length ? state.active : state.table;
    const sealedKeys = new Set(state.held.filter((e) => e.round === round).map((e) => e.seat));
    const answered = (k) => state.cards[round][k] || sealedKeys.has(k);
    const done = seats.filter(answered).length;
    bar.classList.toggle("indeterminate", done === 0);
    $("#wcBar").style.width = done ? Math.round((done / seats.length) * 100) + "%" : "";
    // every few seconds, show what one of the still-thinking seats is weighing
    const pending = seats.filter((k) => !answered(k));
    if (pending.length && Date.now() - (state.museAt || 0) > 5200) {
      state.museAt = Date.now();
      state.museIdx = ((state.museIdx ?? -1) + 1) % pending.length;
      const s = state.byKey[pending[state.museIdx]];
      muse.classList.add("fade");
      setTimeout(() => {
        muse.innerHTML = "<b>" + esc(s.short) + "</b> is weighing: " + esc(s.question.replace(/^./, (c) => c.toLowerCase())) + (done ? " · " + done + " of " + seats.length + " in" : "");
        muse.classList.remove("fade");
        $$(".seat").forEach((el) => el.classList.toggle("musing", el.dataset.seat === s.key));
      }, 300);
    }
  } else {
    bar.classList.add("indeterminate");
    $("#wcBar").style.width = "";
    muse.textContent = "";
    $$(".seat.musing").forEach((e) => e.classList.remove("musing"));
  }
}

function openGuide() {
  $("#guideBody").innerHTML = GUIDE;
  const d = $("#guideDialog");
  if (!d.open) d.showModal();
}

// ------------------------------------------------------------- people at the table
// A seat can be a person on this Mac, or an AI the council could not reach. These handlers keep the
// room honest about both: whose card is sealed, who did not answer, and what the council is waiting for.
const joinList = (xs) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`);

function feedNote(html) {
  const f = document.createElement("div");
  f.className = "feed-note";
  f.innerHTML = html;
  feedAppend(f);
}

// A nameplate chip can carry a mark ("Answered", "Absent"). A mark is removed only by clearMark, or
// overwritten by the seat's own card, so it never outlives the state it describes.
function setMark(key, mark, label) {
  const chip = $(`#plate-${key} .chip`);
  if (!chip) return;
  chip.hidden = false;
  chip.className = `chip ${mark}`;
  chip.textContent = label;
  chip.dataset.mark = mark;
}
function clearMark(key, mark) {
  const chip = $(`#plate-${key} .chip`);
  if (!chip || chip.dataset.mark !== mark) return;
  delete chip.dataset.mark;
  chip.hidden = true;
  chip.className = "chip";
  chip.textContent = "";
}

/** A seat that gave no answer this round: dim the seat and its nameplate, say "Absent", drop its score. */
function markAbsent(key, on) {
  $(`#seat-${key}`)?.classList.toggle("absent-round", on);
  $(`#plate-${key}`)?.classList.toggle("absent-round", on);
  if (on) {
    setMark(key, "absent", "Absent");
    const sc = $(`#plate-${key} .score`);
    if (sc) sc.hidden = true;
  } else clearMark(key, "absent");
}

function onSeatAbsent(ev) {
  const s = state.byKey[ev.seat];
  if (!s) return;
  const reason = String(ev.reason ?? "no reason given");
  (state.absentLog[ev.round] ||= {})[ev.seat] = reason;
  $(`#seat-${ev.seat}`)?.classList.remove("thinking");
  markAbsent(ev.seat, true);
  feedNote(`<b>${esc(s.short)}</b> did not answer Round ${esc(ev.round)} (${esc(reason)})`);
}

// ---- sealed cards
// While a person answers round N, no one else's round-N card is read out, so the person is not
// swayed by what is on the screen. The cards wait in state.held and play, in order, when the round closes.
async function onWaiting(ev) {
  if (!Number.isInteger(ev.round)) return;
  if (state.sealed !== null && state.sealed !== ev.round) await releaseHeld(state.sealed);
  state.sealed = ev.round;
  state.waitingSeats = Array.isArray(ev.seats) ? ev.seats : [];
  state.shut.delete(`${state.session}#${ev.round}`);
  renderYourTurn();
  pollInbox(); // the request exists by now: show the button without waiting for the next tick
}

function holdSeat(ev) {
  const s = state.byKey[ev.seat];
  state.held.push(ev);
  markAbsent(ev.seat, false);
  $(`#seat-${ev.seat}`)?.classList.remove("thinking");
  setMark(ev.seat, "sealed", "Answered");
  if (s) feedNote(`<b>${esc(s.short)}</b> has answered. Cards open when the round closes.`);
}

/** Open the seal on one round and play its held cards in the order they came. */
async function releaseHeld(round) {
  if (state.sealed === round) { state.sealed = null; state.waitingSeats = []; }
  const mine = state.held.filter((e) => e.round === round);
  if (!mine.length) return;
  state.held = state.held.filter((e) => e.round !== round);
  const epoch = player.epoch;
  for (const ev of mine) {
    if (player.epoch !== epoch) return; // the room moved to another council meanwhile
    await onSeatDone(ev);
  }
}

/** waiting_done or round_done: the round is over. Its cards open and its Your turn button goes. */
async function closeRound(round) {
  const epoch = player.epoch;
  await releaseHeld(round);
  if (player.epoch !== epoch) return; // the room moved to another council meanwhile
  state.shut.add(`${state.session}#${round}`);
  renderYourTurn();
}

/** verdict, error or end: nothing in this council can still be waiting. */
async function finishSession() {
  const epoch = player.epoch;
  for (const r of [...new Set(state.held.map((e) => e.round))].sort()) {
    await releaseHeld(r);
    if (player.epoch !== epoch) return;
  }
  state.sealed = null;
  state.waitingSeats = [];
  hidePause();
  if (state.session) state.shut.add(state.session);
  renderYourTurn();
}

// ---- pauses (the API runner stops and asks)
function showPause(ev) {
  hideWait();
  const kind = ev.kind === "quorum" ? "quorum" : "privacy";
  state.pause = { session: state.session, kind, busy: false };
  if (!state.pauseHid) state.pauseHid = { cap: !$("#caption").hidden, cruxes: !$("#cruxes").hidden };
  $("#caption").hidden = true;
  $("#cruxes").hidden = true;
  if (kind === "privacy") {
    $("#pcHead").textContent = ev.recipients
      ? `Before Round 1: these will receive the brief and later rounds: ${ev.recipients}.`
      : "Before Round 1: seats outside Anthropic will receive the brief and later rounds.";
    $("#pcSub").textContent = "Nothing has gone to them yet. Send it and start, or stop here.";
    $("#pcGo").textContent = "Send and start";
  } else {
    const n = Number(ev.have);
    const who = !Number.isFinite(n) ? "Too few seats" : n === 0 ? "No seats" : `Only ${n} seat${n === 1 ? "" : "s"}`;
    $("#pcHead").textContent = `${who} answered Round ${ev.round}.`;
    $("#pcSub").textContent = "Continue with the seats that answered, or stop the council here.";
    $("#pcGo").textContent = "Continue";
  }
  $("#pcErr").hidden = true;
  setPauseBusy(false);
  $("#pausecard").hidden = false;
}

function setPauseBusy(busy) {
  $("#pcGo").disabled = busy;
  $("#pcStop").disabled = busy;
}

function hidePause() {
  const card = $("#pausecard");
  const was = !card.hidden;
  card.hidden = true;
  state.pause = null;
  if (state.pauseHid && was) { // put back what the card covered
    $("#caption").hidden = !state.pauseHid.cap;
    $("#cruxes").hidden = !state.pauseHid.cruxes;
  }
  state.pauseHid = null;
}

async function answerPause(action) {
  const p = state.pause;
  if (!p || p.busy) return;
  p.busy = true;
  setPauseBusy(true);
  $("#pcErr").hidden = true;
  const fail = (msg) => {
    if (state.pause !== p) return;
    p.busy = false;
    setPauseBusy(false);
    $("#pcErr").textContent = msg;
    $("#pcErr").hidden = false;
  };
  try {
    const r = await fetch(`/api/council/${encodeURIComponent(p.session)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const j = await r.json().catch(() => ({}));
    if (state.pause !== p) return; // the room moved on while the request was out
    if (r.ok) { $("#pcSub").textContent = action === "stop" ? "Stopping the council." : "Sent. The council is carrying on."; return; } // the resumed event removes the card
    if (r.status === 404) { toast(j.error || "Nothing is waiting for a decision."); hidePause(); return; } // the card was out of date
    fail(j.error || "That did not go through. Try again.");
  } catch {
    fail("Could not reach the room. Try again.");
  }
}

// ------------------------------------------------------------- your turn
// GET /api/inbox lists the answers the room is waiting on. A person on this Mac answers in a form.
const reqKey = (r) => `${r.session}|${r.seat}|${r.round}`;
const validRequest = (r) => r && typeof r === "object" && typeof r.session === "string" && typeof r.seat === "string" && Number.isInteger(r.round) && r.round >= 1 && r.round <= 3;
const answered = new Set(); // requests this page has sent, so a late poll cannot bring the button back
const drafts = new Map(); // what was typed, by request, so closing the form loses nothing
let inboxBusy = false;
let answer = null; // the open form: { req, key, controls, busy, closed, dead }

async function pollInbox() {
  if (inboxBusy || document.visibilityState !== "visible") return;
  inboxBusy = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000); // a request that hangs must not block the next one
  try {
    const r = await fetch("/api/inbox", { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    if (!Array.isArray(j?.requests)) return;
    state.inbox = j.requests.filter(validRequest);
    renderYourTurn();
    syncAnswer(true);
  } catch {
    // The room is busy or restarting. Keep the last list: not hearing back is not the same as nothing waiting.
  } finally {
    clearTimeout(timer);
    inboxBusy = false;
  }
}

/** Requests to show: not sent from this page, and not in a round or a council the room has seen end. */
function visibleRequests() {
  return state.inbox.filter((r) => !answered.has(reqKey(r)) && !state.shut.has(r.session) && !state.shut.has(`${r.session}#${r.round}`));
}

function renderYourTurn() {
  const box = $("#yourTurn");
  const want = visibleRequests();
  const have = new Map($$("button[data-key]", box).map((b) => [b.dataset.key, b]));
  for (const [k, b] of have) if (!want.some((r) => reqKey(r) === k)) b.remove();
  for (const r of want) {
    const k = reqKey(r);
    let b = have.get(k);
    if (!b) {
      b = document.createElement("button");
      b.setAttribute("type", "button");
      b.className = "pill yt-btn";
      b.dataset.key = k;
      box.appendChild(b);
    }
    const label = `Your turn: ${r.short || r.name || r.seat}, Round ${r.round}`;
    if (b.textContent !== label) b.textContent = label;
  }
  syncAnswer();
}

// ---- the form
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid);
  return el;
}

function fieldKind(name) {
  if (name === "OPTION SCORES") return "scores";
  if (Object.hasOwn(CHOICES, name)) return "choice";
  if (name === "CONFIDENCE") return "confidence";
  if (/ SCORE$/.test(name)) return "score";
  return MULTILINE.includes(name) ? "textarea" : "text";
}

const toInt = (v) => (/^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : null);
const isBlank = (v) => String(v ?? "").trim() === "";

/** One field's raw input -> { value } to send, { skip } for an empty optional field, or { error }. The server checks again. */
function compile(c, raw) {
  const { name, kind, required } = c;
  if (kind === "scores") {
    const ids = c.options.map((o) => o.id);
    if (!ids.length) return { value: {} }; // nothing to score here: the server explains
    if (ids.every((id) => isBlank(raw[id]))) return required ? { error: `${name} is required.` } : { skip: true };
    const value = {};
    const problems = [];
    for (const id of ids) {
      if (isBlank(raw[id])) { problems.push(`needs a score for option ${id}`); continue; }
      const n = toInt(raw[id]);
      if (n === null || n > 10) problems.push(`option ${id} must be a whole number from 0 to 10`);
      else value[id] = n;
    }
    return problems.length ? { error: `${name} ${problems.join("; ")}.` } : { value };
  }
  if (isBlank(raw)) return required ? { error: `${name} is required.` } : { skip: true };
  if (kind === "choice") return { value: raw };
  if (kind === "confidence") {
    const n = toInt(raw);
    return n !== null && n >= 1 && n <= 5 ? { value: n } : { error: `${name} must be a whole number from 1 to 5.` };
  }
  if (kind === "score") {
    const n = toInt(raw);
    return n !== null && n <= 10 ? { value: n } : { error: `${name} must be a whole number from 0 to 10.` };
  }
  return { value: String(raw).trim() };
}

function buildField(a, name, required) {
  const kind = fieldKind(name);
  const id = `ans-f${a.controls.size}`;
  const err = h("div", { class: "ans-err", role: "alert", hidden: true });
  const mark = h("span", { class: required ? "req" : "optional", text: required ? "Required" : "Optional" });
  const c = { name, kind, required, options: a.req.options, err, els: [] };
  let wrap;
  if (kind === "scores") {
    wrap = h("fieldset", { class: "ans-field", dataset: { field: name } }, h("legend", { class: "label" }, name, mark));
    for (const o of c.options) {
      const input = h("input", { type: "number", min: "0", max: "10", step: "1", inputmode: "numeric", name, "data-opt": o.id, "aria-label": `Score for option ${o.id}, 0 to 10` });
      c.els.push(input);
      wrap.append(h("label", { class: "ans-opt" }, h("span", { class: "id", text: String(o.id) }), h("span", { class: "lab", text: String(o.label ?? "") }), input));
    }
    if (!c.options.length) wrap.append(h("p", { class: "muted", text: "This request came with no options to score." }));
    c.get = () => Object.fromEntries(c.els.map((el) => [el.dataset.opt, el.value]));
    c.set = (v) => { for (const el of c.els) el.value = v?.[el.dataset.opt] ?? ""; };
  } else {
    let el;
    if (kind === "choice" || kind === "confidence") {
      const values = kind === "confidence" ? ["1", "2", "3", "4", "5"] : CHOICES[name];
      const label = (v) => (kind === "confidence" && v === "1" ? "1 (low)" : kind === "confidence" && v === "5" ? "5 (high)" : v);
      el = h("select", { id, name, "aria-required": required ? "true" : false }, h("option", { value: "", text: "Choose one" }), values.map((v) => h("option", { value: v, text: label(v) })));
    } else if (kind === "score") {
      el = h("input", { id, type: "number", min: "0", max: "10", step: "1", inputmode: "numeric", name, "aria-required": required ? "true" : false });
    } else if (kind === "textarea") {
      el = h("textarea", { id, name, rows: "3", maxlength: "2000", "aria-required": required ? "true" : false });
    } else {
      el = h("input", { id, type: "text", name, maxlength: "2000", "aria-required": required ? "true" : false });
    }
    c.els.push(el);
    c.get = () => el.value;
    c.set = (v) => { el.value = v ?? ""; };
    wrap = h("div", { class: "ans-field", dataset: { field: name } }, h("label", { class: "label", for: id }, name, mark), el);
  }
  wrap.append(err);
  c.wrap = wrap;
  a.controls.set(name, c);
  return wrap;
}

function openAnswer(req) {
  saveDraft();
  const key = reqKey(req);
  const a = (answer = { req, key, controls: new Map(), busy: false, closed: false, dead: false });
  const spec = { required: req.fields?.required ?? ROUND_FIELDS[req.round].required, optional: req.fields?.optional ?? ROUND_FIELDS[req.round].optional };
  req.options = Array.isArray(req.options) ? req.options : [];
  $("#ansKicker").textContent = `Round ${req.round}: ${ROUND_NAME[req.round]}`;
  $("#ansTitle").textContent = `Your turn, ${req.name || req.short || req.seat}`;
  $("#ansAlert").hidden = true;
  $("#ansAlert").textContent = "";
  $("#ansDone").hidden = true;
  $("#ansDone").textContent = "";
  for (const id of ["#ansContext", "#ansPrompt", "#ansFields"]) $(id).hidden = false;
  $("#ansSend").hidden = false;
  $("#ansSend").disabled = false;
  $("#ansSend").textContent = "Send my card";
  // Everything below comes from the server and goes in as text, never as HTML.
  const context = (Array.isArray(req.context) ? req.context : []).filter((c) => c && typeof c.text === "string");
  $("#ansContext").replaceChildren(...context.map((c, i) => h("details", { class: "ans-ctx", open: i === 0 }, h("summary", { text: String(c.name ?? "") }), h("pre", { text: c.text }))));
  $("#ansPrompt").replaceChildren(...(req.prompt ? [h("p", { class: "ans-prompt", text: req.prompt })] : []));
  $("#ansFields").replaceChildren(...[...spec.required.map((n) => buildField(a, n, true)), ...spec.optional.map((n) => buildField(a, n, false))]);
  const draft = drafts.get(key);
  if (draft) for (const [name, c] of a.controls) if (name in draft) c.set(draft[name]);
  tickAnswer();
  const dlg = $("#answerDialog");
  if (!dlg.open) dlg.showModal();
}

function saveDraft() {
  if (!answer || answer.dead) return;
  drafts.set(answer.key, Object.fromEntries([...answer.controls].map(([name, c]) => [name, c.get()])));
}

// Typing in a field clears that field's error and keeps the draft.
function onFormEdit(e) {
  saveDraft();
  const wrap = e.target?.closest?.(".ans-field");
  const c = wrap && answer && answer.controls.get(wrap.dataset.field);
  if (c) { c.err.hidden = true; c.err.textContent = ""; }
}

function showAlert(a, msg) {
  if (answer !== a) { toast(msg); return; }
  $("#ansAlert").replaceChildren(...[].concat(msg).map((m) => h("div", { text: String(m) })));
  $("#ansAlert").hidden = false;
}

function clearErrors(a) {
  for (const c of a.controls.values()) { c.err.hidden = true; c.err.textContent = ""; }
  $("#ansAlert").hidden = true;
  $("#ansAlert").textContent = "";
}

/** Put each error next to its field. An error names its field first ("CONFIDENCE is required."). Any other goes on top. */
function showErrors(a, errors) {
  clearErrors(a);
  const names = [...a.controls.keys()];
  const byField = new Map();
  const top = [];
  for (const e of errors) {
    const name = names.filter((n) => e.startsWith(n)).sort((x, y) => y.length - x.length)[0];
    if (name) byField.set(name, [...(byField.get(name) || []), e]);
    else top.push(e);
  }
  for (const [name, list] of byField) {
    const c = a.controls.get(name);
    c.err.replaceChildren(...list.map((m) => h("div", { text: m })));
    c.err.hidden = false;
  }
  if (top.length) showAlert(a, top);
  const first = [...byField.keys()].map((n) => a.controls.get(n)).sort((x, y) => names.indexOf(x.name) - names.indexOf(y.name))[0];
  if (first) { first.els[0]?.focus(); first.wrap.scrollIntoView?.({ block: "nearest" }); }
}

async function sendAnswer(e) {
  e.preventDefault();
  const a = answer;
  if (!a || a.busy || a.closed) return;
  const fields = {};
  const errors = [];
  for (const [name, c] of a.controls) {
    const out = compile(c, c.get());
    if (out.error) errors.push(out.error);
    else if ("value" in out) fields[name] = out.value;
  }
  if (errors.length) return showErrors(a, errors);
  clearErrors(a);
  a.busy = true;
  $("#ansSend").disabled = true;
  $("#ansSend").textContent = "Sending...";
  try {
    const r = await fetch("/api/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: a.req.session, seat: a.req.seat, round: a.req.round, fields }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return answerSent(a);
    if (r.status === 400) return showErrors(a, Array.isArray(j.errors) && j.errors.length ? j.errors.map(String) : [String(j.error || "The room did not accept the answer.")]);
    if (r.status === 404 || r.status === 409) return answerDead(a, j.error || "This request is closed.");
    showAlert(a, j.error || "The room could not take the answer. Try again.");
  } catch {
    showAlert(a, "Could not reach the room. Check that it is still running, then send again.");
  } finally {
    a.busy = false;
    if (answer === a && !a.closed) { $("#ansSend").disabled = false; $("#ansSend").textContent = "Send my card"; }
  }
}

function retire(a) { // this request is over: forget the draft, and keep its button from coming back
  a.closed = a.dead = true;
  drafts.delete(a.key);
  answered.add(a.key);
}

function answerSent(a) {
  retire(a);
  if (answer === a) {
    for (const id of ["#ansContext", "#ansPrompt", "#ansFields", "#ansAlert", "#ansSend"]) $(id).hidden = true;
    $("#ansDone").textContent = "Sent. The council has your card.";
    $("#ansDone").hidden = false;
  }
  renderYourTurn();
}

function answerDead(a, msg) {
  retire(a);
  if (answer === a) $("#answerDialog").close();
  toast(msg);
  renderYourTurn();
}

/** The form stays on screen so nothing typed is lost, but it can no longer send. */
function lockAnswer(a, msg) {
  if (a.closed) return;
  a.closed = true;
  if (answer === a) { showAlert(a, msg); $("#ansSend").disabled = true; }
}

// The form cannot be answered once the room has seen its round end, or the server stops listing it.
// A request can drop out of one listing while its file is being rewritten, so the form locks only
// when two polls in a row leave it out.
const CLOSED = "This round has closed. The council moved on without this answer.";
function syncAnswer(polled = false) {
  const a = answer;
  if (!a || a.closed || a.busy) return;
  if (state.shut.has(a.req.session) || state.shut.has(`${a.req.session}#${a.req.round}`)) return lockAnswer(a, CLOSED);
  if (!polled) return;
  if (state.inbox.some((r) => reqKey(r) === a.key)) { a.missed = 0; return; }
  a.missed = (a.missed || 0) + 1;
  if (a.missed >= 2) lockAnswer(a, CLOSED);
}

function tickAnswer() {
  const a = answer;
  if (!a || a.dead) return;
  const left = Date.parse(a.req.deadline) - Date.now();
  const clockEl = $("#ansClock");
  if (Number.isNaN(left)) { clockEl.textContent = ""; return; }
  if (left <= 0) {
    clockEl.textContent = "Time is up";
    lockAnswer(a, "The deadline for this round has passed. The council moved on without this answer.");
    return;
  }
  clockEl.textContent = `Time left ${clock(left)}`;
  clockEl.classList.toggle("low", left < 2 * 60 * 1000);
}

// ------------------------------------------------------------- PDF
async function savePdf(btn) {
  const id = btn.dataset.pdf;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Making PDF...";
  try {
    let setup = state.setup, verdict = state.verdict;
    if (id) { // a past session from the history list
      const j = await fetch("/api/sessions/" + encodeURIComponent(id)).then((x) => x.json());
      setup = j.events.find((e) => e.type === "setup");
      verdict = [...j.events].reverse().find((e) => e.type === "verdict");
    }
    if (!setup || !verdict) throw new Error("This council has no verdict yet.");
    await downloadVerdictPdf({ setup, verdict, byKey: state.byKey, id: id || state.session });
  } catch (e) {
    console.error(e);
    toast("Couldn't make the PDF: " + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ------------------------------------------------------------- misc
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
async function refreshUsage() {
  const u = await fetch("/api/usage").then((x) => x.json()).catch(() => null);
  if (!u || !u.calls) { $("#usage").textContent = ""; return; }
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  $("#usage").textContent = `${u.calls} calls · ${k(u.input + u.cacheRead + u.cacheWrite)} in · ${k(u.output)} out`;
}

boot();

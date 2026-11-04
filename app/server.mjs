import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT, env } from "./lib/env.mjs";
import { loadRoster, BOARD, defaultBoard } from "./lib/seats.mjs";
import { startCouncil, getSession, subscribe, listSaved, loadSaved, resume, missingKeys, missingKeysMessage, MODELS } from "./lib/council.mjs";
import { listPending, submitAnswer } from "./lib/inbox.mjs";
import { usage } from "./lib/providers/anthropic.mjs";
import { hasKey, providerUsage } from "./lib/providers/index.mjs";
import * as watch from "./lib/watch.mjs";

const PUBLIC = path.join(APP_ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8" };

const MAX_BODY = 65536; // bytes, for any POST
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/;

// Every error body is { error } with a fixed sentence. None of them repeats what the caller sent.
const MSG = {
  host: "This room only answers requests addressed to localhost on its own port.",
  origin: "This request did not come from the room's own page.",
  type: "Send the request as JSON (content-type: application/json).",
  big: "The request body is too large. The limit is 64 KB.",
  json: "The request body is not valid JSON.",
  object: "The request body must be a JSON object.",
  aborted: "The request ended before its body was complete.",
  badUrl: "That request address is not valid.",
  badId: "That council id is not valid.",
  badAction: 'The action must be "continue" or "stop".',
  nothing: "Nothing is waiting for a decision.",
};

let running = null; // one council at a time (API runner)

// "viewer" (default): the room plays councils that /roast-room runs in Claude Code.
// "api": the room can also run councils itself on ANTHROPIC_API_KEY (COUNCIL_RUNNER=api in .env).
const RUNNER = (process.env.COUNCIL_RUNNER || env("COUNCIL_RUNNER") || "viewer").toLowerCase() === "api" ? "api" : "viewer";

function send(res, code, body, type = "application/json", extra = {}) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- guards
// The room listens on 127.0.0.1 only, but a web page in the user's browser can still reach it. Two
// attacks matter: another site posting to it (cross-site request), and another name that resolves
// to 127.0.0.1 (DNS rebinding). The Origin header defeats the first, the Host header the second.
// The allowed values name the port the server actually bound, set in start().
let allowed = { hosts: new Set(), origins: new Set() };
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : "");
const hostOk = (req) => allowed.hosts.has(lower(req.headers.host));
const originOk = (req) => allowed.origins.has(lower(req.headers.origin));
const isJson = (req) => /^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "");

/** The body as bytes, at most MAX_BODY. A declared length over the limit is refused unread, and a body
 * with no length (chunked) or a wrong one is counted as it arrives. Nothing past the limit is kept. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_BODY) { reject(new HttpError(413, MSG.big)); return; }
    const chunks = [];
    let size = 0;
    const cleanup = () => { req.off("data", onData); req.off("end", onEnd); req.off("error", onError); req.off("close", onClose); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { cleanup(); chunks.length = 0; reject(new HttpError(413, MSG.big)); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new HttpError(400, MSG.aborted)); }; // the caller hung up mid-body
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

/** The body as a JSON object. An empty body is {}. */
async function readJson(req) {
  const raw = (await readBody(req)).toString("utf8");
  if (!raw.trim()) return {};
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, MSG.json); } // the parser's own message quotes the input
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, MSG.object);
  return body;
}

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  try {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return send(res, 400, { error: MSG.badUrl }); }
    const p = url.pathname;
    const post = req.method === "POST";

    // Host: every API path, GET included, and every POST. Static files are not checked.
    if ((p === "/api" || p.startsWith("/api/") || post) && !hostOk(req)) return send(res, 403, { error: MSG.host });
    // Then, for a POST: Origin, content type, and last the size and shape of the body (in readJson).
    if (post && !originOk(req)) return send(res, 403, { error: MSG.origin });
    if (post && !isJson(req)) return send(res, 415, { error: MSG.type });

    if (p === "/api/seats") {
      // portraits: which of the four mouth shapes exist for each seat (a seat with none gets a drawn bust)
      const frame = (key, sh) => ["webp", "png", "jpg"].map((x) => `${key}-${sh}.${x}`).find((f) => fs.existsSync(path.join(PUBLIC, "portraits", f)));
      const seats = loadRoster().map((s) => ({ ...s, portraits: Object.fromEntries(["base", "open", "mid", "blink"].map((sh) => [sh, frame(s.key, sh)]).filter(([, f]) => f).map(([sh, f]) => [sh, `/portraits/${f}`])) }));
      // keys: whether each provider's key is set. Only yes or no, never the key.
      const keys = { anthropic: hasKey("anthropic"), openai: hasKey("openai"), google: hasKey("google") };
      return send(res, 200, { seats, board: BOARD, models: MODELS, runner: RUNNER, hasKey: keys.anthropic, keys });
    }
    if (p === "/api/usage") return send(res, 200, { ...usage, providers: providerUsage });
    if (p === "/api/inbox") return send(res, 200, { requests: listPending() });
    if (post && p === "/api/answer") {
      const out = submitAnswer(await readJson(req));
      return send(res, out.code, out.body);
    }
    if (post && p === "/api/council") {
      const body = await readJson(req);
      if (RUNNER !== "api") return send(res, 403, { error: "This room is a viewer. Run /roast-room in Claude Code, or set COUNCIL_RUNNER=api in .env." });
      // A council that waits at the privacy or quorum pause is still running.
      if (running && getSession(running)?.status === "running") return send(res, 409, { error: "A council is already in session. Wait for its verdict." });
      const { prompt, mode } = body;
      if (typeof prompt !== "string" || prompt.trim().length < 10) return send(res, 400, { error: "Give the council a real decision (at least a sentence)." });
      // Say what is missing now, before any call. The saved default board is the table, so every seat's
      // key is known. A board the Chair picks only offers seats that can run, so only the Chair's own
      // Anthropic key is needed: missingKeys adds it whenever it is unset.
      loadRoster();
      const missing = missingKeys(BOARD.mode === "default" ? defaultBoard() : []);
      if (missing.length) return send(res, 400, { error: missingKeysMessage(missing) });
      const s = startCouncil(prompt.trim().slice(0, 4000), mode === "quick" ? "quick" : "full");
      running = s.id;
      return send(res, 200, { id: s.id });
    }
    const paused = post ? /^\/api\/council\/([^/]+)\/resume$/.exec(p) : null;
    if (paused) {
      const body = await readJson(req);
      let id = "";
      try { id = decodeURIComponent(paused[1]); } catch { /* not a valid escape: the id stays empty */ }
      if (!SESSION_ID.test(id)) return send(res, 400, { error: MSG.badId });
      if (body.action !== "continue" && body.action !== "stop") return send(res, 400, { error: MSG.badAction });
      return resume(id, body.action) ? send(res, 200, { ok: true }) : send(res, 404, { error: MSG.nothing });
    }
    if (p.startsWith("/api/stream/")) {
      const id = decodeURIComponent(p.split("/").pop());
      const s = getSession(id) || watch.getLive(id);
      if (!s) return send(res, 404, { error: "no such session" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      res.on("close", () => clearInterval(ping));
      return subscribe(s, res);
    }
    if (p === "/api/sessions") {
      const all = [...listSaved(), ...watch.listLive()].sort((a, b) => (a.id < b.id ? 1 : -1));
      const apiRunning = running && getSession(running)?.status === "running" ? running : null;
      return send(res, 200, { sessions: all, running: apiRunning, live: watch.runningId() });
    }
    if (p.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(p.split("/").pop());
      const x = watch.getLive(id);
      const j = loadSaved(id) || (x && { id, title: x.title, mode: x.mode, status: x.status, events: x.events });
      return j ? send(res, 200, j) : send(res, 404, { error: "not found" });
    }
    // static
    const file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (res.headersSent) { res.end(); return; } // a stream already started: nothing more can be said
    if (e instanceof HttpError) {
      // Close after a 413 so a caller that keeps sending is not read to the end.
      return send(res, e.code, { error: e.message }, "application/json", e.code === 413 ? { connection: "close" } : {});
    }
    send(res, 500, { error: String(e.message || e) });
  }
}

// ---------------------------------------------------------------- start and stop
let server = null;
let stopWatching = null;
let closing = null;

/** Listen on 127.0.0.1 and start the folder watcher. Port 0 picks a free one. Resolves with the
 * http.Server once it is listening; rejects (and starts nothing) when the port is taken. */
export function start(port = Number(env("PORT")) || 4730) {
  if (server) return Promise.reject(new Error("The room is already running."));
  const srv = http.createServer(handle);
  server = srv;
  return new Promise((resolve, reject) => {
    // Any way start() can fail ends here: forget the server, so the next start() is not told "already running".
    const fail = (e) => { srv.off("error", fail); server = null; reject(e); };
    srv.once("error", fail);
    try {
      srv.listen(port, "127.0.0.1", () => {
        srv.off("error", fail);
        try {
          const bound = srv.address().port;
          allowed = {
            hosts: new Set([`localhost:${bound}`, `127.0.0.1:${bound}`]),
            origins: new Set([`http://localhost:${bound}`, `http://127.0.0.1:${bound}`]),
          };
          stopWatching = watch.startWatching();
          console.log(`Roast Room on http://localhost:${bound} (${RUNNER === "api" ? "viewer + API runner" : "viewer: run /roast-room in Claude Code"})`);
          resolve(srv);
        } catch (e) {
          srv.close();
          fail(e);
        }
      });
    } catch (e) {
      fail(e); // a port that cannot exist (70000, -1) makes listen() throw at once, before anything listens
    }
  });
}

/** Close the server and stop the watcher. Resolves once the port is free. Open event streams are cut. */
export function stop() {
  if (!server) return Promise.resolve();
  if (!closing) {
    const srv = server;
    stopWatching?.();
    stopWatching = null;
    closing = new Promise((resolve) => srv.close(() => { server = null; closing = null; resolve(); }));
    srv.closeAllConnections(); // an open event stream would keep close() waiting
  }
  return closing;
}

// `npm start` runs this file. A symlinked folder changes argv[1] but not import.meta.url, so compare real paths.
function ranDirectly() {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}
if (ranDirectly()) {
  start().catch((e) => {
    console.error(`Could not start the room: ${e.message}`);
    process.exit(1);
  });
}

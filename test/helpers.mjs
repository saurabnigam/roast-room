// Shared test helpers. Node 20 or newer, no dependencies.
//
// Each test file must set process.env.ROAST_ROOT (and any other env) BEFORE its first
// dynamic import() of app code. env.mjs reads ROAST_ROOT once, at load time:
//
//   const repo = makeRepo({ seats: [...] });
//   process.env.ROAST_ROOT = repo.root;
//   const { loadRoster } = await import("../app/lib/seats.mjs");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

export const BRAIN_FILES = ["_hot.md", "frameworks.md", "positions.md", "principles.md", "voice.md"];
export const HOT_LINE = "Price is what you pay and value is what you get, always.";

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * A disposable repo in the OS temp folder.
 *
 * Each seat is a roster entry: key, name, short, slug, and optionally initials, pillar,
 * question, dimension, color, provider, model, cli_model. Missing pillar, question, dimension
 * and color get defaults, so `{ key, name, short, slug }` is enough.
 * One extra option never reaches roster.json: `agent: false` skips that seat's agent file
 * (for a seat that must have none). Its brain files are still written.
 * Human seats (provider "human") never get an agent file or a brain.
 * `board` is the roster's "board" value. `def` is the roster's "default" list (every seat key
 * when omitted).
 */
export function makeRepo({ seats = [], board = "default", def } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-"));
  const skill = path.join(root, ".claude", "skills", "roast-room");
  const agents = path.join(root, ".claude", "agents");
  const sessions = path.join(root, "sessions");
  for (const d of [skill, agents, sessions]) fs.mkdirSync(d, { recursive: true });

  const entries = [];
  for (const seat of seats) {
    const { agent = true, ...rest } = seat;
    const entry = {
      pillar: `Pillar of ${rest.key}`,
      question: `What does ${rest.short || rest.key} want to know?`,
      dimension: `Dimension of ${rest.key}`,
      color: "#888888",
      ...rest,
    };
    entries.push(entry);
    if (entry.provider === "human") continue;
    if (agent !== false) {
      put(
        path.join(agents, `council-${entry.key}.md`),
        `---\nname: council-${entry.key}\ndescription: Test seat for ${entry.name}.\ntools: Read, Grep, Glob\nmaxTurns: 12\n---\n\nYou hold the ${entry.pillar} seat. Answer as ${entry.name} would.\n`,
      );
    }
    if (entry.slug) {
      const dir = path.join(skill, "brains", entry.slug);
      for (const f of BRAIN_FILES) {
        put(path.join(dir, f), f === "_hot.md" ? `# ${entry.name}\n\n${HOT_LINE}\n` : `# ${entry.name}: ${f}\n\nTest brain file.\n`);
      }
    }
  }
  put(
    path.join(skill, "roster.json"),
    JSON.stringify({ board, default: def ?? entries.map((e) => e.key), seats: entries }, null, 2) + "\n",
  );

  return {
    root,
    sessions,
    cleanup() {
      // Never delete anything that is not a folder this helper made.
      const tmp = fs.realpathSync(os.tmpdir());
      const real = fs.existsSync(root) ? fs.realpathSync(root) : "";
      if (real && path.dirname(real) === tmp && path.basename(real).startsWith("rr-")) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Create <root>/sessions/<name>/ with the given files. Keys are paths relative to the session
 * folder. A string is written as is. Anything else is written as JSON. Returns the folder.
 */
export function makeSession(root, name, files = {}) {
  const dir = path.join(root, "sessions", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.resolve(dir, rel);
    if (path.relative(dir, file).startsWith("..")) throw new Error(`makeSession: ${rel} leaves the session folder`);
    put(file, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
  return dir;
}

const NO_BODY = new Set([204, 205, 304]);
function toResponse(r) {
  if (r instanceof Response) return r;
  const { status = 200, json, text, headers = {} } = r || {};
  let body = text ?? "";
  const h = new Headers(headers);
  if (json !== undefined) {
    body = JSON.stringify(json);
    if (!h.has("content-type")) h.set("content-type", "application/json");
  }
  return new Response(NO_BODY.has(status) ? null : body, { status, headers: h });
}

/**
 * Replace globalThis.fetch. The handler gets (url, init) and returns a Response, or a plain
 * object { status = 200, json?, text?, headers? }, or a promise of either. If it throws, the
 * caller's fetch rejects (a network failure). If it returns nothing (null or undefined), the
 * caller's fetch rejects too, with an error that names the url: a handler that forgot a case
 * must not look like an empty 200. Every call is recorded before the handler runs:
 * url (string), init exactly as passed (headers as given), body (the request body parsed as
 * JSON, or null when there is none or it is not JSON). Call restore() to put fetch back.
 */
export function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = null; }
    }
    const target = String(url?.url ?? url);
    calls.push({ url: target, init, body });
    const result = await handler(target, init);
    if (result === null || result === undefined) throw new Error(`mockFetch handler returned nothing for ${target}`);
    return toResponse(result);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/**
 * One HTTP request to 127.0.0.1:port over node:http, so a test can set Host and Origin freely.
 * `body` is a string (sent as is) or an object (sent as JSON, with content-type
 * application/json unless the caller set one). content-length is set unless the caller passed
 * one. `json` is the parsed response body, or null when it does not parse. A request with no
 * answer after 10 seconds is destroyed and rejects with "request timed out".
 */
export function request(port, { method = "GET", path: urlPath = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    const has = (name) => Object.keys(h).some((k) => k.toLowerCase() === name);
    let payload = null;
    if (body !== undefined && body !== null) {
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        payload = body;
      } else {
        payload = JSON.stringify(body);
        if (!has("content-type")) h["content-type"] = "application/json";
      }
      if (!has("content-length")) h["content-length"] = String(Buffer.byteLength(payload));
    }
    // agent: false opens a fresh connection per request, so no socket outlives the test.
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    // A server that never answers must fail the test, not hang the run.
    req.setTimeout(10000, () => req.destroy(new Error("request timed out")));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** A streaming Response: one `data: <json>` line plus a blank line per event. */
export function sse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

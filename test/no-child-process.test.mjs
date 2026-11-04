import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every file under dir, skipping node_modules.
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("no file under app/ uses child_process", () => {
  const hits = walk(path.join(REPO, "app"))
    .filter((f) => /\.m?js$/.test(f) && fs.readFileSync(f, "utf8").includes("child_process"))
    .map((f) => path.relative(REPO, f));
  assert.deepEqual(hits, []);
});

test("ROAST_ROOT moves every path", async () => {
  // Set before the first import of app code: env.mjs reads it at load time.
  process.env.ROAST_ROOT = "/tmp/rr-root";
  const env = await import("../app/lib/env.mjs");
  assert.equal(env.REPO_ROOT, "/tmp/rr-root");
  assert.equal(env.SESSIONS_DIR, "/tmp/rr-root/sessions");
  assert.equal(env.ROSTER, "/tmp/rr-root/.claude/skills/roast-room/roster.json");
});

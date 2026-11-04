#!/usr/bin/env node
// Register a finished seat in the Roast Room roster (.claude/skills/roast-room/roster.json).
//
//   node .claude/skills/newroaster/scripts/add_seat.mjs --key naval --name "Naval Ravikant" --short Naval \
//     --slug naval-ravikant --pillar "Leverage and wealth" --question "Does this build leverage you own?" \
//     --dimension "Leverage and long-term wealth" [--color "#22b8a0"] [--default] [--swap <key>] \
//     [--provider anthropic|openai|google] [--model <id>] [--cli-model <name>]
//
//   node .claude/skills/newroaster/scripts/add_seat.mjs --human --key priya --name "Priya Rao" --short Priya \
//     --pillar "Operations" --question "Can we run this without you?" [--dimension "Run readiness"] [--default]
//
// Checks the agent file and the brain exist first, so a half-built seat never reaches the table.
// --default puts the seat on the default board; --swap <key> takes that seat off the board in
// the same move (the board holds at most nine). Running it again for the same key updates it.
//
// A seat runs on a provider. --provider picks anthropic (the default), openai or google, and
// --model and --cli-model name the model for the API and for the CLI fallback. Each of the three
// is written only when you pass it. An update keeps the ones you leave out, unless --provider
// changes the provider: model ids belong to one provider, so a change drops the stored model and
// cli_model and keeps only the ones you pass with it.
// --human (the same as --provider human) adds a real person on this Mac. A person needs --key,
// --name, --short, --pillar and --question. --dimension defaults to the pillar, or to the one the
// seat already has. The person has no slug, agent file or brain, and initials and colour are
// picked for you. --human on a key that is already an AI seat is refused: pick another key.
// ROAST_ROOT, when set, is used as the repo root instead of the folder this script sits in.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.ROAST_ROOT
  ? path.resolve(process.env.ROAST_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SKILL = path.join(ROOT, ".claude", "skills", "roast-room");
const ROSTER = path.join(SKILL, "roster.json");
const MAX_BOARD = 9;
const BRAIN_FILES = ["_hot.md", "frameworks.md", "principles.md", "positions.md", "voice.md", "stories.md", "sources.md"];
const PALETTE = ["#22b8a0", "#e05d9b", "#c9a227", "#5b7cfa", "#ef7d32", "#2fa4d6", "#a3be3c", "#b06ad9", "#d6543f", "#3fb37f"];
const PROVIDERS = ["anthropic", "openai", "google", "human"];

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error("add_seat: " + m); process.exit(1); };
const HEX = /^#[0-9a-f]{6}$/i;

// The provider the user asked for. Undefined means "not passed": a new seat then writes none
// (it runs on anthropic) and an update keeps the one it has.
let provider = opt("provider");
if (has("provider") && !PROVIDERS.includes(provider)) fail(`--provider must be one of ${PROVIDERS.join(", ")}`);
if (has("human")) {
  if (provider && provider !== "human") fail(`--human cannot be combined with --provider ${provider}`);
  provider = "human";
}

const key = (opt("key") || "").toLowerCase();
const r = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
const existing = r.seats.find((s) => s.key === key);
// A person is asked for with --human, or kept as one when the seat already is one.
const human = (provider ?? existing?.provider) === "human";
// Turning an AI seat into a person would overwrite it and drop its slug, model and cli_model.
// A seat with no provider is anthropic. A new key for the person keeps the AI seat as it is.
if (human && existing && (existing.provider ?? "anthropic") !== "human") fail(`${key} is an AI seat; pick another key for the person`);

const seat = {
  key,
  name: opt("name"), short: opt("short"), initials: opt("initials"), slug: opt("slug"),
  pillar: opt("pillar"), question: opt("question"), dimension: opt("dimension"), color: opt("color"),
};
if (human) {
  if (["slug", "model", "cli-model"].some(has)) fail("a human seat takes no --slug, --model or --cli-model (to make it an AI seat, pass --provider anthropic, openai or google)");
  seat.slug = null;
  for (const f of ["key", "name", "short", "pillar", "question"]) if (!seat[f]) fail(`--${f} is required`);
  seat.dimension ||= existing?.dimension || seat.pillar; // an update keeps its dimension
} else {
  for (const f of ["key", "name", "short", "slug", "pillar", "question", "dimension"]) if (!seat[f]) fail(`--${f} is required`);
}
if (!/^[a-z][a-z0-9]{1,15}$/.test(seat.key)) fail("--key must be 2 to 16 lowercase letters or digits, starting with a letter");
if (seat.slug !== null && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(seat.slug)) fail("--slug must look like first-last");
// An update keeps the initials it has unless the name changed.
seat.initials ||= existing?.initials && existing.name === seat.name
  ? existing.initials
  : seat.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();

if (!human) {
  const agent = path.join(ROOT, ".claude", "agents", `council-${seat.key}.md`);
  if (!fs.existsSync(agent)) fail(`missing agent file ${path.relative(ROOT, agent)}`);
  const brain = path.join(SKILL, "brains", seat.slug);
  const missing = BRAIN_FILES.filter((f) => !fs.existsSync(path.join(brain, f)));
  if (missing.length) fail(`brain ${path.relative(ROOT, brain)} is missing ${missing.join(", ")}`);
}

const others = r.seats.filter((s) => s.key !== seat.key);
if (seat.slug && others.some((s) => s.slug === seat.slug)) fail(`slug ${seat.slug} already belongs to another seat`);
if (others.some((s) => s.short.toLowerCase() === seat.short.toLowerCase())) fail(`short name ${seat.short} is taken; pick another`);
if (!HEX.test(seat.color || "")) {
  if (HEX.test(existing?.color || "")) seat.color = existing.color; // an update keeps its colour
  else {
    const used = new Set(r.seats.map((s) => (s.color || "").toLowerCase()));
    seat.color = PALETTE.find((c) => !used.has(c)) || PALETTE[r.seats.length % PALETTE.length];
  }
}
// provider, model and cli_model come last and are written only when set. An update keeps the
// ones that were not passed, unless the provider changes: model ids are provider-specific, so a
// change drops the stored model and cli_model. A seat with no provider counts as anthropic.
// A person has no model and no cli_model.
const prov = provider ?? existing?.provider;
if (prov) seat.provider = prov;
if (!human) {
  const changed = provider !== undefined && provider !== (existing?.provider ?? "anthropic");
  const model = opt("model") || (changed ? undefined : existing?.model);
  const cliModel = opt("cli-model") || (changed ? undefined : existing?.cli_model);
  if (model) seat.model = model;
  if (cliModel) seat.cli_model = cliModel;
}
const at = r.seats.findIndex((s) => s.key === seat.key);
if (at >= 0) r.seats[at] = seat; else r.seats.push(seat);

const swap = opt("swap");
if (swap) r.default = r.default.filter((k) => k !== swap);
if (args.includes("--default") && !r.default.includes(seat.key)) {
  if (r.default.length >= MAX_BOARD) fail(`the default board already has ${MAX_BOARD} seats; add --swap <key> to take one off`);
  r.default.push(seat.key);
}

// one seat per line keeps the file easy to read and edit by hand
const line = (o) => "{ " + Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + " }";
const out = [
  "{",
  `  "board": ${JSON.stringify(r.board || "default")},`,
  `  "default": [${r.default.map((k) => JSON.stringify(k)).join(", ")}],`,
  `  "seats": [`,
  r.seats.map((s) => "    " + line(s)).join(",\n"),
  "  ]",
  "}",
].join("\n") + "\n";
JSON.parse(out); // never write a file the room cannot read
fs.writeFileSync(ROSTER, out);

console.log(`${at >= 0 ? "Updated" : "Added"} ${seat.name} (${seat.key}) to the roster.`);
console.log(`Default board (${r.default.length}): ${r.default.map((k) => r.seats.find((s) => s.key === k)?.short || k).join(", ")}`);
console.log(`Board setting: ${r.board || "default"}`);

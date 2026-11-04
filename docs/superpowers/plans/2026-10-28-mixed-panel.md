# Mixed Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any Roast Room seat run on Anthropic, OpenAI, Google, or be a real person answering on this Mac, in both the Claude Code skill and the app's API runner.

**Architecture:** A seat gains `provider` and `model`. One shared prompt builder feeds every non-subagent transport. Provider modules under `app/lib/providers/` share one interface and one retry policy. Human answers go through an inbox (files for skill sessions, memory for API sessions) and become ordinary cards, so the watcher, scoring and verdict code keep working. Process spawning lives only in a skill script (`run_seat.mjs`), never under `app/`.

**Tech Stack:** Node 20+ ESM, zero dependencies, `node:test`, plain browser JS.

**Spec:** `docs/superpowers/specs/2026-10-28-mixed-panel-design.md`. §16 overrides earlier sections where they differ.

## Global Constraints

- Node 20 or newer. Zero npm dependencies. Tests use `node:test` and `node:assert/strict`.
- `child_process` must not appear in any file under `app/`.
- The server stays bound to `127.0.0.1`.
- Never pass `--allow-secrets` to `delegate.py`. The CLI fallback always passes `--isolated`.
- A provider receives only the assembled prompt. API keys never appear in session files, events, logs or stdout.
- The card text format is unchanged. A card from any provider or a person parses with today's `parseCard`.
- No change to scoring formulas, bands or overrides. Absent seats are excluded from option scores, the vote tally and the confidence average.
- Defaults keep today's behaviour: a seat with no `provider` is `anthropic`.
- Default models: `claude-sonnet-5-5` (seat), `claude-opus-5-5` (Chair), `gpt-6.1-sol`, `gemini-3.8-flash`. Output budgets: Anthropic 1400, OpenAI 4000, Google 4000.
- Human deadline: `HUMAN_DEADLINE_MIN`, default 30 (fractions allowed, for tests).
- Chair copy and docs: plain English, short sentences, no em dashes, no hype.
- Do not commit. The user commits when they choose. Do not push: the remote belongs to someone else.

## Review Focus

1. **A person types card-shaped text.** A WHY line that starts with `## Buffett` or `SEAT:` must not split into a fake card when the Chair pastes the answer into `round-N.md`. Pinned in Task 4 (`cardText neutralises headings and SEAT lines`).
2. **A provider returns no usable text.** Gemini returns only thought parts, or a safety block; OpenAI returns an empty `output`. This must count as a failure (retry, fallback, then absent), never an empty card. Pinned in Task 3.
3. **The deadline passes while the form is open.** Submit gets 409 with a plain message, and `wait_answers.mjs` exits 4 naming the seat. Pinned in Tasks 4 and 10.
4. **Option sets other than A, B, C.** A two-option yes/no decision and a four-option decision (with D) must render, validate and print correctly. Pinned in Task 4.
5. **The room restarts while a person is pending.** A skill-session request on disk must reappear in `/api/inbox` after a restart. Pinned in Task 4 (`listPending reads disk requests on a fresh import`).

Also pinned, my call beyond the spec: the Host check runs on every `/api/*` request, not only POSTs, so a DNS-rebinding page cannot read session data (Task 7).

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `package.json`, `app/lib/env.mjs`, `test/helpers.mjs`, `test/no-child-process.test.mjs` | 1 | Test harness, `ROAST_ROOT` override |
| `app/lib/seats.mjs`, `app/public/runners.js` | 2 | Roster loading, card parsing and splitting, runner labels shared by browser and Node |
| `app/lib/providers/{http,anthropic,openai,google,index}.mjs` | 3 | Provider calls, retry policy, model and key resolution, usage |
| `app/lib/seatprompt.mjs`, `app/lib/inbox.mjs` | 4 | Prompt assembly for non-subagent seats; human requests, validation, card writing |
| `app/lib/council.mjs` | 5 | API runner: per-provider dispatch, absent seats, pauses, humans |
| `app/lib/watch.mjs` | 6 | Watcher: runners, waiting events, absent seats |
| `app/server.mjs` | 7 | Guards, inbox and answer routes, resume route |
| `app/public/{app.js,index.html,styles.css}` | 8 | Badges, Your turn form, sealed cards, pauses, disclaimers |
| `.claude/skills/roast-room/scripts/run_seat.mjs` | 9 | Claude Code path: resolve, plan, run a seat over HTTP or CLI |
| `.claude/skills/roast-room/scripts/wait_answers.mjs` | 10 | Write human requests and wait for answers |
| `.claude/skills/newroaster/scripts/add_seat.mjs` | 11 | `--provider`, `--model`, `--cli-model`, `--human` |
| `SKILL.md`, references, `CLAUDE.md`, `.env.example`, `README.md` | 12 | The Chair's protocol and user docs |

Order: 1 → (2, 3, 11 in parallel) → 4 → (5, 6, 9, 10 in parallel) → 7 → (8, 12 in parallel) → 13.

---

### Task 1: Test harness and root override

**Files:**
- Modify: `app/lib/env.mjs:8-13`
- Modify: `package.json` (scripts)
- Create: `test/helpers.mjs`, `test/no-child-process.test.mjs`

**Interfaces:**
- Produces: env var `ROAST_ROOT`. When set, `REPO_ROOT = ROAST_ROOT` and `SESSIONS_DIR = ROAST_ROOT/sessions`; every other path derives from `REPO_ROOT` as today.
- Produces (`test/helpers.mjs`):
  - `makeRepo({ seats, board = "default", def }) -> { root, sessions, cleanup() }`. Writes `roster.json`; for each non-human seat writes `.claude/agents/council-<key>.md` (front matter plus one line) and, when `slug` is set, the five brain files `_hot.md frameworks.md positions.md principles.md voice.md`, with `_hot.md` containing the line `Price is what you pay and value is what you get, always.`
  - `makeSession(root, name, files: Record<string,string|object>) -> dir`. Objects are written as JSON.
  - `mockFetch(handler: (url, init) => Response | Promise<Response>) -> { calls: {url, init, body}[], restore() }`. `body` is the parsed JSON request body.
  - `request(port, { method = "GET", path, headers = {}, body }) -> Promise<{ status, json, text }>`, built on `node:http` so tests can set `Host` and `Origin`.
  - `sse(events: object[]) -> Response` with `text/event-stream` body of `data: <json>\n\n` lines.
- Each test file sets `process.env.ROAST_ROOT` (and any other env) before its first dynamic `import()` of app code.

- [ ] **Step 1: Write the failing test** `test/no-child-process.test.mjs`

```js
test("no file under app/ uses child_process", () => {
  const hits = walk("app").filter((f) => /\.(m?js)$/.test(f) && fs.readFileSync(f, "utf8").includes("child_process"));
  assert.deepEqual(hits, []);
});
test("ROAST_ROOT moves every path", async () => {
  process.env.ROAST_ROOT = "/tmp/rr-root";
  const env = await import("../app/lib/env.mjs");
  assert.equal(env.REPO_ROOT, "/tmp/rr-root");
  assert.equal(env.SESSIONS_DIR, "/tmp/rr-root/sessions");
  assert.equal(env.ROSTER, "/tmp/rr-root/.claude/skills/roast-room/roster.json");
});
```

- [ ] **Step 2:** Run `node --test test/no-child-process.test.mjs`. Expected: the second test FAILS (`REPO_ROOT` is the real repo).
- [ ] **Step 3:** Implement the override in `env.mjs`. Add `"test": "node --test test/*.test.mjs"` to `package.json` scripts. Write `test/helpers.mjs`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS, 2 tests.

---

### Task 2: Roster loading, card parsing, runner labels

**Files:**
- Modify: `app/lib/seats.mjs` (loadRoster at :17, systemFor at :37-51, brainNorm at :58-65, parseCard at :115)
- Modify: `app/lib/watch.mjs:21-48` (move `seatKey` and `splitCards` out; re-export them)
- Create: `app/public/runners.js`
- Test: `test/seats.test.mjs`, `test/runners.test.mjs`

**Interfaces:**
- Produces (`seats.mjs`):
  - Every loaded seat has `provider` (`"anthropic"` when absent) and keeps optional `model`, `cli_model`.
  - `systemText(key) -> string`: agent file without front matter, then today's runtime note, then the brain files. No brain section when `slug` is null.
  - `systemFor(key)` is unchanged in shape: `[{ type: "text", text: systemText(key), cache_control: { type: "ephemeral" } }]`.
  - `checkQuotes(key, text)` returns `[]` for a seat with no `slug`.
  - `normalizeCard(text) -> string` (exported, used by `parseCard`).
  - `seatKey(x)` and `splitCards(md)` move here unchanged; `watch.mjs` imports and re-exports both.
- Produces (`app/public/runners.js`, plain ESM, no DOM, importable by Node and the browser):
  - `PROVIDERS = ["anthropic", "openai", "google", "human"]`
  - `agentAlias(modelId) -> "opus"|"sonnet"|"haiku"|"fable"|null` (first of those words found in the id)
  - `providerName(p) -> "Claude"|"GPT"|"Gemini"|"Human"`
  - `companyName(p) -> "Anthropic"|"OpenAI"|"Google"|""`
  - `badgeFor(runner) -> string`
  - `seatDisclaimer(seat, runner) -> string`
  - `DISCLAIMER` (today's exact sentence, moved from `council.mjs`)
  - `councilDisclaimer(seats, runners) -> string`
  - `recipientsLine(seats, runners) -> string` (`""` when every seat is `anthropic`)
  - `ROUND_FIELDS`, `CHOICES`, `MULTILINE`: the answer-form field lists defined in Task 4's interface block. They live here so the browser form and server validation share one copy; `inbox.mjs` re-exports them.
  - `runner` shape everywhere: `{ provider, model: string|null, transport: "subagent"|"http"|"cli"|"form" }`.

Loading rules (replace the filter at `seats.mjs:17`):
- `anthropic`, `openai`, `google`: need `.claude/agents/council-<key>.md`. `slug` may be null.
- `human`: needs `key`, `name`, `short`. No agent file, no brain.
- Unknown `provider`: drop the seat and `console.warn("roster: dropping <key>: unknown provider <p>")`.

`normalizeCard` algorithm, applied line by line before field matching:
1. Strip leading `#{1,6}\s+` and leading `>\s*`.
2. Rewrite `**LABEL:**`, `**LABEL**:` and `__LABEL:__` at line start to `LABEL:`.
3. A line that is exactly a known label (after steps 1 and 2, no colon), followed by a non-empty line, becomes `LABEL: <next line>`. Known labels are the ones `parseCard` reads.

- [ ] **Step 1: Write the failing tests**

`test/seats.test.mjs` (fixture seats: `bezos` anthropic with slug; `buffett` openai, `model: "gpt-6.1-sol"`, slug; `naval` google, `slug: null`; `priya` human; `ghost` provider `"carrier-pigeon"`; `nofile` anthropic with no agent file):

```js
test("loadRoster keeps human and null-slug seats, drops unknown provider and missing agent", ...
  assert.deepEqual(SEATS.map((s) => s.key), ["bezos", "buffett", "naval", "priya"]);
  assert.equal(byKey.bezos.provider, "anthropic");
  assert.equal(byKey.buffett.model, "gpt-6.1-sol");
test("systemText has no brain section for a null slug", ...
  assert.ok(!systemText("naval").includes("===== brains/"));
  assert.ok(systemText("bezos").includes("===== brains/jeff-bezos/_hot.md ====="));
test("checkQuotes returns [] for seats without a brain", ...
  assert.deepEqual(checkQuotes("naval", '"Price is what you pay and value is what you get, always." (S001)'), []);
test("parseCard reads bold and heading-wrapped fields", ...
  const p = parseCard("SEAT: BEZOS\n### STANCE: Yes\n**OPTION SCORES:** A 7/10 · B 4/10\n**CONFIDENCE**: 4/5\n## THE CALL\nDo B first.", ["A", "B"]);
  assert.equal(p.stance, "Yes"); assert.deepEqual(p.optionScores, { A: 7, B: 4 });
  assert.equal(p.confidence, 4); assert.equal(p.call, "Do B first.");
test("parseCard on today's plain format is unchanged", ...  // one full plain card, every field asserted
test("splitCards still splits ## headings and SEAT: lines", ...  // moved function, same behaviour
```

`test/runners.test.mjs`:

```js
assert.equal(agentAlias("claude-opus-5-5"), "opus");
assert.equal(agentAlias("gpt-6.1-sol"), null);
assert.equal(badgeFor({ provider: "anthropic", model: "claude-sonnet-5-5", transport: "subagent" }), "Claude Sonnet");
assert.equal(badgeFor({ provider: "anthropic", model: null, transport: "subagent" }), "Claude");
assert.equal(badgeFor({ provider: "openai", model: "gpt-6.1-sol", transport: "http" }), "GPT via API");
assert.equal(badgeFor({ provider: "openai", transport: "cli" }), "GPT via Codex");
assert.equal(badgeFor({ provider: "google", transport: "http" }), "Gemini via API");
assert.equal(badgeFor({ provider: "google", transport: "cli" }), "Gemini via agy");
assert.equal(badgeFor({ provider: "human", transport: "form" }), "Human");
assert.equal(badgeFor(undefined), "Claude");
assert.equal(seatDisclaimer({ name: "Priya Rao" }, { provider: "human" }), "Real person, answered live.");
assert.equal(seatDisclaimer({ name: "Warren Buffett" }, { provider: "openai" }), "Simulated from Warren Buffett's public work, run on GPT.");
assert.equal(councilDisclaimer([{ key: "bezos", name: "Jeff Bezos" }], {}), DISCLAIMER);
assert.equal(councilDisclaimer([{ key: "bezos", name: "Jeff Bezos" }, { key: "priya", name: "Priya Rao" }], { priya: { provider: "human" } }),
  DISCLAIMER + " Real people on this panel, answering live: Priya Rao.");
assert.equal(recipientsLine(seats, { buffett: { provider: "openai", transport: "http" }, naval: { provider: "google", transport: "cli" }, priya: { provider: "human", transport: "form" } }),
  "OpenAI (Buffett, via API), Google (Naval, via agy CLI), and Priya on this screen");
assert.equal(recipientsLine(seats, { bezos: { provider: "anthropic", transport: "subagent" } }), "");
```

`recipientsLine` groups seats by provider and transport, in the order openai, google, human. Transport words: `http` → "via API", `cli` → "via Codex CLI" (openai) or "via agy CLI" (google). A group reads `<Company> (<shorts>, <transport words>)`, for example `OpenAI (Buffett and Graham, via API)`. Humans read `<shorts> on this screen`. Shorts inside a group, and the groups themselves, join like English lists: one item alone; two items with " and "; three or more with ", " and ", and " before the last.

- [ ] **Step 2:** Run `node --test test/seats.test.mjs test/runners.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement. `watch.mjs` keeps working through the re-export.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

---

### Task 3: Provider modules

**Files:**
- Move: `app/lib/anthropic.mjs` → `app/lib/providers/anthropic.mjs` (update imports in `app/server.mjs:7`, `app/lib/council.mjs:4-5`, `app/scripts/smoke.mjs:3`)
- Create: `app/lib/providers/http.mjs`, `openai.mjs`, `google.mjs`, `index.mjs`
- Test: `test/providers.test.mjs`

**Interfaces:**
- Produces (`http.mjs`):
  - `class ProviderError extends Error { provider; status; retryable }`
  - `postJson(url, { provider, headers, body, signal }) -> Promise<object>`. Retries on 429, 500, 502, 503, 529, up to 6 attempts. Waits `Retry-After` seconds when the header is present, else `min(30000, 2000 * 2^attempt)` plus up to 250 ms jitter. Never retries a 429 whose body contains `insufficient_quota`. Other non-OK status: throws `ProviderError` with the first 300 characters of the body, with any key value redacted.
  - `setSleep(fn)` for tests.
- Produces (each of `anthropic.mjs`, `openai.mjs`, `google.mjs`):
  - `complete({ model, system, user, maxTokens, signal }) -> { text, usage: { input, output, cacheRead }, stopReason: "end" | "max_tokens" }`
  - Throws `ProviderError("empty reply")` when no text comes back.
  - `anthropic.mjs` keeps `stream`, `json`, `S` and `usage` exactly as today. `stream` gains an optional `onStop(stopReason)` callback, called from `message_delta.delta.stop_reason`. `system` may be a string or the block array.
- Produces (`index.mjs`):
  - `KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY" }`
  - `MODEL_ENV = { anthropic: "SEAT_MODEL", openai: "OPENAI_SEAT_MODEL", google: "GEMINI_SEAT_MODEL" }`
  - `DEFAULT_MODEL = { anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol", google: "gemini-3.8-flash" }`
  - `MAX_TOKENS = { anthropic: 1400, openai: 4000, google: 4000 }`
  - `hasKey(provider) -> boolean` (via `env()`)
  - `resolveModel(provider, { override, seatModel } = {}) -> string | null`. Order: override, seat model, `env(MODEL_ENV[p])`, `DEFAULT_MODEL[p]`. `null` for `human`.
  - `complete(provider, args) -> Promise<result>`. Defaults `maxTokens` to `MAX_TOKENS[provider]`. Adds usage to `providerUsage[provider]`.
  - `providerUsage = { openai: {input, output, cacheRead, calls}, google: {...} }` (Anthropic keeps its own `usage`).

Request and response mapping, from spec §11:
- OpenAI: `POST https://api.openai.com/v1/responses`, `Authorization: Bearer <key>`, body `{ model, instructions: system, input: user, max_output_tokens }`. Text: join every `output[]` item with `type: "message"`, then its `content[]` items with `type: "output_text"`, then `.text`. Usage: `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`. Partial: `status === "incomplete"` and `incomplete_details.reason === "max_output_tokens"`.
- Google: `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, `x-goog-api-key: <key>`, body `{ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { maxOutputTokens } }`. Text: join `candidates[0].content.parts[].text`, skipping parts with `thought: true`. Partial: `finishReason === "MAX_TOKENS"`. No candidates, or `finishReason` of `SAFETY`, `RECITATION`, `PROHIBITED_CONTENT` or `BLOCKLIST`, or `promptFeedback.blockReason`: throw `ProviderError("blocked: <reason>")`. Usage: `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount + thoughtsTokenCount`.
- A string `system` for Anthropic `complete` is sent as `[{ type: "text", text, cache_control: { type: "ephemeral" } }]`.

- [ ] **Step 1: Write the failing tests** (`mockFetch`, `setSleep(async () => {})`, keys set in `process.env`):

```js
test("openai request body and text join", ...
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.deepEqual(calls[0].body, { model: "gpt-6.1-sol", instructions: "SYS", input: "USER", max_output_tokens: 4000 });
  assert.equal(calls[0].init.headers.authorization ?? calls[0].init.headers.Authorization, "Bearer sk-test");
  // response has a reasoning item first, then a message with two output_text parts
  assert.equal(r.text, "part one part two"); assert.equal(r.stopReason, "end");
  assert.deepEqual(r.usage, { input: 100, output: 50, cacheRead: 80 });
test("openai incomplete at max_output_tokens is partial", ... assert.equal(r.stopReason, "max_tokens");
test("openai empty output throws", ... await assert.rejects(complete(...), /empty reply/);
test("google body, thought parts skipped, usage", ...
  assert.match(calls[0].url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g-test");
  assert.deepEqual(calls[0].body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.equal(r.text, "the card");  // parts: [{thought:true,text:"thinking"},{text:"the card"}]
test("google thought-only reply throws", ... /empty reply/
test("google SAFETY block throws", ... /blocked: SAFETY/
test("google MAX_TOKENS is partial", ...
test("429 with Retry-After waits that long, then succeeds", ... assert.deepEqual(sleeps, [2000]);
test("429 insufficient_quota is not retried", ... assert.equal(calls.length, 1);
test("errors never contain the key", ... // 401 body echoes the key; assert message lacks "sk-test"
test("resolveModel order", ...
  assert.equal(resolveModel("openai", { override: "gpt-6-luna", seatModel: "gpt-6.1-terra" }), "gpt-6-luna");
  assert.equal(resolveModel("openai", { seatModel: "gpt-6.1-terra" }), "gpt-6.1-terra");
  process.env.OPENAI_SEAT_MODEL = "gpt-6-astra"; assert.equal(resolveModel("openai"), "gpt-6-astra");
  delete process.env.OPENAI_SEAT_MODEL; assert.equal(resolveModel("openai"), "gpt-6.1-sol");
  assert.equal(resolveModel("human"), null);
test("complete tallies providerUsage", ...
```

- [ ] **Step 2:** Run `node --test test/providers.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement. Move the Anthropic file with `git mv`.
- [ ] **Step 4:** Run `npm test`, then `node -e "import('./app/lib/council.mjs')"`. Expected: PASS, and the import succeeds.

---

### Task 4: Prompt builder and human inbox

**Files:**
- Create: `app/lib/seatprompt.mjs`, `app/lib/inbox.mjs`
- Test: `test/seatprompt.test.mjs`, `test/inbox.test.mjs`

**Interfaces:**
- Consumes: `systemText`, `splitCards`, `byKey`, `loadRoster` (Task 2); `env`, `SESSIONS_DIR` (Task 1).
- Produces (`seatprompt.mjs`):
  - `CARD_ONLY = "Reply with the card only, in the exact field format above. No preamble and no closing remarks."`
  - `contextFiles(round) -> string[]`: `1: ["brief.md"]`, `2: ["brief.md", "round-1.md", "cruxes.json"]`, `3: ["brief.md", "round-2.md#own", "draft-resolution.md"]`.
  - `readContext(sessionDir, round, seatKey) -> { name, text }[]`. `round-2.md#own` is the seat's own card from `splitCards`, named `"Your Round 2 card"`. A missing file is skipped.
  - `buildUser({ promptText, context, cardOnly = true }) -> string`: the prompt, then each context item as `\n\n===== <name> =====\n<text>`, then `\n\n` + `CARD_ONLY` when `cardOnly`.
  - `buildSeatCall({ sessionDir, seatKey, round, promptText, consult = false }) -> { system, user, files }`. Consult: no context, `cardOnly: false`.
- Produces (`inbox.mjs`; the three field constants below are defined in `app/public/runners.js` from Task 2 and re-exported here):
  - `ROUND_FIELDS`: exactly the table in spec §8.
    - 1: required `STANCE, OPTION SCORES, THE CALL, CONFIDENCE, RUIN RISK, DOOR`; optional `PILLAR SCORE, WHY, THE RISK I SEE, WHAT WOULD CHANGE MY MIND, WHAT I'D DO THIS WEEK, QUESTION FOR THE FOUNDER`.
    - 2: required `STANCE, OPTION SCORES, CONFIDENCE, RUIN RISK, I DISAGREE MOST WITH`; optional `I CONCEDE, ON THE CRUXES, PILLAR SCORE, MOVED, MY CONDITIONS FOR YES`.
    - 3: required `VOTE, OPTION SCORES, FINAL SCORE`; optional `FINAL PILLAR SCORE, AMENDMENT OR DISSENT, ONE LINE FOR THE FOUNDER`.
  - `CHOICES = { STANCE: ["Strong yes","Yes","Conditional yes","No","Strong no"], "RUIN RISK": ["none","possible","likely"], DOOR: ["one-way","two-way"], VOTE: ["Endorse","Endorse with amendment","Dissent"] }`
  - `MULTILINE = ["WHY", "ON THE CRUXES", "MY CONDITIONS FOR YES"]`
  - `validateAnswer(round, fields, optionIds) -> string[]` (empty means valid). `OPTION SCORES` is `{ [id]: int }` with every option id, each an integer 0 to 10. `CONFIDENCE` is an integer 1 to 5. `PILLAR SCORE`, `FINAL SCORE`, `FINAL PILLAR SCORE`: integers 0 to 10. Choice fields must be in `CHOICES`. Unknown field names are errors. Text at most 2000 characters.
  - `cardText({ seat, round, fields, optionIds }) -> string`. Round 1 opens `SEAT: <SHORT> (<pillar>)`; rounds 2 and 3 open `SEAT: <SHORT>`. Field order follows `round1Prompt`, `round2Prompt` and `round3Prompt` in `council.mjs`. Scores print `n/10`, confidence `n/5`, options `A 7/10 · B 4/10`. Single-line fields collapse newlines to spaces. In every text field, each line loses leading `#` characters and a leading `SEAT:` becomes `Seat note:`. Absent optional fields are left out.
  - `deadlineFrom(now = Date.now()) -> ISO string` using `HUMAN_DEADLINE_MIN` (default 30).
  - `requestPath(sessionDir, seat, round)`, `answerPath(sessionDir, seat, round)`.
  - `readRequests(sessionDir) -> req[]`: every `inbox/*.request.json` in that folder, parsed, unreadable files skipped.
  - `writeRequest(sessionDir, req)`: tmp file plus rename into `inbox/`. `req = { seat, round, prompt, fields: ROUND_FIELDS[round], context: string[], options: [{id,label}], deadline, status: "pending" }`.
  - `listPending({ now } = {}) -> PendingRequest[]`, where `PendingRequest = { session, source: "skill"|"api", seat, name, short, round, deadline, prompt, fields, options, context: [{name, text}] }`. Skill requests come from `SESSIONS_DIR/*/inbox/*.request.json` with `status: "pending"` and a future deadline, in folders that have `council.json`. Their context is read with `readContext`.
  - `submitAnswer({ session, seat, round, fields }, { now } = {}) -> { code, body }`:
    - 400: `session` fails `/^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/`, or `seat` fails `/^[a-z][a-z0-9]{1,15}$/`, or `round` is not 1, 2 or 3, or validation fails (`body: { error, errors }`).
    - 404: no such request.
    - 409: already answered (`"This round is already answered."`) or past the deadline (`"The deadline for this round has passed. The council moved on without this answer."`).
    - 200: writes `answerPath` with `cardText(...) + "\n"`, then sets the request to `status: "answered"` with `answeredAt` (tmp plus rename).
    - Paths are built from validated ids, never taken from input.
  - `openApiRequest(sessionId, { seat, round, prompt, options, context }) -> Promise<string>` (in memory, keyed `${sessionId}/${seat}/${round}`). It fills `fields` and `deadline` itself. `context` is `[{name, text}]`, carried directly. Resolves with the card text on a valid submit. Rejects with `Error("deadline")` at the deadline.
  - `dropApiSession(sessionId)`: rejects and clears that session's pending memory requests.

- [ ] **Step 1: Write the failing tests**

`test/seatprompt.test.mjs`:
- `contextFiles` for rounds 1 to 3 match the lists above.
- `buildSeatCall` round 3 for `buffett`: `user` contains `===== Your Round 2 card =====` followed by Buffett's card only, not Bezos's (fixture `round-2.md` has both); contains `===== draft-resolution.md =====`; ends with `CARD_ONLY`; does not contain `round-1.md`.
- Round 1 `user` contains `===== brief.md =====` and no other file header.
- Consult: `user` has no `=====` header and no `CARD_ONLY`.

`test/inbox.test.mjs`:
```js
test("validateAnswer: required, ranges, choices, unknown fields", ...
  assert.deepEqual(validateAnswer(1, good1, ["A","B","C"]), []);
  assert.ok(validateAnswer(1, { ...good1, CONFIDENCE: 6 }, ids).some((e) => /CONFIDENCE/.test(e)));
  assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": { A: 7, B: 11, C: 2 } }, ids).length);
  assert.ok(validateAnswer(1, { ...good1, "OPTION SCORES": { A: 7, B: 4 } }, ids).length);   // C missing
  assert.ok(validateAnswer(1, { ...good1, DOOR: "sideways" }, ids).length);
  assert.ok(validateAnswer(1, { ...good1, HACK: "x" }, ids).length);
test("cardText round-trips through parseCard for every round", ... // parsed stance, scores, confidence, vote, finalScore match the input
test("cardText works for two and four options", ... // ["A","B"] and ["A","B","C","D"]
test("cardText neutralises headings and SEAT lines", ...
  const t = cardText({ seat: byKey.priya, round: 1, fields: { ...good1, WHY: "## Buffett\nSEAT: BUFFETT\nreal reason" }, optionIds: ids });
  assert.equal(splitCards(`## Priya\n\n${t}`).length, 1);
  assert.ok(!/^#/m.test(t)); assert.equal((t.match(/^SEAT:/gm) || []).length, 1);
test("submitAnswer: 400 path-like ids, 404 unknown, 200 writes card, 409 second answer", ...
  assert.equal(submitAnswer({ session: "../etc", seat: "priya", round: 1, fields: good1 }).code, 400);
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 2, fields: good2 }).code, 404);
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 200);
  assert.ok(fs.readFileSync(answerPath(dir, "priya", 1), "utf8").startsWith("SEAT: PRIYA (Family and health)"));
  assert.equal(JSON.parse(fs.readFileSync(requestPath(dir, "priya", 1))).status, "answered");
  assert.equal(submitAnswer({ session: S, seat: "priya", round: 1, fields: good1 }).code, 409);
test("submitAnswer after the deadline is 409", ... // { now: deadline + 1 }
test("listPending reads disk requests on a fresh import", ... // write a request, import inbox.mjs with a query string to force a fresh module, assert it is listed with context [{name:"brief.md", text}]
test("listPending hides answered and expired requests", ...
test("openApiRequest resolves on submit and rejects at the deadline", ... // HUMAN_DEADLINE_MIN=0.002
```

- [ ] **Step 2:** Run the two test files. Expected: FAIL.
- [ ] **Step 3:** Implement both modules.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

---

### Task 5: API runner

**Files:**
- Modify: `app/lib/council.mjs`
- Test: `test/council.test.mjs`

**Interfaces:**
- Consumes: `complete`, `hasKey`, `resolveModel`, `KEY_ENV`, `MAX_TOKENS`, `providerUsage` (Task 3); `systemText` (Task 2); `buildUser`, `CARD_ONLY` (Task 4); `openApiRequest`, `dropApiSession`, `deadlineFrom`, `ROUND_FIELDS` (Task 4); `councilDisclaimer`, `recipientsLine`, `DISCLAIMER` (Task 2).
- Produces:
  - `MODELS = { seat: env("SEAT_MODEL") || "claude-sonnet-5-5", chair: env("CHAIR_MODEL") || "claude-opus-5-5" }`
  - `DISCLAIMER` re-exported from `runners.js` (so `watch.mjs` keeps its import).
  - `missingKeys(seatKeys) -> { seat, provider, env }[]`: AI seats whose provider key is unset, plus the Chair's `ANTHROPIC_API_KEY`, reported as seat `"chair"`.
  - `pickableSeats() -> string[]`: non-human seats whose provider is `anthropic` or has a key.
  - `runnersFor(seatKeys) -> Record<key, runner>`: `anthropic` → `{ model: resolveModel(...), transport: "http" }`, `openai`/`google` → `http`, `human` → `{ model: null, transport: "form" }`.
  - `resume(id, action: "continue"|"stop") -> boolean` (false when no pause is pending).
  - New events: `setup` gains `runners`; `pause { kind: "privacy"|"quorum", recipients?, round?, have? }`; `resumed { kind, action }`; `waiting { round, seats: [{ key, deadline }] }`; `waiting_done { round }`; `seat_absent { round, seat, reason }`; `seat_done` gains `partial: boolean`.
  - `finalNumbers(st)`: `votes` counts only seats with a Round 3 card and a parsed vote. "Missing vote counts as endorse" is gone.
  - `verdictSeats(st, last)`: each entry gains `absent: boolean` (no card in the last round).

Behaviour:
- Board: in pick mode the Chair chooses from `pickableSeats()`; in default mode from `defaultBoard()`. Human seats appear only via the default board.
- After setup, compute `st.runners`. If any seat is not `anthropic`, emit `pause { kind: "privacy", recipients: recipientsLine(...) }` and wait for `resume`. `"stop"`: status `"stopped"`, emit `error { error: "Stopped before Round 1. Nothing was sent outside Anthropic." }`, save, end.
- `roundAll`: for human seats, call `openApiRequest` first, with context built from state: round 1 the brief block; round 2 the brief, every Round 1 card and the cruxes; round 3 the brief, the seat's Round 2 card and the draft. Emit `waiting` before any seat starts. Then run every seat with `Promise.allSettled` and the 350 ms stagger. A rejection emits `seat_absent` with the error message (human deadline reason: `"no answer by the deadline"`). Emit `waiting_done` once the humans settle.
- Per provider: `anthropic` uses today's `stream` path, with model `st.runners[k].model` and `onStop` for `partial`. `openai`/`google` call `complete(p, { model, system: systemText(k), user: buildUser({ promptText, context: [], cardOnly: true }) })`, retrying once on error. `human` awaits the request.
- After each round, if fewer than 3 cards came back: emit `pause { kind: "quorum", round, have }`. `"continue"` goes on; `"stop"` ends as above with `"Stopped after Round <n>: only <have> seats answered."`.
- `verdict.disclaimer = councilDisclaimer(seats, st.runners)`. `verdictMarkdown` uses the same text.
- Emit `usage` with `{ ...ai.usage, providers: providerUsage }`. Call `dropApiSession(s.id)` when the council ends for any reason.

- [ ] **Step 1: Write the failing tests** (`ROAST_ROOT` fixture; default board `bezos` and `graham` (anthropic), `buffett` (openai), `priya` (human); `HUMAN_DEADLINE_MIN=0.05`; `mockFetch` routes by URL and by prompt text: `"A founder brought this"` → setup JSON, `"Name the one to three cruxes"` → cruxes, `"Write the draft resolution"` → draft, `"Write the verdict"` → verdict; streamed seat calls → `sse()` card naming the seat; OpenAI → a Responses body with a card):

```js
test("finalNumbers ignores absent seats in votes", ...
  // 3 seats, Round 3 cards for 2 (endorse, dissent)
  assert.deepEqual(finalNumbers(st).votes, { endorse: 1, dissent: 1 });
test("missingKeys names the seat and the env var", ...
  assert.deepEqual(missingKeys(["bezos", "buffett"]), [{ seat: "buffett", provider: "openai", env: "OPENAI_API_KEY" }]);
test("pickableSeats excludes humans and keyless providers", ...
test("mixed council: privacy pause, human answers, absent seat, verdict", async () => {
  const s = startCouncil("Should I raise prices for everyone or only new clients?", "full");
  await until(() => ev(s, "pause"));
  assert.match(ev(s, "pause").recipients, /OpenAI \(Buffett, via API\).*Priya on this screen/);
  assert.equal(calls.filter((c) => c.url.includes("openai")).length, 0);   // nothing sent before confirm
  resume(s.id, "continue");
  await until(() => ev(s, "waiting"));
  submitAnswer({ session: s.id, seat: "priya", round: 1, fields: good1 });   // round 1 answered
  // round 2: Priya does not answer, so the deadline passes
  await until(() => s.status !== "running", 15000);
  assert.ok(evs(s, "seat_absent").some((e) => e.round === 2 && e.seat === "priya"));
  assert.ok(ev(s, "verdict").verdict.disclaimer.includes("Priya Rao"));
  assert.equal(ev(s, "setup").runners.buffett.transport, "http");
});
test("stop at the privacy pause sends nothing outside Anthropic", ...
test("quorum pause when fewer than 3 cards", ... // OpenAI returns 500 every time and Priya misses the deadline, leaving 2 cards
```

- [ ] **Step 2:** Run `node --test test/council.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

---

### Task 6: Watcher

**Files:**
- Modify: `app/lib/watch.mjs`
- Test: `test/watch.test.mjs`

**Interfaces:**
- Consumes: `readRequests` (Task 4); `councilDisclaimer` (Task 2); `finalNumbers`, `optionScores` (Task 5).
- Produces:
  - `setup` gains `runners`: `council.json.runners[k]` when present, else derived from the roster seat. The derived transport is `subagent` for anthropic, `http` for openai and google, `form` for human.
  - `runners { runners }`, emitted when `council.json` changes after setup and its runners differ.
  - `waiting { round, seats: [{ key, deadline }] }` when the set of pending, unexpired inbox requests for the current round changes and is not empty; `waiting_done { round }` when it becomes empty.
  - `seat_absent { round, seat, reason: "no card" }` for each table seat with no card, when a round completes by force.
  - `verdict.disclaimer = councilDisclaimer(...)`.
  - A session is never marked `stopped` while any request is pending and before its deadline.
  - Files in `inbox/` are never read as cards.

- [ ] **Step 1: Write the failing tests** (fixture session folders, then `scan()` and `getLive(name).events`):
- `setup` carries `runners` from `council.json`, and falls back to roster providers when the key is absent.
- A pending `inbox/priya-r1.request.json` → one `waiting` event with `seats[0].key === "priya"`. Mark it answered, scan → `waiting_done`.
- An answer file in `inbox/` alone produces no `seat_done`.
- `round-1.md` without Priya, then `cruxes.json` → `seat_absent { round: 1, seat: "priya" }`.
- Set every file's mtime 4 hours back with a pending request whose deadline is in the future: `status` stays `"running"`. With no pending request: `"stopped"`.
- Rewriting `council.json` with `runners.buffett.transport: "cli"` → a `runners` event.

- [ ] **Step 2:** Run `node --test test/watch.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

---

### Task 7: Server

**Files:**
- Modify: `app/server.mjs`
- Test: `test/server.test.mjs`

**Interfaces:**
- Consumes: `listPending`, `submitAnswer` (Task 4); `resume`, `missingKeys`, `MODELS` (Task 5); `hasKey`, `providerUsage` (Task 3); `watch` (Task 6).
- Produces:
  - `start(port = Number(env("PORT")) || 4730) -> Promise<http.Server>`. It starts the watcher and listens on `127.0.0.1`. The allowed Origin and Host values use the bound port.
  - `stop() -> Promise<void>`: closes the server and clears the watcher interval (`startWatching()` now returns a `stopWatching` function).
  - Runs `start()` only when executed directly (`import.meta.url === pathToFileURL(process.argv[1]).href`).
- Guards:
  - Every `/api/*` request: the Host must be `localhost:<port>` or `127.0.0.1:<port>`, else 403.
  - Every POST:
    - Origin must be `http://localhost:<port>` or `http://127.0.0.1:<port>`, else 403. A missing Origin is rejected.
    - The content type must start with `application/json`, else 415.
    - The body must be at most 65536 bytes, checked by `content-length` and while reading, else 413.
    - Malformed JSON returns 400.
- Routes:
  - `GET /api/inbox` → `{ requests: listPending() }`.
  - `POST /api/answer` → `submitAnswer(body)`.
  - `POST /api/council/<id>/resume` `{ action }` → 200, or 404 when nothing is paused.
  - `POST /api/council`: when the board mode is `default`, `missingKeys(defaultBoard())` must be empty, else 400 `{ error: "<Short> runs on <Company> but <ENV> is not set." }`. This happens before any call.
  - `GET /api/seats` adds `keys: { anthropic, openai, google }` booleans, never values.
  - `GET /api/usage` → `{ ...usage, providers: providerUsage }`.

- [ ] **Step 1: Write the failing tests** (`start(0)` in a fixture root, `request()` helper):

```js
const ok = (port) => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" });
test("POST /api/answer guards", ...
  assert.equal((await request(port, { method: "POST", path: "/api/answer", headers: { ...ok(port), origin: "http://evil.test" }, body })).status, 403);
  assert.equal((await request(port, { ..., headers: { ...ok(port), host: "evil.test:4730" } })).status, 403);
  assert.equal((await request(port, { ..., headers: { ...ok(port), "content-type": "text/plain" } })).status, 415);
  assert.equal((await request(port, { ..., body: "x".repeat(70000) })).status, 413);
  assert.equal((await request(port, { ..., body: { session: "../../x", seat: "priya", round: 1, fields: {} } })).status, 400);
  assert.equal((await request(port, { ..., body: { session: "2026-10-28-nope", seat: "priya", round: 1, fields: good1 } })).status, 404);
test("valid answer is 200, the second is 409, and the inbox empties", ...
test("GET /api/inbox with a foreign Host is 403", ...
test("POST /api/council without an Origin is 403", ...
test("POST /api/council reports a missing key before any call", ... // COUNCIL_RUNNER=api, default board has an openai seat, no key, fetch mocked: 400 and zero fetch calls
test("/api/seats exposes key presence, not values", ... assert.ok(!JSON.stringify(j).includes("sk-test"));
```

- [ ] **Step 2:** Run `node --test test/server.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`, then `npm start` in the background and `curl -s localhost:4730/api/seats`. Expected: tests PASS; the server answers. Stop it.

---

### Task 8: Room UI

**Files:**
- Modify: `app/public/app.js`, `app/public/index.html`, `app/public/styles.css`

**Interfaces:**
- Consumes: `badgeFor`, `seatDisclaimer`, `ROUND_FIELDS`, `CHOICES`, `MULTILINE` from `/runners.js` (Task 2); the events from Tasks 5 and 6; `GET /api/inbox`, `POST /api/answer`, `POST /api/council/<id>/resume` (Task 7).

Changes:
1. **Badges.** `state.runners` comes from `setup` and `runners` events. Each nameplate gets `<span class="prov">` with `badgeFor(runner)`. With no runner it reads "Claude".
2. **Your turn.** Poll `GET /api/inbox` every 2000 ms while the page is visible. For each request, show a fixed button "Your turn: <short>, Round <n>". It opens `<dialog id="answerDialog">` with:
   - the context items as collapsible `<details>` (the first one open);
   - the request prompt, when it has one;
   - the round's fields from `request.fields`:
     - a 0 to 10 number input per option for OPTION SCORES (from `request.options`);
     - a `<select>` for each `CHOICES` field (imported from `/runners.js`, the same lists the server validates against);
     - a 1 to 5 select for CONFIDENCE;
     - 0 to 10 number inputs for the other scores;
     - a `<textarea>` for `WHY`, `ON THE CRUXES` and `MY CONDITIONS FOR YES`, and a single-line input for every other field;
   - required fields marked;
   - a deadline countdown.
   Submit posts to `/api/answer`. A 400 shows each error next to its field. A 409 shows the server's message and closes the form. A 200 shows "Sent. The council has your card." and removes the button.
3. **Sealed cards.**
   - `waiting { round }` sets `state.sealed = round`.
   - While sealed, a `seat_done` for that round does not speak. Store it in `state.held`. The nameplate chip reads "Answered". The feed adds "<short> has answered. Cards open when the round closes."
   - `waiting_done` or `round_done` for that round clears the seal. Before `round_done` updates the scores, the held events play through `onSeatDone` in order.
4. **Absent seats.** `seat_absent` adds the class `absent-round` to the seat and its nameplate for that round. It adds the feed note "<short> did not answer Round <n> (<reason>)". A later `seat_done` for that seat clears it.
5. **Votes.** Replace `parsed.vote || "endorse"` at `app.js:587`, `:599` and `:689` with `parsed.vote || "no vote"` for display. The verdict line counts only `v.votes` keys.
6. **Pauses (API runner).** `pause { kind: "privacy" }` shows a center card: "Before Round 1: these will receive the brief and later rounds: <recipients>." with **Send and start** and **Stop**. `pause { kind: "quorum" }` shows "Only <have> seats answered Round <round>." with **Continue** and **Stop**. The buttons post `/api/council/<id>/resume`. `resumed` hides the card, including on replay.
7. **Disclaimers.** The card dialog line at `app.js:703` uses `seatDisclaimer(seat, state.runners[key])`. The verdict footer already uses `v.disclaimer`.
8. Human seats use the existing drawn bust with initials. No change is needed beyond the badge.

- [ ] **Step 1:** Implement items 1 to 8.
- [ ] **Step 2:** Run `npm test`. Expected: PASS (`runners.js` tests still pass).
- [ ] **Step 3:** Start the room and replay `sessions/2026-10-10-example-raise-coaching-price`. Expected: no console errors, and every nameplate badge reads "Claude".

---

### Task 9: `run_seat.mjs`

**Files:**
- Create: `.claude/skills/roast-room/scripts/run_seat.mjs`, `test/fixtures/fake-delegate.mjs`
- Test: `test/run_seat.test.mjs`

**Interfaces:**
- Consumes: `loadRoster`, `byKey`, `systemText`, `parseCard` (Task 2); `complete`, `hasKey`, `resolveModel`, `MAX_TOKENS` (Task 3); `buildSeatCall` (Task 4); `ROUND_FIELDS` (Task 4); `agentAlias`, `recipientsLine` (Task 2). Imports by relative path from the script's own location.
- Produces (exported, and the CLI runs `main()` only when executed directly):
  - `resolveSeat({ seat, provider, model, session }) -> { seat, provider, model, transport, agentModel, cliModel, reason }`. Provider order: argument, `council.json.runners[seat].provider`, roster. Model order: argument, `council.json.runners[seat].model`, roster `model`, then `resolveModel`. Transport:
    - `anthropic` → `subagent`, with `agentModel = agentAlias(model)` (or `null`, which means the default plus a Chair note).
    - `openai`/`google` → `http` if `hasKey`, else `cli` if `DELEGATE_PY` names an existing file, else `null` with `reason: "no OPENAI_API_KEY and no DELEGATE_PY"` (or `GEMINI_API_KEY`).
    - `human` → `form`.
  - `planSeats({ seats, session }) -> { runners, cannotRun: [{ seat, reason }], recipients }`.
  - `runSeat({ session, seat, round, promptFile, consult, provider, model, dryRun }) -> { code, card, meta }`.
- CLI:
  ```
  node .claude/skills/roast-room/scripts/run_seat.mjs --session <dir> --seat <key> --round <1|2|3> --prompt-file <f> [--provider p] [--model m] [--dry-run]
  node .claude/skills/roast-room/scripts/run_seat.mjs --consult --seat <key> --prompt-file <f> [--provider p] [--model m] [--dry-run]
  node .claude/skills/roast-room/scripts/run_seat.mjs --plan --seats a,b,c [--session <dir>]
  ```
  - Normal run: the card goes to stdout. The last stderr line is `RUN_SEAT {"seat","provider","model","transport","partial","missing","ms","usage"}`. `missing` lists the round's required fields that `parseCard` could not read.
  - `--dry-run`: stdout gets JSON `{ seat, provider, model, transport, agentModel, systemBytes, userBytes, files, argv }`. `argv` is set only for the CLI transport. No network, no process.
  - `--plan`: stdout gets the `planSeats` JSON.
  - Exit codes:
    - 0: ok.
    - 2: cannot run. This covers a human seat, an `anthropic` seat with no `ANTHROPIC_API_KEY` ("use the council-<key> subagent"), no key and no CLI, `delegate.py` exiting 2, and a bad argument.
    - 3: provider failure.
- Run policy:
  - `http`: on failure, if a CLI is available, run the CLI once and set `meta.transport = "cli"`. If not, retry the HTTP call once.
  - `cli`: retry once on exit 3, then exit 3.
  - `delegate.py` exit 2: exit 2 at once, and pass its stderr reason through.
- CLI call: write `<mkdtemp>/task.md` containing `system`, then `\n\n===== YOUR TASK =====\n`, then `user`. Run `${DELEGATE_PYTHON || "python3"} ${DELEGATE_PY} run codex|agy --isolated --json --timeout 570 --task-file <file>`, adding `--model <cli_model>` only when the seat has `cli_model`. Read `.reply` from the stdout JSON. Remove the temp dir afterwards. Never pass `--allow-secrets`. Never pass the API model id.

- [ ] **Step 1: Write the failing tests** (in-process imports, `ROAST_ROOT` fixture; `fake-delegate.mjs` appends its argv to `$FAKE_DELEGATE_LOG` and prints `{"reply":"SEAT: BUFFETT\nSTANCE: Yes\n..."}`; exit code taken from `$FAKE_DELEGATE_EXIT`; run with `DELEGATE_PYTHON=node`):
- Transport matrix: key set → `http`; no key and `DELEGATE_PY` set → `cli`; neither → `transport: null` with the reason. Anthropic seat with `model: "claude-opus-5-5"` → `subagent`, `agentModel: "opus"`. Human → `form`.
- `runners` in `council.json` override the roster provider.
- `--dry-run` for a round 2 openai seat lists `files: ["brief.md", "round-1.md", "cruxes.json"]` and makes zero fetch calls.
- CLI run: the logged argv contains `--isolated` and `--task-file`, and does not contain `--allow-secrets` or `gpt-6.1-sol`. It contains `--model codex-fast` only when the seat has `cli_model: "codex-fast"`. The card comes back with `code: 0`.
- HTTP 500 every time with a CLI available → falls back, `meta.transport === "cli"`, code 0.
- Fake delegate exit 2 → code 2. Exit 3 twice → code 3.
- `planSeats` for `bezos, buffett, priya` with only `DELEGATE_PY` set: `recipients` is `"OpenAI (Buffett, via Codex CLI) and Priya on this screen"`. `cannotRun` is empty.
- `meta.missing` lists `CONFIDENCE` for a card without it.
- Consult with a human seat → code 2 and stderr `"Priya is a person. Ask them directly."`.

- [ ] **Step 2:** Run `node --test test/run_seat.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. The child_process grep test still passes (the script is outside `app/`).

---

### Task 10: `wait_answers.mjs`

**Files:**
- Create: `.claude/skills/roast-room/scripts/wait_answers.mjs`
- Test: `test/wait_answers.test.mjs`

**Interfaces:**
- Consumes: `writeRequest`, `requestPath`, `answerPath`, `deadlineFrom`, `ROUND_FIELDS` (Task 4); `contextFiles` (Task 4); `byKey` (Task 2).
- Produces:
  - `waitAnswers({ session, round, seats, promptFile, deadlineMin, pollMs = 2000 }) -> Promise<{ code: 0|2|4, answered: string[], missing: string[] }>`
  - CLI: `node .claude/skills/roast-room/scripts/wait_answers.mjs --session <dir> --round <n> --seats a,b [--prompt-file f] [--deadline-min 30] [--poll-ms 2000]`.
- Behaviour:
  - For each seat with no request file for the round, write one. Options come from `council.json`, `context` from `contextFiles(round)`, `prompt` from the prompt file (or `""`), and the deadline from `deadlineFrom`.
  - An existing request is kept, including its deadline, so a re-run does not extend it.
  - Poll until every request is answered: print each answer path, exit 0.
  - At the deadline: print `missing: <keys>`, exit 4.
  - A non-human seat, a missing `council.json` or a bad argument: exit 2.

- [ ] **Step 1: Write the failing tests:**
  - requests are written with the right `fields` and `options`;
  - a `submitAnswer` during the wait gives code 0;
  - no answer within `deadlineMin: 0.002` gives code 4 with `missing: ["priya"]`;
  - re-running keeps the original deadline;
  - a non-human seat gives code 2.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

---

### Task 11: `add_seat.mjs` flags

**Files:**
- Modify: `.claude/skills/newroaster/scripts/add_seat.mjs`
- Test: `test/add_seat.test.mjs`

**Interfaces:**
- Produces:
  - Flags `--provider anthropic|openai|google|human`, `--model <id>`, `--cli-model <name>`, and `--human` (the same as `--provider human`).
  - `ROAST_ROOT` overrides the computed `ROOT`.
  - Human seat: requires `--key --name --short --pillar --question`. `--dimension` defaults to the pillar. Stores `slug: null` and `provider: "human"`. Skips the agent and brain checks. Initials and colour are automatic.
  - AI seat: today's checks. `provider`, `model` and `cli_model` are written only when given. When updating an existing seat, any of those three fields not passed is kept.
  - An unknown `--provider` fails with exit 1 and `add_seat: --provider must be one of anthropic, openai, google, human`.

- [ ] **Step 1: Write the failing tests** (spawn the script against a fixture root):
  - `--human` adds `priya` with `provider: "human"`, `slug: null`, initials `PR` and a palette colour;
  - `--provider openai --model gpt-6.1-sol` on an existing seat keeps its other fields;
  - re-running the seat without `--provider` keeps `openai`;
  - a bad provider gives exit 1.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

---

### Task 12: The Chair's protocol and docs

**Files:**
- Modify: `.claude/skills/roast-room/SKILL.md`, `references/live-room.md`, `references/round-prompts.md`, `references/report-template.md`, `CLAUDE.md`, `.env.example`, `README.md`

Content to add (plain English, no em dashes):
1. **`SKILL.md` "Pick the board".**
   - Run `run_seat.mjs --plan --seats <keys> --session <dir>`, and show each seat's provider and model in the recommendation.
   - Never seat a person unless the user names them or they are on the default board.
   - Never change a seat's provider on your own.
   - When an OpenAI or Google key or `DELEGATE_PY` exists, the board question may offer "Mixed board" as one option. "Recommended board" stays first.
2. **Step 2.** Write `runners` into `council.json` from the plan output. If `cannotRun` is not empty, say so and offer to switch those seats to `anthropic`.
3. **New privacy step before Round 1.** If `recipients` is not empty, ask once with AskUserQuestion (header "Privacy"): "These will receive the brief and later round files: <recipients>." Options: **Send** and **Use Claude for those seats**.
4. **Steps 3, 4 and 6: dispatch every seat in one message.**
   - `anthropic`: an Agent call with `model: <agentModel>`. Leave `model` out when `agentModel` is null, and add a Chair note.
   - `openai`/`google`: write the round prompt to `sessions/<id>/prompts/<key>-r<N>.md`, then run a background Bash call of `run_seat.mjs`.
   - Humans: one background `wait_answers.mjs --seats <humans>`.
   - Wait for all of them.
   - Paste each answer from `inbox/<key>-r<N>.answer.md` under `## <short>`, like any card.
   - If a `RUN_SEAT` line says `transport: "cli"`, update `runners` in `council.json`.
5. **Card checks.** A non-Claude card with `missing` fields is sent back once: append "Your card is missing <fields>. Reply again with the full card in the exact format." to its prompt file and re-run. After that, save it as partial with a Chair note.
6. **Absent seats.** No card for that round, and a line in `## Chair notes`. Scoring leaves them out. Fewer than 3 cards: ask the user (AskUserQuestion) whether to continue or stop.
7. **Consult.** `ask <seat>` on an `openai` or `google` seat uses `run_seat.mjs --consult`, after the privacy confirmation. On a human seat, refuse in one line: "<Name> is a person on your board. Ask them directly."
8. **Board settings.**
   - "run <seat> on <provider> [model]" edits that seat's `provider`, `model` and, if given, `cli_model` in `roster.json`.
   - "add a person" runs `add_seat.mjs --human`.
9. **Cost line.** Name the per-seat cost estimates from spec §11 and `delegate.py stats` for CLI runs.
10. **`live-room.md`.**
    - Document `runners` and the `inbox/` request and answer files: the schema, who writes them and when.
    - The room shows a Your turn form.
    - Round files still hold every card.
11. **`round-prompts.md`.**
    - Non-Claude seats get the same template through `--prompt-file`, with the "Read the brief: …" and "Read your brain" lines removed. `run_seat.mjs` attaches the brief, earlier rounds and the brain itself.
    - The Agent call's `model` parameter comes from `agentModel`.
12. **`report-template.md`.** The footer names any human seats with the `councilDisclaimer` wording.
13. **`CLAUDE.md`.** Add to the simulation rule: "A human seat is a real person answering live; their card is their own words."
14. **`.env.example`.** Add `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_SEAT_MODEL`, `GEMINI_SEAT_MODEL`, `SEAT_MODEL`, `CHAIR_MODEL`, `DELEGATE_PY`, `DELEGATE_PYTHON`, `HUMAN_DEADLINE_MIN`, each with a one-line comment.
15. **`README.md`.** Add a short "Mixed panel" section: providers, the CLI fallback, people on this Mac, and the privacy step.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `grep -n "—" .claude/skills/roast-room/SKILL.md .claude/skills/roast-room/references/*.md` shows no new em dashes. Every script command quoted in `SKILL.md` matches the CLIs in Tasks 9 and 10.

---

### Task 13: Acceptance (the driver runs this, not an implementer)

- [ ] `npm test` and `npm run smoke` pass. (Smoke needs `ANTHROPIC_API_KEY`; skip it and say so if the key is absent.)
- [ ] `run_seat.mjs --dry-run` matrix on the real repo: key set, `DELEGATE_PY` only, neither.
- [ ] One live call per configured provider confirms the two "verify live" items in spec §11: OpenAI's partial marker and Gemini's thought flag.
- [ ] A Claude Code council with four Claude seats (one on a different Claude model), one OpenAI seat, one Google seat and one human runs to a verdict. The room shows the badges. The human answers every round in the form. With no `OPENAI_API_KEY`, the OpenAI seat runs through the codex CLI.
- [ ] The API runner refuses a mixed default board with a key missing, before any call.

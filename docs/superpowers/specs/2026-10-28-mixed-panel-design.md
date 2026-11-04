# Mixed panel: humans and other AI providers in the Roast Room

Status: draft for approval · Branch: `mixed-panel` (local only, never pushed) · 2026-10-28

## 1. Intent

Today every seat is Claude playing a persona. Seven seats are one model in seven roles, so they share
one set of blind spots. This change lets a seat run on another provider (OpenAI, Google) or be a real
person on this Mac. The aim is disagreement that is more independent, not just more voices.

The card format stays exactly as it is. A card from GPT, Gemini or a person is the same text a Claude
seat writes today, so the watcher, scoring, verdict sheet and PDF keep working.

## 2. Goals, non-goals, anti-goals

Goals:
1. Each seat has a `provider` (`anthropic`, `openai`, `google`, `human`) and an optional `model`.
   Defaults keep today's behaviour.
2. Any persona seat can run on any AI provider, using the same agent file and brain.
3. An `openai` or `google` seat calls the provider's HTTP API when its key is set. In the Claude Code
   path only, it falls back to the `codex` or `agy` CLI through `delegate.py` when no key is set.
4. A `human` seat answers on this Mac through a form in the room. The answer becomes a normal card.
5. Both orchestration paths work: the Claude Code skill (primary) and the app's API runner.
6. The room shows who runs each seat.
7. Before any non-Anthropic provider or person sees the brief, the user confirms the list once.

Non-goals (v1):
- Humans on other devices. The server stays bound to 127.0.0.1. (v2: email or a hosted form.)
- Accounts or auth.
- Any change to scoring formulas, bands or overrides.
- Streaming token deltas for non-Anthropic seats. The UI drops deltas today anyway.
- New personas or brains. The Chair stays on Anthropic.

Anti-goals (a failure even if it works):
- The server or `app/lib` spawns a process. CLI fallback lives only in a skill script that Claude
  Code runs. `child_process` must not appear under `app/`.
- A seat, human or AI, sees another seat's Round 1 card before writing its own.
- A provider receives anything beyond the assembled prompt: no API key, no file outside the attached
  set, no repo access.
- `delegate.py` is ever called with `--allow-secrets`.

## 3. Concepts

`provider` is who produces the card. `transport` is how the call is made. The transport is resolved
at run time, never configured by hand:

| provider | Claude Code path | API runner (`COUNCIL_RUNNER=api`) |
|---|---|---|
| `anthropic` | Claude subagent `council-<key>`, with the Agent tool's `model` set from the seat | `anthropic` HTTP (today's client) |
| `openai` | HTTP if `OPENAI_API_KEY` is set; else `codex` CLI via `delegate.py`; else the seat cannot run | HTTP; key required |
| `google` | HTTP if `GEMINI_API_KEY` is set; else `agy` CLI via `delegate.py`; else the seat cannot run | HTTP; key required |
| `human` | Inbox request, room form, the Chair waits | Inbox request, room form, the runner awaits |

Model resolution, first match wins: per-council override in `council.json` → seat `model` in
`roster.json` → env default for the provider (`SEAT_MODEL`, `OPENAI_SEAT_MODEL`, `GEMINI_SEAT_MODEL`)
→ the documented default in code. Model ids are configuration. The builder picks defaults from the
provider docs in §11.

## 4. Roster and council files

New optional fields on a seat in `roster.json`:

```json
{ "key": "buffett", "provider": "openai", "model": "<openai model id>", "...": "existing fields" }
{ "key": "priya", "provider": "human", "name": "Priya Rao", "short": "Priya", "initials": "PR",
  "pillar": "Family and health", "question": "What does this cost the family week to week?",
  "dimension": "Family cost", "color": "#7f77dd" }
```

Loading rules (replaces the filter at `app/lib/seats.mjs:17`):
- `anthropic`, `openai`, `google` seats need the agent file. The brain is optional (`slug` may be
  null; such a seat cites nothing).
- `human` seats need neither an agent file nor a brain.
- A missing `provider` means `anthropic`. An unknown provider drops the seat with a console warning.

`council.json` gains `runners`, written by the Chair (or the API runner) at setup, so the room shows
what actually ran rather than the roster default:

```json
"runners": { "buffett": { "provider": "openai", "model": "...", "transport": "http" },
             "priya":   { "provider": "human", "transport": "form" } }
```

`transport` is one of `subagent`, `http`, `cli`, `form`. The Chair may update it mid-council if a
seat falls back (for example HTTP failed and the CLI ran).

Setting providers:
- `/roast-room board` gains "run <seat> on <provider> [model]" and "add a person".
- `add_seat.mjs` gains `--provider`, `--model` and `--human` (name, short, pillar, question). A human
  seat gets an auto colour and initials.
- At board pick, the Chair may propose a provider mix for this council only. That goes in
  `council.json.runners`, not the roster.

## 5. What an AI seat sees

One shared builder assembles the prompt for every transport except Claude subagents:
- `system` = the agent file (front matter stripped) + a runtime note + the brain files that
  `systemFor` loads today (`app/lib/seats.mjs:37-51`: `_hot.md`, `frameworks.md`, `positions.md`,
  `principles.md`, `voice.md`). No brain when `slug` is null.
- `user` = the round prompt the Chair filled from `references/round-prompts.md`, then the session
  files that round allows, each under a fenced header:
  - Round 1: `brief.md`.
  - Round 2: `brief.md`, `round-1.md`, `cruxes.json`.
  - Round 3: `brief.md`, the seat's own Round 2 card, `draft-resolution.md`.
- Runtime note for non-Claude providers: no file tools; everything is below; reply with the card
  only, in the exact field format.

Claude subagents keep reading files themselves, as today, now with `model` set.

## 6. Claude Code path (the skill)

New script `.claude/skills/roast-room/scripts/run_seat.mjs` (Node 20, zero dependencies, imports
`app/lib`):

```
node .claude/skills/roast-room/scripts/run_seat.mjs --session <dir> --seat <key> --round <n>
     --prompt-file <file> [--provider p] [--model m] [--dry-run]
```

- Resolves provider, model and transport (§3).
- HTTP: calls `app/lib/providers/<provider>.mjs`.
- CLI fallback: writes one task file holding the system text and the user text, then runs
  `delegate.py run codex|agy --isolated [--model m] --task-file <file>`. `--isolated` means no repo
  access. The script path comes from `DELEGATE_PY`. No `DELEGATE_PY`, no fallback.
- Prints the card on stdout. Exit codes: `0` ok; `2` cannot run (no key and no CLI, or `delegate.py`
  refused); `3` provider failure after one retry.
- `--dry-run` prints the transport, model, byte counts and the list of what would be sent. No network.

Human seats in the Claude Code path:
1. The Chair writes `sessions/<id>/inbox/<key>-r<N>.request.json`:
   `{seat, round, prompt, fields, context, deadline, status: "pending"}`. `context` names the session
   files the form shows (same rule as §5).
2. The room shows a "Your turn" panel. The person fills the form. The server writes
   `<key>-r<N>.answer.md` in the exact card format and sets `status: "answered"` (tmp file + rename).
3. The Chair runs `node .claude/skills/roast-room/scripts/wait_answers.mjs --session <dir> --round <n>`
   in the background. Exit `0` when every request for the round is answered; exit `4` at the deadline,
   listing missing seats.
4. The Chair saves each answer into `round-N.md` under `## <short>`, like any card.

`SKILL.md` and references change:
- Board step shows each seat's provider and model.
- Privacy step (§9) before Round 1.
- Steps 3 to 5 dispatch every seat in one message: Agent calls for `anthropic` seats (with `model`),
  background Bash calls of `run_seat.mjs` for `openai` and `google`, inbox requests plus one
  `wait_answers.mjs` for humans.
- A malformed non-Claude card is sent back once by re-running `run_seat.mjs` with a short "fix the
  format" note appended to the prompt.
- Absent seats: no card for that round, a line in `## Chair notes`, and scoring excludes them (the
  code already skips missing scores).
- `live-room.md` documents `runners` and `inbox/`.

## 7. API runner (the app)

- `app/lib/providers/anthropic.mjs` (today's `anthropic.mjs`, moved), `openai.mjs`, `google.mjs`.
  Common seat interface: `complete({ model, system, user, maxTokens, signal })` →
  `{ text, usage: { input, output, cacheRead }, stopReason }`. The Chair keeps Anthropic `json()`.
- `council.mjs` dispatches seat calls on provider. Human seats create the same inbox request and
  await an in-memory promise that the answer handler resolves, or the deadline.
- Start-of-council check: any seat whose provider key is missing returns 400 before any call, naming
  the seat and the key.
- Usage is tracked per provider.
- A seat reply cut off at the token limit is marked partial, on every provider. (Today's silent
  truncation stays out of scope for the old path, but the new interface must report it.)
- `SEAT_MODEL`, `CHAIR_MODEL` and `PORT` are read through `env()` so `.env` works for them.

## 8. Server, watcher and room

Server (`app/server.mjs`):
- `GET /api/inbox`: pending human requests across live sessions.
- `POST /api/answer` `{session, seat, round, fields}`: validates and writes the card. `404` unknown
  request; `409` already answered or past deadline; `400` invalid fields.
- Guards on every POST, including the existing `/api/council`: Origin must be
  `http://localhost:<port>` or `http://127.0.0.1:<port>`; Host must be `localhost` or `127.0.0.1` with
  the port; content type `application/json`; body at most 64 KB. Session ids and seat keys are
  checked against existing folders and the roster; paths are built, never taken from input.

Watcher (`app/lib/watch.mjs`):
- Emits `waiting` `{round, seats: [{key, deadline}]}` while inbox requests are pending, and
  `waiting_done` when they clear.
- Never marks a session `stopped` while a request is pending and before its deadline.
- Ignores `inbox/` when splitting cards.

Card parsing (`app/lib/seats.mjs` `parseCard`): strip leading Markdown emphasis and heading markers
from each line before matching fields, so `**OPTION SCORES:**` and `### STANCE` parse. Both paths gain.

Room UI:
- Nameplate badge from `runners`: for example "Claude Sonnet", "GPT via API", "Gemini via agy",
  "Human". Human seats use the existing drawn bust with initials.
- "Your turn: <name>" panel whenever `/api/inbox` has a request. It opens the answer form.
- Form fields mirror the round's card (from `references/round-prompts.md`):

| Round | Shown above the form | Required fields | Optional fields |
|---|---|---|---|
| 1 | The brief only | STANCE, OPTION SCORES (0–10 each), THE CALL, CONFIDENCE (1–5), RUIN RISK, DOOR | PILLAR SCORE, WHY 1–3, THE RISK I SEE, WHAT WOULD CHANGE MY MIND, WHAT I'D DO THIS WEEK, QUESTION FOR THE FOUNDER |
| 2 | Brief, all Round 1 cards, cruxes | STANCE, OPTION SCORES, CONFIDENCE, RUIN RISK, I DISAGREE MOST WITH | I CONCEDE, ON THE CRUXES, PILLAR SCORE, MOVED, MY CONDITIONS FOR YES |
| 3 | Draft resolution, own Round 2 card | VOTE, OPTION SCORES, FINAL SCORE | FINAL PILLAR SCORE, AMENDMENT OR DISSENT, ONE LINE FOR THE FOUNDER |

- Inline validation: required fields present; scores are integers 0 to 10; confidence 1 to 5.

## 9. Privacy

- Before Round 1, if any seat is `openai`, `google` or `human`, the Chair lists who will receive the
  brief and later round files, for example: "OpenAI (Buffett, via API), Google (Naval, via agy CLI),
  and Priya on this screen". It asks once per council. The API runner composer shows the same list
  and needs a tick before start.
- HTTP calls send only the assembled prompt. CLI fallback runs with `--isolated`.
- Keys come only from the environment or `.env`. They never appear in session files, events or logs.

## 10. Failure handling

| Failure | Handling |
|---|---|
| HTTP 429 or 5xx | Retry with backoff (reuse today's policy), honouring `retry-after` when present |
| HTTP fails after retries, CLI available | Fall back to the CLI once; update `runners.transport` |
| CLI times out or crashes (`delegate.py` exit 3) | Retry once; then absent for the round |
| `delegate.py` refuses a possible secret (exit 2) | Absent; show the reason to the user; never `--allow-secrets` |
| No key and no CLI | The Chair says so before Round 1 and offers to switch the seat to `anthropic` |
| Card missing fields | Sent back once; then saved as partial with a Chair note |
| Human misses the deadline | Absent for that round; may answer in later rounds |
| Room closed while a human is pending | The request file stays; the form reappears when the room reopens |

## 11. Provider API facts

Checked against official docs on 2026-10-28. Seat calls are non-streaming plain text: the card is
text, the UI drops deltas, and the Chair stays on Anthropic, so no structured output is needed from
OpenAI or Google. Items marked "verify live" must be confirmed with one real call before merge.

OpenAI, Responses API (recommended over Chat Completions:
https://developers.openai.com/api/docs/guides/text.md):
- `POST https://api.openai.com/v1/responses`, header `Authorization: Bearer <OPENAI_API_KEY>`.
- Body: `{ model, instructions: <system text>, input: <user text>, max_output_tokens }`
  (https://developers.openai.com/api/reference/resources/responses/methods/create.md).
- `max_output_tokens` counts reasoning tokens too, so the seat budget must be larger than the
  Anthropic 1400. Default 4000.
- Text: join every `output[]` item of type `message` → `content[]` of type `output_text` → `.text`.
  Do not assume `output[0]` (same guide).
- Usage: `usage.input_tokens`, `usage.input_tokens_details.cached_tokens`, `usage.output_tokens`.
- Truncation: `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"`
  (verify live).
- Caching is automatic for prompts of 1,024 tokens or more
  (https://developers.openai.com/api/docs/guides/prompt-caching.md). Keep the system text first and
  byte-identical across rounds so rounds 2 and 3 hit the cache.
- 429 and 503: honour `Retry-After` when present, else exponential backoff with jitter. Do not retry
  quota or credit errors such as `insufficient_quota`
  (https://developers.openai.com/api/docs/guides/rate-limits.md,
  https://developers.openai.com/api/docs/guides/error-codes.md).
- Models (https://developers.openai.com/api/docs/models.md): `gpt-6-astra`, `gpt-6.1-sol`,
  `gpt-6.1-terra`, `gpt-6-luna`. Default `gpt-6.1-sol`, the same model the Codex CLI uses here.

Google Gemini, `generateContent` (still fully supported; Google recommends the newer Interactions
API for new work, but its field names are less settled, so v1 uses `generateContent`:
https://ai.google.dev/gemini-api/docs/migrate-to-interactions):
- `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, header
  `x-goog-api-key: <GEMINI_API_KEY>` (https://ai.google.dev/gemini-api/docs/generate-content/text-generation).
- Body: `{ systemInstruction: { parts: [{ text }] }, contents: [{ role: "user", parts: [{ text }] }],
  generationConfig: { maxOutputTokens } }` (https://ai.google.dev/api/generate-content).
  Default budget 4000.
- Text: join `candidates[0].content.parts[].text`, skipping parts flagged as thoughts (verify live).
- Truncation: `candidates[0].finishReason === "MAX_TOKENS"` (verify live).
- Usage: `usageMetadata.promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`,
  `thoughtsTokenCount`.
- Implicit caching is on by default; the minimum is 4,096 tokens for `gemini-3.8-flash`
  (https://ai.google.dev/gemini-api/docs/caching.md).
- 429 `RESOURCE_EXHAUSTED`: backoff. No documented retry header.
- Models (https://ai.google.dev/gemini-api/docs/models): `gemini-4-argon`, `gemini-3.8-flash`,
  `gemini-3.6-flash`, `gemini-3.5-flash-lite`. Default `gemini-3.8-flash`. `gemini-3.8-flash-high` is
  an Antigravity name, not an API id: "High" is a thinking level. v1 leaves the API thinking level at
  its default.

Rough cost per seat for a full council (estimate, not measured): about 25K tokens of system text
plus 3K to 10K of session files per round, and up to 4K out. On `gpt-6.1-sol` ($2 in, $10 out, $0.10
cached per 1M: https://developers.openai.com/api/docs/pricing.md) that is about $0.15 to $0.25. On
`gemini-3.8-flash` ($0.75 in, $3.75 out per 1M until 2026-12-31:
https://ai.google.dev/gemini-api/docs/pricing.md) about $0.08 to $0.12.

## 12. Configuration (`.env`)

`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_SEAT_MODEL`, `GEMINI_SEAT_MODEL`, `DELEGATE_PY` (absolute
path to `delegate.py`), `DELEGATE_PYTHON` (interpreter, default `python3`), `HUMAN_DEADLINE_MIN`
(default 30). `.env.example` documents each.

## 13. Tests (`npm test`, `node:test`, zero dependencies)

- Roster loading: human seat kept; AI seat with null `slug` kept; unknown provider dropped.
- Providers: request bodies match §11 (fetch mocked); usage and stop-reason mapping; 429 retry.
- Server: `POST /api/answer` rejects bad Origin, bad Host, wrong content type, oversize body, unknown
  session, path-like ids; accepts a valid answer; second answer gets 409.
- Watcher: `waiting` event; no `stopped` while pending; `inbox/` ignored for cards.
- `parseCard`: bold and heading-wrapped fields parse.
- `run_seat.mjs --dry-run`: the transport matrix (key set; no key with `DELEGATE_PY`; neither).
- A grep test that `child_process` does not appear under `app/`.
- `npm run smoke` keeps working.

## 14. Acceptance

1. `npm test` passes.
2. A Claude Code council with four Claude seats (one pinned to a different Claude model), one OpenAI
   seat, one Google seat and one human runs to a verdict. The room shows the badges. The human answers
   every round in the form.
3. With no `OPENAI_API_KEY`, the OpenAI seat runs through the codex CLI. With no `DELEGATE_PY` either,
   the Chair reports it before Round 1 and offers to switch the seat.
4. The API runner with a mixed board and keys set runs to a verdict. With a key missing, it refuses
   before any call.

## 15. Eval plan and cost

- Format compliance per provider: share of cards complete on the first try.
- Independence: three briefs, all-Claude board against a mixed board; compare spread and how often
  the recommendation changes.
- Round time: the slowest seat sets it; log per-seat latency.
- Cost per council: Claude tokens plus per-provider usage (HTTP) or `delegate.py stats` (CLI).
- Persona fidelity on other models is untested. A blind judge guessing the seat from an unnamed card
  is the check.

## 16. Decisions settled after the builder review

These are the author's calls. Where they differ from an earlier section, they win.

1. **Independence on a shared screen.** While a human request is pending for round N, the room
   shows other seats' round-N cards as sealed ("answered", no text). They open when the round closes.
   This is done in the client from the `waiting` and `round_done` events, so the watcher and API runner
   keep emitting cards as today. A person who wants to cheat can; the room just doesn't show them.
2. **What the Chair may choose on its own.** It never seats a human unless the user names them or
   they are on the default board. It never changes a seat's provider on its own. When an OpenAI or
   Google key or `DELEGATE_PY` exists, the board question may offer a mixed board as one option.
   All-Anthropic stays the first option.
3. **API runner board and privacy.** The Chair's setup call (Anthropic) picks the board first. In
   pick mode it chooses only seats whose provider can run (key present) and never human seats. Human
   seats sit in the API runner only from the default board. After setup and before Round 1 the
   runner pauses. The room lists who will receive the brief and needs a confirm click. A missing key is
   reported at that pause, before any seat call.
4. **Model names.** `roster.json` `model` holds the provider's API id (`claude-sonnet-5-5`,
   `gpt-6.1-sol`, `gemini-3.8-flash`). For Claude subagents, the skill maps the id to the Agent tool
   alias (`opus`, `sonnet`, `haiku`, `fable`) by name. If no alias matches it uses the default and
   adds a Chair note. The CLI fallback never receives the API id. It gets `--model` only from an
   optional `cli_model` on the seat. Otherwise it uses the `delegate.py` default.
5. **Absent seats, both paths.** The API runner uses `Promise.allSettled`. A failed or timed-out
   seat emits `seat_absent {round, seat, reason}`. Absent seats are excluded from option scores, the
   vote tally and the confidence average. This replaces today's "missing Round 3 vote counts as
   endorse" (`council.mjs:425`, `app.js:587`). A round with fewer than 3 cards stops the council and
   asks the user whether to continue.
6. **Disclaimer.** The text becomes per seat: "Real person, answered live" for humans, and
   "Simulated from <name>'s public work, run on <provider>" for AI seats. The verdict, PDF and report
   footers name any human seats. The project `CLAUDE.md` rule about not presenting a seat's words as
   the real person's gains an exception for human seats.
7. **`/roast-room ask <seat>`.** AI seats honour their provider through `run_seat.mjs --consult`,
   which takes no round. The one-time privacy confirmation applies. Human seats are refused with one
   line: ask the person directly.
8. **API-runner human requests** are kept in memory, keyed by the API session id. `/api/inbox` and
   `/api/answer` accept either an API session id or a skill session folder name. Only skill sessions
   use the on-disk `inbox/`.

## 17. Left to the builder

- Internal structure of the provider modules and file names under `app/lib/providers/`.
- Form styling and layout, within the existing room look.
- Backoff numbers (reuse the Anthropic client's policy).
- Default model ids, picked from the docs in §11 and kept configurable.

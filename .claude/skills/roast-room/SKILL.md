---
name: roast-room
description: Use when a founder wants a hard business decision debated by a council of world-class operators, says "roast room", "put this in the Roast Room", "founder council", "convene the council", "take this to the board", "what would Hormozi, Bezos, or Buffett say", "should I do X", or can't make up their mind on pricing, hiring, raising money, a new product, a partnership, a pivot, an event, or spending. A board of seats, each built from one expert's public work (Bezos, Paul Graham, Hormozi, Gary Vaynerchuk, Dan Martell, Gino Wickman, and Buffett out of the box, plus any seat added with /newroaster), argue it over three rounds, then a Chair returns a scored verdict, the reasoning, the dissent, and next steps. A seat runs as a Claude sub-agent by default; it can also run on OpenAI or Google, and a real person on this Mac can take a seat. Also does a one-seat consult ("ask the Hormozi seat"). Not /roast (generic personas, idea validation).
argument-hint: "[the decision] [--quick] [--all] [--seats hormozi,buffett,...] | ask <seat> [question] | board"
---

## What this does

The Roast Room: runs a board meeting on one decision. A board of seats (seven out of the box), one per business pillar, each by default a Claude sub-agent that reasons and talks the way its expert does, grounded in a brain compiled from that person's videos, essays, letters, talks, and books as they teach them in public. The seats argue across three rounds: open, debate, vote. You act as the **Chair**: you never argue a side, you run the room, keep the score, and write the verdict.

**Mixed panel.** Every seat has a `provider` in `roster.json`:

- `anthropic` (the default when `provider` is missing): a Claude sub-agent.
- `openai` or `google`: the same agent file and brain, run on another model. Seven seats on one model share one set of blind spots; a seat on another model disagrees more independently.
- `human`: a real person on this Mac who answers a form in the room. A person has no agent file and no brain.

A seat may also carry a `model` (the provider's API id, such as `claude-sonnet-5-5`, `gpt-6.1-sol` or `gemini-3.8-flash`) and a `cli_model` (the name the Codex or agy command-line tool takes). The card format is the same for every provider, so scoring and the room do not change.

Read once before the first run: `roster.json` (every seat and the default board), `references/seats.md` (picking the board, weights, tensions), `references/round-prompts.md` (what each seat gets), `references/scoring.md` (math and overrides), `references/report-template.md` (output), `references/live-room.md` (the small JSON files the visual room plays, and the `inbox/` files people answer through). A finished example council lives in `sessions/2026-10-09-example-take-the-seed/`.

## Modes

- **Full council** (default): a board recommended for this decision and confirmed by the user (see "Pick the board"), three rounds. For decisions that are expensive or hard to undo.
- **Quick** (`--quick`): four seats, recommended per "Pick the board" and `seats.md`, Rounds 1 and 2, Round 3 only if the scores did not converge. For reversible calls.
- **Named seats** (`--seats a,b,c`): only those seats, three rounds. Any seat in `roster.json` can be named, on the default board or not.
- **Everyone** (`--all`): every AI seat in `roster.json`, plus any person on the default board, up to nine.
- **Consult** (`ask <seat> ...`): one seat, one answer, using the single-seat prompt. No scoring, no session folder needed. Works for any AI seat in the roster, on its own provider (see "Consult"). A person cannot be consulted this way.
- **Board settings** (`board`): show and change who sits at the table by default, which provider a seat runs on, and which people are on the roster. See "Board settings" below. No council runs.

## Pick the board

Who sits at the table comes from `roster.json`, in this order:

1. `--seats a,b,c` or `--all` on this run wins. No question. `--quick` then picks four from those seats.
2. Otherwise `"board"` in `roster.json` decides:
   - `"ask"` (out of the box): recommend a board for this decision and ask the user to confirm it (below).
   - `"auto"`: recommend a board the same way and seat it without asking. Say who and why in one line.
   - `"default"`: seat the `"default"` list. No question.
3. Never seat more than nine. Every AI seat at the table must have an agent file (`.claude/agents/council-<key>.md`), and a seat with a `slug` must have its brain folder; skip and name any that do not. A seat with no `slug` has no brain and cites nothing. A person (`human`) needs neither.

### Recommend a board

Read the decision, then pick from every AI seat in `roster.json`, and from any person on the default board:

- Every seat whose pillar the decision lives in or materially affects (the seats that would get weight 2 or 3).
- One seat that guards the downside (Buffett, or the roster's money, capital, or risk seat), whether or not it is on the default board.
- The seat most likely to disagree with the rest, so the council argues instead of agreeing.
- Leave out seats whose pillar barely touches the decision. Two seats with close pillars (Martell and Leila Hormozi on people, Hormozi and Codie Sanchez on deals) sit together only when they would disagree.
- Five to seven seats for a full council, four for `--quick`.

### Who runs each seat

Before you show a recommendation, check that every seat on it can run:

```bash
node .claude/skills/roast-room/scripts/run_seat.mjs --plan --seats <keys> [--session <dir>]
```

It makes no network call. It prints JSON with four parts:

- `runners`: for each seat that can run, `{ provider, model, transport }`, plus `agentModel` for a Claude seat. `model` is null for a person and for a Claude seat with no pinned model. `agentModel` is the Agent tool alias (`opus`, `sonnet`, `haiku`, `fable`), or null. `transport` is `subagent` (a Claude sub-agent), `http` (the provider's API), `cli` (the Codex or agy tool through `delegate.py`, used only when the provider has no API key and `DELEGATE_PY` is set) or `form` (a person).
- `cannotRun`: `[{ seat, reason }]` for each seat that cannot run, for example "no OPENAI_API_KEY and no DELEGATE_PY". The reason `no such seat` means the key is not in the roster, or the seat has no agent file or an unknown provider: leave it off the board.
- `recipients`: who besides Anthropic would receive the brief, in words. Empty when every seat runs on Claude.
- `keys`: `{ openai, google, delegate }`, each true or false: whether an OpenAI key, a Google key and a usable `DELEGATE_PY` exist. It holds no value, and it is reported whatever the board is.

Show the provider and model for each seat that is not an unpinned Claude seat, for example "Buffett (OpenAI, gpt-6.1-sol)", "Graham (Claude, opus)" or "Priya (a person)". Name any seat in `cannotRun` and why.

If `node` is missing or the plan fails, and every seat on the board is a Claude seat in `roster.json` (no `provider`, or `anthropic`), go on as before: no plan, no `runners` in `council.json`, no privacy step, and each seat is a Claude sub-agent. If a seat is on OpenAI or Google or is a person, say that it needs Node 20 or newer, and offer to seat it on Claude or leave it off.

- Never seat a person unless the user names them or they are on the default board. This holds for `--all` and Everyone too.
- Never change a seat's provider on your own. The roster decides it. The user changes it with "Mixed board" below or with `/roast-room board`.

### Ask

Show the recommendation in chat first, as a short list: each recommended seat with one plain line on why it fits this decision, then one line naming the seats left out. Then ask with one AskUserQuestion question (header "Board"):

1. **Recommended board (Recommended)**: the names, in the description.
2. **Default board**: the `"default"` list, by name.
3. **Everyone**: every AI seat in the roster, plus any person on the default board (only when there are nine or fewer; otherwise skip this option).
4. **Mixed board**: the recommended seats, with some moved to OpenAI or Google for this council only. Name each move in the description ("Buffett on OpenAI, Naval on Google"). Offer it only when the plan's `keys` show that OpenAI or Google can run: `keys.openai`, `keys.google` or `keys.delegate` is true. Move a seat only to a provider that can run: `keys.openai` for OpenAI, `keys.google` for Google, or `keys.delegate` for either.

"Recommended board" stays first. The user can pick "Other" and type names to swap in or out ("recommended, but add Naval and drop Wickman"). Seat what they chose. When Step 1 also needs to ask about missing facts, put the board question in the same AskUserQuestion call so the user answers once. If the user said "just run it", seat the recommended board without asking.

Tell the user who is at the table in one line when the council starts, which seats do not run on Claude, and that `--seats`, `--all`, or `/roast-room board` change it.

## Step 1: The brief

The council is only as good as the brief. Build it from what the user gave you. If any of the first four items is missing, ask for them in one batch (AskUserQuestion, at most four questions), then proceed. If the user says "just run it", fill gaps with stated assumptions.

1. **The decision** in one line, and the options on the table as A, B, C. Always include "don't do it" (or "keep doing what you do now") and any alternative the founder mentioned. If the founder brought one idea, add the obvious smaller version as an option.
2. **The business**: what it sells, to whom, stage, monthly revenue, margin if known, team size.
3. **The resources**: cash or runway, founder hours, deadline.
4. **What success looks like** and the time horizon.
5. **Which way the founder is leaning, and why** (the council tests the lean, it does not echo it).

Context lookup: if this project holds notes about the founder's business (a `CLAUDE.md`, a `business.md`, or similar), read them for real numbers before asking.

Keep the brief under 300 words. Mark every assumption as `(assumed)`.

## Step 2: Set up the room

The room builds its table from the first `council.json` it reads, and a later change to `seats` does not show there (a change to `runners` does). So settle the seats, who runs them and the privacy answer first, and write the session files last.

### 2a. Seat the board and fix who runs each seat

- Seat the board (see "Pick the board"). Set a relevance weight per seat at the table (1 to 3) with a one-line reason, per `seats.md`.
- Run `node .claude/skills/roast-room/scripts/run_seat.mjs --plan --seats <keys>`. For a Mixed board, or for a seat you switch to `anthropic` below, make one temporary folder outside the repo (`mktemp -d`) and write `{ "runners": { "<key>": { "provider": "openai" } } }` to `council.json` in it. The plan reads the choice from there, and the room does not see it. From then on, pass `--session <that folder>` on every plan. The plan picks the model and works out the transport. This changes this council only; never edit `roster.json` here.
- If `cannotRun` is not empty, say which seats cannot run and why, in plain words. Offer to switch those seats to `anthropic` for this council (AskUserQuestion). If the user agrees, add `"<key>": { "provider": "anthropic" }` to the temporary file and run the plan again. If the user declines, leave those seats off the board and out of the weights.

### 2b. Privacy check

Look at `recipients` in the latest plan. If it is empty, every seat runs on Claude and nothing leaves Anthropic: skip this step.

Otherwise ask once per council, even if the user said "just run it". One AskUserQuestion question (header "Privacy"): "These will receive the brief and later round files: <recipients>." Use the `recipients` text exactly as the plan gives it, for example "OpenAI (Buffett, via API), Google (Naval, via agy CLI), and Priya on this screen". When `keys.delegate` is true, an API seat can fall back to its CLI, so add "(and its CLI if the API fails)" to the end of the line. Two options:

1. **Send**: go on as planned. Do not ask again in later rounds. A fall-back to the CLI sends the same files to the same company, so it needs no new question.
2. **Use Claude for those seats**: add `"<key>": { "provider": "anthropic" }` to `council.json` in the temporary folder (make the folder now if you have not) for each OpenAI or Google seat, run the plan again with `--session <that folder>`, and go on. A person cannot run on Claude (no agent file, no brain), so take a person off the board. Drop the person from `<keys>` and the weights, and run the plan again.

An API call sends only the assembled prompt: the seat's agent file and brain, the round prompt, and the session files that round allows. A CLI call runs with `--isolated`, which means no access to the repo. Never put a key in a session file.

### 2c. Write the session files

- Create the session folder: `sessions/YYYY-MM-DD-<decision-slug>/` at the project root. The slug: lowercase letters, digits and hyphens, at most 60 characters. Save `brief.md` (the brief, the options, and the weights table) and `council.json` (`live-room.md`).
- Put the last plan's `runners` object into `council.json` as `runners`, unchanged. It is what the room shows, and what `run_seat.mjs` reads for this council.
- Only if `recipients` was not empty or you made a temporary folder: check once before Round 1. Run the plan with `--session sessions/<id>`. Its `recipients` must be empty or the same text the user confirmed (the plan's text, without the CLI words added in 2b). If not, fix `runners` and ask the privacy question again. Then delete the temporary folder.
- Tell the user once: "Watch it live at http://localhost:4730" (the Roast Room plays the council as these files land; it is optional and the council runs the same without it). With a person on the panel the room is required: they answer there. If it is not running, start it (`npm start` in the background) and tell the user "<Name> answers at http://localhost:4730".

## Dispatch a round (Steps 3, 4 and 6)

Send every seat in **one message**, so they all work in parallel. Each seat goes by its entry in `runners` in `council.json`. With no `runners` (the Node fall-back in "Who runs each seat"), every seat is a Claude sub-agent with `model` left out.

**`anthropic` (a Claude sub-agent).** An Agent call, foreground (`run_in_background: false`), `subagent_type: council-<seat>`, with the round prompt. If a `council-*` type is not registered in this session, use `general-purpose` with the fallback lines from `round-prompts.md`. Set the call's `model` to the seat's `agentModel` in `runners`. When `agentModel` is null, leave `model` out, so the seat runs on this session's model as before. Only when `model` names a Claude model and `agentModel` is still null, add a line to the Chair notes that the seat ran on the session model.

**`openai`, `google`.** Write the round prompt (see `round-prompts.md`) to `sessions/<id>/prompts/<key>-r<N>.md`, then start a background Bash call (`run_in_background: true`):

```bash
node .claude/skills/roast-room/scripts/run_seat.mjs --session sessions/<id> --seat <key> --round <N> --prompt-file sessions/<id>/prompts/<key>-r<N>.md
```

Always run it in the background. In the worst case a run takes about 20 minutes (the CLI and its one retry), or 15 (a slow API call, then the CLI once), which is longer than a foreground Bash call lasts. The script attaches the brief, the earlier rounds that seat may see, and its brain; the prompt file holds only the round prompt. Whenever it runs the CLI, first or as a fall-back, it removes every environment variable that looks like a secret (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*CREDENTIALS`) before it starts `codex` or `agy`. Those tools must be logged in through their own login, not through a variable such as `GOOGLE_APPLICATION_CREDENTIALS`. If a CLI seat keeps failing, tell the user this.

- Exit 0: the card is on stdout. The last stderr line is `RUN_SEAT {"seat","provider","model","transport","partial","missing","ms","usage"}`.
- Exit 2: the seat cannot run, or an argument is wrong. The reason is on stderr. If `delegate.py` refused the task as a possible secret, this is the exit you get: show the user the reason. Never run `delegate.py` with `--allow-secrets`.
- Exit 3: the provider failed. The script has already retried and fallen back as far as it can, so do not run it again.
- On exit 2 or 3 the seat is absent for the round (see "Absent seats").

**`human` (a person).** Write the prompt the person sees to `sessions/<id>/prompts/people-r<N>.md`: the round title and the task in a line or two, with no card template, because the form has the fields. The form shows the session files that round allows, so make sure they exist first (`brief.md`; for Round 2 also `round-1.md` and `cruxes.json`; for Round 3 also `draft-resolution.md`). Then start one background call for all the people in the round. Start `wait_answers` before you save any card of that round, so the room can seal the other cards:

```bash
node .claude/skills/roast-room/scripts/wait_answers.mjs --session sessions/<id> --round <N> --seats <keys> --prompt-file sessions/<id>/prompts/people-r<N>.md
```

It writes `inbox/<key>-r<N>.request.json` for each person and waits. The room shows each person a "Your turn" form. Always pass the council's own session folder. The script exits 2 for a folder that is not directly under `sessions/` or whose name is not a valid session id, because the room would never show the form.

- Exit 0: every person answered. One line each: `answered: <key> <absolute answer path>`.
- Exit 4: the deadline passed (30 minutes, or `HUMAN_DEADLINE_MIN`, or `--deadline-min`). It prints `missing: <keys>`, then an `answered:` line for each person who did answer. A missing person is absent for the round and may answer in later rounds.
- Exit 2: a usage problem, such as a seat that is not a person. The reason is on stderr.

**Wait, then collect.** Wait for every call to finish. Do not poll the background calls. Add each card to the round file under `## <short>`, exactly as it came: the Agent's reply, the stdout of a `run_seat.mjs` call, or the file named in an `answered:` line (`inbox/<key>-r<N>.answer.md`). Check each card first (below). Save it once it passes, or after its one send-back. The room reads each seat's card once and never re-reads a replaced card. Never edit a card, and never edit a person's answer. The server already changes any line in a person's text that looks like a card label or a heading, so a pasted answer cannot split a card. While a person is still answering, the room keeps the other seats' cards for that round sealed.

If a `RUN_SEAT` line's `transport` differs from the seat's `transport` under `runners` in `council.json`, set the seat's `transport` there to the `RUN_SEAT` value. The room re-reads the file and the seat's badge follows.

**Check each card.** For a Claude card, send it back once if it is missing scores or a stance. For a card from an OpenAI or Google seat, read the `RUN_SEAT` line:

- `missing` lists the required fields that could not be read. If it is not empty, send the card back once: append "Your card is missing <fields>. Reply again with the full card in the exact format." to that seat's prompt file (`<fields>` is the `missing` list) and run the script again, in the background as before. If the second card still has missing fields, save it as it is and add a line to `## Chair notes` that names the seat and the fields. Scoring skips what did not parse. If that run exits 2 or 3, save the first card as it is, with the same Chair note.
- `partial` is `true` when the reply hit the output limit, `false` when it did not, and `null` when the transport cannot say (the CLI). `null` means unknown, not complete. When it is `true`, add a line to the Chair notes.
- A person's form checks the required fields before it accepts an answer, so a person's card is never sent back.

## Absent seats

A seat with no usable card for a round is absent for that round: a `run_seat.mjs` call that exited 2 or 3, a person who missed the deadline, or a Claude call that returned no usable card. Then:

- Write no card for it in that round's file. Add a line to `## Chair notes` that names the seat and the reason ("Buffett: the OpenAI run failed, absent from Round 2").
- Leave it out of every sum: the option scores and the weights under them, the spread, the confidence average, and the vote count. A missing score is not a zero. A missing Round 3 vote is not an endorsement.
- Ask it again in the next round. A seat that was absent once may be back.
- If a round ends with fewer than 3 cards (fewer than every seat, on a board of fewer than 3), stop and ask the user (AskUserQuestion): continue with the seats that answered, or stop. If they stop, end the council there, write no verdict, and say which round files exist.

## Step 3: Round 1, opening positions

Dispatch every seat in one message with the Round 1 prompt (see "Dispatch a round").

When the cards come back, check each card has every field (see "Check each card"), and do its one send-back if it needs one. Then save the cards verbatim to `round-1.md`, one `## <Seat>` heading per card (the seat's `short` name from `roster.json`: Bezos, Graham, Hormozi, Gary V, and so on). Write the file as soon as the cards have passed, so the room can start playing. The room reads each seat's card once. Then add a `## Chair notes` section at the bottom of `round-1.md`:

- The **cruxes**: the one to three underlying disagreements that explain why seats split (a factual question, a numbers question, or a values question such as speed versus safety), with the seats on each side.
- The **unanimity check** (`scoring.md`): if Round 1 converged, make the strongest unargued alternative a crux and name which seats must argue it at full strength.
- Any card that broke format or misread the brief.
- Any absent seat, and any seat pinned to a Claude model that has no Agent alias.

Then write `cruxes.json` (`live-room.md`).

## Step 4: Round 2, debate

Dispatch every seat again, in one message, with the Round 2 prompt (it points them at `brief.md` and `round-1.md`). Check each card first (see "Check each card"). Save the cards to `round-2.md` (same `## <Seat>` headings, written as soon as the cards have passed) with `## Chair notes`: who moved and why, which cruxes resolved, which numbers are still open, any absent seat, and the interim option scores.

## Step 5: Draft resolution

Write `draft-resolution.md`: the recommendation (named option and verdict label), the conditions the seats asked for (merge duplicates, keep them checkable, pick one number when seats differ and say whose), the next steps with dates, the cheapest test, and kill criteria. Weigh arguments, not headcount: a single seat with a decisive fact beats three seats with vibes. Apply the overrides. Also write `draft.json` (`live-room.md`).

## Step 6: Round 3, ratification

Dispatch every seat in one message with the Round 3 prompt (see "Dispatch a round"). Check each card first (see "Check each card"). Save to `round-3.md` (same headings, written as soon as the cards have passed), and add a `## Chair` section listing each amendment and whether it was adopted, with the reason, and any absent seat. Adopt an amendment when no seat objects or the argument for it went unanswered; when seats conflict, adopt the better-argued side and put the other in the minority report. Do not run a fourth round.

Quick mode skips this round when the Round 2 spread on the top option is 3 or less and no seat is at `RUIN RISK: likely`.

## Step 7: Verify, then verdict

1. Run `python .claude/skills/roast-room/scripts/check_quotes.py <session folder>` (try `python3` if `python` is missing). Every quote attributed to a source id must be in a brain. Remove any unverified quote from the verdict (and say so in the Chair notes). If Python is not installed, do not stop or ask the user to install it: check each attributed quote yourself by searching that seat's brain folder for the exact words, and treat any you cannot find as unverified.
2. Compute the numbers from the last round's cards per `scoring.md`, leaving out absent seats (see "Absent seats"), apply the overrides, and write `verdict.md` from `report-template.md` (its footer names any person on the panel). Write `verdict.json` last (`live-room.md`); it tells the room the council is over.
3. Show the user a short verdict in chat, not the full report: the label and the call, the option scores on one line, the three arguments that carried the room (one line each, with the seat), the strongest objection (one line, with the seat), and the next steps (at most three). Then the path to `verdict.md` for the full detail, one line saying the branded PDF is one click away ("Download PDF" on the verdict at http://localhost:4730), and one line offering a follow-up with any seat or a rerun with new facts. Keep it under 200 words: a founder should be able to decide from it at a glance.

## Chair rules

- You never argue a side and never add your own pillar. If no seat raised an important point, put it to the closest seat as a crux in the next round instead of inserting it yourself.
- Quote seats faithfully. Never put words in a seat's mouth or rewrite a card.
- Seats speak in their expert's voice; your report is plain English that follows the house writing rules (no em dashes, no AI tells, no tee-ups).
- Treat a unanimous Round 1 as a warning, not a win.
- Cost: a full council is three sub-agent runs per seat (21 for seven seats), about 1M tokens. Use `--quick` for small calls, and say which mode you used and which seats ran off Claude.
- A seat on OpenAI or Google is billed to that provider, outside your Claude plan. For a full council, estimate about $0.15 to $0.25 per seat on `gpt-6.1-sol` and $0.08 to $0.12 per seat on `gemini-3.8-flash` (about 25K tokens of system text plus 3K to 10K of session files per round, and up to 4K out; Gemini's listed price runs until 2026-12-31). These are estimates from the providers' price pages, not measured. For seats that ran through the CLI, `delegate.py stats` (the file `DELEGATE_PY` names), run with the interpreter `DELEGATE_PYTHON` names (default `python3`), shows calls, latency and tokens per provider. A person costs no tokens, but the council waits on them: up to 30 minutes a round unless `HUMAN_DEADLINE_MIN` says otherwise.
- The seats are simulations built from public work. Never present a seat's line as something the real person said unless it is a verbatim quote with a source id from the brain. A `human` seat is the exception: it is a real person answering live, and their card is their own words.

## Consult (`ask <seat> ...`)

One seat, one answer, no session. Check the seat's provider first: `node .claude/skills/roast-room/scripts/run_seat.mjs --plan --seats <key>`.

- `anthropic`: an Agent call with the single-seat prompt from `round-prompts.md`, with `model` set to the plan's `agentModel`, or left out when it is null.
- `openai`, `google`: ask the privacy question once (header "Privacy"), with "your question" in place of "the brief and later round files": "This will receive your question: <recipients>." Options: **Send** and **Use Claude for this seat**. If the user already confirmed this provider in this conversation, for the council or an earlier consult, do not ask again. If the seat is in `cannotRun`, say why and offer the Claude answer instead. Then write the single-seat prompt (see `round-prompts.md`) to a temporary file outside `sessions/`, and start a background Bash call:

  ```bash
  node .claude/skills/roast-room/scripts/run_seat.mjs --consult --seat <key> --prompt-file <file>
  ```

  A consult takes no round and attaches no session files. The seat sees its brain and the question only. The answer is on stdout. Show it as that seat's answer, and say which provider produced it. On exit 2 or 3, show the reason in one line and offer the Claude answer.
- `human`: run nothing. Refuse in one line: "<Name> is a person on your board. Ask them directly." Use the seat's full `name` from `roster.json`.

## Board settings

`/roast-room board` (or "change my board", "who's on my board", "add Naval to my default board", "run Buffett on openai", "add a person") edits `roster.json` and runs no council.

1. Show the roster in a short table: seat, pillar, provider and model (a seat with no `provider` is Claude), on the default board or not. Then the current `"board"` setting in plain words ("the Chair recommends a board for each decision and asks you", "the Chair picks per decision without asking", or "every council seats your default board").
2. Ask what to change, with AskUserQuestion when the user has not already said: add or remove seats on the default board, switch the setting between `ask`, `auto`, and `default`, run a seat on another provider, or add a person.
3. Edit `roster.json` in place: the `"board"` and `"default"` fields, and the provider fields described below. Keep the default board between one and nine seats, using keys that exist in `"seats"`. Never remove a seat from `"seats"` here; taking someone off the default board keeps them available for `--seats` and `ask`.
   - **"run <seat> on <provider> [model]"** (provider `anthropic`, `openai` or `google`): set that seat's `provider`, and its `model` when the user gave one (the provider's API id, for example `gpt-6.1-sol`, `gemini-3.8-flash` or `claude-opus-5-5`). If the user also gave a CLI model, set `cli_model` (the name the Codex or agy tool takes; the API id is never passed to the CLI). A model id belongs to one provider: when the provider changes, remove the old `model` and `cli_model` unless the user gave new ones. With no `model`, a Claude seat runs on the Claude Code session's model, and an OpenAI or Google seat on that provider's default. Only an AI seat changes this way; a person stays a person.
   - **"add a person"**: ask for the full name, a short name, the pillar they own and the question they own (AskUserQuestion), and whether they join the default board. Then run:

     ```bash
     node .claude/skills/newroaster/scripts/add_seat.mjs --human --key <key> --name "<Full Name>" --short "<Short>" --pillar "<pillar>" --question "<question>" [--default] [--swap <key>]
     ```

     A person has no agent file and no brain; initials and colour are chosen for you. Put a person on the default board only if the user wants to answer at every council.
4. Confirm the new board in one line. The room picks it up on its next page load. If the board now holds a seat on OpenAI or Google, or a person, say that the privacy question will appear at each council.

To add a brand new advisor, use `/newroaster`.

## Without sub-agents (Codex or a runtime that cannot spawn agents)

Run the same protocol sequentially yourself. For each seat, read `.claude/agents/council-<seat>.md` and its brain, write that seat's card, then clear your head before the next seat: do not let one seat's card shape the next one's in Round 1. Rounds 2 and 3 work the same way with the prior cards in view. A seat on OpenAI or Google still runs through `run_seat.mjs`, and a person through `wait_answers.mjs` (see "Dispatch a round"); only the Claude seats are written by you.

## Files

- `brains/<slug>/`: one brain per seat (`_hot.md`, `frameworks.md`, `principles.md`, `positions.md`, `voice.md`, `stories.md`, `books.md`, `sources.md`).
- `scripts/check_quotes.py`: verifies every attributed quote in a session against the brains.
- `scripts/run_seat.mjs`: plans who can run (`--plan`), and gets a card from an OpenAI or Google seat (API, or the Codex or agy CLI through `delegate.py`).
- `scripts/wait_answers.mjs`: writes the inbox requests for people and waits for their answers.
- `roster.json`: every seat (key, name, pillar, the question it owns, scorecard dimension, color, and optionally `provider`, `model` and `cli_model`) and the default board. `/newroaster` adds seats; `/roast-room board` changes the board.
- `sessions/<id>/prompts/`: the prompt files for seats that do not run as Claude sub-agents, and for people. `sessions/<id>/inbox/`: the requests and answers of people.
- Agents: `.claude/agents/council-<key>.md`, one per seat in the roster.
- The room app: `app/` (start at the project `README.md`).

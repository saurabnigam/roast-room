# Live room files

The Roast Room (a local web app on http://localhost:4730) watches the sessions folder and plays a council as its files appear: portraits talk one at a time, rebuttal arrows fly, votes land, and the verdict comes up. It reads the round files you already write, plus four small JSON files. Write each one at the moment listed, as plain JSON (no comments, no trailing commas). Seat names can be keys (`garyvee`) or display names (`Gary V`). When a person sits on the panel, the room also reads an `inbox/` folder (see "inbox/" below).

The room is optional, unless a person sits on the panel: they answer in it. Write these files anyway; they cost a few lines and the council runs the same without the room.

## Order

| When | File |
|---|---|
| Step 2, with `brief.md` | `council.json`, with `runners` from `run_seat.mjs --plan` |
| Each round with a person on the panel, before you wait | `inbox/<key>-r<N>.request.json` (`wait_answers.mjs` writes it) |
| A person submits the form | `inbox/<key>-r<N>.answer.md` (the room's server writes it) |
| A seat falls back from the API to the CLI | `council.json`: change that seat's `transport` under `runners` |
| Round 1 cards back | `round-1.md` (one `## <Seat>` heading per card, cards verbatim, `## Chair notes` last) |
| After the Round 1 Chair notes | `cruxes.json` |
| Round 2 cards back | `round-2.md` |
| With `draft-resolution.md` | `draft.json` (skip in quick mode when Round 3 is skipped) |
| Round 3 cards back | `round-3.md` |
| Last, after `verdict.md` | `verdict.json` |

## council.json

```json
{
  "title": "Raise coaching price to $3,500",
  "decision": "Raise the price from $2,000 to $3,500, and for whom.",
  "mode": "full",
  "options": [
    { "id": "A", "label": "Raise to $3,500 for everyone now" },
    { "id": "B", "label": "Raise for new clients only" },
    { "id": "C", "label": "Keep $2,000" }
  ],
  "weights": {
    "hormozi": { "weight": 3, "reason": "Pricing is his pillar" },
    "buffett": { "weight": 2, "reason": "Cash risk of losing clients" }
  },
  "seats": ["bezos", "graham", "hormozi", "garyvee", "martell", "wickman", "buffett"],
  "runners": {
    "bezos": { "provider": "anthropic", "model": null, "agentModel": null, "transport": "subagent" },
    "graham": { "provider": "anthropic", "model": "claude-opus-5-5", "agentModel": "opus", "transport": "subagent" },
    "buffett": { "provider": "openai", "model": "gpt-6.1-sol", "transport": "http" }
  },
  "brief": "Two or three sentences.",
  "assumptions": ["Close rate holds at 50% (assumed)"]
}
```

`mode` is `full` or `quick`. `seats` lists only the seats at the table. Give every seat at the table a weight (1 to 3). Option labels stay short: under 50 characters.

`runners` says how each seat actually runs in this council. The Chair copies it from the `runners` object that `run_seat.mjs --plan` prints, in Step 2, and the room shows a badge from it ("Claude Sonnet", "GPT via API", "Gemini via agy", "Human"). Keys are seat keys, with one entry for each seat at the table (the example shows three of the seven). Each entry has:

- `provider`: `anthropic`, `openai`, `google` or `human`.
- `model`: the provider's API id (`claude-opus-5-5`, `gpt-6.1-sol`, `gemini-3.8-flash`), or `null` for a person and for a Claude seat with no pinned model.
- `agentModel` (Claude seats only): the Agent tool alias (`opus`, `sonnet`, `haiku` or `fable`), or `null`. The room does not read it.
- `transport`: `subagent` (a Claude sub-agent), `http` (the provider's API), `cli` (the Codex or agy tool) or `form` (a person).

A seat left out of `runners` runs as its roster entry says. The room builds its table from `seats` the first time it reads the file, so `seats` must be final then. `runners` is different: the room reads `council.json` again when it changes, so when a seat falls back from the API to the CLI, change that seat's `transport` to `cli` and its badge follows.

## cruxes.json

```json
{
  "cruxes": [
    {
      "question": "Is customer cash enough to fund the next two hires?",
      "sides": [
        { "position": "Yes, prepay covers it", "seats": ["Hormozi", "Martell"] },
        { "position": "No, prepay is pulled-forward revenue", "seats": ["Graham", "Bezos"] }
      ]
    }
  ],
  "unanimous": false,
  "note": "One plain sentence on what the room is fighting about."
}
```

One to three cruxes. Questions under 90 characters, positions under 50.

## draft.json

```json
{
  "option": "B",
  "label": "GO WITH CONDITIONS",
  "recommendation": "One or two sentences.",
  "conditions": ["Checkable condition"],
  "next_steps": ["Step with a date"],
  "cheapest_test": "One line.",
  "kill_criteria": "One line."
}
```

## verdict.json

```json
{
  "label": "GO WITH CONDITIONS",
  "call": "One or two sentences the founder can act on, naming the option.",
  "recommended": "B",
  "why": [
    { "point": "One line.", "seat": "Graham", "framework": "Startup = Growth" }
  ],
  "minority": { "seat": "Martell", "quote": "The seat's own words, copied from a card.", "would_have_to_be_true": "One line." },
  "next_steps": [ { "when": "This week", "action": "One line." } ],
  "kill_criteria": "One line.",
  "conditions": ["Checkable condition"],
  "fights": [ { "crux": "The question", "story": "Who was on each side, who moved, how it resolved." } ],
  "amendments": [ { "seat": "Buffett", "amendment": "One line.", "adopted": true, "reason": "One line." } ],
  "cheapest_test": "One line.",
  "revisit": "When and with what numbers.",
  "override_note": ""
}
```

`label` is one of GO, GO WITH CONDITIONS, RESHAPE, WAIT, DON'T DO IT. Put the three strongest arguments first in `why` and at most three `next_steps`; the room shows those up front and folds the rest under "Full detail". The room computes the option scores, confidence, and votes itself from the cards, so they are not in this file.

## inbox/ (people on the panel)

Used only when a seat is a person (`provider: "human"`). The files sit in `sessions/<id>/inbox/`. Each person has two files for each round, named `<key>-r<N>`:

| File | Who writes it | When |
|---|---|---|
| `<key>-r<N>.request.json` | `wait_answers.mjs`, which the Chair runs | At the start of that round's wait. A request that already exists is kept as it is, deadline included, so running the script again does not extend the wait. |
| `<key>-r<N>.answer.md` | The room's server | When the person submits a valid form. |

The room shows a "Your turn" form for each request that is `pending` and before its deadline. While a person is answering, the room keeps the other seats' cards for that round sealed, until the round closes. The round files still hold every card, the person's included. If the room is closed while a request is pending, the request file stays and the form comes back when the room reopens.

The request:

```json
{
  "seat": "priya",
  "round": 1,
  "prompt": "The text shown above the form.",
  "fields": {
    "required": ["STANCE", "OPTION SCORES", "THE CALL", "CONFIDENCE", "RUIN RISK", "DOOR"],
    "optional": ["PILLAR SCORE", "WHY", "THE RISK I SEE", "WHAT WOULD CHANGE MY MIND", "WHAT I'D DO THIS WEEK", "QUESTION FOR THE FOUNDER"]
  },
  "context": ["brief.md"],
  "options": [{ "id": "A", "label": "Raise to $3,500 for everyone now" }],
  "deadline": "2026-10-29T10:30:00.000Z",
  "status": "pending"
}
```

- `prompt`: the text of the Chair's `--prompt-file`.
- `fields`: the card fields for that round. The form needs every required field and checks them: scores are whole numbers from 0 to 10, confidence is 1 to 5.
- `context`: the session files the form shows. Round 1: `brief.md`. Round 2: `brief.md`, `round-1.md`, `cruxes.json`. Round 3: `brief.md`, the person's own Round 2 card (`round-2.md#own`), `draft-resolution.md`. Write them before the wait starts.
- `options`: copied from `council.json`.
- `deadline`: when the request closes, as an ISO time. It is 30 minutes after the request is written, or `HUMAN_DEADLINE_MIN` minutes.
- `status`: `pending`. When the server saves the answer it sets `answered` and adds `answeredAt`. It writes the answer file first, so a request that says `answered` always has its answer.

The answer file is the card in the exact card format, starting `SEAT: <SHORT>`, with no `##` heading. The Chair adds the `## <short>` heading when it pastes the card into the round file, and pastes the text exactly as it is. The server has already changed any line of the person's text that looks like a card label or a heading, so a pasted answer cannot split the card.

A person who misses the deadline is absent for that round, and the form closes. They can answer in later rounds, because each round has its own request. Pass the council's own session folder to `wait_answers.mjs`: the room shows forms only for sessions under `sessions/`.

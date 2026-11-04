// Labels, disclaimers and answer-form field lists shared by the room (browser) and the server.
// The browser loads this file as /runners.js and the server loads the same file, so it takes no
// imports and uses no Node or browser APIs. Pure functions and constants only.
//
// A runner says how one seat runs:
//   { provider: "anthropic"|"openai"|"google"|"human", model: string|null,
//     transport: "subagent"|"http"|"cli"|"form" }
// A missing runner or provider means anthropic, as it does in the roster.

export const PROVIDERS = ["anthropic", "openai", "google", "human"];

const PROVIDER_NAME = new Map([["anthropic", "Claude"], ["openai", "GPT"], ["google", "Gemini"], ["human", "Human"]]);
const COMPANY_NAME = new Map([["anthropic", "Anthropic"], ["openai", "OpenAI"], ["google", "Google"], ["human", ""]]);
// The command-line tool behind the "cli" transport for each provider.
const CLI_TOOL = new Map([["openai", "Codex"], ["google", "agy"]]);

const providerOf = (x) => x?.provider ?? "anthropic";
const joinList = (xs) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`);

/** The first of opus, sonnet, haiku or fable found in a model id, else null. */
export function agentAlias(modelId) {
  return String(modelId ?? "").toLowerCase().match(/opus|sonnet|haiku|fable/)?.[0] ?? null;
}

/** "Claude", "GPT", "Gemini" or "Human". A provider this file does not know is returned as
 * written, so it never passes for Claude. */
export function providerName(p) {
  const key = p ?? "anthropic";
  return PROVIDER_NAME.get(key) ?? String(key);
}

/** "Anthropic", "OpenAI" or "Google". Empty for a person and for a provider this file does not know. */
export function companyName(p) {
  return COMPANY_NAME.get(p ?? "anthropic") ?? "";
}

/** The short label on a seat's nameplate: "Claude Sonnet", "GPT via API", "Gemini via agy", "Human". */
export function badgeFor(runner) {
  const p = providerOf(runner);
  if (p === "anthropic") {
    const alias = agentAlias(runner?.model);
    return alias ? `Claude ${alias[0].toUpperCase()}${alias.slice(1)}` : "Claude";
  }
  const name = providerName(p);
  if (!CLI_TOOL.has(p)) return name;
  if (runner.transport === "http") return `${name} via API`;
  if (runner.transport === "cli") return `${name} via ${CLI_TOOL.get(p)}`;
  return name;
}

export const DISCLAIMER = "Simulated advisors built from each person's public work. They are not the people and do not speak for them.";

// A seat is a person when its runner says so, or when its own roster entry does.
const isHuman = (seat, runner) => runner?.provider === "human" || seat?.provider === "human";

/** One line about one seat: a real person, or a simulation and the model family running it. */
export function seatDisclaimer(seat, runner) {
  if (isHuman(seat, runner)) return "Real person, answered live.";
  const who = seat?.name || seat?.short || seat?.key || "this person";
  return `Simulated from ${who}'s public work, run on ${providerName(runner?.provider ?? seat?.provider)}.`;
}

/** The council-wide disclaimer. It names every real person at the table. */
export function councilDisclaimer(seats, runners) {
  const people = (seats || []).filter((s) => isHuman(s, runners?.[s.key])).map((s) => s.name || s.short || s.key);
  return people.length ? `${DISCLAIMER} Real people on this panel, answering live: ${joinList(people)}.` : DISCLAIMER;
}

const RECIPIENT_ORDER = ["openai", "google", "human"];
const transportWords = (provider, transport) => {
  if (transport === "http") return "via API";
  if (transport === "cli") return CLI_TOOL.has(provider) ? `via ${CLI_TOOL.get(provider)} CLI` : "via CLI";
  return "";
};

// When a seat has no runner yet, its own roster provider still says where the question goes.
// The transport is not known then, so assume the usual one.
const DEFAULT_TRANSPORT = new Map([["openai", "http"], ["google", "http"], ["human", "form"]]);
const runnerOrRoster = (seat, runners) =>
  runners?.[seat.key] ?? (seat.provider ? { provider: seat.provider, transport: DEFAULT_TRANSPORT.get(seat.provider) } : null);

/** Who besides Anthropic receives the question, for the line before a council starts:
 * "OpenAI (Buffett, via API), Google (Naval, via agy CLI), and Priya on this screen".
 * Empty only when every seat runs on Anthropic. A seat with no runner uses its own roster
 * provider, so a missing runner never hides a recipient. A provider not named above still
 * appears, under its own name, so an unknown recipient never reads as "nothing leaves". */
export function recipientsLine(seats, runners) {
  const groups = new Map();
  for (const s of seats || []) {
    const r = runnerOrRoster(s, runners);
    if (!r) continue;
    const provider = providerOf(r);
    if (provider === "anthropic") continue;
    const transport = provider === "human" ? "" : r.transport ?? "";
    const id = `${provider}|${transport}`;
    if (!groups.has(id)) groups.set(id, { provider, transport, shorts: [] });
    groups.get(id).shorts.push(s.short || s.name || s.key);
  }
  const rank = (g) => {
    const i = RECIPIENT_ORDER.indexOf(g.provider);
    return i < 0 ? RECIPIENT_ORDER.length : i;
  };
  const parts = [...groups.values()]
    .sort((a, b) => rank(a) - rank(b)) // stable: ties keep the order the seats came in
    .map(({ provider, transport, shorts }) => {
      if (provider === "human") return `${joinList(shorts)} on this screen`;
      const words = transportWords(provider, transport);
      return `${companyName(provider) || provider} (${joinList(shorts)}${words ? `, ${words}` : ""})`;
    });
  return joinList(parts);
}

// ---------- answer form ----------
// The fields of each round's card, shared by the browser form and the server's validation.
export const ROUND_FIELDS = {
  1: {
    required: ["STANCE", "OPTION SCORES", "THE CALL", "CONFIDENCE", "RUIN RISK", "DOOR"],
    optional: ["PILLAR SCORE", "WHY", "THE RISK I SEE", "WHAT WOULD CHANGE MY MIND", "WHAT I'D DO THIS WEEK", "QUESTION FOR THE FOUNDER"],
  },
  2: {
    required: ["STANCE", "OPTION SCORES", "CONFIDENCE", "RUIN RISK", "I DISAGREE MOST WITH"],
    optional: ["I CONCEDE", "ON THE CRUXES", "PILLAR SCORE", "MOVED", "MY CONDITIONS FOR YES"],
  },
  3: {
    required: ["VOTE", "OPTION SCORES", "FINAL SCORE"],
    optional: ["FINAL PILLAR SCORE", "AMENDMENT OR DISSENT", "ONE LINE FOR THE FOUNDER"],
  },
};

// Fields whose value is one of a fixed list.
export const CHOICES = {
  STANCE: ["Strong yes", "Yes", "Conditional yes", "No", "Strong no"],
  "RUIN RISK": ["none", "possible", "likely"],
  DOOR: ["one-way", "two-way"],
  VOTE: ["Endorse", "Endorse with amendment", "Dissent"],
};

// Fields that take several lines. Every other text field is a single line.
export const MULTILINE = ["WHY", "ON THE CRUXES", "MY CONDITIONS FOR YES"];

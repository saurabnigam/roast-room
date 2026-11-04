// One door to the three provider clients: key lookup, model choice, default budgets, usage tally.
import { env } from "../env.mjs";
import { KEY_ENV, ProviderError } from "./http.mjs";
import * as anthropic from "./anthropic.mjs";
import * as openai from "./openai.mjs";
import * as google from "./google.mjs";

export { KEY_ENV };
export const MODEL_ENV = { anthropic: "SEAT_MODEL", openai: "OPENAI_SEAT_MODEL", google: "GEMINI_SEAT_MODEL" };
export const DEFAULT_MODEL = { anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol", google: "gemini-3.8-flash" };
// OpenAI and Google count thinking tokens against the budget, so theirs is larger.
export const MAX_TOKENS = { anthropic: 1400, openai: 4000, google: 4000 };

const CLIENTS = { anthropic, openai, google };

// Own keys only, so a provider named "constructor" or "__proto__" is simply unknown.
const known = (table, provider) => typeof provider === "string" && Object.hasOwn(table, provider);

/**
 * Running token tally for OpenAI and Google. Anthropic keeps its own `usage` object in
 * anthropic.mjs, which is what /api/usage returns today, and its complete() adds to that.
 */
export const providerUsage = {
  openai: { input: 0, output: 0, cacheRead: 0, calls: 0 },
  google: { input: 0, output: 0, cacheRead: 0, calls: 0 },
};

/** True when the provider's key is set in the environment or .env. False for "human" and unknown names. */
export function hasKey(provider) {
  return known(KEY_ENV, provider) && Boolean(env(KEY_ENV[provider]));
}

const given = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * The model id to call. Order: override, the seat's own model, the provider's env variable,
 * the default. Empty values are skipped. null for "human" and for any name with no default.
 */
export function resolveModel(provider, opts) {
  if (!known(DEFAULT_MODEL, provider)) return null;
  const { override, seatModel } = opts ?? {};
  return given(override) || given(seatModel) || given(env(MODEL_ENV[provider])) || DEFAULT_MODEL[provider];
}

/**
 * complete(provider, { model, system, user, maxTokens?, signal? }) ->
 *   { text, usage: { input, output, cacheRead }, stopReason: "end" | "max_tokens" }
 * maxTokens defaults to MAX_TOKENS[provider]. A successful OpenAI or Google call is added to
 * providerUsage. "human" and unknown providers have no API client and throw a ProviderError.
 */
export async function complete(provider, args = {}) {
  if (!known(CLIENTS, provider)) {
    throw new ProviderError(`no API client for provider ${JSON.stringify(provider) ?? "undefined"}`, {
      provider: typeof provider === "string" ? provider : null,
    });
  }
  const result = await CLIENTS[provider].complete({ ...args, maxTokens: args.maxTokens ?? MAX_TOKENS[provider] });
  const tally = providerUsage[provider];
  if (tally) {
    tally.input += result.usage.input;
    tally.output += result.usage.output;
    tally.cacheRead += result.usage.cacheRead;
    tally.calls += 1;
  }
  return result;
}

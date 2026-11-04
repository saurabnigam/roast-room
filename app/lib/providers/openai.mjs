// OpenAI, Responses API. One non-streaming call that returns the seat's card as text.
import { env } from "../env.mjs";
import { postJson, ProviderError, excerpt } from "./http.mjs";

const URL = "https://api.openai.com/v1/responses";

// Why the reply was empty, when the response says: " (status incomplete: max_output_tokens)".
function emptyCause(j) {
  const status = typeof j?.status === "string" ? excerpt(j.status) : "";
  const reason = typeof j?.incomplete_details?.reason === "string" ? excerpt(j.incomplete_details.reason) : "";
  if (!status && !reason) return "";
  return ` (status ${status || "unknown"}${reason ? `: ${reason}` : ""})`;
}

/**
 * complete({ model, system, user, maxTokens, signal }) ->
 *   { text, usage: { input, output, cacheRead }, stopReason: "end" | "max_tokens" }
 *
 * `max_output_tokens` counts reasoning tokens too, so the caller should pass a larger budget
 * than the Anthropic one. The text is every output_text part of every message item, joined as
 * is: output[0] is often a reasoning item, so no index is assumed.
 * Any status of "incomplete" is a partial reply (stopReason "max_tokens"), whatever the reason,
 * because the text was cut short and must not be taken for a whole card.
 */
export async function complete({ model, system, user, maxTokens, signal }) {
  const j = await postJson(URL, {
    provider: "openai",
    headers: { authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    // store: false, because the Responses API keeps a response on OpenAI's side by default.
    body: { model, instructions: system, input: user, max_output_tokens: maxTokens, store: false },
    signal,
  });
  const text = (Array.isArray(j?.output) ? j.output : [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  if (!text.trim()) throw new ProviderError(`empty reply${emptyCause(j)}`, { provider: "openai" });
  const u = j.usage ?? {};
  return {
    text,
    usage: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.input_tokens_details?.cached_tokens || 0,
    },
    stopReason: j.status === "incomplete" ? "max_tokens" : "end",
  };
}

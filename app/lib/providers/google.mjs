// Google Gemini, generateContent. One non-streaming call that returns the seat's card as text.
import { env } from "../env.mjs";
import { postJson, ProviderError, excerpt } from "./http.mjs";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// A finish reason that means Google withheld the reply.
const BLOCKED = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST"]);

const blocked = (reason) => new ProviderError(`blocked: ${excerpt(reason)}`, { provider: "google" });

/**
 * complete({ model, system, user, maxTokens, signal }) ->
 *   { text, usage: { input, output, cacheRead }, stopReason: "end" | "max_tokens" }
 *
 * The key goes in the x-goog-api-key header, never in the URL. Thought parts are skipped.
 * Output tokens are the answer plus the thinking, because both count against the budget and the bill.
 */
export async function complete({ model, system, user, maxTokens, signal }) {
  const j = await postJson(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
    provider: "google",
    headers: { "x-goog-api-key": env("GEMINI_API_KEY") },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    },
    signal,
  });
  if (j?.promptFeedback?.blockReason) throw blocked(j.promptFeedback.blockReason);
  const candidate = Array.isArray(j?.candidates) ? j.candidates[0] : undefined;
  if (!candidate) throw blocked("no candidates");
  if (BLOCKED.has(candidate.finishReason)) throw blocked(candidate.finishReason);
  const text = (Array.isArray(candidate.content?.parts) ? candidate.content.parts : [])
    .filter((part) => part && part.thought !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  if (!text.trim()) {
    const finish = typeof candidate.finishReason === "string" ? excerpt(candidate.finishReason) : "";
    throw new ProviderError(`empty reply${finish ? ` (finish ${finish})` : ""}`, { provider: "google" });
  }
  const u = j.usageMetadata ?? {};
  return {
    text,
    usage: {
      input: u.promptTokenCount || 0,
      output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      cacheRead: u.cachedContentTokenCount || 0,
    },
    stopReason: candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end",
  };
}

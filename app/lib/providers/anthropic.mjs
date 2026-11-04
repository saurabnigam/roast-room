import { env } from "../env.mjs";
import { postJson, fetchOrThrow, sleep, excerpt, ProviderError } from "./http.mjs";

const URL = "https://api.anthropic.com/v1/messages";
const RETRY = new Set([429, 500, 502, 503, 529]);

function headers() {
  return {
    "x-api-key": env("ANTHROPIC_API_KEY"),
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

// Running token tally for the whole app, shown in the UI.
export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
function addUsage(u = {}) {
  usage.input += u.input_tokens || 0;
  usage.output += u.output_tokens || 0;
  usage.cacheRead += u.cache_read_input_tokens || 0;
  usage.cacheWrite += u.cache_creation_input_tokens || 0;
  usage.calls += 1;
}

/**
 * Stream a message; calls onText(delta) as text arrives. Returns the full text.
 * onStop(stopReason) is called with the API's own stop reason ("end_turn", "max_tokens", ...)
 * when the stream reports one.
 * `signal` (optional) is passed to fetch, so the caller can cut the call off, for example with
 * AbortSignal.timeout(ms). An abort rejects with the signal's own reason.
 */
export async function stream({ model, system, messages, maxTokens = 2000, onText = () => {}, onStop = () => {}, signal }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetchOrThrow(URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model, system, messages, max_tokens: maxTokens, stream: true }),
      signal,
    }, "anthropic");
    if (RETRY.has(res.status)) { await sleep(Math.min(30000, 2000 * 2 ** attempt), signal); continue; }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${excerpt(await res.text())}`);
    let text = "";
    let buf = "";
    const dec = new TextDecoder();
    const finalUsage = {};
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          text += ev.delta.text;
          onText(ev.delta.text);
        } else if (ev.type === "message_start") {
          Object.assign(finalUsage, ev.message?.usage || {});
        } else if (ev.type === "message_delta") {
          Object.assign(finalUsage, ev.usage || {});
          if (ev.delta?.stop_reason) onStop(ev.delta.stop_reason);
        } else if (ev.type === "error") {
          throw new Error(`Anthropic stream error: ${excerpt(JSON.stringify(ev.error))}`);
        }
      }
    }
    addUsage(finalUsage);
    return text;
  }
  throw new Error("Anthropic API kept refusing after retries");
}

/** One call with structured JSON output matching `schema`. */
export async function json({ model, system, prompt, schema, maxTokens = 4000 }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetchOrThrow(URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model, system, max_tokens: maxTokens,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      }),
    }, "anthropic");
    if (RETRY.has(res.status)) { await sleep(Math.min(30000, 2000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${excerpt(await res.text())}`);
    const j = await res.json();
    addUsage(j.usage);
    if (j.stop_reason === "max_tokens") throw new Error("Chair output hit max_tokens");
    return JSON.parse(j.content.map((b) => b.text || "").join(""));
  }
  throw new Error("Anthropic API kept refusing after retries");
}

/**
 * One non-streaming call that returns a seat's card as text, in the same shape as the other
 * providers: { text, usage: { input, output, cacheRead }, stopReason: "end" | "max_tokens" }.
 * A string `system` is sent as one cached block. A block array is sent as is.
 * The call is added to the same `usage` tally that /api/usage returns. Retries come from postJson.
 */
export async function complete({ model, system, user, maxTokens, signal }) {
  const blocks = typeof system === "string"
    ? (system ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : undefined)
    : system;
  const j = await postJson(URL, {
    provider: "anthropic",
    headers: headers(),
    body: { model, system: blocks, max_tokens: maxTokens, messages: [{ role: "user", content: user }] },
    signal,
  });
  // Tokens were spent even if the reply turns out to be empty, so count them first.
  addUsage(j?.usage ?? undefined);
  const text = (Array.isArray(j?.content) ? j.content : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new ProviderError("empty reply", { provider: "anthropic" });
  const u = j.usage ?? {};
  return {
    text,
    usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
    stopReason: j.stop_reason === "max_tokens" ? "max_tokens" : "end",
  };
}

// JSON schema helpers
export const S = {
  str: { type: "string" },
  num: { type: "number" },
  int: { type: "integer" },
  bool: { type: "boolean" },
  arr: (items) => ({ type: "array", items }),
  obj: (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false }),
  enum: (...v) => ({ type: "string", enum: v }),
};

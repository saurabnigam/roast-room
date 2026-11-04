// Shared HTTP for the provider clients: one error type, one retry policy, one redaction rule.
// Node 20 or newer, no dependencies.
import { env } from "../env.mjs";

// Which environment variable holds each provider's key. index.mjs re-exports this.
export const KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY" };

const LABEL = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };
const RETRY = new Set([429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = 6;
const BODY_CHARS = 300;
// The longest Retry-After we will sit out. A server asking for more is reported as an error,
// so one stuck seat cannot stall a whole round.
const MAX_WAIT_MS = 120_000;

/**
 * Every failure a provider client reports. `status` is the HTTP status, or null when there was
 * no HTTP answer to read. `retryable` is true for a status the policy retries (even after the
 * retries ran out) and false for everything else. The message never holds a key or a header.
 */
export class ProviderError extends Error {
  constructor(message, { provider = null, status = null, retryable = false } = {}) {
    super(message);
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}
// On the prototype, so it does not show up as an own property of every error.
Object.defineProperty(ProviderError.prototype, "name", { value: "ProviderError", writable: true, configurable: true });

// ---------------------------------------------------------------- redaction

/** Replace every configured key value in `text` with [redacted]. */
export function redact(text) {
  const keys = Object.values(KEY_ENV).map((name) => env(name)).filter(Boolean).sort((a, b) => b.length - a.length);
  let out = String(text ?? "");
  for (const key of keys) out = out.split(key).join("[redacted]");
  return out;
}

/**
 * The first 300 characters of a response body, safe to put in an error message.
 * Redact first, then cut: cutting first could leave the front half of a key at the edge.
 */
export function excerpt(text) {
  return redact(text).slice(0, BODY_CHARS);
}

// ---------------------------------------------------------------- sleeping

const realSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

let sleeper = realSleep;

/** Wait `ms`. Every retry loop in the providers waits through this, so a test can stub it. */
export const sleep = (ms, signal) => sleeper(ms, signal);

/** Tests only: replace the wait. Call with no argument to put the real one back. */
export function setSleep(fn) {
  sleeper = typeof fn === "function" ? fn : realSleep;
}

// ---------------------------------------------------------------- retry policy

// Retry-After is either a number of seconds or an HTTP date. Anything else is no answer.
function retryAfterMs(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const when = Date.parse(v);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

const backoffMs = (attempt) => Math.min(30000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 251);

const labelOf = (provider) => (Object.hasOwn(LABEL, provider) ? LABEL[provider] : String(provider ?? "Provider"));

/**
 * fetch(), except that a failure to get any answer (DNS, connection reset, a header the runtime
 * refuses) becomes a retryable ProviderError. The new error has no `cause` and its message is
 * redacted, so nothing the runtime attached to the original, such as a header value, can leak.
 * If the caller's signal has aborted, the original error is rethrown unchanged.
 */
export async function fetchOrThrow(url, init, provider) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init?.signal?.aborted) throw e;
    throw new ProviderError(`${labelOf(provider)} request failed: ${excerpt(e?.message ?? e)}`, { provider, retryable: true });
  }
}

/**
 * POST `body` as JSON and return the parsed reply.
 *
 * Retries 429, 500, 502, 503 and 529, up to 6 attempts in all. The wait is the Retry-After
 * header when there is one, else 2s, 4s, 8s ... capped at 30s, plus up to 250 ms of jitter.
 * A Retry-After longer than 120s is not waited: it throws a retryable ProviderError instead.
 * There is no wait after the last attempt. A 429 whose body says insufficient_quota is a
 * billing problem, so it is never retried. Any other failure throws a ProviderError at once.
 * There is no timeout here: the caller passes an AbortSignal (for example AbortSignal.timeout).
 */
export async function postJson(url, { provider, headers = {}, body, signal } = {}) {
  const label = labelOf(provider);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    const res = await fetchOrThrow(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    }, provider);
    if (res.ok) {
      try {
        return await res.json();
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new ProviderError(`${label} sent a reply that is not JSON`, { provider, status: res.status });
      }
    }
    const text = await res.text().catch(() => "");
    const quota = res.status === 429 && /insufficient_quota/.test(text);
    if (!RETRY.has(res.status) || quota) {
      throw new ProviderError(`${label} ${res.status}: ${excerpt(text)}`, { provider, status: res.status, retryable: false });
    }
    if (attempt === MAX_ATTEMPTS - 1) {
      throw new ProviderError(`${label} ${res.status} after ${MAX_ATTEMPTS} attempts: ${excerpt(text)}`, { provider, status: res.status, retryable: true });
    }
    const asked = retryAfterMs(res.headers.get("retry-after"));
    if (asked != null && asked > MAX_WAIT_MS) {
      throw new ProviderError(`${label} ${res.status}: asked to wait ${Math.ceil(asked / 1000)}s`, { provider, status: res.status, retryable: true });
    }
    await sleep(asked ?? backoffMs(attempt), signal);
  }
}

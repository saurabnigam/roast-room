import test, { after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, mockFetch, sse } from "./helpers.mjs";

// The provider modules read ROAST_ROOT and the API keys when they are used, so set them first.
const repo = makeRepo({ seats: [] });
process.env.ROAST_ROOT = repo.root;
process.env.ANTHROPIC_API_KEY = "a-test";
process.env.OPENAI_API_KEY = "sk-test";
process.env.GEMINI_API_KEY = "g-test";
for (const k of ["SEAT_MODEL", "OPENAI_SEAT_MODEL", "GEMINI_SEAT_MODEL"]) delete process.env[k];
after(() => { repo.cleanup(); setSleep(); });

const { ProviderError, postJson, setSleep } = await import("../app/lib/providers/http.mjs");
const anthropic = await import("../app/lib/providers/anthropic.mjs");
const openai = await import("../app/lib/providers/openai.mjs");
const google = await import("../app/lib/providers/google.mjs");
const P = await import("../app/lib/providers/index.mjs");
const { complete, hasKey, resolveModel, providerUsage } = P;

// ---------------------------------------------------------------- helpers

/** Stub the sleep and return the list of waits it was asked for. */
function stubSleep() {
  const sleeps = [];
  setSleep(async (ms) => { sleeps.push(ms); });
  return sleeps;
}

/** Install a fetch mock for one test and put the real fetch back when the test ends. */
function useFetch(t, handler) {
  const m = mockFetch(handler);
  t.after(() => m.restore());
  return m;
}

const headerOf = (init, name) => {
  const h = init.headers;
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit === undefined ? undefined : h[hit];
};

const openaiReply = (over = {}) => ({
  status: "completed",
  output: [
    { type: "reasoning", summary: [] },
    { type: "message", role: "assistant", content: [
      { type: "output_text", text: "part one " },
      { type: "output_text", text: "part two" },
    ] },
  ],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 50 },
  ...over,
});

const googleReply = (over = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text: "the card" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 30, candidatesTokenCount: 40, thoughtsTokenCount: 25 },
  ...over,
});

const anthropicReply = (over = {}) => ({
  content: [{ type: "text", text: "claude card" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
  ...over,
});

// ---------------------------------------------------------------- constants

test("index constants match the contract", () => {
  assert.deepEqual(P.KEY_ENV, { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY" });
  assert.deepEqual(P.MODEL_ENV, { anthropic: "SEAT_MODEL", openai: "OPENAI_SEAT_MODEL", google: "GEMINI_SEAT_MODEL" });
  assert.deepEqual(P.DEFAULT_MODEL, { anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol", google: "gemini-3.8-flash" });
  assert.deepEqual(P.MAX_TOKENS, { anthropic: 1400, openai: 4000, google: 4000 });
});

test("anthropic.mjs still exports stream, json, S and usage", () => {
  assert.equal(typeof anthropic.stream, "function");
  assert.equal(typeof anthropic.json, "function");
  assert.equal(typeof anthropic.complete, "function");
  assert.deepEqual(Object.keys(anthropic.S).sort(), ["arr", "bool", "enum", "int", "num", "obj", "str"]);
  assert.deepEqual(Object.keys(anthropic.usage).sort(), ["cacheRead", "cacheWrite", "calls", "input", "output"]);
});

// ---------------------------------------------------------------- OpenAI

test("openai request body and text join", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, () => ({ json: openaiReply() }));
  const r = await complete("openai", { model: "gpt-6.1-sol", system: "SYS", user: "USER" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].init.method, "POST");
  // store: false, so OpenAI does not keep the prompt (the Responses API stores responses by default).
  assert.deepEqual(calls[0].body, { model: "gpt-6.1-sol", instructions: "SYS", input: "USER", max_output_tokens: 4000, store: false });
  assert.equal(calls[0].init.headers.authorization ?? calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(headerOf(calls[0].init, "content-type"), "application/json");
  // A reasoning item comes first, then a message with two output_text parts.
  assert.equal(r.text, "part one part two");
  assert.equal(r.stopReason, "end");
  assert.deepEqual(r.usage, { input: 100, output: 50, cacheRead: 80 });
});

test("openai joins every message item and skips non-text content", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: openaiReply({ output: [
    { type: "message", content: [{ type: "refusal", refusal: "no" }, { type: "output_text", text: "A" }] },
    { type: "function_call", name: "x" },
    { type: "message", content: [{ type: "output_text", text: "B" }] },
  ] }) }));
  const r = await openai.complete({ model: "m", system: "s", user: "u", maxTokens: 10 });
  assert.equal(r.text, "AB");
});

test("openai module passes maxTokens through", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, () => ({ json: openaiReply() }));
  await openai.complete({ model: "gpt-6-luna", system: "S", user: "U", maxTokens: 123 });
  assert.equal(calls[0].body.max_output_tokens, 123);
  assert.equal(calls[0].body.model, "gpt-6-luna");
});

test("openai incomplete at max_output_tokens is partial", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: openaiReply({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) }));
  const r = await complete("openai", { model: "gpt-6.1-sol", system: "S", user: "U" });
  assert.equal(r.stopReason, "max_tokens");
  assert.equal(r.text, "part one part two", "a partial reply keeps its text");
});

test("openai incomplete for any other reason is partial too, and keeps its text", async (t) => {
  stubSleep();
  for (const reason of ["content_filter", "something_new", undefined]) {
    const incomplete_details = reason === undefined ? undefined : { reason };
    const m = mockFetch(() => ({ json: openaiReply({ status: "incomplete", incomplete_details }) }));
    try {
      const r = await complete("openai", { model: "m", system: "S", user: "U" });
      assert.equal(r.stopReason, "max_tokens", `reason ${reason}`);
      assert.equal(r.text, "part one part two");
    } finally { m.restore(); }
  }
});

test("openai completed and other statuses are not partial", async (t) => {
  stubSleep();
  for (const status of ["completed", undefined]) {
    const m = mockFetch(() => ({ json: openaiReply({ status }) }));
    try {
      assert.equal((await complete("openai", { model: "m", system: "S", user: "U" })).stopReason, "end", `status ${status}`);
    } finally { m.restore(); }
  }
});

test("openai empty output throws", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: openaiReply({ output: [{ type: "reasoning", summary: [] }] }) }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, "openai");
    assert.match(e.message, /empty reply/);
    assert.match(e.message, /^empty reply \(status completed\)$/, "names the status when there is no reason");
    return true;
  });
});

test("openai empty reply names the status and the incomplete reason", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: openaiReply({
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }],
  }) }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /empty reply/);
    assert.equal(e.message, "empty reply (status incomplete: max_output_tokens)");
    return true;
  });
});

test("openai empty reply with no status says only empty reply", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: { output: [] } }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.equal(e.message, "empty reply");
    return true;
  });
});

test("openai whitespace-only text is an empty reply", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: openaiReply({ output: [{ type: "message", content: [{ type: "output_text", text: " \n " }] }] }) }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), /empty reply/);
});

// ---------------------------------------------------------------- Google

test("google body, thought parts skipped, usage", async (t) => {
  stubSleep();
  const reply = googleReply({ candidates: [{
    content: { role: "model", parts: [{ thought: true, text: "thinking" }, { text: "the card" }] },
    finishReason: "STOP",
  }] });
  const { calls } = useFetch(t, () => ({ json: reply }));
  const r = await complete("google", { model: "gemini-3.8-flash", system: "SYS", user: "USER" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.match(calls[0].url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g-test");
  assert.deepEqual(calls[0].body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.deepEqual(calls[0].body, {
    systemInstruction: { parts: [{ text: "SYS" }] },
    contents: [{ role: "user", parts: [{ text: "USER" }] }],
    generationConfig: { maxOutputTokens: 4000 },
  });
  assert.equal(r.text, "the card");
  assert.equal(r.stopReason, "end");
  assert.deepEqual(r.usage, { input: 120, output: 65, cacheRead: 30 });
});

test("google never puts the key in the URL", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, () => ({ json: googleReply() }));
  await complete("google", { model: "gemini-3.8-flash", system: "S", user: "U" });
  assert.ok(!calls[0].url.includes("g-test"));
  assert.ok(!calls[0].url.includes("key="));
});

test("google escapes a model id so it cannot leave the models path", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, () => ({ json: googleReply() }));
  await google.complete({ model: "x/../y?z", system: "S", user: "U", maxTokens: 5 });
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/x%2F..%2Fy%3Fz:generateContent");
});

test("google joins text parts and counts missing usage fields as zero", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: { candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } } }));
  const r = await google.complete({ model: "m", system: "S", user: "U", maxTokens: 5 });
  assert.equal(r.text, "ab");
  assert.equal(r.stopReason, "end");
  assert.deepEqual(r.usage, { input: 7, output: 3, cacheRead: 0 });
});

test("google thought-only reply throws", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: googleReply({ candidates: [{ content: { parts: [{ thought: true, text: "thinking" }] }, finishReason: "STOP" }] }) }));
  await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, "google");
    assert.match(e.message, /empty reply/);
    assert.equal(e.message, "empty reply (finish STOP)");
    return true;
  });
});

test("google empty reply names a MAX_TOKENS finish, and says only empty reply when there is none", async (t) => {
  stubSleep();
  let reply = googleReply({ candidates: [{ content: { parts: [{ thought: true, text: "t" }] }, finishReason: "MAX_TOKENS" }] });
  useFetch(t, () => ({ json: reply }));
  await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), (e) => {
    assert.equal(e.message, "empty reply (finish MAX_TOKENS)");
    return true;
  });
  reply = googleReply({ candidates: [{ content: { parts: [] } }] });
  await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), (e) => {
    assert.equal(e.message, "empty reply");
    return true;
  });
});

test("google SAFETY block throws", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: googleReply({ candidates: [{ content: { parts: [{ text: "half a card" }] }, finishReason: "SAFETY" }] }) }));
  await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), /blocked: SAFETY/);
});

test("google RECITATION, PROHIBITED_CONTENT and BLOCKLIST finish reasons throw", async (t) => {
  stubSleep();
  for (const reason of ["RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST"]) {
    const m = mockFetch(() => ({ json: googleReply({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: reason }] }) }));
    try {
      await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), new RegExp(`blocked: ${reason}`));
    } finally { m.restore(); }
  }
});

test("google promptFeedback.blockReason throws, even with no candidates", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 4 } } }));
  await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), /blocked: PROHIBITED_CONTENT/);
});

test("google with no candidates and no reason is still a block, not an empty success", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: { candidates: [] } }));
  await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /^blocked: /);
    return true;
  });
});

test("google MAX_TOKENS is partial", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: googleReply({ candidates: [{ content: { parts: [{ text: "cut off" }] }, finishReason: "MAX_TOKENS" }] }) }));
  const r = await complete("google", { model: "m", system: "S", user: "U" });
  assert.equal(r.stopReason, "max_tokens");
  assert.equal(r.text, "cut off");
});

// ---------------------------------------------------------------- Anthropic complete

test("anthropic complete sends a string system as one cached block", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, () => ({ json: anthropicReply() }));
  const before = { ...anthropic.usage };
  const r = await complete("anthropic", { model: "claude-sonnet-5-5", system: "SYS", user: "USER" });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(headerOf(calls[0].init, "x-api-key"), "a-test");
  assert.equal(headerOf(calls[0].init, "anthropic-version"), "2023-06-01");
  assert.deepEqual(calls[0].body, {
    model: "claude-sonnet-5-5",
    system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }],
    max_tokens: 1400,
    messages: [{ role: "user", content: "USER" }],
  });
  assert.ok(!("stream" in calls[0].body), "complete is not streaming");
  assert.equal(r.text, "claude card");
  assert.equal(r.stopReason, "end");
  assert.deepEqual(r.usage, { input: 10, output: 20, cacheRead: 5 });
  // It adds to the same tally /api/usage returns, not to providerUsage.
  assert.equal(anthropic.usage.calls, before.calls + 1);
  assert.equal(anthropic.usage.input, before.input + 10);
  assert.equal(anthropic.usage.output, before.output + 20);
  assert.equal(anthropic.usage.cacheRead, before.cacheRead + 5);
  assert.equal(anthropic.usage.cacheWrite, before.cacheWrite + 7);
  assert.ok(!("anthropic" in providerUsage));
});

test("anthropic complete passes a block array through unchanged", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, () => ({ json: anthropicReply() }));
  const blocks = [{ type: "text", text: "A", cache_control: { type: "ephemeral" } }, { type: "text", text: "B" }];
  await anthropic.complete({ model: "m", system: blocks, user: "U", maxTokens: 321 });
  assert.deepEqual(calls[0].body.system, blocks);
  assert.equal(calls[0].body.max_tokens, 321);
});

test("anthropic complete: max_tokens is partial; other stop reasons are end", async (t) => {
  stubSleep();
  let reason = "max_tokens";
  useFetch(t, () => ({ json: anthropicReply({ stop_reason: reason }) }));
  assert.equal((await anthropic.complete({ model: "m", system: "S", user: "U", maxTokens: 5 })).stopReason, "max_tokens");
  reason = "end_turn";
  assert.equal((await anthropic.complete({ model: "m", system: "S", user: "U", maxTokens: 5 })).stopReason, "end");
  reason = "stop_sequence";
  assert.equal((await anthropic.complete({ model: "m", system: "S", user: "U", maxTokens: 5 })).stopReason, "end");
});

test("anthropic complete with no text throws, and the spent tokens are still counted", async (t) => {
  stubSleep();
  useFetch(t, () => ({ json: anthropicReply({ content: [] }) }));
  const calls0 = anthropic.usage.calls;
  await assert.rejects(complete("anthropic", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, "anthropic");
    assert.match(e.message, /empty reply/);
    return true;
  });
  assert.equal(anthropic.usage.calls, calls0 + 1);
});

// ---------------------------------------------------------------- retry policy

test("429 with Retry-After waits that long, then succeeds", async (t) => {
  const sleeps = stubSleep();
  let n = 0;
  const { calls } = useFetch(t, () => (++n === 1
    ? { status: 429, headers: { "retry-after": "2" }, text: "slow down" }
    : { json: openaiReply() }));
  const r = await complete("openai", { model: "m", system: "S", user: "U" });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(r.text, "part one part two");
});

test("Retry-After of 0 waits zero, not the backoff", async (t) => {
  const sleeps = stubSleep();
  let n = 0;
  useFetch(t, () => (++n === 1 ? { status: 503, headers: { "retry-after": "0" }, text: "" } : { json: googleReply() }));
  await complete("google", { model: "m", system: "S", user: "U" });
  assert.deepEqual(sleeps, [0]);
});

test("an HTTP-date Retry-After in the past waits zero", async (t) => {
  const sleeps = stubSleep();
  let n = 0;
  useFetch(t, () => (++n === 1
    ? { status: 429, headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, text: "" }
    : { json: openaiReply() }));
  await complete("openai", { model: "m", system: "S", user: "U" });
  assert.deepEqual(sleeps, [0]);
});

test("an unreadable Retry-After falls back to the backoff", async (t) => {
  const sleeps = stubSleep();
  let n = 0;
  useFetch(t, () => (++n === 1 ? { status: 503, headers: { "retry-after": "soon" }, text: "" } : { json: openaiReply() }));
  await complete("openai", { model: "m", system: "S", user: "U" });
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 2000 && sleeps[0] <= 2250, `got ${sleeps[0]}`);
});

test("without Retry-After the wait is 2s, 4s, ... plus up to 250 ms of jitter, capped at 30s", async (t) => {
  const sleeps = stubSleep();
  const { calls } = useFetch(t, () => ({ status: 503, text: "down" }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }));
  assert.equal(calls.length, 6, "six attempts");
  assert.equal(sleeps.length, 5, "no wait after the last attempt");
  const base = [2000, 4000, 8000, 16000, 30000]; // the fifth would be 32000, capped
  base.forEach((b, i) => assert.ok(sleeps[i] >= b && sleeps[i] <= b + 250, `wait ${i} was ${sleeps[i]}, want ${b}..${b + 250}`));
});

test("after six failed attempts the error is a retryable ProviderError with the status", async (t) => {
  stubSleep();
  useFetch(t, () => ({ status: 529, text: "overloaded" }));
  await assert.rejects(complete("anthropic", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, "anthropic");
    assert.equal(e.status, 529);
    assert.equal(e.retryable, true);
    assert.match(e.message, /529/);
    assert.match(e.message, /overloaded/);
    return true;
  });
});

test("each of 429, 500, 502, 503 and 529 is retried", async (t) => {
  for (const status of [429, 500, 502, 503, 529]) {
    const sleeps = stubSleep();
    let n = 0;
    const m = mockFetch(() => (++n === 1 ? { status, text: "try later" } : { json: openaiReply() }));
    try {
      const r = await complete("openai", { model: "m", system: "S", user: "U" });
      assert.equal(r.text, "part one part two", `status ${status}`);
      assert.equal(sleeps.length, 1, `status ${status}`);
    } finally { m.restore(); }
  }
});

test("429 insufficient_quota is not retried", async (t) => {
  const sleeps = stubSleep();
  const { calls } = useFetch(t, () => ({ status: 429, json: { error: { code: "insufficient_quota", message: "You exceeded your current quota" } } }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.status, 429);
    assert.equal(e.retryable, false);
    assert.match(e.message, /insufficient_quota/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("a 429 without insufficient_quota is still retried", async (t) => {
  const sleeps = stubSleep();
  let n = 0;
  const { calls } = useFetch(t, () => (++n === 1 ? { status: 429, json: { error: { code: "rate_limit_exceeded" } } } : { json: openaiReply() }));
  await complete("openai", { model: "m", system: "S", user: "U" });
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test("other non-OK statuses are not retried and carry only the first 300 characters", async (t) => {
  const sleeps = stubSleep();
  const { calls } = useFetch(t, () => ({ status: 400, text: "B".repeat(1000) }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, "openai");
    assert.equal(e.status, 400);
    assert.equal(e.retryable, false);
    assert.ok(e.message.includes("B".repeat(300)));
    assert.ok(!e.message.includes("B".repeat(301)));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("a 200 that is not JSON is a ProviderError, not a raw SyntaxError", async (t) => {
  stubSleep();
  useFetch(t, () => ({ text: "<html>gateway</html>" }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, "openai");
    return true;
  });
});

test("postJson sends JSON with the caller's headers and returns the parsed body", async (t) => {
  const { calls } = useFetch(t, () => ({ json: { ok: true } }));
  const out = await postJson("https://example.test/x", { provider: "openai", headers: { "x-thing": "1" }, body: { a: 1 } });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(calls[0].body, { a: 1 });
  assert.equal(headerOf(calls[0].init, "x-thing"), "1");
  assert.equal(headerOf(calls[0].init, "content-type"), "application/json");
});

test("Retry-After beyond two minutes is not slept: one call, no wait, a retryable ProviderError", async (t) => {
  const sleeps = stubSleep();
  const { calls } = useFetch(t, () => ({ status: 429, headers: { "retry-after": "3600" }, text: "slow down" }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, "openai");
    assert.equal(e.status, 429);
    assert.equal(e.retryable, true);
    assert.equal(e.message, "OpenAI 429: asked to wait 3600s");
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("a far-future Retry-After date is refused the same way", async (t) => {
  const sleeps = stubSleep();
  const when = new Date(Date.now() + 3600 * 1000).toUTCString();
  const { calls } = useFetch(t, () => ({ status: 503, headers: { "retry-after": when }, text: "" }));
  await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.status, 503);
    assert.equal(e.retryable, true);
    assert.match(e.message, /^Google 503: asked to wait \d+s$/);
    const secs = Number(/(\d+)s$/.exec(e.message)[1]);
    assert.ok(secs > 3500 && secs <= 3600, `got ${secs}`);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("Retry-After of exactly 120 seconds is still waited; one more second is not", async (t) => {
  const sleeps = stubSleep();
  let wait = "120";
  let n = 0;
  const { calls } = useFetch(t, () => (++n % 2 === 1 ? { status: 429, headers: { "retry-after": wait }, text: "" } : { json: openaiReply() }));
  await complete("openai", { model: "m", system: "S", user: "U" });
  assert.deepEqual(sleeps, [120000]);
  wait = "121";
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), /asked to wait 121s/);
  assert.deepEqual(sleeps, [120000], "no second sleep");
  assert.equal(calls.length, 3);
});

test("the Retry-After cap does not touch the backoff, which never gets near it", async (t) => {
  const sleeps = stubSleep();
  useFetch(t, () => ({ status: 503, text: "down" }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), /after 6 attempts/);
  assert.equal(sleeps.length, 5);
});

test("a fetch that throws becomes a retryable ProviderError, with no cause", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, () => { throw new TypeError("fetch failed"); });
  for (const p of ["openai", "google", "anthropic"]) {
    await assert.rejects(complete(p, { model: "m", system: "S", user: "U" }), (e) => {
      assert.ok(e instanceof ProviderError, p);
      assert.equal(e.provider, p);
      assert.equal(e.retryable, true);
      assert.equal(e.status, null, "no HTTP answer, so no status");
      assert.match(e.message, /request failed: fetch failed$/);
      assert.equal(e.cause, undefined);
      assert.ok(!("cause" in e));
      assert.deepEqual(Object.keys(e).sort(), ["provider", "retryable", "status"]);
      return true;
    });
  }
  assert.equal(calls.length, 3, "a network failure is reported, not retried by postJson");
});

test("a fetch failure message is redacted and cut like any other", async (t) => {
  stubSleep();
  useFetch(t, () => { throw new TypeError(`Headers.append: "Bearer sk-test" is an invalid header value ${"z".repeat(400)}`); });
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(!e.message.includes("sk-test"), e.message);
    assert.match(e.message, /\[redacted\]/);
    assert.ok(!e.message.includes("z".repeat(301)));
    return true;
  });
});

test("a fetch failure after the caller aborted is rethrown unchanged", async (t) => {
  stubSleep();
  const ctl = new AbortController();
  const abortError = new DOMException("The operation was aborted", "AbortError");
  useFetch(t, () => { ctl.abort(); throw abortError; });
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U", signal: ctl.signal }), (e) => {
    assert.equal(e, abortError, "the very same object");
    assert.ok(!(e instanceof ProviderError));
    return true;
  });
});

test("an aborted signal stops the request and ends a long Retry-After wait early", async (t) => {
  setSleep(); // the real, abortable sleep
  t.after(() => setSleep(async () => {}));
  const ctl = new AbortController();
  let n = 0;
  const { calls } = useFetch(t, (url, init) => {
    if (init.signal?.aborted) throw init.signal.reason;
    return ++n === 1 ? { status: 429, headers: { "retry-after": "30" }, text: "" } : { json: openaiReply() };
  });
  const started = Date.now();
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U", signal: ctl.signal }));
  assert.ok(Date.now() - started < 5000, "did not sit out the 30 second wait");
  assert.equal(calls.length, 1, "no second request after the abort");
});

// ---------------------------------------------------------------- redaction

test("errors never contain the key", async (t) => {
  stubSleep();
  useFetch(t, () => ({ status: 401, json: { error: { message: "Incorrect API key provided: sk-test. Also g-test and a-test." } } }));
  for (const p of ["openai", "google", "anthropic"]) {
    await assert.rejects(complete(p, { model: "m", system: "S", user: "U" }), (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.status, 401);
      for (const k of ["sk-test", "g-test", "a-test", "Bearer"]) assert.ok(!e.message.includes(k), `${p} message leaked ${k}: ${e.message}`);
      assert.match(e.message, /\[redacted\]/);
      return true;
    });
  }
});

test("a key that straddles the 300 character cut is redacted before the cut", async (t) => {
  stubSleep();
  useFetch(t, () => ({ status: 400, text: "x".repeat(296) + "sk-test and more" }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(!e.message.includes("sk-"), e.message);
    assert.ok(!e.message.includes("sk-t"), e.message);
    return true;
  });
});

test("a key repeated in the body is redacted everywhere", async (t) => {
  stubSleep();
  useFetch(t, () => ({ status: 403, text: "sk-test sk-test sk-test" }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.ok(!e.message.includes("sk-test"));
    assert.equal(e.message.split("[redacted]").length - 1, 3);
    return true;
  });
});

test("a key that is not set does not turn the empty string into a redaction", async (t) => {
  stubSleep();
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => { process.env.GEMINI_API_KEY = saved; });
  useFetch(t, () => ({ status: 400, text: "plain failure" }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.match(e.message, /plain failure/);
    assert.ok(!e.message.includes("[redacted]"));
    return true;
  });
});

test("ProviderError carries no request headers or response", async (t) => {
  stubSleep();
  useFetch(t, () => ({ status: 401, text: "no" }));
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), (e) => {
    assert.deepEqual(Object.keys(e).sort(), ["provider", "retryable", "status"]);
    assert.ok(!JSON.stringify(e).includes("sk-test"));
    assert.equal(e.name, "ProviderError");
    return true;
  });
});

// ---------------------------------------------------------------- Anthropic stream and json keep working

const streamEvents = (stop = "end_turn") => [
  { type: "message_start", message: { usage: { input_tokens: 11, cache_read_input_tokens: 2 } } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
  { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 9 } },
];

test("stream returns the text, tallies usage, and reports the stop reason through onStop", async (t) => {
  useFetch(t, () => sse(streamEvents("max_tokens")));
  const stops = [];
  const deltas = [];
  const calls0 = anthropic.usage.calls;
  const text = await anthropic.stream({
    model: "m", system: "S", messages: [{ role: "user", content: "U" }],
    onText: (d) => deltas.push(d), onStop: (s) => stops.push(s),
  });
  assert.equal(text, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(stops, ["max_tokens"]);
  assert.equal(anthropic.usage.calls, calls0 + 1);
});

test("stream works without onStop", async (t) => {
  useFetch(t, () => sse(streamEvents()));
  assert.equal(await anthropic.stream({ model: "m", system: "S", messages: [{ role: "user", content: "U" }] }), "Hello");
});

test("stream sends the request it always sent", async (t) => {
  const { calls } = useFetch(t, () => sse(streamEvents()));
  await anthropic.stream({ model: "m", system: [{ type: "text", text: "S" }], messages: [{ role: "user", content: "U" }], maxTokens: 77 });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(calls[0].body, { model: "m", system: [{ type: "text", text: "S" }], messages: [{ role: "user", content: "U" }], max_tokens: 77, stream: true });
});

test("stream and json retry with the sleep that setSleep replaces", async (t) => {
  const sleeps = stubSleep();
  let n = 0;
  useFetch(t, () => {
    n++;
    if (n === 1 || n === 3) return { status: 529, text: "overloaded" };
    return n === 2 ? sse(streamEvents()) : { json: { content: [{ type: "text", text: "{\"a\":1}" }], stop_reason: "end_turn", usage: {} } };
  });
  assert.equal(await anthropic.stream({ model: "m", system: "S", messages: [] }), "Hello");
  assert.deepEqual(await anthropic.json({ model: "m", system: "S", prompt: "P", schema: anthropic.S.obj({ a: anthropic.S.int }) }), { a: 1 });
  assert.deepEqual(sleeps, [2000, 2000]);
});

test("stream and json error messages never contain a key", async (t) => {
  stubSleep();
  useFetch(t, () => ({ status: 401, text: "bad key a-test" }));
  await assert.rejects(anthropic.stream({ model: "m", system: "S", messages: [] }), (e) => {
    assert.match(e.message, /^Anthropic 401: /);
    assert.ok(!e.message.includes("a-test"));
    return true;
  });
  await assert.rejects(anthropic.json({ model: "m", system: "S", prompt: "P", schema: {} }), (e) => {
    assert.match(e.message, /^Anthropic 401: /);
    assert.ok(!e.message.includes("a-test"));
    return true;
  });
});

test("stream and json turn a fetch failure into a retryable ProviderError, with no cause", async (t) => {
  useFetch(t, () => { throw new TypeError("fetch failed"); });
  const check = (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, "anthropic");
    assert.equal(e.retryable, true);
    assert.equal(e.message, "Anthropic request failed: fetch failed");
    assert.equal(e.cause, undefined);
    return true;
  };
  await assert.rejects(anthropic.stream({ model: "m", system: "S", messages: [] }), check);
  await assert.rejects(anthropic.json({ model: "m", system: "S", prompt: "P", schema: {} }), check);
});

test("a stream error event is redacted too", async (t) => {
  useFetch(t, () => sse([{ type: "error", error: { type: "authentication_error", message: "key a-test is bad" } }]));
  await assert.rejects(anthropic.stream({ model: "m", system: "S", messages: [] }), (e) => {
    assert.match(e.message, /^Anthropic stream error: /);
    assert.ok(!e.message.includes("a-test"));
    return true;
  });
});

// ---------------------------------------------------------------- index

test("hasKey reads the environment and knows only real providers", () => {
  assert.equal(hasKey("anthropic"), true);
  assert.equal(hasKey("openai"), true);
  assert.equal(hasKey("google"), true);
  assert.equal(hasKey("human"), false);
  assert.equal(hasKey("carrier-pigeon"), false);
  assert.equal(hasKey("constructor"), false);
  assert.equal(hasKey(undefined), false);
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try { assert.equal(hasKey("openai"), false); } finally { process.env.OPENAI_API_KEY = saved; }
});

test("resolveModel order", () => {
  assert.equal(resolveModel("openai", { override: "gpt-6-luna", seatModel: "gpt-6.1-terra" }), "gpt-6-luna");
  assert.equal(resolveModel("openai", { seatModel: "gpt-6.1-terra" }), "gpt-6.1-terra");
  process.env.OPENAI_SEAT_MODEL = "gpt-6-astra";
  assert.equal(resolveModel("openai"), "gpt-6-astra");
  delete process.env.OPENAI_SEAT_MODEL;
  assert.equal(resolveModel("openai"), "gpt-6.1-sol");
  assert.equal(resolveModel("human"), null);
});

test("resolveModel for each provider, with empty values skipped", () => {
  assert.equal(resolveModel("anthropic"), "claude-sonnet-5-5");
  assert.equal(resolveModel("google"), "gemini-3.8-flash");
  process.env.SEAT_MODEL = "claude-opus-5-5";
  process.env.GEMINI_SEAT_MODEL = "gemini-3.6-flash";
  try {
    assert.equal(resolveModel("anthropic"), "claude-opus-5-5");
    assert.equal(resolveModel("google"), "gemini-3.6-flash");
    assert.equal(resolveModel("google", { override: "", seatModel: null }), "gemini-3.6-flash");
    assert.equal(resolveModel("google", { override: undefined, seatModel: "gemini-4-argon" }), "gemini-4-argon");
  } finally {
    delete process.env.SEAT_MODEL;
    delete process.env.GEMINI_SEAT_MODEL;
  }
  assert.equal(resolveModel("carrier-pigeon"), null);
  assert.equal(resolveModel("constructor"), null);
});

test("complete tallies providerUsage", async (t) => {
  stubSleep();
  // Earlier tests also call complete(), so compare against a snapshot, not against zero.
  assert.deepEqual(Object.keys(providerUsage).sort(), ["google", "openai"]);
  const snap = () => structuredClone(providerUsage);
  const delta = (a, b, p) => ({
    input: b[p].input - a[p].input, output: b[p].output - a[p].output,
    cacheRead: b[p].cacheRead - a[p].cacheRead, calls: b[p].calls - a[p].calls,
  });
  let body = openaiReply();
  const m = useFetch(t, (url) => ({ json: url.includes("openai.com") ? body : googleReply() }));
  const s0 = snap();
  await complete("openai", { model: "m", system: "S", user: "U" });
  await complete("openai", { model: "m", system: "S", user: "U" });
  const s1 = snap();
  assert.deepEqual(delta(s0, s1, "openai"), { input: 200, output: 100, cacheRead: 160, calls: 2 });
  assert.deepEqual(delta(s0, s1, "google"), { input: 0, output: 0, cacheRead: 0, calls: 0 }, "the other provider is untouched");
  await complete("google", { model: "m", system: "S", user: "U" });
  const s2 = snap();
  assert.deepEqual(delta(s1, s2, "google"), { input: 120, output: 65, cacheRead: 30, calls: 1 });
  assert.deepEqual(delta(s1, s2, "openai"), { input: 0, output: 0, cacheRead: 0, calls: 0 });

  // A call that fails is not tallied.
  body = { ...openaiReply(), output: [] };
  await assert.rejects(complete("openai", { model: "m", system: "S", user: "U" }), /empty reply/);
  assert.deepEqual(snap(), s2);
  m.restore();
  const m2 = mockFetch(() => ({ status: 400, text: "no" }));
  try {
    await assert.rejects(complete("google", { model: "m", system: "S", user: "U" }), ProviderError);
  } finally { m2.restore(); }
  assert.deepEqual(snap(), s2);
});

test("complete defaults maxTokens per provider and honours an explicit one", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, (url) => {
    if (url.includes("openai.com")) return { json: openaiReply() };
    if (url.includes("googleapis.com")) return { json: googleReply() };
    return { json: anthropicReply() };
  });
  await complete("anthropic", { model: "m", system: "S", user: "U" });
  await complete("openai", { model: "m", system: "S", user: "U" });
  await complete("google", { model: "m", system: "S", user: "U" });
  assert.equal(calls[0].body.max_tokens, 1400);
  assert.equal(calls[1].body.max_output_tokens, 4000);
  assert.equal(calls[2].body.generationConfig.maxOutputTokens, 4000);
  await complete("openai", { model: "m", system: "S", user: "U", maxTokens: 900 });
  await complete("openai", { model: "m", system: "S", user: "U", maxTokens: undefined });
  assert.equal(calls[3].body.max_output_tokens, 900);
  assert.equal(calls[4].body.max_output_tokens, 4000, "an explicit undefined still gets the default");
});

test("complete passes the signal to fetch", async (t) => {
  stubSleep();
  const { calls } = useFetch(t, () => ({ json: openaiReply() }));
  const ctl = new AbortController();
  await complete("openai", { model: "m", system: "S", user: "U", signal: ctl.signal });
  assert.equal(calls[0].init.signal, ctl.signal);
});

test("complete throws ProviderError for human and for an unknown provider, and makes no call", async (t) => {
  const { calls } = useFetch(t, () => ({ json: {} }));
  for (const p of ["human", "carrier-pigeon", "constructor", "__proto__", undefined]) {
    await assert.rejects(complete(p, { model: "m", system: "S", user: "U" }), (e) => {
      assert.ok(e instanceof ProviderError, `${String(p)}`);
      assert.equal(e.retryable, false);
      return true;
    });
  }
  assert.equal(calls.length, 0);
});

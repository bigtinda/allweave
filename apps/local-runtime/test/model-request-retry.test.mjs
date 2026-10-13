import assert from "node:assert/strict";
import { test } from "node:test";
import { completeWithTransientRetry, modelAvailabilityHint } from "../src/model-request-retry.mjs";

const unavailable = { stopReason: "error", content: [], errorMessage: '429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}' };

test("transient upstream unavailability retries within a bound and returns recovered completion", async () => {
  let calls = 0;
  const waits = [];
  const recovered = { stopReason: "stop", content: [{ type: "text", text: "OK" }] };
  const result = await completeWithTransientRetry(() => ++calls < 3 ? unavailable : recovered, { wait: async (ms) => { waits.push(ms); } });
  assert.equal(result.completion, recovered);
  assert.equal(result.attempts, 3);
  assert.deepEqual(waits, [1000, 2500]);
  const failed = await completeWithTransientRetry(() => unavailable, { wait: async () => {} });
  assert.equal(failed.attempts, 3);
  assert.equal(failed.completion, unavailable);
  assert.match(modelAvailabilityHint(failed.completion.errorMessage, failed.attempts), /已尝试 3 次/);
});

test("auth, quota, abort, and partially generated responses are not replayed", async () => {
  for (const completion of [
    { ...unavailable, errorMessage: "401: invalid key" },
    { ...unavailable, errorMessage: "429: insufficient quota" },
    { ...unavailable, errorMessage: "429: rate limit" },
    { ...unavailable, stopReason: "aborted" },
    { ...unavailable, content: [{ type: "text", text: "partial answer" }] },
    { ...unavailable, content: [{ type: "toolCall", name: "send_agent_message" }] },
  ]) {
    let calls = 0;
    await completeWithTransientRetry(() => { calls++; return completion; }, { wait: async () => { throw new Error("must not wait"); } });
    assert.equal(calls, 1);
  }
});

test("total deadline stops retries without reporting attempts that were never made", async () => {
  let time = 0;
  const result = await completeWithTransientRetry(({ timeoutMs }) => {
    assert.equal(timeoutMs, 120000);
    time = 120000;
    return unavailable;
  }, { now: () => time, wait: async () => { throw new Error("must not wait beyond deadline"); } });
  assert.equal(result.attempts, 1);
});

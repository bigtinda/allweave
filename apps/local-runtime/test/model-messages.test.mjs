import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { toModelMessages } from "../src/model-messages.mjs";

test("multi-turn browser history is usable by the actual Pi context estimator", () => {
  const history = [{ role: "user", content: "你好", timestamp: 1 }, { role: "assistant", content: "你好，请继续", timestamp: 2 }, { role: "user", content: "继续讨论需求", timestamp: 3 }];
  assert.throws(() => estimateContextTokens(history), /totalTokens/);
  const model = { id: "step-5-preview-free", provider: "opencode-go", api: "openai-completions" };
  const converted = toModelMessages(history, model);
  assert.ok(estimateContextTokens(converted).tokens > 0);
  assert.deepEqual(converted[1].content, [{ type: "text", text: history[1].content }]);
  assert.equal(converted[1].usage.totalTokens, 0);
  assert.equal(typeof history[1].content, "string");
  assert.equal(history[1].usage, undefined);
});

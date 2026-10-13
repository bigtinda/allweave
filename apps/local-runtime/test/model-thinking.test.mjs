import assert from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels, normalizeThinkingLevel } from "../src/model-thinking.mjs";

test("thinking selection preserves provider defaults and rejects unsupported effort", () => {
  const standard = { reasoning: true };
  assert.equal(normalizeThinkingLevel(undefined, standard), undefined);
  assert.equal(normalizeThinkingLevel("default", standard), undefined);
  for (const level of ["off", "minimal", "low", "medium", "high"]) assert.equal(normalizeThinkingLevel(level, standard), level);
  for (const level of ["xhigh", "max", "invalid", 4, null, {}]) assert.throws(() => normalizeThinkingLevel(level, standard), /不支持/);
  assert.deepEqual(getSupportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.throws(() => normalizeThinkingLevel("high", { reasoning: false }), /不支持/);
});

test("thinking options respect model-specific disabled and extended levels", () => {
  const mapped = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: null } };
  assert.deepEqual(getSupportedThinkingLevels(mapped), ["high", "xhigh"]);
  assert.equal(normalizeThinkingLevel("xhigh", mapped), "xhigh");
  assert.throws(() => normalizeThinkingLevel("off", mapped), /不支持/);
  assert.throws(() => normalizeThinkingLevel("max", mapped), /不支持/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildValidationCheck, isValidationCommand, presentHistoricalValidation } from "../src/validation-checks.mjs";
test("documents are not applicable while unverified source output remains not run", () => {
  assert.equal(buildValidationCheck([{ path: "风险清单.md" }]).status, "not_applicable");
  assert.equal(buildValidationCheck([{ path: "src/main.ts" }], [], true).status, "not_run");
  assert.equal(buildValidationCheck([]).status, "not_run");
});
test("verification requires actual commands and records unsuccessful exits", () => {
  assert.equal(isValidationCommand("node", ["--check", "main.js"]), true);
  assert.equal(isValidationCommand("npm.cmd", ["run", "lint"]), true);
  assert.equal(isValidationCommand("node", ["--version"]), false);
  assert.equal(buildValidationCheck([{ path: "main.js" }], [{ command: "node --version", validation: false, exitCode: 0, durationMs: 1 }]).status, "not_run");
  const failed = buildValidationCheck([{ path: "main.js" }], [{ command: "node --check main.js", validation: true, exitCode: 1, durationMs: 10 }]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.evidence[0].exitCode, 1);
});
test("old placeholder messages are corrected without inventing historical command success", () => {
  const old = { id: "automated_tests", status: "not_run", details: "当前 AgentSession 没有命令执行工具，未运行编译、Lint 或测试。", evidence: [] };
  assert.equal(presentHistoricalValidation(old, [{ path: "风险清单.md" }]).status, "not_applicable");
  assert.equal(presentHistoricalValidation(old, [{ path: "main.js" }]).status, "not_run");
  assert.match(presentHistoricalValidation(old, [{ path: "main.js" }]).details, /未保存验证命令记录/);
});

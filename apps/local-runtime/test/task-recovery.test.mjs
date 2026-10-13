import { test } from "node:test";
import assert from "node:assert/strict";
import { planTaskRecovery } from "../src/task-recovery.mjs";
test("transient failures back off and stop after two automatic attempts", () => {
  const first = planTaskRecovery("Connection error.", 0, 0);
  const second = planTaskRecovery("429 Endpoint is unavailable", 1, 0);
  assert.equal(Date.parse(first.nextRetryAt), 20000);
  assert.equal(Date.parse(second.nextRetryAt), 40000);
  assert.equal(planTaskRecovery("Connection error.", 2).nextRetryAt, null);
});
test("output and timeout failures allow one repair while configuration and cancellation require user action", () => {
  assert.equal(planTaskRecovery("任务客观检查未通过：required_output、output_integrity", 0).kind, "output");
  assert.equal(planTaskRecovery("任务执行超时：30 分钟运行上限", 0).limit, 1);
  assert.equal(planTaskRecovery("任务执行超时", 1).nextRetryAt, null);
  for (const error of ["403 权限不足", "用户取消任务", "用户拒绝指令", "无法识别的错误"]) assert.equal(planTaskRecovery(error).nextRetryAt, null);
});

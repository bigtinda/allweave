import { test } from "node:test";
import assert from "node:assert/strict";
import { taskSessionTimeoutMs, assertTaskSessionFinished } from "../src/task-session-limit.mjs";

test("research tasks get a thirty minute budget with bounded configuration", () => {
	assert.equal(taskSessionTimeoutMs(undefined), 1800000);
	assert.equal(taskSessionTimeoutMs("invalid"), 1800000);
	assert.equal(taskSessionTimeoutMs("5000"), 1800000);
	assert.equal(taskSessionTimeoutMs("3600000"), 3600000);
});
test("timeout and aborted sessions stop before output validation", () => {
	assert.throws(() => assertTaskSessionFinished({ stopReason: "aborted" }, { timedOut: true, timeoutMs: 1800000, aborted: false }), /任务执行超时.*30 分钟/);
	assert.throws(() => assertTaskSessionFinished({ stopReason: "aborted" }, { timedOut: false, timeoutMs: 1800000, aborted: false }), /任务执行已中断/);
	assert.throws(() => assertTaskSessionFinished({ stopReason: "stop" }, { timedOut: false, timeoutMs: 1800000, aborted: true }), /任务执行已中断/);
	assert.doesNotThrow(() => assertTaskSessionFinished({ stopReason: "stop" }, { timedOut: false, timeoutMs: 1800000, aborted: false }));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRunActivity } from "../src/run-activity.mjs";
const run = { taskId: "TASK-001", runNumber: 1, status: "running", startedAt: "2026-10-12T12:00:00Z", finishedAt: null };
const event = (type, details = {}, createdAt = "2026-10-12T12:00:10Z") => ({ type, details, createdAt });
test("activity follows reasoning, output and active commands and files", () => {
  assert.equal(deriveRunActivity(run, [event("reasoning_started")]).phase, "思考中");
  assert.equal(deriveRunActivity(run, [event("model_output")]).phase, "输出中");
  const events = [event("tool_started", { toolCallId: "a", toolName: "execute_command" }), event("tool_started", { toolCallId: "b", toolName: "write_project_file" })];
  assert.equal(deriveRunActivity(run, events).phase, "运行命令中");
  events.push(event("tool_finished", { toolCallId: "a" }));
  assert.equal(deriveRunActivity(run, events).phase, "编辑文件中");
  events.push(event("tool_finished", { toolCallId: "b" }));
  assert.equal(deriveRunActivity(run, events).phase, "生成中");
});
test("completed activity overrides in-flight tools and freezes elapsed time at agent completion", () => {
  const activity = deriveRunActivity({ ...run, status: "completed", finishedAt: "2026-10-12T12:05:00Z" }, [event("tool_started", { toolCallId: "a", toolName: "execute_command" }), event("agent_completed"), event("completed", {}, "2026-10-12T12:05:00Z")]);
  assert.equal(activity.phase, "完成");
  assert.equal(activity.running, false);
  assert.equal(activity.endedAt, "2026-10-12T12:00:10Z");
});

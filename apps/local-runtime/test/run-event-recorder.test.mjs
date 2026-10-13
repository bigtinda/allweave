import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunEventRecorder } from "../src/run-event-recorder.mjs";

test("records text before tools, including command arguments and results", () => {
	const events = [];
	const recorder = createRunEventRecorder((type, details) => events.push({ type, details }));
	recorder.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "正在读取项目" } });
	recorder.handle({ type: "tool_execution_start", toolCallId: "a", toolName: "execute_command", args: { executable: "node", args: ["--version"] } });
	recorder.handle({ type: "tool_execution_end", toolCallId: "a", toolName: "execute_command", result: { content: [{ type: "text", text: "v24" }] }, isError: false, durationMs: 20 });
	recorder.flush();
	assert.deepEqual(events.map((event) => event.type), ["model_output", "tool_started", "tool_finished"]);
	assert.equal(events[0].details.text, "正在读取项目");
	assert.deepEqual(events[1].details.arguments.args, ["--version"]);
	assert.equal(events[2].details.result.content[0].text, "v24");
});

test("persists reasoning status but excludes reasoning content and credentials", () => {
	const events = [];
	const recorder = createRunEventRecorder((type, details) => events.push({ type, details }));
	for (const type of ["thinking_start", "thinking_delta", "thinking_end"]) recorder.handle({ type: "message_update", assistantMessageEvent: { type, content: "PRIVATE_REASONING", delta: "PRIVATE_REASONING" } });
	recorder.handle({ type: "tool_execution_start", toolCallId: "a", toolName: "tool", args: { apiKey: "secret-value", header: "Bearer secret-value" } });
	recorder.flush();
	assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["reasoning_started", "reasoning_finished"]);
	assert.ok(!JSON.stringify(events).includes("PRIVATE_REASONING"));
	assert.ok(!JSON.stringify(events).includes("secret-value"));
});

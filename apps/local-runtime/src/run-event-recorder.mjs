// Record observable execution activity without persisting private reasoning blocks.
export function createRunEventRecorder(append) {
	let pending = "";
	let timer;
	let reasoningStartedAt = 0;
	const clean = (value) => JSON.parse(JSON.stringify(value ?? {}, (key, item) => {
		if (/password|secret|token|authorization|api.?key|thinking|reasoning/i.test(key)) return "[已隐藏]";
		if (typeof item === "string") return item.replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]").slice(0, 16000);
		return item;
	}));
	const flush = () => {
		clearTimeout(timer);
		timer = undefined;
		if (pending) { append("model_output", clean({ text: pending })); pending = ""; }
	};
	const record = (type, details) => { flush(); append(type, clean(details)); };
	return {
		handle(event) {
			if (event.type === "message_update") {
				const update = event.assistantMessageEvent;
				if (update?.type === "text_delta") {
					pending += update.delta || "";
					if (pending.length >= 8000) flush();
					else if (!timer) timer = setTimeout(flush, 300);
				} else if (update?.type === "thinking_start") {
					reasoningStartedAt = Date.now(); record("reasoning_started", {});
				} else if (update?.type === "thinking_end") {
					record("reasoning_finished", { durationMs: reasoningStartedAt ? Date.now() - reasoningStartedAt : undefined });
					reasoningStartedAt = 0;
				}
			} else if (event.type === "tool_execution_start") {
				record("tool_started", { toolCallId: event.toolCallId, toolName: event.toolName, arguments: event.args });
			} else if (event.type === "tool_execution_update") {
				record("tool_output", { toolCallId: event.toolCallId, toolName: event.toolName, result: event.partialResult });
			} else if (event.type === "tool_execution_end") {
				record("tool_finished", { toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, durationMs: event.durationMs });
			} else if (event.type === "auto_retry_start") {
				record("retry", { attempt: event.attempt, delayMs: event.delayMs, error: event.errorMessage });
			} else if (event.type === "agent_start" || event.type === "turn_start") record(event.type, {});
			else if (event.type === "message_end" || event.type === "agent_end") flush();
		},
		flush,
	};
}

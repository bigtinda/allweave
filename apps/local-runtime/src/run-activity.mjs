export function deriveRunActivity(run, events) {
	const labels = { completed: "完成", agent_completed: "待审核", failed: "失败", cancelled: "已取消", interrupted: "中断待核验" };
	let phase = "请求模型中";
	const tools = new Map();
	for (const event of events) {
		const details = event.details || {};
		if (event.type === "tool_started") tools.set(details.toolCallId, details.toolName);
		if (event.type === "tool_finished") { tools.delete(details.toolCallId); phase = "生成中"; }
		if (event.type === "reasoning_started") phase = "思考中";
		if (event.type === "reasoning_finished") phase = "生成中";
		if (event.type === "model_output") phase = "输出中";
		if (event.type === "turn_start") phase = "请求模型中";
		if (event.type === "retry") phase = "重试中";
		if (event.type === "objective_checks_completed") phase = "检查产物中";
	}
	if (tools.size) {
		const names = [...tools.values()];
		phase = names.includes("execute_command") ? "运行命令中" : names.some((name) => /write|create|edit|delete/.test(name || "")) ? "编辑文件中" : names.some((name) => /read|list_project_files/.test(name || "")) ? "读取文件中" : names.some((name) => /search/.test(name || "")) ? "检索中" : "调用工具中";
	}
	const ended = events.find((event) => ["agent_completed", "completed", "failed", "cancelled", "interrupted"].includes(event.type));
	return { taskId: run.taskId, runNumber: run.runNumber, phase: run.status === "failed" && events.some((event) => event.type === "execution_timeout") ? "执行超时" : labels[run.status] || phase, startedAt: run.startedAt, endedAt: ended?.createdAt || run.finishedAt || null, running: run.status === "running" };
}

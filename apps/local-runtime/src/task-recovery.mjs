export function planTaskRecovery(error, previousAttempts = 0, now = Date.now()) {
	const message = String(error || "");
	const attempts = Math.max(0, Number(previousAttempts) || 0);
	let kind = "manual", limit = 0, action = "检查错误详情后重试";
	if (/取消|用户拒绝|已中断|aborted/i.test(message)) { kind = "cancelled"; action = "确认后手动重试"; }
	else if (/401|403|凭证|权限|未启用|未授权|模型配置|模型不存在|负责人.*不存在/i.test(message)) { kind = "configuration"; action = "修正 Agent 模型或权限配置后重试"; }
	else if (/Connection error|ECONN|ETIMEDOUT|fetch failed|429|502|503|504|端点.*不可用|Endpoint.*unavailable/i.test(message)) { kind = "network"; limit = 2; action = "等待连接恢复后重试"; }
	else if (/任务执行超时|运行上限/.test(message)) { kind = "timeout"; limit = 1; action = "参考上次部分成果继续执行"; }
	else if (/required_output|output_integrity|未创建任务文件/.test(message)) { kind = "output"; limit = 1; action = "检查输出路径并补齐交付文件"; }
	const retryable = attempts < limit;
	return { kind, attempts, limit, action, nextRetryAt: retryable ? new Date(now + (kind === "network" ? 20000 * 2 ** attempts : 10000)).toISOString() : null };
}

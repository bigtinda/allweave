export function taskSessionTimeoutMs(value) {
	const configured = Number(value);
	return Number.isSafeInteger(configured) && configured >= 60000 && configured <= 7200000 ? configured : 30 * 60 * 1000;
}

export function assertTaskSessionFinished(message, { timedOut, timeoutMs, aborted }) {
	if (timedOut) throw new Error(`任务执行超时：已达到 ${Math.round(timeoutMs / 60000)} 分钟运行上限，Agent 尚未完成。已写入的文件保留在当前 Run 目录；请重试任务或调整运行模型。`);
	if (aborted || message?.stopReason === "aborted") throw new Error("任务执行已中断，Agent 尚未完成；已写入的文件保留在当前 Run 目录。");
}

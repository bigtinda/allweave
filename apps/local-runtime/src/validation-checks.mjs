const documentationFile = (path) => /\.(md|txt|rst|pdf|docx?|xlsx?|pptx?|csv)$/i.test(path || "");
export function isValidationCommand(executable, args) {
	const name = executable.toLowerCase().replace(/\.(cmd|exe)$/, "");
	if (["tsc", "eslint", "pytest", "ruff", "mypy", "vitest", "jest"].includes(name)) return true;
	if (["npm", "pnpm", "yarn", "bun"].includes(name)) return args.some((arg) => /^(test|test:[\w-]+|build|lint|typecheck|check)$/.test(arg));
	if (name === "node") return args.includes("--check") || args.includes("--test");
	if (["python", "python3", "py"].includes(name)) return args.some((arg, index) => arg === "-m" && ["pytest", "compileall", "py_compile", "unittest"].includes(args[index + 1]));
	return false;
}
export function buildValidationCheck(files, executions = [], commandEnabled = false) {
	const evidence = executions.filter((item) => item.validation === true).map(({ command, exitCode, durationMs }) => ({ command, exitCode, durationMs }));
	if (evidence.length) return { id: "automated_tests", label: "编译、Lint 与测试", status: evidence.every((item) => item.exitCode === 0) ? "passed" : "failed", details: `已执行 ${evidence.length} 条验证命令，${evidence.every((item) => item.exitCode === 0) ? "退出码均为 0" : "存在执行失败"}。`, evidence };
	const documentsOnly = files.length > 0 && files.every((file) => documentationFile(file.path));
	return { id: "automated_tests", label: "编译、Lint 与测试", status: documentsOnly ? "not_applicable" : "not_run", details: documentsOnly ? "本 Run 产物为文档，不适用代码编译、Lint 或测试。" : commandEnabled ? "本 Run 尚未执行编译、Lint 或测试命令。" : "本 Run 未启用命令权限，尚未执行编译、Lint 或测试。", evidence: [] };
}
export function presentHistoricalValidation(check, files) {
	if (check.id !== "automated_tests" || check.status !== "not_run" || !check.details?.includes("当前 AgentSession 没有命令执行工具")) return check;
	const documentsOnly = files.length > 0 && files.every((file) => documentationFile(file.path));
	return { ...check, status: documentsOnly ? "not_applicable" : "not_run", details: documentsOnly ? "本 Run 产物为文档，不适用代码编译、Lint 或测试。" : "此历史 Run 未保存验证命令记录，无法确认是否已运行编译、Lint 或测试。" };
}

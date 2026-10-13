import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const requirementsPath = fileURLToPath(new URL("./wps-office-mcp-requirements.txt", import.meta.url));
const importCheck = "import sys; assert sys.version_info >= (3, 10); from mcp.server.fastmcp import FastMCP; import docx, openpyxl, pptx";
const pythonVersionCheck = "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)";

async function canRun(python, prefix = []) {
	try {
		await execFileAsync(python, [...prefix, "-c", importCheck], { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 });
		return true;
	} catch { return false; }
}

export async function prepareWpsOfficeMcpRuntime(stateDirectory) {
	const configuredPython = process.env.AI_TEAM_PYTHON || process.env.PYTHON;
	const candidates = [
		...(configuredPython ? [{ executable: configuredPython, prefix: [] }] : []),
		{ executable: process.platform === "win32" ? "python" : "python3", prefix: [] },
		...(process.platform === "win32" ? [{ executable: "py", prefix: ["-3"] }] : []),
	];
	const seen = new Set();
	for (const candidate of candidates) {
		const key = `${candidate.executable}\0${candidate.prefix.join("\0")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (await canRun(candidate.executable, candidate.prefix)) return { executable: candidate.executable, prefix: candidate.prefix };
	}

	let python;
	for (const candidate of candidates) {
		try {
			await execFileAsync(candidate.executable, [...candidate.prefix, "-c", pythonVersionCheck], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
			python = candidate;
			break;
		} catch { }
	}
	if (!python) throw new Error("找不到 Python 3.10 或更新版本；请安装后重启本机服务");

	const venvDirectory = join(stateDirectory, "wps-office-mcp-venv");
	const venvPython = join(venvDirectory, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	await mkdir(stateDirectory, { recursive: true });
	try { await access(venvPython); }
	catch {
		await execFileAsync(python.executable, [...python.prefix, "-m", "venv", venvDirectory], { windowsHide: true, timeout: 60_000, maxBuffer: 512 * 1024 });
	}
	if (!await canRun(venvPython)) {
		await execFileAsync(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", requirementsPath], {
			windowsHide: true,
			timeout: 5 * 60_000,
			maxBuffer: 2 * 1024 * 1024,
		});
	}
	if (!await canRun(venvPython)) throw new Error("WPS 文档处理依赖安装后仍无法加载，请检查 Python 安装和网络连接");
	return { executable: venvPython, prefix: [] };
}

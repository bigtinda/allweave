import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { taskFileBytesLimit, taskFileContentBytes, taskOutputTotalBytesLimit } from "./task-file-content.mjs";
import { buildValidationCheck } from "./validation-checks.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function isWithinPath(root, target) {
	const path = relative(root, target);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function safeSegments(value) {
	if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || isAbsolute(value) || win32.isAbsolute(value)) return null;
	const segments = value.split("/");
	if (segments.length > 8 || segments.some((part) => !part || part === "." || part === ".." || part.length > 180 || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part))) return null;
	return segments;
}

const check = (id, label, status, details, evidence = []) => ({ id, label, status, details, evidence });

async function resolveRegularFile(root, segments) {
	let current = root;
	for (let index = 0; index < segments.length; index++) {
		current = resolve(current, segments[index]);
		const info = await lstat(current);
		if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error("路径包含链接或非普通文件");
		const actual = await realpath(current);
		if (!isWithinPath(root, actual)) throw new Error("文件路径超出任务 Run 目录");
		current = actual;
	}
	return current;
}

export async function checkTaskRunOutputs({ projectRoot, taskRoot, outputDirectory, taskId, runNumber, projectId, files, authorization, commandChecks = [], commandEnabled = false }) {
	const authorizationMatches = authorization?.status === "in_progress"
		&& authorization.operation === "task.execute"
		&& authorization.payload?.projectId === projectId
		&& authorization.payload?.taskId === taskId;
	const authorizationCheck = check(
		"authorization_binding",
		"任务出站授权",
		authorizationMatches ? "passed" : "failed",
		authorizationMatches ? "Runtime 核对了已批准的任务执行授权与项目、任务绑定。" : "任务执行授权与当前项目或任务不匹配。",
		authorizationMatches ? [{ authorizationId: authorization.id, operation: authorization.operation }] : [],
	);

	let resolvedProjectRoot = "";
	let resolvedTaskRoot = "";
	let runDirectoryOk = false;
	try {
		resolvedProjectRoot = await realpath(projectRoot);
		const baseSegments = [outputDirectory, taskId, `Run-${runNumber}`];
		let current = resolvedProjectRoot;
		for (const segment of baseSegments) {
			current = resolve(current, segment);
			const info = await lstat(current);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Run 目录包含链接或非目录文件");
			current = await realpath(current);
			if (!isWithinPath(resolvedProjectRoot, current)) throw new Error("Run 目录超出项目目录");
		}
		resolvedTaskRoot = current;
		const suppliedRoot = await realpath(taskRoot);
		const samePath = process.platform === "win32" ? suppliedRoot.toLowerCase() === resolvedTaskRoot.toLowerCase() : suppliedRoot === resolvedTaskRoot;
		runDirectoryOk = samePath;
	} catch {
		runDirectoryOk = false;
	}
	const directoryCheck = check(
		"run_directory",
		"Run 目录范围",
		runDirectoryOk ? "passed" : "failed",
		runDirectoryOk ? "实际输出目录与项目、任务及 Run 编号一致，且位于项目目录内。" : "实际输出目录不存在、越界或与当前任务 Run 不匹配。",
		runDirectoryOk ? [{ scope: [outputDirectory, taskId, `Run-${runNumber}`].join("/") }] : [],
	);

	const sourceFiles = Array.isArray(files) ? files : [];
	let submittedTotalBytes = 0;
	const validInput = runDirectoryOk && sourceFiles.length > 0 && sourceFiles.length <= 40 && sourceFiles.every((file) => {
		if (typeof file?.content !== "string" || !safeSegments(file.path)) return false;
		try {
			const bytes = taskFileContentBytes(file.path, file.content, file.contentEncoding);
			if (bytes.byteLength > taskFileBytesLimit(file.path)) return false;
			submittedTotalBytes += bytes.byteLength;
			return submittedTotalBytes <= taskOutputTotalBytesLimit;
		}
		catch { return false; }
	});
	const requiredOutputCheck = check(
		"required_output",
		"必需产物",
		validInput ? "passed" : "failed",
		validInput ? `Run 包含 ${sourceFiles.length} 个路径有效的产物文件。` : "Run 没有产物，或产物数量、路径或内容无效。",
	);

	const seen = new Set();
	const verifiedFiles = [];
	let integrityOk = runDirectoryOk && validInput;
	if (integrityOk) {
		for (const file of sourceFiles) {
			const segments = safeSegments(file.path);
			const normalizedPath = segments.join("/");
			const key = normalizedPath.toLocaleLowerCase("en-US");
			if (seen.has(key)) {
				integrityOk = false;
				break;
			}
			seen.add(key);
			try {
				const target = await resolveRegularFile(resolvedTaskRoot, segments);
				const actualBytes = await readFile(target);
				const submittedBytes = taskFileContentBytes(normalizedPath, file.content, file.contentEncoding);
				const actualHash = hash(actualBytes);
				const submittedHash = hash(submittedBytes);
				if (actualHash !== submittedHash || actualBytes.byteLength !== submittedBytes.byteLength) {
					integrityOk = false;
					break;
				}
				verifiedFiles.push({ path: normalizedPath, sha256: actualHash, bytes: actualBytes.byteLength });
			} catch {
				integrityOk = false;
				break;
			}
		}
	}
	const integrityCheck = check(
		"output_integrity",
		"产物文件完整性",
		integrityOk ? "passed" : "failed",
		integrityOk ? "Runtime 从磁盘重新读取每个文件，并核对内容、字节数及 SHA-256。" : "至少一个产物文件缺失、路径不安全，或磁盘内容与提交内容不一致。",
		integrityOk ? verifiedFiles : [],
	);
	const automatedChecks = buildValidationCheck(sourceFiles, commandChecks, commandEnabled);
	return {
		checks: [authorizationCheck, directoryCheck, requiredOutputCheck, integrityCheck, automatedChecks],
		verifiedFiles,
		passed: authorizationMatches && runDirectoryOk && validInput && integrityOk && automatedChecks.status !== "failed",
	};
}


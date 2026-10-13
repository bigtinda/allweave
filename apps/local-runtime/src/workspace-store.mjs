import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
import { createOpenCodeSessionId, isOpenCodeSessionId } from "@earendil-works/pi-ai/providers/opencode-headers";
import { taskFileBytesLimit, taskFileContentBytes } from "./task-file-content.mjs";
import { planTaskRecovery } from "./task-recovery.mjs";

const taskStatuses = new Set(["待分配", "执行中", "待审核", "返工中", "失败", "已完成", "已撤销"]);
const artifactStatuses = new Set(["参考", "待审核", "已通过"]);
const artifactKinds = new Set(["会议记录", "设计文档", "源代码", "测试报告", "交付文件"]);
const projectStatuses = new Set(["配置中", "进行中", "已验收"]);
const meetingStatuses = new Set(["需求确认中", "计划待审批", "已批准"]);
const deliveryStatuses = new Set(["未发布", "待验收", "已验收"]);
const versionStatuses = new Set(["待验收", "已验收"]);
const runGitFile = promisify(execFile);
const folderForKind = new Map([
	["会议记录", "01_需求文档"], ["设计文档", "02_设计文档"], ["源代码", "03_源代码"],
	["测试报告", "04_测试报告"], ["交付文件", "05_最终交付"],
]);
const projectFolders = new Set(folderForKind.values());
const defaultExcludedPaths = [".env*", "**/secrets/**", "**/*credential*"];
const egressApprovalModes = new Set(["每次确认", "项目范围内"]);

function sameFileIdentity(left, right) {
	return left.isFile() && right.isFile() && left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}

function sameDirectoryIdentity(left, right) {
	return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}

function isPathWithin(root, target) {
	const path = relative(root, target);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

const execGit = async (root, args) => runGitFile("git", args, { cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });

export async function addGitExcludes(root, patterns = []) {
	const { stdout } = await execGit(root, ["rev-parse", "--git-path", "info/exclude"]);
	const excludePath = resolve(root, stdout.trim());
	await mkdir(dirname(excludePath), { recursive: true });
	let current = "";
	try { current = await readFile(excludePath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
	const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
	const missing = [...new Set([...defaultExcludedPaths, ...patterns].filter((item) => typeof item === "string" && item.trim() && !/[\r\n]/.test(item)).map((item) => item.trim()))].filter((item) => !existing.has(item));
	if (missing.length) await writeFile(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}# AI Agent Team protected workspace paths\n${missing.join("\n")}\n`, "utf8");
}

async function projectRoot(state) {
	const configured = state?.project?.workspacePath;
	if (typeof configured !== "string" || !isAbsolute(configured)) throw new WorkspaceRuleError("项目没有有效的本机文件夹，无法写入文件或创建 Git 版本");
	let root;
	try { root = await realpath(configured); } catch { throw new WorkspaceRuleError("项目文件夹不可访问，请检查文件夹位置"); }
	let { stdout } = await execGit(root, ["rev-parse", "--show-toplevel"]).catch(async () => {
		try { await runGitFile("git", ["init", "--quiet", root], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }); }
		catch { throw new WorkspaceRuleError("项目文件夹尚未初始化 Git 仓库，且无法自动初始化"); }
		return execGit(root, ["rev-parse", "--show-toplevel"]);
	});
	let gitRoot = await realpath(stdout.trim()).catch(() => "");
	const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
	if (!gitRoot || normalize(gitRoot) !== normalize(root)) {
		try {
			await runGitFile("git", ["init", "--quiet", root], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
			({ stdout } = await execGit(root, ["rev-parse", "--show-toplevel"]));
			gitRoot = await realpath(stdout.trim()).catch(() => "");
		} catch { throw new WorkspaceRuleError("项目文件夹必须是独立的 Git 仓库"); }
		if (!gitRoot || normalize(gitRoot) !== normalize(root)) throw new WorkspaceRuleError("项目文件夹必须是独立的 Git 仓库");
	}
	await addGitExcludes(root, state.settings?.excludedPaths ?? []);
	return root;
}

async function ensureProjectFolders(state, folders) {
	const unique = [...new Set(folders)].filter((folder) => projectFolders.has(folder));
	state.workspaceFolders = [...new Set([...(Array.isArray(state.workspaceFolders) ? state.workspaceFolders : []), ...unique])];
	if (!state.project.workspacePath || !unique.length) return;
	const root = await projectRoot(state);
	for (const folder of unique) {
		const target = resolve(root, folder);
		const pathFromRoot = relative(root, target);
		if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) throw new WorkspaceRuleError("项目分类文件夹路径无效");
		await mkdir(target, { recursive: true });
		const actual = await realpath(target);
		const actualRelative = relative(root, actual);
		if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new WorkspaceRuleError("项目分类文件夹不能指向项目目录之外");
	}
}

function safeFileName(input) {
	const name = String(input ?? "").trim().split(/[\\/]/).pop()?.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 180);
	if (!name || name === "." || name === "..") throw new WorkspaceRuleError("交付物文件名无效");
	return name;
}

function safeTaskFileSegments(input) {
	if (typeof input !== "string" || input.includes("\0") || isAbsolute(input) || win32.isAbsolute(input)) throw new WorkspaceRuleError("Agent 输出文件必须使用项目内相对路径");
	const parts = input.replaceAll("\\", "/").split("/");
	if (!parts.length || parts.length > 8 || parts.some((part) => !part || part === "." || part === ".." || part.length > 180 || /[<>:\"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(\.git|\.env(?:\..*)?|node_modules|secrets?)$/i.test(part) || /(credential|token|api.?key|private.?key)/i.test(part))) {
		throw new WorkspaceRuleError("Agent 输出路径包含无效或受保护的文件名");
	}
	return parts;
}

const interruptedRunFileLimit = 40;
const interruptedRunFileBytesLimit = 1024 * 1024;
const interruptedRunTotalBytesLimit = 5 * 1024 * 1024;
const interruptedRunEntryLimit = 512;

async function scanInterruptedRunFiles(state, task, fileSystemHooks = {}) {
	const root = await projectRoot(state);
	const runNumber = Number(task.run);
	if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new WorkspaceRuleError("中断 Run 编号无效");
	const runParts = safeTaskFileSegments(`${task.outputDirectory}/${task.id}/Run-${runNumber}`);
	let runRoot = root;
	for (const part of runParts) {
		const next = join(runRoot, part);
		let info;
		try { info = await lstat(next); }
		catch (error) { if (error.code === "ENOENT") return { files: [], skippedCount: 0 }; throw error; }
		if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspaceRuleError("中断 Run 输出目录包含符号链接或非目录文件");
		const actual = await realpath(next);
		const withinRoot = relative(root, actual);
		if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) throw new WorkspaceRuleError("中断 Run 输出目录超出项目文件夹");
		runRoot = actual;
	}

	const files = [];
	const seenPaths = new Set();
	let skippedCount = 0;
	let totalBytes = 0;
	let visitedEntries = 0;
	const insideProject = (absolutePath) => {
		const pathFromRoot = relative(root, absolutePath);
		return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
	};
	async function visit(directory, parentParts = []) {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const entry of entries) {
			if (visitedEntries >= interruptedRunEntryLimit) {
				skippedCount += entries.length - entries.indexOf(entry);
				return;
			}
			visitedEntries++;
			const parts = [...parentParts, entry.name];
			let relativeFilePath;
			try { relativeFilePath = safeTaskFileSegments(parts.join("/")).join("/"); }
			catch { skippedCount++; continue; }
			const key = relativeFilePath.toLocaleLowerCase("en-US");
			if (seenPaths.has(key)) { skippedCount++; continue; }
			seenPaths.add(key);
			const absolutePath = join(directory, entry.name);
			let info;
			try { info = await lstat(absolutePath); }
			catch { skippedCount++; continue; }
			if (info.isSymbolicLink()) { skippedCount++; continue; }
			if (info.isDirectory()) {
				try {
					const actual = await realpath(absolutePath);
					if (!insideProject(actual)) { skippedCount++; continue; }
					await visit(actual, parts);
				} catch { skippedCount++; }
				continue;
			}
			if (!info.isFile() || files.length >= interruptedRunFileLimit || info.size > interruptedRunFileBytesLimit || totalBytes + info.size > interruptedRunTotalBytesLimit) {
				skippedCount++;
				continue;
			}
			try {
				const actual = await realpath(absolutePath);
				if (!insideProject(actual)) { skippedCount++; continue; }
				const current = await lstat(absolutePath);
				if (current.isSymbolicLink() || !current.isFile() || current.size > interruptedRunFileBytesLimit) { skippedCount++; continue; }
				await fileSystemHooks.afterInterruptedFilePathValidated?.({ absolutePath, relativeFilePath });
				const handle = await open(absolutePath, "r");
				let buffer;
				try {
					const opened = await handle.stat();
					const openedPath = await realpath(absolutePath);
					const openedPathInfo = await lstat(absolutePath);
					if (!opened.isFile() || !sameFileIdentity(current, opened) || !sameFileIdentity(opened, openedPathInfo) || openedPathInfo.isSymbolicLink() || !insideProject(openedPath) || opened.size > interruptedRunFileBytesLimit) { skippedCount++; continue; }
					const boundedBuffer = Buffer.alloc(interruptedRunFileBytesLimit + 1);
					let bytesRead = 0;
					while (bytesRead < boundedBuffer.length) {
						const result = await handle.read(boundedBuffer, bytesRead, boundedBuffer.length - bytesRead, bytesRead);
						if (!result.bytesRead) break;
						bytesRead += result.bytesRead;
					}
					if (bytesRead > interruptedRunFileBytesLimit) { skippedCount++; continue; }
					const afterRead = await handle.stat();
					const finalPath = await realpath(absolutePath);
					const finalInfo = await lstat(absolutePath);
					if (!sameFileIdentity(opened, afterRead) || opened.size !== afterRead.size || opened.mtimeMs !== afterRead.mtimeMs || !sameFileIdentity(afterRead, finalInfo) || finalInfo.isSymbolicLink() || !insideProject(finalPath)) { skippedCount++; continue; }
					buffer = boundedBuffer.subarray(0, bytesRead);
				} finally { await handle.close(); }
				if (buffer.length > interruptedRunFileBytesLimit || totalBytes + buffer.length > interruptedRunTotalBytesLimit || buffer.includes(0)) { skippedCount++; continue; }
				const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
				if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) { skippedCount++; continue; }
				totalBytes += buffer.length;
				files.push({ path: relativeFilePath, content, sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length });
			} catch { skippedCount++; }
		}
	}
	await visit(runRoot);
	return { files, skippedCount };
}

async function writeTaskFile(state, task, parts, content, contentEncoding, fileSystemHooks = {}) {
	const root = await projectRoot(state);
	let current = root;
	for (const part of [task.outputDirectory, task.id, `Run-${task.run}`, ...parts.slice(0, -1)]) {
		const next = join(current, part);
		try {
			const info = await lstat(next);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspaceRuleError("Agent 输出目录不能包含符号链接或非目录文件");
		} catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(next); }
		const actual = await realpath(next);
		const pathFromRoot = relative(root, actual);
		if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) throw new WorkspaceRuleError("Agent 输出目录超出项目文件夹");
		current = actual;
	}
	const filePath = join(current, parts.at(-1));
	let initialInfo = null;
	try {
		initialInfo = await lstat(filePath);
		if (initialInfo.isSymbolicLink() || !initialInfo.isFile()) throw new WorkspaceRuleError("Agent 只能覆盖当前 Run 目录中的普通文件");
	} catch (error) { if (error.code !== "ENOENT") throw error; }
	await fileSystemHooks.afterTaskFilePathValidated?.({ filePath, parent: current, parts: [...parts] });
	const parentRelative = relative(root, current);
	const parentParts = parentRelative ? parentRelative.split(sep) : [];
	const verifiedParent = parentParts.length ? await resolveTaskDirectory(root, parentParts) : root;
	const verifiedParentInfo = await lstat(verifiedParent);
	if (!sameDirectoryIdentity(await lstat(current), verifiedParentInfo) || !isPathWithin(root, await realpath(verifiedParent))) throw new WorkspaceRuleError("Agent 输出目录在写入期间发生变化，已拒绝写入");
	const verifiedPath = join(verifiedParent, parts.at(-1));
	let currentInfo = null;
	try { currentInfo = await lstat(verifiedPath); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	if ((initialInfo && (!currentInfo || currentInfo.isSymbolicLink() || !sameFileIdentity(initialInfo, currentInfo))) || (!initialInfo && currentInfo)) throw new WorkspaceRuleError("Agent 输出文件在写入期间发生变化，已拒绝写入");
	const temporaryPath = join(verifiedParent, `.${parts.at(-1)}.${randomUUID()}.tmp`);
	const handle = await open(temporaryPath, "wx", 0o600);
	let temporaryInfo;
	try {
		await handle.writeFile(taskFileContentBytes(parts.at(-1), content, contentEncoding));
		await handle.sync();
		temporaryInfo = await handle.stat();
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
	await handle.close();
	try {
		const finalParent = parentParts.length ? await resolveTaskDirectory(root, parentParts) : root;
		const finalParentInfo = await lstat(finalParent);
		if (finalParent !== verifiedParent || !sameDirectoryIdentity(verifiedParentInfo, finalParentInfo) || !isPathWithin(root, await realpath(finalParent))) throw new WorkspaceRuleError("Agent 输出目录在写入期间发生变化，已拒绝写入");
		const finalPath = join(finalParent, parts.at(-1));
		let finalTargetInfo = null;
		try { finalTargetInfo = await lstat(finalPath); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		if ((initialInfo && (!finalTargetInfo || finalTargetInfo.isSymbolicLink() || !sameFileIdentity(initialInfo, finalTargetInfo))) || (!initialInfo && finalTargetInfo)) throw new WorkspaceRuleError("Agent 输出文件在写入期间发生变化，已拒绝写入");
		await rename(temporaryPath, finalPath);
		const savedInfo = await lstat(finalPath);
		const afterRenameParent = parentParts.length ? await resolveTaskDirectory(root, parentParts) : root;
		const afterRenameParentInfo = await lstat(afterRenameParent);
		if (afterRenameParent !== verifiedParent || !sameDirectoryIdentity(verifiedParentInfo, afterRenameParentInfo) || !sameFileIdentity(temporaryInfo, savedInfo) || !isPathWithin(root, await realpath(finalPath))) throw new WorkspaceRuleError("Agent 输出路径在写入期间发生变化，已拒绝写入");
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
	return relative(root, filePath).split(sep).join("/");
}

async function resolveTaskDirectory(root, parts) {
	let current = await realpath(root);
	for (const part of parts) {
		const next = join(current, part);
		const info = await lstat(next);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspaceRuleError("Agent 输出目录包含符号链接或非目录文件");
		const actual = await realpath(next);
		if (!isPathWithin(root, actual)) throw new WorkspaceRuleError("Agent 输出目录超出项目文件夹");
		current = actual;
	}
	return current;
}

async function writeArtifact(state, artifact, preferredFolder, fileSystemHooks = {}) {
	const folder = projectFolders.has(preferredFolder) ? preferredFolder : folderForKind.get(artifact.kind);
	if (!folder) throw new WorkspaceRuleError("交付物分类无效");
	await ensureProjectFolders(state, [folder]);
	let name = safeFileName(artifact.name);
	if (!state.project.workspacePath) {
		artifact.name = name;
		artifact.relativePath = `${folder}/${name}`;
		return;
	}
	const root = await projectRoot(state);
	const folderPath = await resolveTaskDirectory(root, [folder]);
	const folderInfo = await lstat(folderPath);
	let filePath = join(folderPath, name);
	const extensionIndex = name.lastIndexOf(".");
	const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
	const extension = extensionIndex > 0 ? name.slice(extensionIndex) : "";
	for (let suffix = 2; ; suffix++) {
		try {
			await access(filePath);
			const label = ` (${suffix})`;
			name = `${stem.slice(0, Math.max(1, 180 - label.length - extension.length))}${label}${extension}`;
			filePath = join(folderPath, name);
		}
		catch (error) { if (error.code === "ENOENT") break; throw error; }
	}
	artifact.name = name;
	artifact.relativePath = `${folder}/${name}`;
	const fileRelative = relative(root, filePath);
	if (fileRelative === ".." || fileRelative.startsWith(`..${sep}`) || isAbsolute(fileRelative)) throw new WorkspaceRuleError("交付物保存路径无效");
	await fileSystemHooks.afterArtifactPathValidated?.({ filePath, folderPath });
	const verifiedFolder = await resolveTaskDirectory(root, [folder]);
	const verifiedFolderInfo = await lstat(verifiedFolder);
	if (verifiedFolder !== folderPath || !sameDirectoryIdentity(folderInfo, verifiedFolderInfo) || !isPathWithin(root, await realpath(verifiedFolder))) throw new WorkspaceRuleError("交付物目录在写入期间发生变化，已拒绝写入");
	try { await lstat(filePath); throw new WorkspaceRuleError("交付物文件在写入期间已创建，请重试"); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	const temporaryPath = join(verifiedFolder, `.${name}.${randomUUID()}.tmp`);
	const handle = await open(temporaryPath, "wx", 0o600);
	let temporaryInfo;
	try {
		await handle.writeFile(artifactContentBytes(artifact.content, artifact.contentEncoding));
		await handle.sync();
		temporaryInfo = await handle.stat();
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
	await handle.close();
	try {
		const finalFolder = await resolveTaskDirectory(root, [folder]);
		const finalFolderInfo = await lstat(finalFolder);
		if (finalFolder !== verifiedFolder || !sameDirectoryIdentity(verifiedFolderInfo, finalFolderInfo) || !isPathWithin(root, await realpath(finalFolder))) throw new WorkspaceRuleError("交付物目录在写入期间发生变化，已拒绝写入");
		try { await lstat(filePath); throw new WorkspaceRuleError("交付物文件在写入期间已创建，请重试"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		await rename(temporaryPath, filePath);
		const savedInfo = await lstat(filePath);
		const afterRenameFolder = await resolveTaskDirectory(root, [folder]);
		const afterRenameFolderInfo = await lstat(afterRenameFolder);
		if (afterRenameFolder !== verifiedFolder || !sameDirectoryIdentity(verifiedFolderInfo, afterRenameFolderInfo) || !sameFileIdentity(temporaryInfo, savedInfo) || !isPathWithin(root, await realpath(filePath))) throw new WorkspaceRuleError("交付物路径在写入期间发生变化，已拒绝写入");
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

function summarizeMeetingMessages(messages, sender) {
	const candidates = [];
	const seen = new Set();
	for (const message of messages.filter((item) => item.sender === sender)) {
		const normalized = String(message.text ?? "")
			.replace(/```[\s\S]*?```/g, "代码片段")
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
			.replace(/^[\s>*#`]+|[*_~`]/gm, " ")
			.replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
			.replace(/<[^>]*>/g, " ");
		for (const raw of normalized.split(/[\r\n。！？!?；;]+/)) {
			const point = raw.replace(/\s+/g, " ").trim().replace(/^[-：:、，,。\s]+|[-：:、，,。\s]+$/g, "");
			if (point.length < 8 || /^(好的|收到|明白|了解|谢谢|感谢|你好|您好|测试|ok|okay)[，,。！!：:]?$/i.test(point)) continue;
			const key = point.toLocaleLowerCase().replace(/[\s，。；：、,.!?！？]/g, "");
			if (seen.has(key)) continue;
			seen.add(key);
			const priority = (point.match(/需求|目标|范围|建议|确认|计划|任务|交付|验收|风险|时间|权限|方案|问题|负责|实现/g) ?? []).length;
			candidates.push({ point, score: priority * 10 + Math.min(point.length, 160) / 100, order: candidates.length });
		}
	}
	return candidates.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 4).map(({ point }) => `- ${point.length > 220 ? `${point.slice(0, 217)}…` : point}`);
}

function buildMeetingMinutesArtifact(state, meeting) {
	const userPoints = summarizeMeetingMessages(meeting.messages, "用户");
	const managerPoints = summarizeMeetingMessages(meeting.messages, "项目经理 Agent");
	const tasks = meeting.plan?.tasks ?? [];
	const attachmentNames = [...new Set([
		...meeting.messages.flatMap((message) => (message.attachments ?? []).map((file) => file.name)),
		...(meeting.fileArtifactIds ?? []).map((artifactId) => state.artifacts.find((artifact) => artifact.id === artifactId)?.name).filter(Boolean),
	])];
	const content = `# ${meeting.title}\n\n## 会议概览\n- 会议主题：${meeting.topic || "未设置"}\n- 项目目标：${state.project.goal || "尚未填写项目目标"}\n- 讨论消息：共 ${meeting.messages.length} 条（用户 ${meeting.messages.filter((message) => message.sender === "用户").length} 条，项目经理 Agent ${meeting.messages.filter((message) => message.sender === "项目经理 Agent").length} 条）\n\n## 需求与补充\n${userPoints.join("\n") || "- 暂无用户补充内容。"}\n\n## 项目经理分析与建议\n${managerPoints.join("\n") || "- 项目经理 Agent 尚未给出分析或建议。"}\n\n## 确认状态与后续行动\n- 需求范围：${meeting.needsConfirmed ? "已确认" : "待确认"}\n- 任务计划：${meeting.plan ? `v${meeting.plan.version} · ${meeting.plan.status} · ${tasks.length} 项任务` : "尚未生成"}\n${tasks.length ? tasks.map((task) => `- ${task.id} ${task.title} · 负责人：${task.assignee} · 小组：${task.group} · 工期：${task.timeEstimate || "未设置"} · 时间安排：${task.timeline || "未设置"}\n  ${task.summary}`).join("\n") : "- 暂无后续任务；计划获批前不会创建执行任务。"}\n\n## 待确认问题\n${meeting.openQuestions.length ? meeting.openQuestions.map((question) => `- ${question}`).join("\n") : meeting.needsConfirmed ? "- 当前没有待决问题。" : "- 尚待确认需求范围。"}\n\n## 相关附件\n${attachmentNames.length ? attachmentNames.map((name) => `- ${name}`).join("\n") : "- 本次会议没有上传附件。"}\n`;
	return {
		id: `minutes-${meeting.id}`, name: `${meeting.title}纪要.md`, kind: "会议记录", taskId: "会议记录", owner: "项目经理 Agent",
		version: `v${meeting.plan?.version ?? 1}`, status: "参考", updatedAt: nowLabel(),
		size: `${Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 1024))} KB`, content,
	};
}

async function ensureMeetingMinutes(state, meeting, fileSystemHooks) {
	const id = `minutes-${meeting.id}`;
	if (state.artifacts.some((artifact) => artifact.id === id)) return false;
	const artifact = buildMeetingMinutesArtifact(state, meeting);
	await writeArtifact(state, artifact, undefined, fileSystemHooks);
	state.artifacts.unshift(artifact);
	return true;
}

function artifactPathParts(input, artifact) {
	const value = typeof input === "string" && input.trim() ? input : `${folderForKind.get(artifact.kind)}/${safeFileName(artifact.name)}`;
	if (isAbsolute(value) || win32.isAbsolute(value) || value.includes("\0")) throw new WorkspaceRuleError("项目文件路径无效");
	const parts = value.replaceAll("\\", "/").split("/");
	if (parts.length < 2 || !projectFolders.has(parts[0]) || parts.some((part) => !part || part === "." || part === ".." || part.length > 180 || /[<>:\"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) || parts.slice(1, -1).some((part) => /^(\.git|node_modules|secrets?)$/i.test(part))) throw new WorkspaceRuleError("项目文件路径无效");
	parts[parts.length - 1] = safeFileName(parts.at(-1));
	return parts;
}

async function ensureArtifactParent(root, parts) {
	let current = root;
	for (const part of parts.slice(0, -1)) {
		const next = join(current, part);
		try {
			const info = await lstat(next);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspaceRuleError("项目文件所在目录不能包含符号链接或非目录文件");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await mkdir(next);
		}
		const actual = await realpath(next);
		const actualRelative = relative(root, actual);
		if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new WorkspaceRuleError("项目文件所在目录不能超出工作空间");
		current = actual;
	}
}

async function inspectArtifactPath(root, parts, { allowMissing = false } = {}) {
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspaceRuleError("项目文件所在目录不能包含符号链接或非目录文件");
		} catch (error) {
			if (error.code === "ENOENT" && allowMissing) return null;
			if (error.code === "ENOENT") throw new WorkspaceRuleError("项目文件所在目录不存在");
			throw error;
		}
	}
	const filePath = join(current, parts.at(-1));
	try {
		const info = await lstat(filePath);
		if (info.isSymbolicLink() || !info.isFile()) throw new WorkspaceRuleError("项目文件必须是普通文件，不能是符号链接");
		const actual = await realpath(filePath);
		const actualRelative = relative(root, actual);
		if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new WorkspaceRuleError("项目文件不能位于工作空间之外");
		return filePath;
	} catch (error) {
		if (error.code === "ENOENT" && allowMissing) return null;
		if (error.code === "ENOENT") throw new WorkspaceRuleError("项目文件在工作空间中不存在");
		throw error;
	}
}

async function availableArtifactPath(root, parts, existingPath = null) {
	const originalName = parts.at(-1);
	const extensionIndex = originalName.lastIndexOf(".");
	const stem = extensionIndex > 0 ? originalName.slice(0, extensionIndex) : originalName;
	const extension = extensionIndex > 0 ? originalName.slice(extensionIndex) : "";
	for (let suffix = 1; ; suffix++) {
		const name = suffix === 1 ? originalName : `${stem.slice(0, Math.max(1, 180 - String(suffix).length - extension.length - 3))} (${suffix})${extension}`;
		const candidate = [...parts.slice(0, -1), name];
		const path = join(root, ...candidate);
		if (existingPath && (process.platform === "win32" ? path.toLowerCase() === existingPath.toLowerCase() : path === existingPath)) return { parts: candidate, path };
		try { await lstat(path); }
		catch (error) { if (error.code === "ENOENT") return { parts: candidate, path }; throw error; }
	}
}

async function writeArtifactContent(filePath, contentBytes) {
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, contentBytes, { mode: 0o600 });
		await rename(temporaryPath, filePath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

async function nextGitTag(state, versionNumber) {
	const root = await projectRoot(state);
	await addGitExcludes(root, state.settings?.excludedPaths ?? []);
	const { stdout: tagsText } = await execGit(root, ["tag", "--list", "v*"]);
	const existing = new Set(tagsText.split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean));
	let minor = Math.max(versionNumber - 1, ...[...existing].map((tag) => /^v0\.(\d+)$/.exec(tag)?.[1]).filter(Boolean).map(Number), 0);
	let tag = `v0.${minor + 1}`;
	while (existing.has(tag)) tag = `v0.${++minor + 1}`;
	return { root, tag };
}

async function createGitVersion(state, root, tag) {
	await addGitExcludes(root, state.settings?.excludedPaths ?? []);
	await execGit(root, ["add", "--all"]);
	const { stdout: status } = await execGit(root, ["status", "--porcelain"]);
	if (status.trim()) {
		await runGitFile("git", ["-c", "user.name=AI Agent Team", "-c", "user.email=ai-agent-team@localhost", "commit", "-m", `Release ${tag}: ${state.project.name}`], { cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
	} else {
		await runGitFile("git", ["-c", "user.name=AI Agent Team", "-c", "user.email=ai-agent-team@localhost", "commit", "--allow-empty", "-m", `Release ${tag}: ${state.project.name}`], { cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
	}
	const { stdout: commit } = await execGit(root, ["rev-parse", "HEAD"]);
	await execGit(root, ["tag", "-a", tag, "-m", `Release ${tag}`, commit.trim()]);
	return { tag, commit: commit.trim() };
}

export class WorkspaceConflictError extends Error {
	constructor(message, revision, workspace) {
		super(message);
		this.name = "WorkspaceConflictError";
		this.revision = revision;
		this.workspace = workspace;
	}
}

export class WorkspaceRuleError extends Error {
	constructor(message) {
		super(message);
		this.name = "WorkspaceRuleError";
	}
}

function artifactContentBytes(content, encoding) {
	if (typeof content !== "string") failRule("交付物文件内容无效");
	if (encoding === undefined) return Buffer.from(content, "utf8");
	if (encoding !== "base64") failRule("交付物文件编码无效");
	const bytes = Buffer.from(content, "base64");
	if (bytes.toString("base64") !== content) failRule("Office 文件编码无效");
	return bytes;
}

const failRule = (message) => { throw new WorkspaceRuleError(message); };
const clone = (value) => structuredClone(value);
const idOf = (value) => typeof value?.id === "string" ? value.id : "";
const trim = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";

const planToolPermissionIds = new Set(["file-read", "file-write", "file-create", "file-delete", "web-search", "command"]);

function availablePlanPermissions(state, agent) {
	const permissions = (Array.isArray(agent.tools) ? agent.tools : [])
		.filter((tool) => tool?.enabled === true && planToolPermissionIds.has(tool.id) && (tool.id !== "web-search" || state.settings?.networkEnabled === true))
		.map((tool) => tool.id);
	for (const server of Array.isArray(state.settings?.mcpServers) ? state.settings.mcpServers : []) {
		if (server?.enabled === true && typeof server.id === "string" && (server.id !== "wps-office-local" || state.settings?.wpsOfficeMcpInstalled === true)) permissions.push(`mcp:${server.id}`);
	}
	const linkedSkillIds = new Set(Array.isArray(agent.skillIds) ? agent.skillIds : []);
	for (const skill of Array.isArray(state.settings?.agentSkills) ? state.settings.agentSkills : []) {
		if (skill?.enabled === true && typeof skill.id === "string" && linkedSkillIds.has(skill.id)) permissions.push(`skill:${skill.id}`);
	}
	return new Set(permissions);
}

function normalizePlanTasks(state, inputTasks, previousTasks = []) {
	if (!Array.isArray(inputTasks) || inputTasks.length < 1 || inputTasks.length > 8) failRule("计划需要包含 1 到 8 项任务");
	const agents = new Map(state.agents.map((agent) => [agent.name, agent]));
	const preservedIds = new Set(previousTasks.map((task) => task.id));
	const usedIds = new Set();
	const sourceIds = new Map();
	const lastTaskNumber = [...state.tasks, ...previousTasks].reduce((maximum, task) => {
		const match = /^TASK-(\d+)$/.exec(task.id);
		return match ? Math.max(maximum, Number(match[1])) : maximum;
	}, 0);
	let nextTaskNumber = lastTaskNumber + 1;
	const normalizedTasks = inputTasks.map((task, index) => {
		const title = trim(task?.title, 120);
		const assignee = trim(task?.assignee, 80);
		const agent = agents.get(assignee);
		if (!title || !agent || !state.groups.includes(agent.group)) failRule(`计划第 ${index + 1} 项的名称、负责人或所属小组无效`);
		const enabledPermissions = availablePlanPermissions(state, agent);
		if (!enabledPermissions.has("file-create")) failRule(`「${agent.name}」未启用创建任务文件权限，不能作为计划执行人`);
		const requestedPermissions = Array.isArray(task?.permissions)
			? [...new Set(task.permissions.filter((permission) => typeof permission === "string"))]
			: [...enabledPermissions];
		if (requestedPermissions.some((permission) => !enabledPermissions.has(permission))) failRule(`计划第 ${index + 1} 项请求了执行人未启用的权限`);
		if (!requestedPermissions.includes("file-create")) failRule(`计划第 ${index + 1} 项必须保留创建任务文件权限`);
		const requestedId = trim(task?.id, 64);
		let id = preservedIds.has(requestedId) && !usedIds.has(requestedId) ? requestedId : "";
		while (!id) {
			const candidate = `TASK-${String(nextTaskNumber++).padStart(3, "0")}`;
			if (!state.tasks.some((existing) => existing.id === candidate) && !previousTasks.some((existing) => existing.id === candidate) && !usedIds.has(candidate)) id = candidate;
		}
		usedIds.add(id);
		const sourceId = trim(task?.id, 64);
		if (sourceId) {
			if (sourceIds.has(sourceId)) failRule(`计划任务编号「${sourceId}」重复`);
			sourceIds.set(sourceId, id);
		}
		return {
			id,
			title,
			group: agent.group,
			assignee: agent.name,
			summary: trim(task?.summary, 1000),
			permissions: requestedPermissions,
			timeEstimate: trim(task?.timeEstimate, 80) || "待估算",
			timeline: trim(task?.timeline, 120) || "按依赖顺序",
			rationale: trim(task?.rationale, 300) || "按交付成果和执行人能力安排。",
			dependsOn: [],
		};
	});
	const taskIds = new Set(normalizedTasks.map((task) => task.id));
	for (const [index, task] of inputTasks.entries()) {
		const current = normalizedTasks[index];
		const dependencies = Array.isArray(task?.dependsOn) ? task.dependsOn : [];
		if (dependencies.length > inputTasks.length) failRule(`计划第 ${index + 1} 项的前置任务数量无效`);
		current.dependsOn = [...new Set(dependencies.map((dependency) => {
			if (typeof dependency !== "string") failRule(`计划第 ${index + 1} 项的前置任务编号无效`);
			const requestedId = trim(dependency, 64);
			const mappedId = sourceIds.get(requestedId) ?? requestedId;
			if (!taskIds.has(mappedId)) failRule(`计划第 ${index + 1} 项引用了不存在的前置任务「${requestedId}」`);
			if (mappedId === current.id) failRule(`任务「${current.id}」不能依赖自身`);
			return mappedId;
		}))];
	}
	const visiting = new Set();
	const visited = new Set();
	const byId = new Map(normalizedTasks.map((task) => [task.id, task]));
	const visit = (taskId) => {
		if (visiting.has(taskId)) failRule("计划任务的前后依赖存在循环");
		if (visited.has(taskId)) return;
		visiting.add(taskId);
		for (const dependencyId of byId.get(taskId)?.dependsOn ?? []) visit(dependencyId);
		visiting.delete(taskId);
		visited.add(taskId);
	};
	for (const task of normalizedTasks) visit(task.id);
	return normalizedTasks;
}
const nowLabel = () => new Date().toLocaleString("zh-CN");

function validateWorkspace(workspace) {
	if (!workspace || typeof workspace !== "object" || !Array.isArray(workspace.projects) || workspace.projects.length > 100) {
		failRule("工作空间数据格式无效");
	}
	if (workspace.settings !== undefined) {
		const settings = workspace.settings;
		if (!settings || typeof settings !== "object"
			|| typeof settings.providerName !== "string" || typeof settings.modelName !== "string" || typeof settings.endpoint !== "string"
			|| !new Set(["未连接", "已连接"]).has(settings.connectionStatus) || !egressApprovalModes.has(settings.egressApproval)
			|| !Array.isArray(settings.excludedPaths) || settings.excludedPaths.some((item) => typeof item !== "string")
			|| typeof settings.localModel !== "boolean" || typeof settings.networkEnabled !== "boolean" || typeof settings.commandApproval !== "boolean"
			|| typeof settings.defaultProviderId !== "string" || typeof settings.defaultModelId !== "string") {
			failRule("工作空间设置格式无效");
		}
		validateAgentExtensionSettings(settings);
	}
	const projectIds = workspace.projects.map((state) => idOf(state?.project));
	if (projectIds.some((id) => !id || id.length > 128) || new Set(projectIds).size !== projectIds.length || (projectIds.length ? !projectIds.includes(workspace.activeProjectId) : workspace.activeProjectId !== "")) {
		failRule("工作空间项目列表无效");
	}
	for (const state of workspace.projects) {
		if (!Array.isArray(state.agents) || !Array.isArray(state.groups) || !Array.isArray(state.tasks) || !Array.isArray(state.artifacts) || !Array.isArray(state.versions) || !state.meeting || typeof state.meeting !== "object") {
			failRule("项目数据格式无效");
		}
		if (state.settings !== undefined) {
			if (!state.settings || typeof state.settings !== "object" || Array.isArray(state.settings)) failRule("项目设置格式无效");
			validateAgentExtensionSettings(state.settings);
		}
		if (state.meetingHistory !== undefined && !Array.isArray(state.meetingHistory)) failRule("会议历史格式无效");
		if (state.roleLibrary !== undefined && !Array.isArray(state.roleLibrary)) failRule("角色组件库格式无效");
		if (!projectStatuses.has(state.project.status) || !meetingStatuses.has(state.meeting.status) || typeof state.meeting.needsConfirmed !== "boolean" || !deliveryStatuses.has(state.deliveryStatus)) failRule("项目业务状态无效");
		if (state.workspaceFolders !== undefined && (!Array.isArray(state.workspaceFolders) || state.workspaceFolders.some((folder) => !projectFolders.has(folder)))) failRule("项目文件夹列表无效");
		if (state.meeting.plan && (!new Set(["草案", "指派待确认", "已批准"]).has(state.meeting.plan.status) || !Array.isArray(state.meeting.plan.tasks) || (state.meeting.plan.directApproval !== undefined && typeof state.meeting.plan.directApproval !== "boolean"))) failRule("会议计划状态无效");
		if (state.versions.some((version) => !versionStatuses.has(version.status))) failRule("交付版本状态无效");
		if (state.tasks.some((task) => task.outputDirectory !== undefined && !projectFolders.has(task.outputDirectory))) failRule("任务输出目录无效");
		const taskIds = state.tasks.map(idOf);
		if (taskIds.some((id) => !id) || new Set(taskIds).size !== taskIds.length || state.tasks.some((task) => !taskStatuses.has(task.status))) failRule("项目任务列表无效");
		const artifactIds = state.artifacts.map(idOf);
		if (artifactIds.some((id) => !id) || new Set(artifactIds).size !== artifactIds.length || state.artifacts.some((artifact) => !artifactStatuses.has(artifact.status) || !artifactKinds.has(artifact.kind))) failRule("项目交付物列表无效");
	}
}

function needsProviderSessionMigration(workspace) {
	return workspace.projects.some((state) => [state.meeting, ...(state.meetingHistory ?? [])].some((meeting) => meeting.id && !isOpenCodeSessionId(meeting.providerSessionId)));
}

function migrateProviderSessionIds(workspace) {
	for (const state of workspace.projects) {
		for (const meeting of [state.meeting, ...(state.meetingHistory ?? [])]) {
			if (meeting.id && !isOpenCodeSessionId(meeting.providerSessionId)) meeting.providerSessionId = createOpenCodeSessionId();
		}
	}
}

function validateAgentExtensionSettings(settings) {
	if (settings.mcpServers !== undefined) {
		if (!Array.isArray(settings.mcpServers) || settings.mcpServers.length > 40) failRule("MCP 服务配置无效");
		const ids = new Set();
		const names = new Set();
		const namespaces = new Set();
		for (const server of settings.mcpServers) {
			const namespace = typeof server?.name === "string" ? server.name.toLowerCase().replaceAll("-", "_") : "";
			if (!server || typeof server !== "object" || !/^[\w.-]{1,64}$/.test(server.id ?? "") || !/^[\w.-]{1,64}$/.test(server.name ?? "")
				|| ids.has(server.id) || names.has(server.name.toLowerCase()) || namespaces.has(namespace) || !["stdio", "http"].includes(server.type)
				|| typeof server.enabled !== "boolean" || typeof server.description !== "string" || server.description.length > 500) failRule("MCP 服务配置无效");
			ids.add(server.id);
			names.add(server.name.toLowerCase());
			namespaces.add(namespace);
			if (server.type === "stdio") {
				if (typeof server.command !== "string" || !server.command.trim() || server.command.length > 300 || !Array.isArray(server.args) || server.args.length > 64
					|| server.args.some((item) => typeof item !== "string" || item.length > 1000 || /[\u0000-\u001f]/.test(item))) failRule("MCP 命令配置无效");
				if (server.env !== undefined && (!server.env || typeof server.env !== "object" || Array.isArray(server.env)
					|| Object.entries(server.env).length > 32 || Object.entries(server.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || typeof value !== "string" || value.length > 300 || /[\r\n\u0000]/.test(value)
						|| (/(token|secret|password|credential|api[-_]?key)/i.test(key) && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))))) failRule("MCP 环境变量配置无效；敏感值必须引用环境变量");
			} else {
				if (typeof server.url !== "string" || server.url.length > 2048 || /[\u0000-\u0020]/.test(server.url)) failRule("MCP 地址无效");
				let address;
				try { address = new URL(server.url); } catch { failRule("MCP 地址无效"); }
				const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(address.hostname.toLowerCase());
				if ((address.protocol !== "https:" && !(address.protocol === "http:" && loopback)) || address.username || address.password) failRule("MCP 地址必须使用 HTTPS；仅本机服务可使用 HTTP");
				if (server.headers !== undefined && (!server.headers || typeof server.headers !== "object" || Array.isArray(server.headers)
					|| Object.entries(server.headers).length > 32 || Object.entries(server.headers).some(([key, value]) => !/^[A-Za-z0-9-]{1,80}$/.test(key) || typeof value !== "string" || value.length > 1000 || /[\r\n\u0000]/.test(value)
						|| (/(authorization|cookie|token|secret|password|api[-_]?key)/i.test(key) && !/^(?:Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/i.test(value))))) failRule("MCP 请求头配置无效；凭据必须引用环境变量");
			}
		}
	}
	if (settings.agentSkills !== undefined) {
		if (!Array.isArray(settings.agentSkills) || settings.agentSkills.length > 40) failRule("Agent Skill 配置无效");
		const ids = new Set();
		const names = new Set();
		let totalSkillChars = 0;
		for (const skill of settings.agentSkills) {
			if (!skill || typeof skill !== "object" || !/^[\w.-]{1,64}$/.test(skill.id ?? "") || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name ?? "")
				|| ids.has(skill.id) || names.has(skill.name) || typeof skill.enabled !== "boolean"
				|| (skill.displayName !== undefined && (typeof skill.displayName !== "string" || skill.displayName.length > 100))
				|| typeof skill.description !== "string" || !skill.description.trim() || skill.description.length > 500
				|| typeof skill.content !== "string" || skill.content.length > 100_000) failRule("Agent Skill 配置无效");
			ids.add(skill.id);
			names.add(skill.name);
			totalSkillChars += skill.content.length;
			if (totalSkillChars > 1_500_000) failRule("Agent Skill 配置总量不能超过 150 万字符");
		}
	}
}

function ensureSnapshotDoesNotChangeBusinessState(previous, next) {
	const nextByProject = new Map(next.projects.map((state) => [state.project.id, state]));
	const previousIds = new Set(previous.projects.map((state) => state.project.id));
	for (const created of next.projects) {
		if (!previousIds.has(created.project.id) && (created.tasks.length || created.artifacts.length || created.versions.length || created.workspaceFolders?.length || created.meeting.plan || created.project.archivedAt || created.project.status !== "配置中" || created.deliveryStatus !== "未发布" || created.meeting.needsConfirmed || created.meeting.status !== "需求确认中")) failRule("新项目必须从空白状态开始，通过业务命令建立任务和交付状态");
	}
	for (const before of previous.projects) {
		const after = nextByProject.get(before.project.id);
		if (!after) failRule("删除项目必须通过 Runtime 项目命令");
		if ((before.project.archivedAt ?? "") !== (after.project.archivedAt ?? "")) failRule("归档状态必须通过 Runtime 项目命令");
		if (before.project.status !== after.project.status || before.deliveryStatus !== after.deliveryStatus) failRule("项目状态必须通过 Runtime 业务命令");
		if (before.meeting.id !== after.meeting.id || before.meeting.providerSessionId !== after.meeting.providerSessionId) failRule("会议会话标识必须由 Runtime 管理");
		if (JSON.stringify(before.workspaceFolders ?? []) !== JSON.stringify(after.workspaceFolders ?? [])) failRule("项目分类目录必须通过 Runtime 命令创建");
		if (before.meeting.needsConfirmed !== after.meeting.needsConfirmed || before.meeting.status !== after.meeting.status) failRule("会议状态必须通过 Runtime 会议命令");
		if (JSON.stringify(before.meeting.plan ?? null) !== JSON.stringify(after.meeting.plan ?? null)) failRule("计划变更必须通过 Runtime 计划命令");
		if (JSON.stringify(before.meetingHistory ?? []) !== JSON.stringify(after.meetingHistory ?? [])) failRule("会议历史必须通过 Runtime 会议命令");
		const beforeTasks = new Map(before.tasks.map((task) => [task.id, task]));
		const afterTasks = new Map(after.tasks.map((task) => [task.id, task]));
		if (beforeTasks.size !== afterTasks.size || [...beforeTasks.keys()].some((id) => !afterTasks.has(id))) failRule("创建或删除任务必须通过 Runtime 计划命令");
		for (const [id, task] of beforeTasks) if (JSON.stringify(task) !== JSON.stringify(afterTasks.get(id))) failRule("任务和 Run 数据必须通过 Runtime 任务命令");
		const beforeArtifacts = new Map(before.artifacts.map((artifact) => [artifact.id, artifact]));
		const afterArtifacts = new Map(after.artifacts.map((artifact) => [artifact.id, artifact]));
		if ([...beforeArtifacts.keys()].some((id) => !afterArtifacts.has(id))) failRule("当前不支持直接删除交付物");
		for (const [id, artifact] of beforeArtifacts) {
			const current = afterArtifacts.get(id);
			if (current && JSON.stringify({ ...artifact, status: null }) !== JSON.stringify({ ...current, status: null })) failRule("交付物内容和审核状态必须通过 Runtime 命令");
		}
		for (const [id] of afterArtifacts) if (!beforeArtifacts.has(id)) failRule("交付物必须通过 Runtime 命令提交");
		if (JSON.stringify(before.versions) !== JSON.stringify(after.versions)) failRule("交付版本必须通过 Runtime 交付命令");
	}
}

function appendActivity(state, message, details = {}) {
	const previous = (Array.isArray(state.activities) ? state.activities : []).map((activity) => {
		if (typeof activity === "string") return { message: activity, createdAt: "" };
		if (!activity || typeof activity.message !== "string") return null;
		return {
			id: typeof activity.id === "string" ? activity.id : undefined,
			message: activity.message,
			createdAt: typeof activity.createdAt === "string" ? activity.createdAt : "",
			...(activity.kind === "task-status" ? {
				kind: activity.kind,
				taskId: typeof activity.taskId === "string" ? activity.taskId : undefined,
				taskTitle: typeof activity.taskTitle === "string" ? activity.taskTitle : undefined,
				previousStatus: typeof activity.previousStatus === "string" ? activity.previousStatus : undefined,
				status: typeof activity.status === "string" ? activity.status : undefined,
			} : {}),
		};
	}).filter(Boolean);
	state.activities = [{ id: `activity-${randomUUID()}`, message, createdAt: new Date().toISOString(), ...details }, ...previous].slice(0, 40);
	state.project.updatedAt = "刚刚";
}

function recordTaskStatusChanges(previousState, state) {
	const previousTasks = new Map((previousState?.tasks ?? []).map((task) => [task.id, task]));
	for (const task of state.tasks) {
		const previous = previousTasks.get(task.id);
		if (previous?.status === task.status) continue;
		const previousStatus = previous?.status ?? "新建";
		const message = previous
			? `${task.id} · ${task.title}：${previousStatus} → ${task.status}`
			: `已创建任务 ${task.id} · ${task.title}，当前状态：${task.status}`;
		appendActivity(state, message, {
			kind: "task-status",
			taskId: task.id,
			taskTitle: task.title,
			previousStatus,
			status: task.status,
		});
	}
}

function summarizeMeetingContext(meeting) {
	const messages = Array.isArray(meeting?.messages) ? meeting.messages : [];
	const weightedMessages = (sender, limit) => {
		const candidates = messages.map((message, index) => ({ message, index }))
			.filter(({ message }) => message.sender === sender)
			.map(({ message, index }, offset, all) => {
				const text = String(message.text ?? "").slice(0, 6000);
				const keywords = (text.match(/确认|必须|需要|不要|不能|目标|范围|约束|验收|交付|权限|拆分|计划|决定|结论|风险|阻塞|完成|任务|时间|文件|架构/g) ?? []).length;
				return { message, index, score: Math.min(12, all.length - offset) + Math.min(24, keywords * 2) };
			})
			.sort((left, right) => right.score - left.score)
			.slice(0, limit)
			.sort((left, right) => left.index - right.index);
		const seen = new Set();
		return candidates.map(({ message }) => {
			const raw = String(message.text ?? "").replace(/```[\s\S]*?```/g, "（代码块已省略）").slice(0, 6000);
			const fragments = raw.split(/[\r\n]+|(?<=[。！？；.!?])\s*/u)
				.map((line) => line.replace(/^\s*(?:[-*#>\d.、|]+\s*)+/, "").replace(/\s+/g, " ").trim())
				.filter((line) => line.length >= 8 && !/^以上(内容|安排)|^请(确认|核对|查看)$/.test(line));
			const chosen = fragments.map((line, index) => ({ line, index, weight: (line.match(/确认|必须|需要|不要|不能|目标|范围|约束|验收|交付|权限|拆分|计划|决定|结论|风险|阻塞|完成|任务|时间|文件|架构/g) ?? []).length }))
				.sort((left, right) => right.weight - left.weight || left.index - right.index)
				.slice(0, 2)
				.sort((left, right) => left.index - right.index)
				.map(({ line }) => line.length > 260 ? `${line.slice(0, 257)}…` : line);
			const attachmentNames = (message.attachments ?? []).map((file) => file.name).filter(Boolean);
			const lines = [...chosen, ...(attachmentNames.length ? [`附件：${attachmentNames.join("、")}`] : [])];
			return lines.filter((line) => {
				const key = line.toLocaleLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}).flat().slice(-limit * 2);
	};
	const userNotes = weightedMessages("用户", 12);
	const managerNotes = weightedMessages("项目经理 Agent", 8);
	const plan = meeting.plan;
	const planLines = plan?.tasks?.slice(0, 16).map((task) => `- ${task.id} ${task.title} · ${task.assignee} · ${task.timeline || "按依赖顺序"} · ${task.status}`) ?? [];
	const sections = [
		"## 自动归纳的上下文记忆（基于原始会议记录提炼）",
		`- 需求范围：${meeting.needsConfirmed ? "用户已确认" : "仍待用户确认"}`,
		`- 当前阶段：${plan ? `计划 v${plan.version} · ${plan.status}` : "需求讨论与澄清"}`,
		`- 待确认问题：${meeting.openQuestions?.length ? meeting.openQuestions.slice(0, 8).join("；") : "无"}`,
		"### 用户要求与约束",
		...(userNotes.length ? userNotes.map((line) => `- ${line}`) : ["- 暂无用户补充记录。"]),
		"### 项目经理的阶段结论",
		...(managerNotes.length ? managerNotes.map((line) => `- ${line}`) : ["- 暂无项目经理结论。"]),
		...(planLines.length ? ["### 当前任务计划", ...planLines] : []),
	];
	return sections.join("\n").slice(0, 8000);
}

function appendTaskLog(task, message) {
	task.logs = [...(Array.isArray(task.logs) ? task.logs : []), `${nowLabel()} · ${message}`];
}

function taskById(state, taskId) {
	return state.tasks.find((task) => task.id === taskId);
}

function meetingForTask(state, task) {
	if (!task?.sourceMeetingId || task.sourceMeetingId === state.meeting.id) return state.meeting;
	return (state.meetingHistory ?? []).find((meeting) => meeting.id === task.sourceMeetingId) ?? state.meeting;
}

async function createStageReportMeeting(state, planId, sourceMeetingId, stage, stageTasks, planTasks, fileSystemHooks) {
	const meetings = [state.meeting, ...(state.meetingHistory ?? [])];
	if (meetings.some((meeting) => meeting.reportForPlanId === planId && meeting.reportForStage === stage)) return false;
	const taskIds = new Set(stageTasks.map((task) => task.id));
	const files = state.artifacts.filter((artifact) => taskIds.has(artifact.taskId));
	const planVersion = stageTasks[0]?.sourcePlanVersion ?? "—";
	const resultLines = stageTasks.map((task) => {
		const taskFiles = files.filter((artifact) => artifact.taskId === task.id);
		const fileSummary = taskFiles.length
			? taskFiles.map((artifact) => `${artifact.name}（${artifact.kind}，${artifact.relativePath ?? "项目工作区"}）`).join("；")
			: "本任务没有关联文件产物";
		return `- **${task.id} · ${task.title}**：${task.summary}\n  - 对应计划：${task.id} · ${task.title}\n  - 本阶段产物：${fileSummary}`;
	});
	const issues = stageTasks.flatMap((task) => task.logs.filter((line) => /失败|重试|返工|驳回/.test(line)).map((line) => `- ${task.id}：${line}`));
	const nextTasks = planTasks.filter((task) => task.status !== "已完成" && task.status !== "已撤销");
	const nextSteps = nextTasks.length
		? nextTasks.map((task) => `- ${task.timeline || "后续阶段"} · ${task.id} ${task.title}（${task.assignee}）`).join("\n")
		: "- 当前计划中的任务阶段均已完成；可以进入项目验收或另行创建新会议。";
	const time = nowLabel();
	const report = {
		id: `meeting-${randomUUID()}`,
		providerSessionId: createOpenCodeSessionId(),
		title: `${stage}阶段进展汇报`,
		topic: `${stage}阶段任务进展、成果与后续安排`,
		status: "已批准",
		needsConfirmed: true,
		archivedAt: new Date().toISOString(),
		openQuestions: [],
		messages: [
			{ id: `message-${randomUUID()}`, sender: "项目经理 Agent", time, text: `## 本阶段成果\n本次阶段已完成 ${stageTasks.length} 项任务，成果文件保存在项目工作区：\n\n${resultLines.join("\n")}\n\n任务输出位于隔离的 Run 目录，原始项目文件不会被直接覆盖；需要替换原文件时可先在交付中心审阅产物。` },
			{ id: `message-${randomUUID()}`, sender: "项目经理 Agent", time, text: `## 任务进展与困难\n${stageTasks.map((task) => `- ${task.id} · ${task.title}：${task.reviewNote || "Runtime 产物完整性与授权检查通过"}`).join("\n")}\n\n### 处理记录\n${issues.length ? issues.join("\n") : "- 本阶段没有记录到执行失败、返工或驳回问题。"}` },
			{ id: `message-${randomUUID()}`, sender: "项目经理 Agent", time, text: `## 下一步规划\n${nextSteps}\n\n以上安排对应原计划 **v${planVersion}**；文件列表可在本会议右侧“会议文件”中查看。` },
		],
		plan: null,
		fileArtifactIds: files.map((artifact) => artifact.id),
		reportForPlanId: planId,
		reportForStage: stage,
		sourceMeetingId,
	};
	report.contextSummary = summarizeMeetingContext(report);
	state.meetingHistory = [report, ...(state.meetingHistory ?? []).filter((meeting) => meeting.id !== report.id)];
	await ensureMeetingMinutes(state, report, fileSystemHooks);
	report.fileArtifactIds = [...new Set([...(report.fileArtifactIds ?? []), `minutes-${report.id}`])];
	appendActivity(state, `项目经理创建并归档了「${report.title}」汇报会议，已生成会议纪要`);
	return true;
}

async function applyCommand(workspace, projectId, command, fileSystemHooks = {}) {
	const previousState = workspace.projects.find((item) => item.project.id === projectId);
	const next = clone(workspace);
	const value = command && typeof command === "object" ? command : {};
	if (value.type === "workspace.reset") {
		if (next.projects.some((project) => project.tasks.some((task) => task.status === "执行中"))) failRule("仍有任务运行中，不能重置工作空间");
		const replacement = value.workspace;
		validateWorkspace(replacement);
		if (replacement.projects.length && replacement.projects.some((project) => project.tasks.length || project.artifacts.length || project.versions.length || project.meeting.plan || project.workspaceFolders?.length)) failRule("重置目标必须是空白工作空间");
		return clone(replacement);
	}
	const state = next.projects.find((item) => item.project.id === projectId);
	if (!state) failRule("项目不存在或已被删除");

	switch (value.type) {
		case "meeting.create": {
			const title = trim(value.title, 80);
			const topic = trim(value.topic, 120);
			if (!title || !topic) failRule("请填写会议名称和会议主题");
			const previous = state.meeting;
			if (previous.id) {
				state.meetingHistory = [previous, ...(Array.isArray(state.meetingHistory) ? state.meetingHistory : []).filter((meeting) => meeting.id !== previous.id)];
			}
			state.meeting = { id: `meeting-${randomUUID()}`, providerSessionId: createOpenCodeSessionId(), title, topic, status: "需求确认中", needsConfirmed: false, openQuestions: [], messages: [], plan: null };
			appendActivity(state, `创建了会议「${title}」`);
			break;
		}
		case "meeting.select": {
			const meetingId = trim(value.meetingId, 160);
			if (state.meeting.id === meetingId) break;
			const history = Array.isArray(state.meetingHistory) ? state.meetingHistory : [];
			const selected = history.find((meeting) => meeting.id === meetingId);
			if (!selected) failRule("会议不存在或已被移除");
			if (selected.archivedAt) failRule("归档会议只能查看，不能继续讨论");
			state.meetingHistory = [...(state.meeting.id ? [state.meeting] : []), ...history.filter((meeting) => meeting.id !== meetingId)];
			state.meeting = selected;
			break;
		}
		case "meeting.message.edit":
		case "meeting.message": {
			const meetingId = trim(value.meetingId, 160);
			const meeting = state.meeting.id === meetingId ? state.meeting : state.meetingHistory?.find((item) => item.id === meetingId);
			if (!meeting || meeting.archivedAt) failRule("会议不存在或已归档，不能发送消息");
			const content = trim(value.text, 200000);
			const editing = value.type === "meeting.message.edit";
			if (!content || (!editing && !["用户", "项目经理 Agent"].includes(value.sender))) failRule("会议消息无效");
			const ids = value.attachmentIds ?? [];
			if (!Array.isArray(ids) || ids.length > 5) failRule("每条消息最多添加 5 个附件");
			const attachments = [...new Set(ids)].map((id) => {
				const artifact = state.artifacts.find((item) => item.id === id);
				if (!artifact) failRule("附件不存在或不属于当前项目");
				return { artifactId: artifact.id, name: artifact.name };
			});
			const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(new Date());
			if (editing) {
				const index = meeting.messages.findIndex((item) => item.id === value.messageId && item.sender === "用户");
				if (index < 0) failRule("只能修改用户发送的消息");
				if (meeting.plan?.status === "已批准") failRule("会议计划已批准，请创建新会议讨论变更");
				meeting.messages = [...meeting.messages.slice(0, index), { ...meeting.messages[index], text: content, time, attachments }];
				meeting.needsConfirmed = false;
				meeting.plan = null;
			} else meeting.messages.push({ id: `message-${randomUUID()}`, sender: value.sender, text: content, time, attachments });
			meeting.contextSummary = summarizeMeetingContext(meeting);
			break;
		}
		case "meeting.archive": {
			const meetingId = trim(value.meetingId, 160);
			const meeting = state.meeting.id === meetingId ? state.meeting : (Array.isArray(state.meetingHistory) ? state.meetingHistory.find((item) => item.id === meetingId) : null);
			if (!meeting) failRule("会议不存在或已被移除");
			if (meeting.archivedAt) failRule("会议已经归档");
			meeting.archivedAt = new Date().toISOString();
			await ensureMeetingMinutes(state, meeting, fileSystemHooks);
			appendActivity(state, `归档了会议「${meeting.title}」并生成会议纪要`);
			break;
		}
		case "meeting.rename": {
			const meetingId = trim(value.meetingId, 160);
			const title = trim(value.title, 80);
			const meeting = state.meeting.id === meetingId ? state.meeting : (Array.isArray(state.meetingHistory) ? state.meetingHistory.find((item) => item.id === meetingId) : null);
			if (!meeting) failRule("会议不存在或已被移除");
			if (!title) failRule("会议名称不能为空");
			const previousTitle = meeting.title;
			meeting.title = title;
			appendActivity(state, `将会议「${previousTitle}」改名为「${title}」`);
			break;
		}
		case "meeting.delete": {
			const meetingId = trim(value.meetingId, 160);
			const currentMeeting = state.meeting.id === meetingId ? state.meeting : null;
			const meeting = currentMeeting ?? (Array.isArray(state.meetingHistory) ? state.meetingHistory.find((item) => item.id === meetingId) : null);
			if (!meeting) failRule("会议不存在或已被移除");
			if (!meeting.archivedAt) failRule("只能删除已归档的会议");
			await ensureMeetingMinutes(state, meeting, fileSystemHooks);
			if (currentMeeting) {
				state.meeting = { id: "", title: "", topic: "", status: "需求确认中", needsConfirmed: false, openQuestions: [], messages: [], plan: null };
			} else {
				state.meetingHistory = state.meetingHistory.filter((item) => item.id !== meetingId);
			}
			appendActivity(state, `删除了已归档会议「${meeting.title}」`);
			break;
		}
		case "meeting.confirm-requirements": {
			if (state.meeting.needsConfirmed) failRule("当前需求已经确认");
			if (!trim(state.project.goal, 4000) || !state.meeting.messages.some((item) => item.sender === "用户")) failRule("请先填写项目目标并记录需求消息");
			state.meeting.needsConfirmed = true;
			state.meeting.status = "需求确认中";
			state.meeting.messages.push({ id: `confirm-${randomUUID()}`, sender: "系统", text: "用户已确认当前需求范围。接下来可以生成计划草案供审批。", time: "刚刚" });
			state.meeting.contextSummary = summarizeMeetingContext(state.meeting);
			appendActivity(state, "用户确认了当前需求范围");
			break;
		}
		case "plan.generate": {
			if (!state.meeting.needsConfirmed || state.meeting.plan?.status === "已批准") failRule("请先确认需求；已批准的计划不能覆盖");
			const tasks = normalizePlanTasks(state, value.tasks);
			const version = (state.meeting.plan?.version ?? 0) + 1;
			state.meeting.plan = { id: `plan-${randomUUID()}`, version, status: "草案", createdAt: "刚刚", tasks };
			state.meeting.status = "计划待审批";
			state.meeting.messages.push({ id: `plan-${randomUUID()}`, sender: "项目经理 Agent", text: `任务规划草案 v${version} 已完成，共 ${tasks.length} 项。请先确认任务范围、拆分和验收结果；确认后我会单独汇总执行人、所属小组、权限与工期，供你审阅指派规划。当前尚未创建执行任务。`, time: "刚刚" });
			state.meeting.contextSummary = summarizeMeetingContext(state.meeting);
			appendActivity(state, `生成了计划 v${version} 草案`);
			break;
		}
		case "plan.propose": {
			if (state.meeting.plan?.status === "已批准") failRule("已批准的计划不能覆盖，请在新会议中提出新增任务");
			const tasks = normalizePlanTasks(state, value.tasks, state.meeting.plan?.tasks ?? []);
			const version = (state.meeting.plan?.version ?? 0) + 1;
			state.meeting.plan = { id: `plan-${randomUUID()}`, version, status: "指派待确认", directApproval: true, createdAt: "刚刚", tasks };
			state.meeting.status = "计划待审批";
			const assignmentLines = tasks.map((task) => `- **${task.id} · ${task.title}**：${task.assignee}（${task.group}），${task.timeline || "按依赖顺序"}，预计 ${task.timeEstimate || "待估算"}；${task.dependsOn?.length ? `前置任务：${task.dependsOn.join("、")}` : "无前置依赖，可并行"}；交付：${task.summary}`).join("\n");
			state.meeting.messages.push({ id: `proposal-${randomUUID()}`, sender: "项目经理 Agent", text: `我识别到这项工作适合创建为可执行任务，已按角色职能和前后依赖拟好任务建议（共 ${tasks.length} 项）：\n\n${assignmentLines}\n\n请审阅负责人、任务边界和依赖关系。回复“确认”或“同意”后，我会创建任务并按依赖自动调度；如需调整，请直接告诉我。确认前不会创建或启动任务。`, time: "刚刚" });
			state.meeting.contextSummary = summarizeMeetingContext(state.meeting);
			appendActivity(state, `生成了待确认任务建议 v${version}`);
			break;
		}
		case "plan.confirm-draft": {
			const plan = state.meeting.plan;
			if (!state.meeting.needsConfirmed || !plan || plan.id !== value.planId || plan.status !== "草案") failRule("只有当前待确认的任务规划草案可以进入指派规划");
			plan.status = "指派待确认";
			const assignmentLines = plan.tasks.map((task) => `- **${task.id} · ${task.title}**：${task.assignee}（${task.group}），${task.timeline || "按依赖顺序"}，预计 ${task.timeEstimate || "待估算"}；权限：${(task.permissions ?? []).join("、") || "未设置"}`).join("\n");
			state.meeting.messages.push({ id: `assignment-${randomUUID()}`, sender: "项目经理 Agent", text: `任务规划草案已确认。以下是我依据当前组织架构与最小权限原则整理的任务指派规划：\n\n${assignmentLines}\n\n请核对执行人、权限与相对工期；确认指派规划后，我会创建这些任务并进入任务执行。确认前不会派发或启动任务。`, time: "刚刚" });
			state.meeting.contextSummary = summarizeMeetingContext(state.meeting);
			appendActivity(state, `确认计划 v${plan.version} 草案并生成指派规划`);
			break;
		}
		case "plan.update": {
			const plan = state.meeting.plan;
			if (!state.meeting.needsConfirmed || !plan || plan.id !== value.planId || !["草案", "指派待确认"].includes(plan.status)) failRule("只有当前待确认的计划可以修改");
			plan.tasks = normalizePlanTasks(state, value.tasks, plan.tasks);
			plan.version += 1;
			state.meeting.contextSummary = summarizeMeetingContext(state.meeting);
			appendActivity(state, `调整了计划 v${plan.version} 草案`);
			break;
		}
		case "plan.approve": {
			const plan = state.meeting.plan;
			if ((!state.meeting.needsConfirmed && !plan?.directApproval) || !plan || plan.id !== value.planId || plan.status !== "指派待确认") failRule("请先确认任务拆分草案，再确认指派规划");
			if (state.deliveryStatus === "待验收") failRule("请先完成当前交付版本的验收，再批准新的任务计划");
			if (plan.tasks.some((task) => state.tasks.some((existing) => existing.id === task.id))) failRule("计划任务编号已存在，请重新生成计划");
			for (const task of plan.tasks) {
				const agent = state.agents.find((item) => item.name === task.assignee);
				const availablePermissions = agent ? availablePlanPermissions(state, agent) : new Set();
				if (agent && !Array.isArray(task.permissions)) {
					task.permissions = [...availablePermissions];
					task.group = agent.group;
				}
				if (!agent || agent.group !== task.group || !task.permissions?.includes("file-create") || task.permissions.some((permission) => !availablePermissions.has(permission))) failRule(`「${task.title}」的执行人或权限已发生变化，请先调整计划草案`);
			}
			plan.status = "已批准";
			if (plan.directApproval) state.meeting.needsConfirmed = true;
			state.meeting.status = "已批准";
			const folders = new Set(["01_需求文档"]);
			const assignedTasks = plan.tasks.map((task) => {
				const assignee = task.assignee;
				const outputDirectory = assignee.includes("测试") || assignee.includes("质量") ? "04_测试报告" : assignee.includes("文档") || assignee.includes("研究") || assignee.includes("设计") ? "02_设计文档" : assignee.includes("项目经理") ? "01_需求文档" : "03_源代码";
				folders.add(outputDirectory);
				return { ...task, sourceMeetingId: state.meeting.id, sourcePlanId: plan.id, sourcePlanVersion: plan.version, outputDirectory, status: "待分配", progress: 0, run: 0, reworkCount: 0, reviewNote: "", logs: [`已由项目经理 Agent 分配给 ${assignee}，输出目录：${outputDirectory}`] };
			});
			state.tasks.push(...assignedTasks);
			await ensureProjectFolders(state, [...folders]);
			state.project.status = "进行中";
			if (state.deliveryStatus === "已验收") state.deliveryStatus = "未发布";
			state.meeting.messages.push({ id: `assignment-confirmed-${randomUUID()}`, sender: "项目经理 Agent", text: `指派规划 v${plan.version} 已确认，已创建 ${plan.tasks.length} 项执行任务。任务将依据前置关系自动调度，互不依赖且由不同 Agent 承担的任务会并行执行。每项产物通过 Runtime 客观检查后，我会继续调度后续阶段并自动创建阶段汇报；全部任务完成后，你只需审查最终交付版本。`, time: "刚刚" });
			state.meeting.contextSummary = summarizeMeetingContext(state.meeting);
			appendActivity(state, `批准计划 v${plan.version}，创建了 ${plan.tasks.length} 项任务`);
			break;
		}
		case "task.revoke": {
			const task = taskById(state, value.taskId);
			if (!task) failRule("任务不存在或已被移除");
			if (task.status === "已撤销") failRule("该任务已经撤销");
			if (task.status === "已完成") failRule("已完成的任务不能撤销；如需调整请在会议室创建变更计划");
			const downstreamIds = new Set();
			let frontier = [task.id];
			while (frontier.length) {
				const nextFrontier = state.tasks.filter((item) => !downstreamIds.has(item.id) && (item.dependsOn ?? []).some((id) => frontier.includes(id)));
				for (const item of nextFrontier) downstreamIds.add(item.id);
				frontier = nextFrontier.map((item) => item.id);
			}
			task.status = "已撤销";
			task.recovery = task.recovery ? { ...task.recovery, nextRetryAt: null } : undefined;
			task.reviewNote = "用户已通过项目经理撤销此任务；运行记录和已有产物保留供追溯。";
			appendTaskLog(task, "项目经理根据用户要求撤销任务；任务已从任务执行中心隐藏");
			state.artifacts = state.artifacts.map((artifact) => artifact.taskId === task.id && artifact.status === "待审核" ? { ...artifact, status: "参考" } : artifact);
			state.agents = state.agents.map((agent) => agent.name === task.assignee
				? { ...agent, status: state.tasks.some((item) => item.assignee === agent.name && item.status === "执行中") ? "运行中" : "空闲" }
				: agent);
			const downstream = state.tasks.filter((item) => downstreamIds.has(item.id) && item.status !== "已完成" && item.status !== "已撤销");
			const taskMeeting = meetingForTask(state, task);
			const dependencyNote = downstream.length
				? `以下后续任务仍因依赖此任务而保持阻塞，未自动撤销：${downstream.map((item) => `${item.id}「${item.title}」`).join("、")}。请在会议室调整计划后再继续。`
				: "没有后续任务因此被阻塞。";
			taskMeeting.messages.push({ id: `task-revoked-${randomUUID()}`, sender: "项目经理 Agent", time: "刚刚", text: `## 任务已撤销\n${task.id}「${task.title}」已撤销，已停止自动调度并从任务执行中心移除。运行记录和已有产物保留供追溯。${dependencyNote}` });
			taskMeeting.contextSummary = summarizeMeetingContext(taskMeeting);
			appendActivity(state, `项目经理撤销了 ${task.id} · ${task.title}`);
			break;
		}
		case "task.start": {
			const task = taskById(state, value.taskId);
			if (!task || !["待分配", "返工中", "失败"].includes(task.status)) failRule("任务当前状态不允许启动");
			const taskMeeting = meetingForTask(state, task);
			if (taskMeeting.plan?.id !== task.sourcePlanId || taskMeeting.plan?.status !== "已批准") failRule("任务必须来自已批准的计划");
			if (!state.agents.some((agent) => agent.name === task.assignee)) failRule("任务负责人已不在当前团队中");
			if (state.tasks.some((item) => item.id !== task.id && item.status === "执行中" && item.assignee === task.assignee)) failRule("该 Agent 仍有其他任务运行中");
			const blockedBy = (task.dependsOn ?? []).filter((dependencyId) => state.tasks.find((item) => item.id === dependencyId)?.status !== "已完成");
			if (blockedBy.length) failRule(`任务仍被前置任务阻塞：${blockedBy.join("、")}`);
			const isRework = task.status === "返工中";
			const isRetry = task.status === "失败";
			if (value.automaticRetry === true) {
				if (!isRetry || !task.recovery?.nextRetryAt || Date.parse(task.recovery.nextRetryAt) > Date.now() || task.recovery.attempts >= task.recovery.limit) failRule("任务不符合自动恢复条件");
				task.recovery = { ...task.recovery, attempts: task.recovery.attempts + 1, nextRetryAt: null };
			} else if (isRetry && task.recovery) task.recovery = { ...task.recovery, attempts: 0, nextRetryAt: null };
			task.status = "执行中";
			task.progress = 10;
			task.run = (Number(task.run) || 0) + 1;
			appendTaskLog(task, isRework ? `启动 ${task.id} 的返工 Run ${task.run}` : isRetry ? `重试 ${task.id} Run ${task.run}` : `开始 ${task.id} · ${task.title}`);
			state.agents = state.agents.map((agent) => agent.name === task.assignee ? { ...agent, status: "运行中" } : agent);
			appendActivity(state, isRework ? `启动 ${task.id} 的返工 Run ${task.run}` : isRetry ? `重试 ${task.id} · ${task.title}` : `开始 ${task.id} · ${task.title}`);
			taskMeeting.messages.push({ id: `task-start-${randomUUID()}`, sender: "项目经理 Agent", time: "刚刚", text: `## 执行监督\n已启动 ${task.timeline || "当前阶段"} · ${task.id}「${task.title}」，由 ${task.assignee} 执行。前置任务已完成；我会检查本次运行的授权范围和交付完整性，再调度已解锁的后续任务。` });
			taskMeeting.contextSummary = summarizeMeetingContext(taskMeeting);
			break;
		}
		case "task.complete": {
			const task = taskById(state, value.taskId);
			const artifact = value.artifact;
			if (!task || task.status !== "执行中") failRule("任务当前状态不允许提交产物");
			if (!artifact || !trim(artifact.id, 160) || !trim(artifact.name, 240) || artifact.taskId !== task.id || artifact.status !== "待审核" || !artifactKinds.has(artifact.kind) || typeof artifact.content !== "string" || Buffer.byteLength(artifact.content, "utf8") > 1024 * 1024) failRule("交付物信息无效或超过 1 MB");
			const files = value.files ?? [];
			if (!Array.isArray(files) || files.length > 40) failRule("任务文件列表无效或超过 40 个");
			const seenPaths = new Set();
			let totalBytes = 0;
			const validatedFiles = files.map((file) => {
				const parts = safeTaskFileSegments(file?.path);
				const key = parts.join("/").toLocaleLowerCase("en-US");
				if (seenPaths.has(key)) failRule("任务文件路径重复");
				seenPaths.add(key);
				if (typeof file?.content !== "string") failRule("任务文件内容无效");
				let rawBytes;
				try { rawBytes = taskFileContentBytes(parts.at(-1), file.content, file.contentEncoding); }
				catch (error) { failRule(error instanceof Error ? error.message : "任务文件编码无效"); }
				const bytes = rawBytes.byteLength;
				if (bytes > taskFileBytesLimit(parts.at(-1))) failRule("普通文本任务文件不能超过 1 MB，Office 文件不能超过 5 MB");
				totalBytes += bytes;
				if (totalBytes > 5 * 1024 * 1024) failRule("单次任务产物总量不能超过 5 MB");
				return { parts, content: file.content, contentEncoding: file.contentEncoding, bytes };
			});
			const existing = state.artifacts.findIndex((item) => item.id === artifact.id);
			if (existing >= 0 && state.artifacts[existing].taskId !== task.id) failRule("交付物编号已被其他任务使用");
			const storedArtifact = clone(artifact);
			storedArtifact.status = "已通过";
			await writeArtifact(state, storedArtifact, task.outputDirectory, fileSystemHooks);
			const fileArtifacts = [];
			for (const file of validatedFiles) {
				const relativePath = await writeTaskFile(state, task, file.parts, file.content, file.contentEncoding, fileSystemHooks);
				const name = basename(file.parts.at(-1));
				fileArtifacts.push({
					id: `artifact-${randomUUID()}`, name, kind: storedArtifact.kind, taskId: task.id, owner: task.assignee,
					version: storedArtifact.version, status: "已通过", updatedAt: storedArtifact.updatedAt,
					size: `${Math.max(1, Math.ceil(file.bytes / 1024))} KB`, content: file.content,
					...(file.contentEncoding ? { contentEncoding: file.contentEncoding } : {}), relativePath,
				});
			}
			task.status = "已完成";
			task.progress = 100;
			task.reviewNote = "项目经理已依据 Runtime 客观检查确认授权范围、输出目录与交付文件完整性；最终项目成果仍待用户验收。";
			appendTaskLog(task, `Pi Agent 已保存 ${validatedFiles.length} 个分类文件；项目经理完成 Runtime 客观检查`);
			if (existing >= 0) state.artifacts[existing] = storedArtifact;
			else state.artifacts.unshift(storedArtifact);
			state.artifacts.unshift(...fileArtifacts);
			state.agents = state.agents.map((agent) => agent.name === task.assignee ? { ...agent, status: "空闲" } : agent);
			appendActivity(state, `项目经理完成 ${task.id} 阶段检查`);
			const unlockedTasks = state.tasks.filter((item) => item.sourcePlanId === task.sourcePlanId && item.status === "待分配" && (item.dependsOn ?? []).includes(task.id));
			const outputNames = [...fileArtifacts.map((artifact) => `${artifact.name}（${artifact.relativePath}）`), storedArtifact.name].join("、");
			const taskMeeting = meetingForTask(state, task);
			taskMeeting.messages.push({ id: `task-progress-${randomUUID()}`, sender: "项目经理 Agent", time: "刚刚", text: `## 阶段进展\n${task.id}「${task.title}」已完成。Runtime 客观检查确认了授权、输出目录和交付文件完整性。成果：${outputNames}。${unlockedTasks.length ? `已解锁：${unlockedTasks.map((item) => `${item.id}「${item.title}」`).join("、")}，将按可用 Agent 自动调度。` : "我会继续检查本阶段其余任务和后续依赖。"}最终项目成果将在交付版本中交由你审查。` });
			taskMeeting.contextSummary = summarizeMeetingContext(taskMeeting);
			if (task.sourcePlanId && task.sourceMeetingId) {
				const planTasks = state.tasks.filter((item) => item.sourcePlanId === task.sourcePlanId);
				const stageTasks = planTasks.filter((item) => item.timeline === task.timeline);
				if (stageTasks.length && stageTasks.every((item) => item.status === "已完成")) await createStageReportMeeting(state, task.sourcePlanId, task.sourceMeetingId, task.timeline || "任务", stageTasks, planTasks, fileSystemHooks);
			}
			break;
		}
		case "task.recovery.pause": {
			const task = taskById(state, value.taskId);
			if (!task || task.status !== "失败") failRule("只有失败任务可以暂停自动恢复");
			if (task.recovery) task.recovery.nextRetryAt = null;
			appendTaskLog(task, "用户暂停了自动恢复，可手动重试");
			break;
		}
		case "task.fail": {
			const task = taskById(state, value.taskId);
			if (value.runNumber !== undefined && task?.run !== value.runNumber) failRule("失败记录不属于当前 Run");
			if (task?.status === "失败") break;
			if (!task || task.status !== "执行中") failRule("任务当前状态不允许标记失败");
			const error = trim(value.error, 500) || "任务执行失败";
			task.status = "失败";
			task.progress = 0;
			task.reviewNote = error;
			task.recovery = planTaskRecovery(error, task.recovery?.attempts);
			appendTaskLog(task, `执行失败：${error}`);
			state.agents = state.agents.map((agent) => agent.name === task.assignee ? { ...agent, status: "空闲" } : agent);
			appendActivity(state, `${task.id} 执行失败`);
			const blockedTasks = state.tasks.filter((item) => item.sourcePlanId === task.sourcePlanId && (item.dependsOn ?? []).includes(task.id));
			const taskMeeting = meetingForTask(state, task);
			taskMeeting.messages.push({ id: `task-failed-${randomUUID()}`, sender: "项目经理 Agent", time: "刚刚", text: `## 执行阻塞\n${task.id}「${task.title}」运行失败：${error}。${blockedTasks.length ? `依赖它的任务暂缓调度：${blockedTasks.map((item) => `${item.id}「${item.title}」`).join("、")}。` : ""}${task.recovery.nextRetryAt ? `已安排自动恢复（最多 ${task.recovery.limit} 次）：${task.recovery.action}。` : `需要处理：${task.recovery.action}。` }运行记录和已有文件已保留；完成后继续调度后续任务。` });
			taskMeeting.contextSummary = summarizeMeetingContext(taskMeeting);
			break;
		}
		case "task.review": {
			const task = taskById(state, value.taskId);
			if (!task || task.status !== "待审核") failRule("任务当前状态不允许审核");
			if (value.decision !== "通过" && value.decision !== "返工") failRule("审核结论无效");
			const note = trim(value.note, 2000);
			if (value.decision === "返工" && !note) failRule("驳回返工必须填写具体原因");
			const approved = value.decision === "通过";
			task.status = approved ? "已完成" : "返工中";
			task.progress = approved ? 100 : 70;
			task.reworkCount = approved ? task.reworkCount : task.reworkCount + 1;
			task.reviewNote = note || "审核通过，交付物已记录。";
			appendTaskLog(task, `用户审核${approved ? "通过" : "返工"}${note ? `：${note}` : ""}`);
			state.artifacts = state.artifacts.map((artifact) => artifact.taskId === task.id ? { ...artifact, status: approved ? "已通过" : "待审核" } : artifact);
			appendActivity(state, approved ? `审核通过 ${task.id}` : `驳回 ${task.id} 并进入返工`);
			if (approved && task.sourcePlanId && task.sourceMeetingId) {
				const taskMeeting = meetingForTask(state, task);
				const planTasks = state.tasks.filter((item) => item.sourcePlanId === task.sourcePlanId);
				const stageTasks = planTasks.filter((item) => item.timeline === task.timeline);
				if (stageTasks.length && stageTasks.every((item) => item.status === "已完成")) await createStageReportMeeting(state, task.sourcePlanId, taskMeeting.id, task.timeline || "任务", stageTasks, planTasks, fileSystemHooks);
			}
			break;
		}
		case "artifact.add": {
			const artifact = value.artifact;
			if (!artifact || !trim(artifact.id, 160) || !trim(artifact.name, 240) || !artifactStatuses.has(artifact.status) || !artifactKinds.has(artifact.kind) || typeof artifact.content !== "string") failRule("交付物信息无效");
			const artifactBytes = artifactContentBytes(artifact.content, artifact.contentEncoding);
			if (artifactBytes.byteLength > 1024 * 1024) failRule("交付物文件不能超过 1 MB");
			if (state.artifacts.some((item) => item.id === artifact.id)) failRule("交付物已存在");
			const task = taskById(state, artifact.taskId);
			if (artifact.status === "已通过") failRule("新交付物必须经过任务审核后才能标记为已通过");
			if (artifact.taskId !== "项目文件" && artifact.taskId !== "会议记录" && !task) failRule("交付物关联任务不存在");
			if (artifact.status === "待审核" && (!task || task.status !== "执行中")) failRule("待审核交付物必须来自正在执行的任务");
			if (task?.status === "执行中") {
				if (artifact.status !== "待审核") failRule("执行中的任务提交交付物时必须进入审核状态");
				task.status = "待审核";
				task.progress = 100;
				appendTaskLog(task, "用户上传交付文件并提交审核");
				state.agents = state.agents.map((agent) => agent.name === task.assignee ? { ...agent, status: "空闲" } : agent);
			}
			const storedArtifact = clone(artifact);
			await writeArtifact(state, storedArtifact, task?.outputDirectory, fileSystemHooks);
			state.artifacts.unshift(storedArtifact);
			appendActivity(state, `上传了交付文件「${artifact.name}」`);
			break;
		}
		case "artifact.update": {
			const artifact = state.artifacts.find((item) => item.id === value.artifactId);
			const name = trim(value.name, 240);
			const content = value.content;
			const contentEncoding = value.contentEncoding;
			if (!artifact) failRule("项目文件不存在或已删除");
			if (!name || !artifactKinds.has(value.kind) || typeof content !== "string") failRule("文件信息无效");
			const contentBytes = artifactContentBytes(content, contentEncoding);
			if (contentBytes.byteLength > 1024 * 1024) failRule("文件内容不能超过 1 MB");
			const task = taskById(state, artifact.taskId);
			if (task?.status === "执行中") failRule("关联任务正在运行，暂时不能编辑该文件");
			const safeName = safeFileName(name);
			const oldParts = artifactPathParts(artifact.relativePath, artifact);
			const nextParts = value.kind === artifact.kind
				? [...oldParts.slice(0, -1), safeName]
				: [folderForKind.get(value.kind), safeName];
			let nextRelativePath = nextParts.join("/");
			if (state.project.workspacePath) {
				const root = await projectRoot(state);
				const oldPath = await inspectArtifactPath(root, oldParts, { allowMissing: true });
				await ensureProjectFolders(state, [nextParts[0]]);
				await ensureArtifactParent(root, nextParts);
				const target = await availableArtifactPath(root, nextParts, oldPath);
				const samePath = oldPath && (process.platform === "win32" ? target.path.toLowerCase() === oldPath.toLowerCase() : target.path === oldPath);
				if (samePath) await writeArtifactContent(target.path, contentBytes);
				else {
					await inspectArtifactPath(root, target.parts, { allowMissing: true });
					await writeArtifactContent(target.path, contentBytes);
					if (oldPath) {
						try { await unlink(oldPath); }
						catch (error) { await unlink(target.path).catch(() => {}); throw error; }
					}
				}
				nextRelativePath = target.parts.join("/");
			}
			artifact.name = safeName;
			artifact.kind = value.kind;
			artifact.content = content;
			if (contentEncoding === undefined) delete artifact.contentEncoding;
			else artifact.contentEncoding = contentEncoding;
			artifact.relativePath = nextRelativePath;
			artifact.owner = "用户";
			artifact.version = "手动修改";
			if (task?.status === "已完成") {
				task.status = "待审核";
				task.progress = 100;
				task.reviewNote = "文件已手动修改，等待重新审核。";
			}
			artifact.status = task?.status === "待审核" ? "待审核" : "参考";
			artifact.updatedAt = nowLabel();
			artifact.size = `${Math.max(1, Math.ceil(contentBytes.byteLength / 1024))} KB`;
			if (task) appendTaskLog(task, `用户手动修改文件「${safeName}」${task.status === "待审核" ? "，等待审核" : ""}`);
			appendActivity(state, `手动修改了项目文件「${safeName}」`);
			break;
		}
		case "artifact.delete": {
			const index = state.artifacts.findIndex((item) => item.id === value.artifactId);
			if (index < 0) failRule("项目文件不存在或已删除");
			const artifact = state.artifacts[index];
			const task = taskById(state, artifact.taskId);
			if (task?.status === "执行中") failRule("关联任务正在运行，暂时不能删除该文件");
			if (state.project.workspacePath) {
				const root = await projectRoot(state);
				const parts = artifactPathParts(artifact.relativePath, artifact);
				const filePath = await inspectArtifactPath(root, parts, { allowMissing: true });
				if (filePath) await unlink(filePath);
			}
			state.artifacts.splice(index, 1);
			if (task) appendTaskLog(task, `用户手动删除文件「${artifact.name}」`);
			appendActivity(state, `手动删除了项目文件「${artifact.name}」`);
			break;
		}
		case "delivery.publish": {
			const activeTasks = state.tasks.filter((task) => task.status !== "已撤销");
			if (!activeTasks.length || activeTasks.some((task) => task.status !== "已完成") || state.deliveryStatus === "待验收") failRule("所有未撤销任务通过审核后才可发布交付版本");
			const versionNumber = state.versions.length + 1;
			await ensureProjectFolders(state, ["05_最终交付"]);
			const { root, tag } = await nextGitTag(state, versionNumber);
			const approvedArtifacts = state.artifacts.filter((artifact) => artifact.status === "已通过");
			const manifest = {
				id: `delivery-manifest-${tag.replace(/[^a-z0-9.-]/gi, "-")}`,
				name: `交付清单_${tag}.md`, kind: "交付文件", taskId: "项目文件", owner: "项目经理 Agent",
				version: tag, status: "已通过", updatedAt: new Date().toLocaleString("zh-CN"), size: "1 KB",
				content: `# ${state.project.name} ${tag} 交付清单\n\nGit 标签：${tag}\n\n${approvedArtifacts.map((artifact) => `- ${artifact.name} · ${artifact.kind} · ${artifact.relativePath ?? artifact.name}`).join("\n") || "- 本次交付没有审核通过的文件"}\n`,
			};
			const priorManifest = state.artifacts.findIndex((artifact) => artifact.id === manifest.id);
			await writeArtifact(state, manifest, undefined, fileSystemHooks);
			if (priorManifest >= 0) state.artifacts[priorManifest] = manifest; else state.artifacts.unshift(manifest);
			const gitVersion = await createGitVersion(state, root, tag);
			const version = { id: `delivery-${randomUUID()}`, label: gitVersion.tag, gitTag: gitVersion.tag, gitCommit: gitVersion.commit, createdAt: new Date().toLocaleString("zh-CN"), artifactCount: state.artifacts.filter((artifact) => artifact.status === "已通过").length, status: "待验收" };
			state.versions.unshift(version);
			state.deliveryStatus = "待验收";
			appendActivity(state, `发布了交付版本 ${version.label}`);
			break;
		}
		case "delivery.accept": {
			const version = state.versions.find((item) => item.id === value.versionId);
			if (!version || version.status !== "待验收") failRule("交付版本不存在或已经验收");
			if (state.tasks.some((task) => task.status !== "已完成" && task.status !== "已撤销")) failRule("仍有未完成任务，当前版本暂时不能验收");
			version.status = "已验收";
			state.deliveryStatus = "已验收";
			state.project.status = "已验收";
			appendActivity(state, `完成 ${version.label} 的交付验收`);
			break;
		}
		case "project.archive": {
			const archived = Boolean(value.archived);
			if (Boolean(state.project.archivedAt) === archived) failRule("项目状态已经更新");
			if (state.tasks.some((task) => task.status === "执行中")) failRule("项目仍有任务运行中，不能归档");
			state.project.archivedAt = archived ? new Date().toISOString() : undefined;
			if (archived && next.activeProjectId === projectId) next.activeProjectId = next.projects.find((item) => item.project.id !== projectId && !item.project.archivedAt)?.project.id ?? projectId;
			appendActivity(state, `${archived ? "归档" : "恢复"}了「${state.project.name}」项目`);
			break;
		}
		case "project.delete": {
			if (state.tasks.some((task) => task.status === "执行中")) failRule("项目仍有任务运行中，不能删除");
			next.projects = next.projects.filter((item) => item.project.id !== projectId);
			if (next.activeProjectId === projectId) next.activeProjectId = next.projects.find((item) => !item.project.archivedAt)?.project.id ?? next.projects[0]?.project.id ?? "";
			break;
		}
		default:
			failRule("不支持的工作空间命令");
	}
	recordTaskStatusChanges(previousState, state);
	validateWorkspace(next);
	return next;
}

export function createWorkspaceStore(filePath, fileSystemHooks = {}) {
	let writeChain = Promise.resolve();

	async function readStored() {
		try {
			const parsed = JSON.parse(await readFile(filePath, "utf8"));
			const revision = Number.isSafeInteger(parsed?.revision) && parsed.revision >= 0 ? parsed.revision : 0;
			const workspace = { activeProjectId: parsed.activeProjectId ?? "", projects: Array.isArray(parsed.projects) ? parsed.projects : [], ...(parsed.settings === undefined ? {} : { settings: parsed.settings }) };
			validateWorkspace(workspace);
			return { revision, workspace };
		} catch (error) {
			if (error.code === "ENOENT") return { revision: 0, workspace: null };
			if (error instanceof WorkspaceRuleError) throw error;
			throw new Error("工作空间数据无法读取");
		}
	}

	function serialize(operation) {
		const result = writeChain.then(operation);
		writeChain = result.catch(() => {});
		return result;
	}

	async function persist(revision, workspace) {
		await mkdir(dirname(filePath), { recursive: true });
		const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify({ ...workspace, revision }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		for (let attempt = 0; ; attempt++) {
			try { await rename(temporaryPath, filePath); break; }
			catch (error) {
				if (!["EPERM", "EBUSY", "EEXIST"].includes(error.code) || attempt >= 4) {
					await unlink(temporaryPath).catch(() => {});
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
			}
		}
	}

	return {
		read: async () => {
			const stored = await readStored();
			if (stored.workspace && needsProviderSessionMigration(stored.workspace)) {
				return serialize(async () => {
					const current = await readStored();
					if (current.workspace && needsProviderSessionMigration(current.workspace)) {
						migrateProviderSessionIds(current.workspace);
						current.revision += 1;
						await persist(current.revision, current.workspace);
					}
					return { revision: current.revision, workspace: current.workspace ? clone(current.workspace) : null };
				});
			}
			return { revision: stored.revision, workspace: stored.workspace ? clone(stored.workspace) : null };
		},
		put: (expectedRevision, workspace) => serialize(async () => {
			const current = await readStored();
			if (expectedRevision !== current.revision) throw new WorkspaceConflictError("工作空间版本已变化，请重新加载后再保存", current.revision, current.workspace);
			validateWorkspace(workspace);
			if (current.workspace) ensureSnapshotDoesNotChangeBusinessState(current.workspace, workspace);
			const nextWorkspace = clone(workspace);
			const revision = current.revision + 1;
			await persist(revision, nextWorkspace);
			return { revision, workspace: nextWorkspace };
		}),
		command: (expectedRevision, projectId, command) => serialize(async () => {
			const current = await readStored();
			if (!current.workspace) throw new WorkspaceRuleError("工作空间尚未初始化");
			if (expectedRevision !== current.revision) throw new WorkspaceConflictError("工作空间版本已变化，请重新加载后再执行操作", current.revision, current.workspace);
			const nextWorkspace = await applyCommand(current.workspace, projectId, command, fileSystemHooks);
			const revision = current.revision + 1;
			await persist(revision, nextWorkspace);
			return { revision, workspace: nextWorkspace };
		}),
		recoverInterruptedRun: (input) => serialize(async () => {
			const current = await readStored();
			const emptyRecovery = { revision: current.revision, workspace: current.workspace, files: [], registeredCount: 0, skippedCount: 0, scanComplete: true, recovered: false };
			if (!current.workspace) return emptyRecovery;
			const state = current.workspace.projects.find((item) => item.project.id === input.projectId);
			const task = state?.tasks.find((item) => item.id === input.taskId);
			if (!state || !task || task.run !== input.runNumber) return emptyRecovery;
			const canRecover = task.status === "执行中" || task.status === "待分配" || task.status === "返工中";
			if (!canRecover) return emptyRecovery;

			let scan = { files: [], skippedCount: 0 };
			let scanComplete = true;
			let scanError = "";
			try { scan = await scanInterruptedRunFiles(state, task, fileSystemHooks); }
			catch (error) {
				scanComplete = false;
				scanError = error instanceof WorkspaceRuleError ? error.message : "Run 输出目录无法安全扫描";
			}

			const nextWorkspace = clone(current.workspace);
			const nextState = nextWorkspace.projects.find((item) => item.project.id === input.projectId);
			const nextTask = nextState.tasks.find((item) => item.id === input.taskId);
			let registeredCount = 0;
			for (const file of scan.files) {
				const relativePath = [nextTask.outputDirectory, nextTask.id, "Run-" + input.runNumber, file.path].join("/");
				const artifactIdentity = [input.projectId, input.taskId, input.runNumber, relativePath.toLocaleLowerCase("en-US")].join("\0");
				const artifactId = "artifact-interrupted-" + createHash("sha256").update(artifactIdentity).digest("hex").slice(0, 40);
				if (nextState.artifacts.some((artifact) => artifact.id === artifactId)) continue;
				const kind = [...folderForKind].find(([, folder]) => folder === nextTask.outputDirectory)?.[0] ?? "交付文件";
				nextState.artifacts.unshift({
					id: artifactId,
					name: basename(file.path),
					kind,
					taskId: nextTask.id,
					owner: nextTask.assignee,
					version: "Run " + input.runNumber + "（中断恢复）",
					status: "参考",
					updatedAt: nowLabel(),
					size: Math.max(1, Math.ceil(file.bytes / 1024)) + " KB",
					content: file.content,
					relativePath,
				});
				registeredCount++;
			}

			let changed = registeredCount > 0;
			if (nextTask.status === "执行中") {
				const fileSummary = scan.files.length
					? "已发现 " + scan.files.length + " 个部分文件" + (registeredCount ? "，其中 " + registeredCount + " 个已登记为参考" : "")
					: "未发现可登记的部分文件";
				const skippedSummary = scan.skippedCount ? "另有 " + scan.skippedCount + " 个文件因路径、安全或容量限制未登记" : "";
				const errorSummary = scanError ? scanError + "，请手动检查 Run 输出目录" : "";
				const note = ["Runtime 重启后发现 Run " + input.runNumber + " 中断", fileSummary, skippedSummary, errorSummary, "请检查后重试"].filter(Boolean).join("；");
				nextTask.status = nextTask.reworkCount > 0 ? "返工中" : "待分配";
				nextTask.progress = 0;
				nextTask.reviewNote = note;
				appendTaskLog(nextTask, "执行失败：" + note);
				nextState.agents = nextState.agents.map((agent) => agent.name === nextTask.assignee ? { ...agent, status: "空闲" } : agent);
				appendActivity(nextState, nextTask.id + " 执行中断并恢复为可重试状态");
				changed = true;
			}
			if (registeredCount) {
				if (nextTask.status !== "执行中") {
					const skippedSummary = scan.skippedCount ? "；另有 " + scan.skippedCount + " 个文件因路径、安全或容量限制未登记" : "";
					nextTask.reviewNote = "Runtime 重启后发现 Run " + input.runNumber + " 中断；已发现 " + scan.files.length + " 个部分文件，并登记 " + registeredCount + " 个为参考" + skippedSummary + "；请检查后重试。";
				}
				appendTaskLog(nextTask, "中断 Run " + input.runNumber + " 的部分文件已登记为参考（" + registeredCount + " 个）");
				appendActivity(nextState, "登记了 " + registeredCount + " 个中断 Run " + input.runNumber + " 的部分文件");
			}
			if (changed) {
				recordTaskStatusChanges(state, nextState);
				validateWorkspace(nextWorkspace);
				const revision = current.revision + 1;
				await persist(revision, nextWorkspace);
				return { revision, workspace: nextWorkspace, files: scan.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), registeredCount, skippedCount: scan.skippedCount, scanComplete, recovered: true };
			}
			return { ...emptyRecovery, files: scan.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), skippedCount: scan.skippedCount, scanComplete, recovered: true };
		}),
	};
}

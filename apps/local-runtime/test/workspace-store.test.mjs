import assert from "node:assert/strict";
import { after, test } from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createOpenCodeSessionId } from "@earendil-works/pi-ai/providers/opencode-headers";
import { createWorkspaceStore, WorkspaceConflictError, WorkspaceRuleError } from "../src/workspace-store.mjs";

const testDirectory = await mkdtemp(join(process.cwd(), ".workspace-runtime-test-"));
const execFileAsync = promisify(execFile);
async function wait(ms) { await new Promise((done) => setTimeout(done, ms)); }
async function removeTemporaryTree(path) {
	for (let attempt = 0; ; attempt++) {
		try { await rm(path, { recursive: true, force: true }); return; }
		catch (error) {
			if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code) || attempt >= 8) throw error;
			await wait(50 * (attempt + 1));
		}
	}
}
after(async () => {
	const root = resolve(process.cwd());
	const target = resolve(testDirectory);
	const rel = relative(root, target);
	if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) await removeTemporaryTree(target);
});

const createProjectState = (id, name) => ({
	project: { id, name, goal: `${name} 的目标`, status: "配置中", updatedAt: "刚刚" },
	agents: [
		{ id: `${id}-manager`, templateId: "project-manager", name: "项目经理 Agent", role: "项目管理", group: "项目管理组", status: "待命" },
		{ id: `${id}-java`, templateId: "java-backend", name: "Java 后端 Agent", role: "后端开发", group: "研发组", status: "空闲" },
	],
	groups: ["项目管理组", "研发组"],
	meeting: { id: `${id}-meeting`, providerSessionId: createOpenCodeSessionId(), title: "需求会议", status: "需求确认中", needsConfirmed: false, openQuestions: [], messages: [{ id: `${id}-message`, sender: "用户", text: "完成目标", time: "现在" }], plan: null },
	tasks: [], artifacts: [], workspaceFolders: [], versions: [], deliveryStatus: "未发布", settings: {}, activities: [], teamSaved: true,
});

const seedWorkspace = () => ({
	activeProjectId: "project-a",
	projects: [createProjectState("project-a", "项目 A"), createProjectState("project-b", "项目 B")],
});

test("meeting lifecycle preserves ongoing meetings and routes replies to their original meeting", async () => {
	const { store, result: initial } = await setupStore("meeting-lifecycle");
	const original = structuredClone(initial.workspace.projects[0].meeting);
	let result = await store.command(initial.revision, "project-a", { type: "meeting.create", title: "验收评审", topic: "检查交付边界" });
	const createdId = result.workspace.projects[0].meeting.id;
	assert.match(result.workspace.projects[0].meeting.providerSessionId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	assert.deepEqual(result.workspace.projects[0].meetingHistory[0], original);
	assert.equal(result.workspace.projects[0].artifacts.length, 0);
	assert.equal(result.workspace.projects[0].meeting.topic, "检查交付边界");
	result = await store.command(result.revision, "project-a", { type: "meeting.select", meetingId: original.id });
	assert.deepEqual(result.workspace.projects[0].meeting, original);
	assert.equal(result.workspace.projects[0].meetingHistory[0].id, createdId);
	assert.equal(result.workspace.projects[0].meetingHistory[0].archivedAt, undefined);
	result = await store.command(result.revision, "project-a", { type: "meeting.message", meetingId: createdId, sender: "项目经理 Agent", text: "这是验收评审的回复" });
	assert.deepEqual(result.workspace.projects[0].meeting.messages, original.messages);
	assert.equal(result.workspace.projects[0].meetingHistory[0].messages[0].text, "这是验收评审的回复");
	assert.deepEqual(result.workspace.projects[1], initial.workspace.projects[1]);
	await assert.rejects(store.command(result.revision, "project-a", { type: "meeting.delete", meetingId: createdId }), WorkspaceRuleError);
	result = await store.command(result.revision, "project-a", { type: "meeting.archive", meetingId: createdId });
	assert.ok(result.workspace.projects[0].meetingHistory[0].archivedAt);
	const minutes = result.workspace.projects[0].artifacts.find((item) => item.id === `minutes-${createdId}`);
	assert.ok(minutes);
	assert.match(minutes.content, /检查交付边界/);
	assert.match(minutes.content, /这是验收评审的回复/);
	await assert.rejects(store.command(result.revision, "project-a", { type: "meeting.select", meetingId: createdId }), WorkspaceRuleError);
	await assert.rejects(store.command(result.revision, "project-a", { type: "meeting.message", meetingId: createdId, sender: "用户", text: "不应写入归档会议" }), WorkspaceRuleError);
	result = await store.command(result.revision, "project-a", { type: "meeting.delete", meetingId: createdId });
	assert.equal(result.workspace.projects[0].meetingHistory.length, 0);
	assert.deepEqual(result.workspace.projects[0].meeting.messages, original.messages);
	assert.ok(result.workspace.projects[0].artifacts.some((item) => item.id === minutes.id));
});

test("workspace migration assigns a stable OpenCode session ID to each existing meeting", async () => {
	const { store, result: initial } = await setupStore("meeting-session-migration");
	const filePath = join(testDirectory, "meeting-session-migration.json");
	const stored = JSON.parse(await readFile(filePath, "utf8"));
	delete stored.projects.find((state) => state.project.id === "project-a").meeting.providerSessionId;
	await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`);
	const created = await store.command(initial.revision, "project-a", { type: "meeting.create", title: "新会议", topic: "迁移测试" });
	const migrated = await store.read();
	const project = migrated.workspace.projects[0];
	assert.equal(migrated.revision, created.revision + 1);
	assert.match(project.meeting.providerSessionId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	assert.match(project.meetingHistory[0].providerSessionId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	const secondRead = await store.read();
	assert.equal(secondRead.revision, migrated.revision);
	assert.equal(secondRead.workspace.projects[0].meeting.providerSessionId, project.meeting.providerSessionId);
});

async function setupStore(name, fileSystemHooks = {}) {
	const store = createWorkspaceStore(join(testDirectory, `${name}.json`), fileSystemHooks);
	const workspace = seedWorkspace();
	for (const state of workspace.projects) {
		const projectPath = join(testDirectory, `${name}-${state.project.id}`);
		await mkdir(projectPath, { recursive: true });
		await execFileAsync("git", ["init", "--quiet", projectPath]);
		state.project.workspacePath = projectPath;
	}
	const initial = await store.put(0, workspace);
	return { store, result: initial };
}

async function createApprovedTask(store, result, projectId = "project-a") {
	result = await store.command(result.revision, projectId, { type: "meeting.confirm-requirements" });
	result = await store.command(result.revision, projectId, { type: "plan.generate", tasks: [{ title: "实现关键流程", group: "研发组", assignee: "Java 后端 Agent", summary: "完成可验收流程" }] });
	const planId = result.workspace.projects.find((state) => state.project.id === projectId).meeting.plan.id;
	result = await store.command(result.revision, projectId, { type: "plan.approve", planId });
	return { result, task: result.workspace.projects.find((state) => state.project.id === projectId).tasks[0] };
}

test("workspace writes use compare-and-swap revisions and reject snapshot status bypasses", async () => {
	const { store, result: initial } = await setupStore("revision-cas");
	assert.equal(initial.revision, 1);
	const edit = structuredClone(initial.workspace);
	edit.projects[0].project.name = "已修改名称";
	const saved = await store.put(initial.revision, edit);
	assert.equal(saved.revision, 2);
	await assert.rejects(store.put(initial.revision, edit), WorkspaceConflictError);
	const bypass = structuredClone(saved.workspace);
	bypass.projects[0].tasks.push({ id: "TASK-001", status: "已完成" });
	await assert.rejects(store.put(saved.revision, bypass), WorkspaceRuleError);
	const createdAsAccepted = structuredClone(saved.workspace);
	const forgedProject = createProjectState("project-forged", "伪造项目");
	forgedProject.project.status = "已验收";
	forgedProject.deliveryStatus = "已验收";
	createdAsAccepted.projects.push(forgedProject);
	await assert.rejects(store.put(saved.revision, createdAsAccepted), WorkspaceRuleError);
	await assert.rejects(store.command(saved.revision, "project-a", { type: "artifact.add", artifact: {
		id: "forged-approved", name: "绕过审核.md", kind: "设计文档", taskId: "项目文件", owner: "用户", version: "v1", status: "已通过", updatedAt: "现在", size: "1 KB", content: "绕过审核",
	} }), WorkspaceRuleError);
	assert.deepEqual((await store.read()).workspace.projects[0].tasks, []);
});

test("a fresh workspace may contain no projects and project deletion may return it to empty", async () => {
	const store = createWorkspaceStore(join(testDirectory, "empty-workspace.json"));
	let result = await store.put(0, { activeProjectId: "", projects: [] });
	assert.deepEqual(result.workspace, { activeProjectId: "", projects: [] });
	const project = createProjectState("only-project", "唯一项目");
	result = await store.put(result.revision, { activeProjectId: project.project.id, projects: [project] });
	result = await store.command(result.revision, project.project.id, { type: "project.delete" });
	assert.deepEqual(result.workspace, { activeProjectId: "", projects: [] });
});

test("one Agent cannot run concurrent tasks and new artifacts cannot skip review", async () => {
	const { store, result: initial } = await setupStore("single-agent-run");
	let result = await store.command(initial.revision, "project-a", { type: "meeting.confirm-requirements" });
	result = await store.command(result.revision, "project-a", { type: "plan.generate", tasks: [
		{ title: "任务一", group: "项目管理组", assignee: "项目经理 Agent", summary: "先执行" },
		{ title: "任务二", group: "项目管理组", assignee: "项目经理 Agent", summary: "等待负责人空闲" },
	] });
	const planId = result.workspace.projects[0].meeting.plan.id;
	result = await store.command(result.revision, "project-a", { type: "plan.approve", planId });
	assert.deepEqual(result.workspace.projects[0].workspaceFolders, ["01_需求文档"]);
	await access(join(result.workspace.projects[0].project.workspacePath, "01_需求文档"));
	const [first, second] = result.workspace.projects[0].tasks;
	result = await store.command(result.revision, "project-a", { type: "task.start", taskId: first.id });
	await assert.rejects(store.command(result.revision, "project-a", { type: "task.start", taskId: second.id }), WorkspaceRuleError);
	await assert.rejects(store.command(result.revision, "project-a", { type: "artifact.add", artifact: {
		id: "unreviewed", name: "未经审核.md", kind: "设计文档", taskId: "项目文件", owner: "用户", version: "v1", status: "待审核", updatedAt: "现在", size: "1 KB", content: "缺少任务审核",
	} }), WorkspaceRuleError);
});

test("runtime commands enforce approval, task, review, delivery, and project transition rules", async () => {
	const { store, result: initial } = await setupStore("business-commands");
	let { result, task } = await createApprovedTask(store, initial);
	assert.equal(result.workspace.projects[0].tasks.length, 1);
	assert.equal(result.workspace.projects[0].project.status, "进行中");
	const statusBypass = structuredClone(result.workspace);
	statusBypass.projects[0].tasks[0].status = "已完成";
	await assert.rejects(store.put(result.revision, statusBypass), WorkspaceRuleError);

	const startVersion = result.revision;
	const attempts = await Promise.allSettled([
		store.command(startVersion, "project-a", { type: "task.start", taskId: task.id }),
		store.command(startVersion, "project-a", { type: "task.start", taskId: task.id }),
	]);
	assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
	assert.equal(attempts.filter((item) => item.status === "rejected" && item.reason instanceof WorkspaceConflictError).length, 1);
	result = attempts.find((item) => item.status === "fulfilled").value;
	assert.equal(result.workspace.projects[0].tasks[0].status, "执行中");
	await assert.rejects(store.command(result.revision, "project-a", { type: "project.archive", archived: true }), WorkspaceRuleError);

	assert.equal(task.outputDirectory, "03_源代码");
	const artifact = { id: "artifact-task-1", name: "结果.md", kind: "源代码", taskId: task.id, owner: task.assignee, version: "Run 1", status: "待审核", updatedAt: "现在", size: "1 KB", content: "结果" };
	await assert.rejects(store.command(result.revision, "project-a", { type: "task.complete", taskId: task.id, artifact: { ...artifact, taskId: "TASK-999" } }), WorkspaceRuleError);
	result = await store.command(result.revision, "project-a", { type: "task.complete", taskId: task.id, artifact, files: [{ path: "src/index.ts", content: "export const ready = true;\n" }] });
	assert.equal(result.workspace.projects[0].tasks[0].status, "待审核");
	assert.equal(result.workspace.projects[0].artifacts.find((item) => item.id === artifact.id).relativePath, "03_源代码/结果.md");
	assert.equal(result.workspace.projects[0].artifacts.find((item) => item.name === "index.ts").relativePath, "03_源代码/TASK-001/Run-1/src/index.ts");
	assert.equal(await readFile(join(result.workspace.projects[0].project.workspacePath, "03_源代码", "结果.md"), "utf8"), "结果");
	assert.equal(await readFile(join(result.workspace.projects[0].project.workspacePath, "03_源代码", "TASK-001", "Run-1", "src", "index.ts"), "utf8"), "export const ready = true;\n");
	await assert.rejects(store.command(result.revision, "project-a", { type: "task.review", taskId: task.id, decision: "返工", note: "  " }), WorkspaceRuleError);
	result = await store.command(result.revision, "project-a", { type: "task.review", taskId: task.id, decision: "通过", note: "已按验收标准检查" });
	assert.equal(result.workspace.projects[0].tasks[0].status, "已完成");
	assert.equal(result.workspace.projects[0].artifacts[0].status, "已通过");
	assert.equal(result.workspace.projects[0].artifacts.find((item) => item.name === "index.ts").status, "已通过");
	result = await store.command(result.revision, "project-a", { type: "delivery.publish" });
	const versionId = result.workspace.projects[0].versions[0].id;
	assert.equal(result.workspace.projects[0].versions[0].gitTag, "v0.1");
	assert.match(result.workspace.projects[0].versions[0].gitCommit, /^[0-9a-f]{40}$/i);
	assert.ok((await execFileAsync("git", ["tag", "--list", "v0.1"], { cwd: result.workspace.projects[0].project.workspacePath })).stdout.includes("v0.1"));
	await access(join(result.workspace.projects[0].project.workspacePath, "05_最终交付", "交付清单_v0.1.md"));
	const committedManifest = await execFileAsync("git", ["show", "v0.1:05_最终交付/交付清单_v0.1.md"], { cwd: result.workspace.projects[0].project.workspacePath });
	assert.match(committedManifest.stdout, /03_源代码\/结果\.md/);
	result = await store.command(result.revision, "project-a", { type: "delivery.accept", versionId });
	assert.equal(result.workspace.projects[0].project.status, "已验收");
	assert.equal(result.workspace.projects[0].deliveryStatus, "已验收");
	result = await store.command(result.revision, "project-a", { type: "project.archive", archived: true });
	assert.equal(result.workspace.activeProjectId, "project-b");
	result = await store.command(result.revision, "project-a", { type: "project.delete" });
	assert.deepEqual(result.workspace.projects.map((state) => state.project.id), ["project-b"]);
});

async function createRecoveryTask(store, result) {
  const agent = result.workspace.projects[0].agents.find((agent) => agent.name === "Java 后端 Agent");
  agent.tools = [{ id: "file-read", enabled: true }, { id: "file-create", enabled: true }];
  result = await store.put(result.revision, result.workspace);
  result = await store.command(result.revision, "project-a", { type: "meeting.confirm-requirements" });
  result = await store.command(result.revision, "project-a", { type: "plan.generate", tasks: [{ title: "实现关键流程", group: "研发组", assignee: "Java 后端 Agent", summary: "完成可验收流程" }] });
  const planId = result.workspace.projects[0].meeting.plan.id;
  result = await store.command(result.revision, "project-a", { type: "plan.confirm-draft", planId });
  result = await store.command(result.revision, "project-a", { type: "plan.approve", planId });
  return { result, task: result.workspace.projects[0].tasks[0] };
}

test("failed tasks release agents, limit automatic recovery and reject stale Run failures", async (context) => {
  const { store, result: initial } = await setupStore("bounded-task-recovery");
  let { result, task } = await createRecoveryTask(store, initial);
  result = await store.command(result.revision, "project-a", { type: "task.start", taskId: task.id });
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (let attempt = 0; attempt <= 2; attempt++) {
    const currentTask = result.workspace.projects[0].tasks[0];
    result = await store.command(result.revision, "project-a", { type: "task.fail", taskId: task.id, runNumber: currentTask.run, error: "Connection error." });
    const failedTask = result.workspace.projects[0].tasks[0];
    assert.equal(failedTask.status, "失败");
    assert.equal(result.workspace.projects[0].agents.find((agent) => agent.name === task.assignee).status, "空闲");
    assert.equal(failedTask.recovery.attempts, attempt);
    if (attempt === 2) { assert.equal(failedTask.recovery.nextRetryAt, null); break; }
    await assert.rejects(store.command(result.revision, "project-a", { type: "task.start", taskId: task.id, automaticRetry: true }), WorkspaceRuleError);
    context.mock.timers.tick(45000);
    result = await store.command(result.revision, "project-a", { type: "task.start", taskId: task.id, automaticRetry: true });
    await assert.rejects(store.command(result.revision, "project-a", { type: "task.fail", taskId: task.id, runNumber: currentTask.run, error: "old failure" }), WorkspaceRuleError);
  }
  await assert.rejects(store.command(result.revision, "project-a", { type: "task.start", taskId: task.id, automaticRetry: true }), WorkspaceRuleError);
});

test("pausing recovery prevents an automatic start and manual retry restores its budget", async () => {
  const { store, result: initial } = await setupStore("pause-task-recovery");
  let { result, task } = await createRecoveryTask(store, initial);
  result = await store.command(result.revision, "project-a", { type: "task.start", taskId: task.id });
  result = await store.command(result.revision, "project-a", { type: "task.fail", taskId: task.id, error: "required_output" });
  result = await store.command(result.revision, "project-a", { type: "task.recovery.pause", taskId: task.id });
  assert.equal(result.workspace.projects[0].tasks[0].recovery.nextRetryAt, null);
  await assert.rejects(store.command(result.revision, "project-a", { type: "task.start", taskId: task.id, automaticRetry: true }), WorkspaceRuleError);
  result = await store.command(result.revision, "project-a", { type: "task.start", taskId: task.id });
  assert.equal(result.workspace.projects[0].tasks[0].status, "执行中");
  assert.equal(result.workspace.projects[0].tasks[0].recovery.attempts, 0);
});

test("Run submission rejects a directory junction inserted after output path validation", async () => {
	const outsideRoot = join(testDirectory, "task-write-race-outside");
	await mkdir(outsideRoot, { recursive: true });
	let injected = false;
	const { store, result: initial } = await setupStore("task-write-race", {
		afterTaskFilePathValidated: async ({ parent }) => {
			if (injected) return;
			injected = true;
			await rename(parent, `${parent}-original`);
			await symlink(outsideRoot, parent, "junction");
		},
	});
	let { result, task } = await createApprovedTask(store, initial);
	result = await store.command(result.revision, "project-a", { type: "task.start", taskId: task.id });
	const artifact = { id: "artifact-race", name: "race.md", kind: "源代码", taskId: task.id, owner: task.assignee, version: "Run 1", status: "待审核", updatedAt: "现在", size: "1 KB", content: "race" };
	await assert.rejects(store.command(result.revision, "project-a", { type: "task.complete", taskId: task.id, artifact, files: [{ path: "src/index.ts", content: "must stay in Run" }] }), WorkspaceRuleError);
	assert.deepEqual(await readdir(outsideRoot), [], "校验后替换为外部目录联接时不能向项目外写入 Run 文件");
	assert.equal((await store.read()).revision, result.revision, "失败的文件提交不得更新工作空间 JSON");
});

test("artifact submission rejects a category directory switched to an outside junction", async () => {
	const outsideRoot = join(testDirectory, "artifact-write-race-outside");
	await mkdir(outsideRoot, { recursive: true });
	let injected = false;
	const { store, result: initial } = await setupStore("artifact-write-race", {
		afterArtifactPathValidated: async ({ folderPath }) => {
			if (injected) return;
			injected = true;
			await rename(folderPath, `${folderPath}-original`);
			await symlink(outsideRoot, folderPath, "junction");
		},
	});
	let { result, task } = await createApprovedTask(store, initial);
	result = await store.command(result.revision, "project-a", { type: "task.start", taskId: task.id });
	const artifact = { id: "artifact-category-race", name: "race.md", kind: "源代码", taskId: task.id, owner: task.assignee, version: "Run 1", status: "待审核", updatedAt: "现在", size: "1 KB", content: "must stay in project" };
	await assert.rejects(store.command(result.revision, "project-a", { type: "task.complete", taskId: task.id, artifact, files: [{ path: "index.ts", content: "export {};" }] }), WorkspaceRuleError);
	assert.deepEqual(await readdir(outsideRoot), [], "分类目录被换成外部目录联接时不能写入交付物正文");
	assert.equal((await store.read()).revision, result.revision);
});

test("interrupted Run recovery skips a file switched to an outside junction before open", async () => {
	const outsideRoot = join(testDirectory, "interrupted-race-outside");
	await mkdir(outsideRoot, { recursive: true });
	await writeFile(join(outsideRoot, "result.md"), "outside secret", "utf8");
	let injected = false;
	const { store, result: initial } = await setupStore("interrupted-scan-race", {
		afterInterruptedFilePathValidated: async ({ absolutePath }) => {
			if (injected) return;
			injected = true;
			const sourceDirectory = dirname(absolutePath);
			await rename(sourceDirectory, `${sourceDirectory}-original`);
			await symlink(outsideRoot, sourceDirectory, "junction");
		},
	});
	let { result, task } = await createApprovedTask(store, initial);
	result = await store.command(result.revision, "project-a", { type: "task.start", taskId: task.id });
	const runDirectory = join(result.workspace.projects[0].project.workspacePath, task.outputDirectory, task.id, "Run-1", "src");
	await mkdir(runDirectory, { recursive: true });
	await writeFile(join(runDirectory, "result.md"), "inside partial output", "utf8");
	const recovered = await store.recoverInterruptedRun({ projectId: "project-a", taskId: task.id, runNumber: 1 });
	assert.equal(injected, true);
	assert.deepEqual(recovered.files, [], "目录联接切换后不得将项目外文件作为部分产物恢复");
	assert.equal(recovered.skippedCount, 1);
	assert.equal(recovered.registeredCount, 0);
});

test("editing a user message replaces following conversation and rejects foreign attachments", async () => {
 const { store, result: initial } = await setupStore("meeting-edit");
 let result = await store.command(initial.revision, "project-a", { type: "meeting.message", meetingId: "project-a-meeting", sender: "项目经理 Agent", text: "old answer" });
 result = await store.command(result.revision, "project-a", { type: "meeting.message.edit", meetingId: "project-a-meeting", messageId: "project-a-message", text: "updated question", attachmentIds: [] });
 const meeting = result.workspace.projects[0].meeting;
 assert.equal(meeting.messages.length, 1);
 assert.equal(meeting.messages[0].text, "updated question");
 assert.equal(meeting.needsConfirmed, false);
 assert.equal(meeting.plan, null);
 await assert.rejects(store.command(result.revision, "project-a", { type: "meeting.message", meetingId: "project-a-meeting", sender: "用户", text: "attachment", attachmentIds: ["foreign-file"] }), WorkspaceRuleError);
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createTaskRunStore } from "../src/task-run-store.mjs";

const testDirectory = await mkdtemp(join(process.cwd(), ".task-run-store-test-"));
after(async () => {
	const root = resolve(process.cwd());
	const target = resolve(testDirectory);
	const rel = relative(root, target);
	if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) await rm(target, { recursive: true, force: true });
});

function runInput(taskId = "TASK-001", runNumber = 1) {
	return {
		projectId: "project-fixture",
		taskId,
		runNumber,
		planVersion: 3,
		agentName: "测试 Agent",
		providerId: "openai",
		modelId: "fixture-model",
		input: { summary: "fixture-only task", prompt: "must never be persisted in clear text" },
	};
}

test("execution events retain cursor order and remain isolated by Run", async () => {
	const store = await createTaskRunStore(join(testDirectory, "event-pages.sqlite"));
	try {
		const first = store.start(runInput("TASK-101"));
		const second = store.start(runInput("TASK-102"));
		store.recordEvent(first.id, "model_output", { text: "first" });
		store.recordEvent(second.id, "model_output", { text: "other run" });
		store.recordEvent(first.id, "tool_started", { toolName: "execute_command", arguments: { executable: "node" } });
		assert.equal(store.activity(first).phase, "运行命令中");
		assert.equal(store.latestRuns(first.projectId).length, 2);
		assert.equal(store.latestRuns("another-project").length, 0);
		const page = store.eventPage(first.id);
		assert.deepEqual(page.map((event) => event.type), ["started", "model_output", "tool_started"]);
		assert.equal(store.eventPage(first.id, page[1].id)[0].type, "tool_started");
		assert.equal(store.eventPage(first.id, page.at(-1).id).length, 0);
		store.fail(first.id, "fixture failure");
		store.recordEvent(first.id, "model_output", { text: "late output" });
		assert.equal(store.eventPage(first.id).at(-1).type, "failed");
	} finally { store.close(); }
});

function objectiveChecks(fileContent, path = "src/fixture.ts") {
	return [
		{ id: "authorization_binding", label: "任务出站授权", status: "passed", details: "Runtime 校验通过。", evidence: [{ authorizationId: "fixture-authorization", operation: "task.execute" }] },
		{ id: "run_directory", label: "Run 目录范围", status: "passed", details: "Run 路径正确。", evidence: [{ scope: "03_源代码/TASK-001/Run-1" }] },
		{ id: "required_output", label: "必需产物", status: "passed", details: "Run 有产物。", evidence: [] },
		{ id: "output_integrity", label: "产物文件完整性", status: "passed", details: "磁盘哈希核对通过。", evidence: [{ path, sha256: createHash("sha256").update(fileContent, "utf8").digest("hex"), bytes: Buffer.byteLength(fileContent, "utf8") }] },
		{ id: "automated_tests", label: "编译、Lint 与测试", status: "not_run", details: "当前未提供命令工具。", evidence: [] },
	];
}

function egressInput(id, operation = "meeting.reply") {
	return {
		id,
		projectId: "project-fixture",
		projectName: "隔离测试项目",
		operation,
		providerId: "openai",
		modelId: "fixture-model",
		dataScope: "fixture-only text",
		payloadSha256: "a".repeat(64),
		payloadBytes: 41,
		// The durable audit record must only persist the digest and byte count.
		payload: { messages: [{ role: "user", content: "must never be persisted" }] },
	};
}

test("TaskRun persists successful output metadata and lifecycle events without task prompt text", async () => {
	const databasePath = join(testDirectory, "successful-run.sqlite");
	let store = await createTaskRunStore(databasePath);
	const run = store.start(runInput());
	assert.equal(run.status, "running");
	assert.equal(run.runNumber, 1);
	assert.equal(run.inputHash, createHash("sha256").update(JSON.stringify(runInput().input)).digest("hex"));
	assert.equal(JSON.stringify(run).includes("must never be persisted in clear text"), false);

	const fileContent = "export const fixture = true;\n";
	const recordedChecks = store.recordObjectiveChecks(run.id, objectiveChecks(fileContent));
	assert.equal(recordedChecks.objectiveChecks.find((item) => item.id === "automated_tests").status, "not_run");
	const completedByAgent = store.agentCompleted(run.id, { content: "Fixture output", files: [{ path: "src/fixture.ts", content: fileContent }] });
	assert.equal(completedByAgent.status, "agent_completed");
	assert.deepEqual(completedByAgent.outputFiles, [{
		path: "src/fixture.ts",
		sha256: createHash("sha256").update(fileContent, "utf8").digest("hex"),
		bytes: Buffer.byteLength(fileContent, "utf8"),
	}]);
	assert.throws(() => store.complete(run.id), /尚未提交审核产物或已经结束/);
	store.workspaceCommitted(run.id);
	assert.equal(store.complete(run.id).status, "completed");
	assert.throws(() => store.complete(run.id), /尚未提交审核产物或已经结束/);
	store.close();

	store = await createTaskRunStore(databasePath);
	const [persisted] = store.list("project-fixture", "TASK-001");
	assert.equal(persisted.status, "completed");
	assert.equal(persisted.summary, "Fixture output");
	assert.deepEqual(store.events(run.id).map((event) => event.type), ["started", "objective_checks_completed", "agent_completed", "workspace_artifacts_committed", "completed"]);
	assert.deepEqual(persisted.objectiveChecks, objectiveChecks(fileContent));
	store.close();
});

test("startup preserves finished Agent output for server-side submission", async () => {
  const store = await createTaskRunStore(join(testDirectory, "pending-submit.sqlite"));
  const running = store.start(runInput("TASK-101"));
  const ready = store.start(runInput("TASK-102"));
  const content = "checked output";
  store.recordObjectiveChecks(ready.id, objectiveChecks(content));
  store.agentCompleted(ready.id, { content, files: [{ path: "src/fixture.ts", content }] });
  const interrupted = store.interruptOpenRuns({ runningOnly: true });
  assert.deepEqual(interrupted.map((run) => run.id), [running.id]);
  assert.equal(store.get(ready.id).status, "agent_completed");
  assert.equal(store.pendingSubmissions()[0].id, ready.id);
  store.close();
});

test("TaskRun records failure, cancellation, and idempotent interrupted-run recovery", async () => {
	const store = await createTaskRunStore(join(testDirectory, "recovery.sqlite"));
	const failed = store.start(runInput("TASK-001", 1));
	store.fail(failed.id, "fixture provider rejected the request");
	const cancelled = store.start(runInput("TASK-001", 2));
	store.cancel(cancelled.id);
	const interruptedRunning = store.start(runInput("TASK-001", 3));
	const interruptedAfterAgent = store.start(runInput("TASK-001", 4));
	const partial = "partially prepared";
	store.recordObjectiveChecks(interruptedAfterAgent.id, objectiveChecks(partial));
	store.agentCompleted(interruptedAfterAgent.id, { content: "prepared", files: [{ path: "src/fixture.ts", content: partial }] });

	const interrupted = store.interruptOpenRuns();
	assert.deepEqual(interrupted.map((run) => run.id).sort(), [interruptedRunning.id, interruptedAfterAgent.id].sort());
	assert.ok(interrupted.every((run) => run.status === "interrupted"));
	assert.deepEqual(store.pendingRecovery().map((run) => run.id).sort(), [interruptedRunning.id, interruptedAfterAgent.id].sort());
	store.markRecoveryApplied(interruptedRunning.id, "已恢复为可重试状态");
	store.markRecoveryApplied(interruptedRunning.id, "重复恢复不得重复记账");
	assert.deepEqual(store.pendingRecovery().map((run) => run.id), [interruptedAfterAgent.id]);

	const statuses = Object.fromEntries(store.list("project-fixture", "TASK-001").map((run) => [run.runNumber, run.status]));
	assert.deepEqual(statuses, { 4: "interrupted", 3: "interrupted", 2: "cancelled", 1: "failed" });
	assert.deepEqual(store.events(interruptedRunning.id).map((event) => event.type), ["started", "interrupted", "recovery_applied"]);
	store.close();

	const reopened = await createTaskRunStore(join(testDirectory, "recovery.sqlite"));
	assert.deepEqual(reopened.pendingRecovery().map((run) => run.id), [interruptedAfterAgent.id]);
	reopened.close();
});

test("failed objective checks remain durable and prevent a Run from entering review", async () => {
	const store = await createTaskRunStore(join(testDirectory, "objective-failure.sqlite"));
	const run = store.start(runInput());
	const checks = objectiveChecks("expected output\n").map((item) => item.id === "output_integrity" ? { ...item, status: "failed", details: "磁盘内容与 Agent 输出不一致。", evidence: [] } : item);
	const recorded = store.recordObjectiveChecks(run.id, checks);
	assert.equal(recorded.objectiveChecks.find((item) => item.id === "output_integrity").status, "failed");
	assert.throws(() => store.agentCompleted(run.id, { content: "not submitted", files: [{ path: "src/fixture.ts", content: "expected output\n" }] }), /未达到可提交审核条件/);
	store.fail(run.id, "任务客观检查未通过：output_integrity");
	const [persisted] = store.list("project-fixture", "TASK-001");
	assert.equal(persisted.status, "failed");
	assert.equal(persisted.objectiveChecks.find((item) => item.id === "output_integrity").status, "failed");
	assert.deepEqual(store.events(run.id).map((event) => event.type), ["started", "objective_checks_completed", "failed"]);
	store.close();
});

test("interrupted Run is reconciled after its submitted workspace artifacts are verified", async () => {
	const store = await createTaskRunStore(join(testDirectory, "workspace-reconciliation.sqlite"));
	const run = store.start(runInput());
	const content = "submitted output";
	store.recordObjectiveChecks(run.id, objectiveChecks(content));
	store.agentCompleted(run.id, { content: "submitted", files: [{ path: "src/fixture.ts", content }] });
	store.workspaceCommitted(run.id);
	assert.equal(store.interruptOpenRuns()[0].status, "interrupted");
	assert.equal(store.pendingRecovery()[0].id, run.id);
	assert.equal(store.reconcileWorkspaceCommit(run.id).status, "completed");
	assert.deepEqual(store.pendingRecovery(), []);
	assert.ok(store.events(run.id).some((event) => event.type === "workspace_commit_reconciled"));
	store.close();
});

test("egress audit stores decisions, guarded provider counts, and restart outcomes without request bodies", async () => {
	const store = await createTaskRunStore(join(testDirectory, "egress.sqlite"));
	store.requestEgress(egressInput("denied-request"));
	store.decideEgress("denied-request", "denied", "fixture user decision");
	assert.throws(() => store.startEgress("denied-request"), /未批准、已使用或已过期/);

	store.requestEgress(egressInput("successful-request"));
	store.decideEgress("successful-request", "approved", "fixture user confirmation");
	store.startEgress("successful-request");
	store.providerRequest("successful-request", { providerId: "openai", modelId: "fixture-model", filesRead: [] });
	store.providerRequest("successful-request", { providerId: "openai", modelId: "fixture-model", filesRead: [{ path: "docs/brief.md", bytes: 22, sha256: "b".repeat(64) }] });
	store.egressFileRead("successful-request", { path: "docs/brief.md", bytes: 22, sha256: "b".repeat(64) });
	store.finishEgress("successful-request", "succeeded", "2 fixture requests");

	store.requestEgress(egressInput("approved-before-restart"));
	store.decideEgress("approved-before-restart", "approved", "fixture project scope");
	store.requestEgress(egressInput("running-before-restart"));
	store.decideEgress("running-before-restart", "approved", "fixture user confirmation");
	store.startEgress("running-before-restart");
	assert.deepEqual(store.recoverOpenEgress(), { expired: 1, interrupted: 1 });

	const records = Object.fromEntries(store.listEgress("project-fixture", 20).map((record) => [record.id, record]));
	assert.equal(records["denied-request"].status, "denied");
	assert.equal(records["denied-request"].providerRequestCount, 0);
	assert.equal(records["successful-request"].status, "succeeded");
	assert.equal(records["successful-request"].providerRequestCount, 2);
	assert.equal(records["successful-request"].payloadSha256, "a".repeat(64));
	assert.equal(JSON.stringify(records).includes("must never be persisted"), false);
	assert.equal(records["successful-request"].events.filter((event) => event.type === "provider_request_guard_passed").length, 2);
	assert.equal(records["successful-request"].events.filter((event) => event.type === "project_file_read").length, 1);
	assert.equal(records["approved-before-restart"].status, "expired");
	assert.equal(records["running-before-restart"].status, "interrupted");
	store.close();
});

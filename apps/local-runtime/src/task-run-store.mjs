import { createHash, randomUUID } from "node:crypto";
import { taskFileBytesLimit, taskFileContentBytes } from "./task-file-content.mjs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deriveRunActivity } from "./run-activity.mjs";
import { presentHistoricalValidation } from "./validation-checks.mjs";

const shortText = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

function mapRun(row) {
	return {
		id: row.id,
		projectId: row.project_id,
		taskId: row.task_id,
		runNumber: row.run_number,
		planVersion: row.plan_version,
		agentName: row.agent_name,
		providerId: row.provider_id,
		modelId: row.model_id,
		inputHash: row.input_hash,
		status: row.status,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		summary: row.summary,
		error: row.error,
		outputFiles: JSON.parse(row.output_files_json),
		objectiveChecks: JSON.parse(row.objective_checks_json ?? "[]").map((check) => presentHistoricalValidation(check, JSON.parse(row.output_files_json))),
		workspaceCommitted: Boolean(row.workspace_committed),
	};
}

const objectiveCheckIds = new Set(["authorization_binding", "run_directory", "required_output", "output_integrity", "automated_tests"]);

function normalizeObjectiveChecks(input, requirePass = false) {
	if (!Array.isArray(input) || input.length !== objectiveCheckIds.size) throw new Error("任务客观检查记录不完整");
	const seen = new Set();
	const checks = input.map((item) => {
		const id = shortText(item?.id, 64);
		const label = shortText(item?.label, 100);
		const status = item?.status;
		if (!objectiveCheckIds.has(id) || seen.has(id) || !label || !["passed", "failed", "not_run", "not_applicable"].includes(status) || status === "not_applicable" && id !== "automated_tests") throw new Error("任务客观检查记录格式无效");
		seen.add(id);
		const evidence = Array.isArray(item.evidence) ? item.evidence.slice(0, 40).map((entry) => {
			const path = shortText(entry?.path, 512);
			const scope = shortText(entry?.scope, 512);
			const sha256 = shortText(entry?.sha256, 64);
			const bytes = entry?.bytes;
			const authorizationId = shortText(entry?.authorizationId, 64);
			const operation = shortText(entry?.operation, 40);
			const command = shortText(entry?.command, 1000);
			if (command && (!Number.isSafeInteger(entry.exitCode) || !Number.isFinite(entry.durationMs) || entry.durationMs < 0)) throw new Error("验证命令证据无效");
			if (path && (!Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/i.test(sha256))) throw new Error("任务客观检查证据无效");
			if (authorizationId && operation !== "task.execute") throw new Error("任务授权检查证据无效");
			return { ...(path ? { path, sha256: sha256.toLowerCase(), bytes } : {}), ...(scope ? { scope } : {}), ...(authorizationId ? { authorizationId, operation } : {}), ...(command ? { command, exitCode: entry.exitCode, durationMs: entry.durationMs } : {}) };
		}) : [];
		return { id, label, status, details: shortText(item?.details, 500), evidence };
	});
	const statuses = new Map(checks.map((item) => [item.id, item.status]));
	const byId = new Map(checks.map((item) => [item.id, item]));
	if (statuses.get("authorization_binding") === "passed" && !byId.get("authorization_binding").evidence.some((item) => item.authorizationId && item.operation === "task.execute")) throw new Error("任务授权检查缺少授权记录证据");
	if (statuses.get("run_directory") === "passed" && !byId.get("run_directory").evidence.some((item) => item.scope)) throw new Error("Run 目录检查缺少路径范围证据");
	if (statuses.get("output_integrity") === "passed" && !byId.get("output_integrity").evidence.length) throw new Error("文件完整性检查缺少哈希证据");
	const validation = byId.get("automated_tests");
	if (validation.status === "passed" && (!validation.evidence.length || validation.evidence.some((item) => !item.command || item.exitCode !== 0))) throw new Error("验证通过缺少真实命令退出码证据");
	if (validation.status === "failed" && !validation.evidence.some((item) => item.command && item.exitCode !== 0)) throw new Error("验证失败缺少命令执行证据");
	if (requirePass && validation.status === "failed") throw new Error("验证命令失败，不能提交审核");
	if (requirePass && ["authorization_binding", "run_directory", "required_output", "output_integrity"].some((id) => statuses.get(id) !== "passed")) throw new Error("任务客观检查未达到可提交审核条件");
	return checks;
}

export async function createTaskRunStore(filePath) {
	await mkdir(dirname(filePath), { recursive: true });
	const database = new DatabaseSync(filePath);
	database.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = FULL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS task_runs (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			run_number INTEGER NOT NULL CHECK (run_number > 0),
			plan_version INTEGER NOT NULL,
			agent_name TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			model_id TEXT NOT NULL,
			input_hash TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('running', 'agent_completed', 'completed', 'failed', 'cancelled', 'interrupted')),
			started_at TEXT NOT NULL,
			finished_at TEXT,
		summary TEXT NOT NULL DEFAULT '',
			error TEXT NOT NULL DEFAULT '',
			output_files_json TEXT NOT NULL DEFAULT '[]',
			objective_checks_json TEXT NOT NULL DEFAULT '[]',
			workspace_committed INTEGER NOT NULL DEFAULT 0 CHECK (workspace_committed IN (0, 1)),
			recovery_applied INTEGER NOT NULL DEFAULT 0 CHECK (recovery_applied IN (0, 1)),
			UNIQUE (project_id, task_id, run_number)
		);
		CREATE INDEX IF NOT EXISTS task_runs_project_task_started ON task_runs(project_id, task_id, started_at DESC);
		CREATE TABLE IF NOT EXISTS task_run_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
			event_type TEXT NOT NULL,
			created_at TEXT NOT NULL,
			details_json TEXT NOT NULL DEFAULT '{}'
		);
		CREATE INDEX IF NOT EXISTS task_run_events_run_id ON task_run_events(run_id, id);
		CREATE TABLE IF NOT EXISTS egress_authorizations (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			project_name TEXT NOT NULL,
			operation TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			model_id TEXT NOT NULL,
			data_scope TEXT NOT NULL,
			payload_sha256 TEXT NOT NULL,
			payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
			status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'in_progress', 'succeeded', 'failed', 'cancelled', 'expired', 'interrupted')),
			requested_at TEXT NOT NULL,
			decided_at TEXT,
			finished_at TEXT,
			result TEXT NOT NULL DEFAULT '',
			provider_request_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_request_count >= 0)
		);
		CREATE INDEX IF NOT EXISTS egress_authorizations_project_requested ON egress_authorizations(project_id, requested_at DESC);
		CREATE TABLE IF NOT EXISTS egress_audit_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			authorization_id TEXT NOT NULL REFERENCES egress_authorizations(id) ON DELETE CASCADE,
			event_type TEXT NOT NULL,
			created_at TEXT NOT NULL,
			details_json TEXT NOT NULL DEFAULT '{}'
		);
		CREATE INDEX IF NOT EXISTS egress_audit_events_authorization ON egress_audit_events(authorization_id, id);
	`);
	const taskRunColumns = new Set(database.prepare("PRAGMA table_info(task_runs)").all().map((column) => column.name));
	if (!taskRunColumns.has("objective_checks_json")) database.exec("ALTER TABLE task_runs ADD COLUMN objective_checks_json TEXT NOT NULL DEFAULT '[]'");
	if (!taskRunColumns.has("workspace_committed")) database.exec("ALTER TABLE task_runs ADD COLUMN workspace_committed INTEGER NOT NULL DEFAULT 0 CHECK (workspace_committed IN (0, 1))");

	const runById = database.prepare("SELECT * FROM task_runs WHERE id = ?");
	const eventInsert = database.prepare("INSERT INTO task_run_events (run_id, event_type, created_at, details_json) VALUES (?, ?, ?, ?)");
	const egressById = database.prepare("SELECT * FROM egress_authorizations WHERE id = ?");
	const egressEventInsert = database.prepare("INSERT INTO egress_audit_events (authorization_id, event_type, created_at, details_json) VALUES (?, ?, ?, ?)");
	const transaction = (operation) => {
		database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			database.exec("COMMIT");
			return result;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	};
	const addEvent = (runId, type, details = {}) => eventInsert.run(runId, type, new Date().toISOString(), JSON.stringify(details));
	const addEgressEvent = (authorizationId, type, details = {}) => egressEventInsert.run(authorizationId, type, new Date().toISOString(), JSON.stringify(details));
	const mapEgress = (row) => ({
		id: row.id,
		projectId: row.project_id,
		projectName: row.project_name,
		operation: row.operation,
		providerId: row.provider_id,
		modelId: row.model_id,
		dataScope: row.data_scope,
		payloadSha256: row.payload_sha256,
		payloadBytes: row.payload_bytes,
		status: row.status,
		requestedAt: row.requested_at,
		decidedAt: row.decided_at,
		finishedAt: row.finished_at,
		result: row.result,
		providerRequestCount: row.provider_request_count,
	});

	return {
		activity(run) {
			const events = database.prepare("SELECT event_type AS type, created_at AS createdAt, details_json AS details FROM task_run_events WHERE run_id = ? ORDER BY id").all(run.id).map((event) => ({ ...event, details: JSON.parse(event.details) }));
			return deriveRunActivity(run, events);
		},
		latestRuns(projectId) {
			return database.prepare("SELECT * FROM task_runs r WHERE project_id = ? AND run_number = (SELECT MAX(run_number) FROM task_runs WHERE project_id = r.project_id AND task_id = r.task_id)").all(projectId).map(mapRun);
		},
		recordEvent(id, type, details) {
			const row = runById.get(id);
			if (!row || row.status !== "running") return;
			const count = database.prepare("SELECT COUNT(*) AS count FROM task_run_events WHERE run_id = ?").get(id).count;
			if (count >= 5000) return;
			const serialized = JSON.stringify(details);
			addEvent(id, shortText(type, 64), serialized.length > 32000 ? { text: serialized.slice(0, 32000), truncated: true } : details);
		},
		eventPage(id, after = 0) {
			return database.prepare("SELECT id, event_type AS type, created_at AS createdAt, details_json AS details FROM task_run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT 200").all(id, after).map((event) => ({ ...event, details: JSON.parse(event.details) }));
		},
		start(input) {
			const id = randomUUID();
			const startedAt = new Date().toISOString();
			const inputHash = createHash("sha256").update(JSON.stringify(input.input)).digest("hex");
			transaction(() => {
				database.prepare(`INSERT INTO task_runs
					(id, project_id, task_id, run_number, plan_version, agent_name, provider_id, model_id, input_hash, status, started_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
					.run(id, input.projectId, input.taskId, input.runNumber, input.planVersion, input.agentName, input.providerId, input.modelId, inputHash, startedAt);
				addEvent(id, "started", { runNumber: input.runNumber, planVersion: input.planVersion });
			});
			return mapRun(runById.get(id));
		},
		recordObjectiveChecks(id, input) {
			const checks = normalizeObjectiveChecks(input);
			transaction(() => {
				const updated = database.prepare("UPDATE task_runs SET objective_checks_json = ? WHERE id = ? AND status = 'running' AND objective_checks_json = '[]'").run(JSON.stringify(checks), id);
				if (!updated.changes) throw new Error("任务检查记录已写入、任务运行已经结束或记录不存在");
				addEvent(id, "objective_checks_completed", { checks });
			});
			return mapRun(runById.get(id));
		},
		agentCompleted(id, output) {
			const files = output.files.map((file) => {
				const bytes = taskFileContentBytes(file.path, file.content, file.contentEncoding);
				return { path: shortText(file.path, 512), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
			});
			const current = runById.get(id);
			if (!current) throw new Error("任务运行记录已结束或不存在");
			const checks = normalizeObjectiveChecks(JSON.parse(current.objective_checks_json), true);
			const integrity = checks.find((item) => item.id === "output_integrity");
			const sortFiles = (items) => items.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })).sort((a, b) => a.path.localeCompare(b.path));
			if (JSON.stringify(sortFiles(files)) !== JSON.stringify(sortFiles(integrity.evidence))) throw new Error("运行记录中的文件与客观检查证据不一致");
			const summary = shortText(output.content, 4000);
			transaction(() => {
				const result = database.prepare("UPDATE task_runs SET status = 'agent_completed', summary = ?, output_files_json = ? WHERE id = ? AND status = 'running'").run(summary, JSON.stringify(files), id);
				if (!result.changes) throw new Error("任务运行记录已结束或不存在");
				addEvent(id, "agent_completed", { outputFiles: files });
			});
			return mapRun(runById.get(id));
		},
		reconcileOutputFiles(id, inputFiles) {
			if (!Array.isArray(inputFiles) || inputFiles.length > 40) throw new Error("中断 Run 文件元数据无效");
			let totalBytes = 0;
			const files = inputFiles.map((file) => {
				const path = shortText(file?.path, 512);
				const parts = path.split("/");
				const bytes = file?.bytes;
				if (!path || path.startsWith("/") || path.includes("\\") || parts.some((part) => !part || part === "." || part === ".." || part.length > 180 || /[<>:"|?*\u0000-\u001f]/.test(part))
					|| typeof file?.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)
					|| !Number.isSafeInteger(bytes) || bytes < 0 || bytes > taskFileBytesLimit(path)) throw new Error("中断 Run 文件元数据无效");
				totalBytes += bytes;
				if (totalBytes > 5 * 1024 * 1024) throw new Error("中断 Run 文件总量超过上限");
				return { path, sha256: file.sha256.toLowerCase(), bytes };
			});
			transaction(() => {
				const row = runById.get(id);
				if (!row || row.status !== "interrupted") return;
				if (JSON.stringify(JSON.parse(row.output_files_json)) === JSON.stringify(files)) return;
				const updated = database.prepare("UPDATE task_runs SET output_files_json = ? WHERE id = ? AND status = 'interrupted'").run(JSON.stringify(files), id);
				if (updated.changes) addEvent(id, "output_files_reconciled", { outputFiles: files });
			});
			return runById.get(id) ? mapRun(runById.get(id)) : null;
		},
		workspaceCommitted(id) {
			transaction(() => {
				const updated = database.prepare("UPDATE task_runs SET workspace_committed = 1 WHERE id = ? AND status = 'agent_completed' AND workspace_committed = 0").run(id);
				if (!updated.changes) throw new Error("任务运行尚未通过产物提交校验或提交状态已变化");
				addEvent(id, "workspace_artifacts_committed");
			});
			return mapRun(runById.get(id));
		},
		complete(id) {
			transaction(() => {
				const result = database.prepare("UPDATE task_runs SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'agent_completed' AND workspace_committed = 1").run(new Date().toISOString(), id);
				if (!result.changes) throw new Error("任务运行尚未提交审核产物或已经结束");
				addEvent(id, "completed");
			});
			return mapRun(runById.get(id));
		},
		fail(id, error) {
			transaction(() => {
				const message = shortText(error, 4000) || "Pi Agent 执行失败";
				const result = database.prepare("UPDATE task_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status IN ('running', 'agent_completed')").run(new Date().toISOString(), message, id);
				if (result.changes) addEvent(id, "failed", { error: message });
			});
		},
		cancel(id) {
			transaction(() => {
				const result = database.prepare("UPDATE task_runs SET status = 'cancelled', finished_at = ?, error = '用户取消任务' WHERE id = ? AND status IN ('running', 'agent_completed')").run(new Date().toISOString(), id);
				if (result.changes) addEvent(id, "cancelled", { reason: "用户取消任务" });
			});
		},
		pendingSubmissions() {
			return database.prepare("SELECT * FROM task_runs WHERE status = 'agent_completed' ORDER BY started_at LIMIT 100").all().map(mapRun);
		},
		interruptOpenRuns({ runningOnly = false } = {}) {
			return transaction(() => {
				const rows = database.prepare(runningOnly ? "SELECT * FROM task_runs WHERE status = 'running'" : "SELECT * FROM task_runs WHERE status IN ('running', 'agent_completed')").all();
				for (const row of rows) {
					database.prepare("UPDATE task_runs SET status = 'interrupted', finished_at = ?, recovery_applied = 0 WHERE id = ?").run(new Date().toISOString(), row.id);
					addEvent(row.id, "interrupted", { previousStatus: row.status });
				}
				return rows.map((row) => ({ ...mapRun(row), status: "interrupted" }));
			});
		},
		pendingRecovery() {
			return database.prepare("SELECT * FROM task_runs WHERE status = 'interrupted' AND recovery_applied = 0 ORDER BY started_at").all().map(mapRun);
		},
		markRecoveryApplied(id, outcome) {
			transaction(() => {
				const result = database.prepare("UPDATE task_runs SET recovery_applied = 1 WHERE id = ? AND status = 'interrupted' AND recovery_applied = 0").run(id);
				if (result.changes) addEvent(id, "recovery_applied", { outcome: shortText(outcome, 200) });
			});
		},
		reconcileWorkspaceCommit(id) {
			transaction(() => {
				const result = database.prepare("UPDATE task_runs SET status = 'completed', finished_at = COALESCE(finished_at, ?), workspace_committed = 1, recovery_applied = 1 WHERE id = ? AND status = 'interrupted' AND recovery_applied = 0").run(new Date().toISOString(), id);
				if (!result.changes) throw new Error("中断 Run 已恢复或状态已变化");
				addEvent(id, "workspace_commit_reconciled", { outcome: "已核对工作空间任务产物及磁盘哈希" });
			});
			return mapRun(runById.get(id));
		},
		list(projectId, taskId) {
			return database.prepare("SELECT * FROM task_runs WHERE project_id = ? AND task_id = ? ORDER BY run_number DESC LIMIT 50").all(projectId, taskId).map(mapRun);
		},
		get(id) {
			const row = runById.get(id);
			return row ? mapRun(row) : null;
		},
		requestEgress(input) {
			const requestedAt = new Date().toISOString();
			transaction(() => {
				database.prepare(`INSERT INTO egress_authorizations
					(id, project_id, project_name, operation, provider_id, model_id, data_scope, payload_sha256, payload_bytes, status, requested_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
					.run(input.id, input.projectId, input.projectName, input.operation, input.providerId, input.modelId, input.dataScope, input.payloadSha256, input.payloadBytes, requestedAt);
				addEgressEvent(input.id, "authorization_requested", { dataScope: input.dataScope, payloadBytes: input.payloadBytes, payloadSha256: input.payloadSha256 });
			});
			return mapEgress(egressById.get(input.id));
		},
		decideEgress(id, decision, source) {
			const status = decision === "approved" ? "approved" : "denied";
			const decidedAt = new Date().toISOString();
			transaction(() => {
				const updated = database.prepare("UPDATE egress_authorizations SET status = ?, decided_at = ?, result = ? WHERE id = ? AND status = 'pending'").run(status, decidedAt, decision === "approved" ? "" : "用户拒绝或取消", id);
				if (!updated.changes) throw new Error("该出站授权已处理或已过期");
				addEgressEvent(id, decision === "approved" ? "authorization_approved" : "authorization_denied", { source });
			});
			return mapEgress(egressById.get(id));
		},
		cancelApprovedEgress(id, reason = "授权后操作未能启动") {
			const finishedAt = new Date().toISOString();
			transaction(() => {
				const result = database.prepare("UPDATE egress_authorizations SET status = 'cancelled', finished_at = ?, result = ? WHERE id = ? AND status = 'approved'").run(finishedAt, shortText(reason, 500), id);
				if (!result.changes) throw new Error("该授权已开始、取消或过期");
				addEgressEvent(id, "authorization_cancelled", { reason: shortText(reason, 500), finishedAt });
			});
			return mapEgress(egressById.get(id));
		},
		startEgress(id) {
			const updatedAt = new Date().toISOString();
			transaction(() => {
				const updated = database.prepare("UPDATE egress_authorizations SET status = 'in_progress' WHERE id = ? AND status = 'approved'").run(id);
				if (!updated.changes) throw new Error("出站授权未批准、已使用或已过期");
				addEgressEvent(id, "model_operation_started", { startedAt: updatedAt });
			});
			return mapEgress(egressById.get(id));
		},
		providerRequest(id, details) {
			transaction(() => {
				const updated = database.prepare("UPDATE egress_authorizations SET provider_request_count = provider_request_count + 1 WHERE id = ? AND status = 'in_progress'").run(id);
				if (!updated.changes) throw new Error("出站授权不再处于运行状态");
				addEgressEvent(id, "provider_request_guard_passed", details);
			});
		},
		egressFileRead(id, details) {
			transaction(() => {
				const row = egressById.get(id);
				if (!row || row.status !== "in_progress") throw new Error("出站授权不再处于运行状态");
				addEgressEvent(id, "project_file_read", details);
			});
		},
		finishEgress(id, status, result = "") {
			if (!new Set(["succeeded", "failed", "cancelled", "expired", "interrupted"]).has(status)) throw new Error("出站审计状态无效");
			const finishedAt = new Date().toISOString();
			const auditResult = shortText(result, 4000);
			transaction(() => {
				const updated = database.prepare("UPDATE egress_authorizations SET status = ?, finished_at = ?, result = ? WHERE id = ? AND status IN ('pending', 'approved', 'in_progress')").run(status, finishedAt, auditResult, id);
				if (updated.changes) addEgressEvent(id, `model_operation_${status}`, { result: auditResult, finishedAt });
			});
			return egressById.get(id) ? mapEgress(egressById.get(id)) : null;
		},
		recoverOpenEgress() {
			return transaction(() => {
				const pending = database.prepare("SELECT id FROM egress_authorizations WHERE status IN ('pending', 'approved')").all();
				const running = database.prepare("SELECT id FROM egress_authorizations WHERE status = 'in_progress'").all();
				for (const row of pending) {
					database.prepare("UPDATE egress_authorizations SET status = 'expired', finished_at = ?, result = 'Runtime 重启前未完成授权' WHERE id = ?").run(new Date().toISOString(), row.id);
					addEgressEvent(row.id, "authorization_expired", { reason: "Runtime 重启前未完成授权" });
				}
				for (const row of running) {
					database.prepare("UPDATE egress_authorizations SET status = 'interrupted', finished_at = ?, result = 'Runtime 在模型操作期间重启' WHERE id = ?").run(new Date().toISOString(), row.id);
					addEgressEvent(row.id, "model_operation_interrupted", { reason: "Runtime 在模型操作期间重启" });
				}
				return { expired: pending.length, interrupted: running.length };
			});
		},
		listEgress(projectId, limit = 50) {
			const rows = projectId
				? database.prepare("SELECT * FROM egress_authorizations WHERE project_id = ? ORDER BY requested_at DESC LIMIT ?").all(projectId, limit)
				: database.prepare("SELECT * FROM egress_authorizations ORDER BY requested_at DESC LIMIT ?").all(limit);
			return rows.map((row) => ({
				...mapEgress(row),
				events: database.prepare("SELECT event_type AS type, created_at AS createdAt, details_json AS details FROM egress_audit_events WHERE authorization_id = ? ORDER BY id").all(row.id).map((event) => ({ ...event, details: JSON.parse(event.details) })),
			}));
		},
		events(id) {
			return database.prepare("SELECT event_type AS type, created_at AS createdAt, details_json AS details FROM task_run_events WHERE run_id = ? ORDER BY id").all(id).map((event) => ({ ...event, details: JSON.parse(event.details) }));
		},
		close() { database.close(); },
	};
}

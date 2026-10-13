import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createWorkspaceStore } from "../src/workspace-store.mjs";

const testDirectory = await mkdtemp(join(process.cwd(), ".egress-api-test-"));
const execFileAsync = promisify(execFile);
const activeFixtures = new Set();
const childEntry = join(process.cwd(), "test", "fixtures", "egress-runtime-child.mjs");

after(async () => {
	for (const fixture of activeFixtures) await fixture.stop().catch(() => {});
	const root = resolve(process.cwd());
	const target = resolve(testDirectory);
	const rel = relative(root, target);
	if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) await removeTemporaryTree(target);
});

async function reservePort() {
	const server = createNetServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address();
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return port;
}

async function wait(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function removeTemporaryTree(path) {
	for (let attempt = 0; ; attempt++) {
		try { await rm(path, { recursive: true, force: true }); return; }
		catch (error) {
			if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code) || attempt >= 8) throw error;
			await wait(50 * (attempt + 1));
		}
	}
}

async function waitForExit(child, timeoutMs = 5000) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		wait(timeoutMs).then(() => { throw new Error("fixture Runtime 子进程未退出"); }),
	]);
}

async function makeFixture({ egressLifetimeMs = 10_000, approval = "每次确认" } = {}) {
	const root = await mkdtemp(join(testDirectory, "runtime-"));
	const agentDirectory = join(root, "agent");
	const stateDirectory = join(root, "runtime-state");
	const projectDirectory = join(root, "project");
	const providerLog = join(root, "provider-fetches.jsonl");
	const providerMode = join(root, "provider-mode.txt");
	await Promise.all([mkdir(agentDirectory, { recursive: true }), mkdir(stateDirectory, { recursive: true }), mkdir(projectDirectory, { recursive: true })]);
	await execFileAsync("git", ["init", "--quiet", projectDirectory]);
	await writeFile(providerMode, "reject", "utf8");
	await writeFile(join(agentDirectory, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-only-not-a-credential" } }), "utf8");
	await writeFile(join(agentDirectory, "models.json"), JSON.stringify({ providers: {
		openai: {
			api: "openai-completions",
			baseUrl: "http://fixture-provider.invalid/v1",
			models: [{ id: "fixture-model", name: "Fixture Model", api: "openai-completions", baseUrl: "http://fixture-provider.invalid/v1", input: ["text"], contextWindow: 8192, maxTokens: 512 }],
		},
	} }), "utf8");
	const projectId = "project-egress-fixture";
	const workspacePath = join(agentDirectory, "ai-agent-team-workspace.json");
	const workspaceStore = createWorkspaceStore(workspacePath);
	const project = {
		project: { id: projectId, name: "隔离出站测试", goal: "只用于 Runtime 验收", status: "配置中", updatedAt: "现在", workspacePath: projectDirectory },
		agents: [{ id: "fixture-agent", templateId: "project-manager", name: "测试 Agent", role: "项目管理", group: "研发组", status: "待命", tools: [{ id: "file-create", enabled: true }, { id: "file-read", enabled: true }] }],
		groups: ["研发组"],
		meeting: { id: "fixture-meeting", title: "隔离会议", status: "需求确认中", needsConfirmed: false, openQuestions: [], messages: [{ id: "fixture-user-message", sender: "用户", text: "仅用于隔离测试", time: "现在" }], plan: null },
		tasks: [], artifacts: [], workspaceFolders: [], versions: [], deliveryStatus: "未发布",
		settings: { egressApproval: approval }, activities: [], teamSaved: true,
	};
	await workspaceStore.put(0, { activeProjectId: projectId, projects: [project] });
	const runtimePort = await reservePort();
	let webPort = await reservePort();
	while (webPort === runtimePort) webPort = await reservePort();
	const proxy = createHttpServer((incoming, outgoing) => {
		const upstream = httpRequest({
			hostname: "127.0.0.1", port: runtimePort, path: incoming.url, method: incoming.method,
			headers: { ...incoming.headers, host: `127.0.0.1:${webPort}` },
		}, (response) => {
			outgoing.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(outgoing);
		});
		upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
		incoming.pipe(upstream);
	});
	await new Promise((resolve, reject) => {
		proxy.once("error", reject);
		proxy.listen(webPort, "127.0.0.1", resolve);
	});
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDirectory,
		AI_TEAM_RUNTIME_STATE_DIR: stateDirectory,
		AI_TEAM_MODEL_RUNTIME_PORT: String(runtimePort),
		AI_TEAM_WEB_PORT: String(webPort),
		AI_TEAM_EGRESS_AUTH_LIFETIME_MS: String(egressLifetimeMs),
		FIXTURE_PROVIDER_LOG: providerLog,
		FIXTURE_PROVIDER_MODE: providerMode,
	};
	let child;
	let childStderr = "";
	let childStdout = "";
	let token = "";
	let apiOrigin = `http://127.0.0.1:${webPort}`;
	const trustedOrigin = `http://127.0.0.1:${webPort}`;
	const fixture = {
		root, agentDirectory, stateDirectory, projectDirectory, providerLog, providerMode, workspaceStore, projectId,
		async launch() {
			child = spawn(process.execPath, [childEntry], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			child.stderr.setEncoding("utf8").on("data", (chunk) => { childStderr = (childStderr + chunk).slice(-4000); });
			child.stdout.setEncoding("utf8").on("data", (chunk) => { childStdout = (childStdout + chunk).slice(-1000); });
			const deadline = Date.now() + 15_000;
			let ready = false;
			let healthDiagnostic = "";
			while (Date.now() < deadline) {
				if (child.exitCode !== null) throw new Error(`隔离 Runtime 子进程提前退出 (${child.exitCode})`);
				try {
					const response = await fetch(`${apiOrigin}/api/health`, { headers: { host: `127.0.0.1:${runtimePort}` }, signal: AbortSignal.timeout(500) });
					const body = await response.text();
					healthDiagnostic = "HTTP " + response.status + " " + body;
					if (response.ok && JSON.parse(body).status === "ok") { ready = true; break; }
				} catch (error) { healthDiagnostic = error instanceof Error ? error.message : String(error); }
				await wait(50);
			}
			if (!ready) throw new Error("隔离 Runtime 未能启动" + (childStderr ? "：" + childStderr : "") + (childStdout ? "；stdout: " + childStdout : "") + (healthDiagnostic ? "；health: " + healthDiagnostic : ""));
			const session = await fetch(`${apiOrigin}/api/session`, {
				method: "POST",
				headers: { host: `127.0.0.1:${webPort}`, origin: trustedOrigin, "content-type": "application/json" },
				body: "{}",
			});
			const sessionBody = await session.json();
			assert.equal(session.status, 200, JSON.stringify(sessionBody));
			token = sessionBody.token;
		},
		async request(path, { method = "POST", body, trusted = true } = {}) {
			return fetch(`${apiOrigin}${path}`, {
				method,
				headers: {
					host: `127.0.0.1:${webPort}`,
					...(trusted ? { origin: trustedOrigin } : {}),
					...(token ? { "x-ai-team-session": token } : {}),
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		},
		async json(path, options) { const response = await this.request(path, options); return { response, body: await response.json() }; },
		async prepare(operation = "meeting.reply", extra = {}) {
			const request = operation === "meeting.plan" ? {
				meetingId: "fixture-meeting",
				projectGoal: "隔离会议计划测试",
				groups: ["研发组"],
				agents: [{ name: "测试 Agent", role: "项目管理" }],
				messages: [{ role: "user", content: "fixture-private-request-body" }],
			} : { meetingId: "fixture-meeting", systemPrompt: "Isolated fixture", messages: [{ role: "user", content: "fixture-private-request-body" }] };
			const authorizedRequest = { ...request, ...extra.request };
			return this.json("/api/model-runtime/egress/prepare", { body: {
			operation, projectId, providerId: "openai", modelId: "fixture-model",
				...(operation === "task.execute" ? extra : { request: authorizedRequest }),
			} });
		},
		async audit() { return (await this.json(`/api/model-runtime/egress/audit?projectId=${projectId}`, { method: "GET" })).body.records; },
		async providerCalls() { try { return (await readFile(providerLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } },
		async setProviderMode(mode) { await writeFile(providerMode, mode, "utf8"); },
		async waitForProviderCalls(count, timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) { if ((await this.providerCalls()).length >= count) return; await wait(25); }
			throw new Error(`假 Provider 未收到预期的 ${count} 次请求`);
		},
		async stop() {
			if (child && child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await waitForExit(child);
			}
			if (proxy.listening) await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
		},
		async killHard() {
			if (!child || child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGKILL");
			await waitForExit(child);
		},
	};
	activeFixtures.add(fixture);
	await fixture.launch();
	return fixture;
}

async function approve(fixture, authorizationId, userConfirmed = true) {
	return fixture.json("/api/model-runtime/egress/decision", { body: { authorizationId, decision: "approved", userConfirmed } });
}

test("Runtime rejects unprepared and denied model requests, and records startup cancellation", async () => {
	const fixture = await makeFixture();
	try {
		const unprepared = await fixture.json("/api/model-runtime/chat", { body: { authorizationId: "not-authorized" } });
		assert.equal(unprepared.response.status, 409);
		assert.equal((await fixture.providerCalls()).length, 0);

		const prepared = await fixture.prepare();
		assert.equal(prepared.response.status, 200);
		const denied = await fixture.json("/api/model-runtime/egress/decision", { body: { authorizationId: prepared.body.authorizationId, decision: "denied" } });
		assert.equal(denied.response.status, 200);
		const deniedCall = await fixture.json("/api/model-runtime/chat", { body: { authorizationId: prepared.body.authorizationId } });
		assert.equal(deniedCall.response.status, 409);

		const cancelledAuth = await fixture.prepare();
		assert.equal((await approve(fixture, cancelledAuth.body.authorizationId)).response.status, 200);
		const cancelled = await fixture.json("/api/model-runtime/egress/decision", { body: { authorizationId: cancelledAuth.body.authorizationId, decision: "cancelled" } });
		assert.equal(cancelled.response.status, 200);
		assert.equal((await fixture.providerCalls()).length, 0);

		const records = Object.fromEntries((await fixture.audit()).map((record) => [record.id, record]));
		assert.equal(records[prepared.body.authorizationId].status, "denied");
		assert.equal(records[prepared.body.authorizationId].providerRequestCount, 0);
		assert.equal(records[cancelledAuth.body.authorizationId].status, "cancelled");
		assert.equal(JSON.stringify(records).includes("fixture-private-request-body"), false);
	} finally { await fixture.stop(); }
});

test("Runtime rechecks stricter egress policy at approval time", async () => {
	const fixture = await makeFixture({ approval: "项目范围内" });
	try {
		const prepared = await fixture.prepare();
		assert.equal(prepared.body.requiresConfirmation, false);
		const stored = await fixture.workspaceStore.read();
		const workspace = structuredClone(stored.workspace);
		workspace.projects[0].settings.egressApproval = "每次确认";
		await fixture.workspaceStore.put(stored.revision, workspace);

		const decision = await approve(fixture, prepared.body.authorizationId, false);
		assert.equal(decision.response.status, 403);
		assert.equal((await fixture.providerCalls()).length, 0);
		const [record] = await fixture.audit();
		assert.equal(record.status, "denied");
		assert.ok(record.events.some((event) => event.type === "authorization_denied" && event.details.source === "授权策略要求重新确认"));
	} finally { await fixture.stop(); }
});

test("only an approved operation reaches the fake provider and its authorization is one-use", async () => {
	const fixture = await makeFixture();
	try {
		const prepared = await fixture.prepare();
		assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
		const approval = await approve(fixture, prepared.body.authorizationId);
		assert.equal(approval.response.status, 200, JSON.stringify({ prepared: prepared.body, approval: approval.body }));
		const response = await fixture.json("/api/model-runtime/chat", { body: { authorizationId: prepared.body.authorizationId } });
		assert.equal(response.response.status, 502, "the fake provider deliberately returns 401");
		const replay = await fixture.json("/api/model-runtime/chat", { body: { authorizationId: prepared.body.authorizationId } });
		assert.equal(replay.response.status, 409);

		const calls = await fixture.providerCalls();
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "http://fixture-provider.invalid/v1/chat/completions");
		const [record] = await fixture.audit();
		assert.equal(record.status, "failed");
		assert.equal(record.providerRequestCount, 1);
		assert.match(record.result, /供应商：openai/);
		assert.match(record.result, /模型：fixture-model/);
		assert.match(record.result, /Fixture provider intentionally rejects test requests/);
		assert.match(record.result, /401/);
		assert.doesNotMatch(record.result, /sk_fixture_secret_123456789/);
		assert.match(record.result, /凭证已隐藏|已隐藏/);
		assert.ok(record.events.some((event) => event.type === "provider_request_guard_passed"));
	} finally { await fixture.stop(); }
});

test("meeting plan failures keep detailed provider diagnostics in the audit log", async () => {
	const fixture = await makeFixture();
	try {
		const prepared = await fixture.prepare("meeting.plan");
		assert.equal(prepared.response.status, 200);
		assert.equal((await approve(fixture, prepared.body.authorizationId)).response.status, 200);
		const response = await fixture.json("/api/model-runtime/plan", { body: { authorizationId: prepared.body.authorizationId } });
		assert.equal(response.response.status, 502);
		const record = (await fixture.audit()).find((item) => item.id === prepared.body.authorizationId);
		assert.equal(record.status, "failed");
		assert.match(record.result, /Fixture provider intentionally rejects test requests/);
		assert.match(record.result, /401/);
		assert.doesNotMatch(record.result, /计划请求失败或模型未生成有效计划/);
		assert.doesNotMatch(record.result, /sk_fixture_secret_123456789/);
	} finally { await fixture.stop(); }
});

test("expired authorization is rejected before provider access", async () => {
	const fixture = await makeFixture({ egressLifetimeMs: 100 });
	try {
		const prepared = await fixture.prepare();
		await wait(180);
		const decision = await approve(fixture, prepared.body.authorizationId);
		assert.equal(decision.response.status, 409);
		assert.equal((await fixture.providerCalls()).length, 0);
		const [record] = await fixture.audit();
		assert.equal(record.status, "expired");
		assert.equal(record.providerRequestCount, 0);
	} finally { await fixture.stop(); }
});

test("Runtime restart expires approved authorization and marks an active model operation interrupted", async () => {
	const fixture = await makeFixture();
	try {
		const approvedAuth = await fixture.prepare();
		await approve(fixture, approvedAuth.body.authorizationId);

		const activeAuth = await fixture.prepare();
		await approve(fixture, activeAuth.body.authorizationId);
		await fixture.setProviderMode("hold");
		const activeRequest = fixture.request("/api/model-runtime/chat", { body: { authorizationId: activeAuth.body.authorizationId } }).catch(() => null);
		await fixture.waitForProviderCalls(1);
		await fixture.killHard();
		await activeRequest;
		await fixture.launch();

		const records = Object.fromEntries((await fixture.audit()).map((record) => [record.id, record]));
		assert.equal(records[approvedAuth.body.authorizationId].status, "expired");
		assert.equal(records[activeAuth.body.authorizationId].status, "interrupted");
		assert.equal(records[activeAuth.body.authorizationId].providerRequestCount, 1);
	} finally { await fixture.stop(); }
});

test("authorized TaskRun records Provider failure and can be cancelled while awaiting the fixture", async () => {
	const fixture = await makeFixture();
	try {
		let stored = await fixture.workspaceStore.read();
		let result = await fixture.workspaceStore.command(stored.revision, fixture.projectId, { type: "meeting.confirm-requirements" });
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.generate", tasks: [{ title: "验证假 Provider", group: "研发组", assignee: "测试 Agent", summary: "确认任务执行通过 Runtime 授权" }] });
		const planId = result.workspace.projects[0].meeting.plan.id;
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.approve", planId });
		let task = result.workspace.projects[0].tasks[0];

		const prepared = await fixture.prepare("task.execute", { taskId: task.id });
		await approve(fixture, prepared.body.authorizationId);
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "task.start", taskId: task.id });
		let execute = await fixture.json("/api/model-runtime/execute", { body: { authorizationId: prepared.body.authorizationId } });
		assert.equal(execute.response.status, 502);
		let runs = (await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs;
		assert.equal(runs[0].status, "failed");
		let egress = (await fixture.audit()).find((record) => record.id === prepared.body.authorizationId);
		assert.equal(egress.status, "failed");
		assert.equal(egress.providerRequestCount, 1, JSON.stringify({ egress, runs }));
		assert.match(egress.result, /Fixture provider intentionally rejects test requests/);
		assert.match(runs[0].error, /Fixture provider intentionally rejects test requests/);
		assert.doesNotMatch(egress.result, /sk_fixture_secret_123456789/);
		assert.doesNotMatch(runs[0].error, /sk_fixture_secret_123456789/);

		stored = await fixture.workspaceStore.read();
		result = await fixture.workspaceStore.command(stored.revision, fixture.projectId, { type: "task.fail", taskId: task.id, error: "假 Provider 拒绝请求" });
		stored = await fixture.workspaceStore.read();
		task = stored.workspace.projects[0].tasks[0];
		const secondPrepared = await fixture.prepare("task.execute", { taskId: task.id });
		await approve(fixture, secondPrepared.body.authorizationId);
		result = await fixture.workspaceStore.command(stored.revision, fixture.projectId, { type: "task.start", taskId: task.id });
		await fixture.setProviderMode("hold");
		const runningRequest = fixture.request("/api/model-runtime/execute", { body: { authorizationId: secondPrepared.body.authorizationId } }).catch(() => null);
		await fixture.waitForProviderCalls(2);
		const cancel = await fixture.json("/api/model-runtime/runs/cancel", { body: { projectId: fixture.projectId, taskId: task.id } });
		assert.equal(cancel.response.status, 200);
		await runningRequest;
		runs = (await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs;
		assert.equal(runs[0].status, "cancelled");
		egress = (await fixture.audit()).find((record) => record.id === secondPrepared.body.authorizationId);
		assert.equal(egress.status, "cancelled");
	} finally { await fixture.killHard(); }
});

test("actual AgentSession file reads are recorded in egress audit without storing file contents", async () => {
	const fixture = await makeFixture();
	try {
		const sourceContent = "仅用于本地假 Provider 文件访问验收";
		await mkdir(join(fixture.projectDirectory, "01_需求文档"), { recursive: true });
		await writeFile(join(fixture.projectDirectory, "01_需求文档", "brief.md"), sourceContent, "utf8");
		let stored = await fixture.workspaceStore.read();
		let result = await fixture.workspaceStore.command(stored.revision, fixture.projectId, { type: "meeting.confirm-requirements" });
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.generate", tasks: [{ title: "验证文件审计", group: "研发组", assignee: "测试 Agent", summary: "读取项目需求并创建审计文件" }] });
		const planId = result.workspace.projects[0].meeting.plan.id;
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.approve", planId });
		const task = result.workspace.projects[0].tasks[0];
		const prepared = await fixture.prepare("task.execute", { taskId: task.id });
		assert.equal(prepared.response.status, 200);
		assert.equal((await approve(fixture, prepared.body.authorizationId)).response.status, 200);
		await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "task.start", taskId: task.id });

		await fixture.setProviderMode("agent-read-audit");
		const execution = await fixture.json("/api/model-runtime/execute", { body: { authorizationId: prepared.body.authorizationId } });
		assert.equal(execution.response.status, 200, JSON.stringify(execution.body));
		assert.equal((await fixture.providerCalls()).length, 3, "读取工具、写入工具和最终回复各发起一次模型请求");
		assert.equal(execution.body.files.length, 1);
		assert.equal(execution.body.files[0].path, "audit-result.md");
		assert.deepEqual(execution.body.objectiveChecks.map((item) => item.status), ["passed", "passed", "passed", "passed", "not_run"]);
		assert.equal(await readFile(join(fixture.projectDirectory, "04_测试报告", task.id, "Run-1", "audit-result.md"), "utf8"), "由隔离 Agent 依据项目文件生成");

		const [record] = (await fixture.audit()).filter((item) => item.id === prepared.body.authorizationId);
		assert.equal(record.status, "succeeded");
		assert.equal(record.providerRequestCount, 3);
		const reads = record.events.filter((event) => event.type === "project_file_read");
		assert.equal(reads.length, 1);
		assert.deepEqual(reads[0].details, {
			path: "01_需求文档/brief.md",
			sha256: createHash("sha256").update(sourceContent, "utf8").digest("hex"),
			bytes: Buffer.byteLength(sourceContent, "utf8"),
		});
		assert.equal(JSON.stringify(record).includes(sourceContent), false, "出站审计仅保留文件路径、大小及哈希，不写入文件正文");
		const runs = (await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs;
		assert.equal(runs[0].status, "agent_completed");
		assert.deepEqual(runs[0].outputFiles.map((file) => file.path), ["audit-result.md"]);
		assert.equal(runs[0].objectiveChecks.find((item) => item.id === "output_integrity").evidence[0].sha256, createHash("sha256").update("由隔离 Agent 依据项目文件生成", "utf8").digest("hex"));

		const artifact = { id: "fixture-agent-artifact", name: "验证文件审计_Run-1.md", kind: "测试报告", taskId: task.id, owner: task.assignee, version: "Run 1", status: "待审核", updatedAt: "现在", size: "1 KB", content: execution.body.content };
		const prematureComplete = await fixture.json(`/api/model-runtime/runs/${execution.body.runId}/complete`, { body: {} });
		assert.equal(prematureComplete.response.status, 409, "Run 在工作空间产物提交前不能标记为完成");
		let workspace = await fixture.workspaceStore.read();
		const tamperedSubmission = await fixture.json("/api/workspace/command", { body: {
			expectedRevision: workspace.revision,
			projectId: fixture.projectId,
			command: { type: "task.complete", taskId: task.id, runId: execution.body.runId, artifact, files: [{ path: "audit-result.md", content: "客户端伪造的文件" }] },
		} });
		assert.equal(tamperedSubmission.response.status, 409);
		workspace = await fixture.workspaceStore.read();
		assert.equal(workspace.workspace.projects[0].tasks[0].status, "执行中", "文件与检查哈希不匹配时不得提交审核");

		const validSubmission = await fixture.json("/api/workspace/command", { body: {
			expectedRevision: workspace.revision,
			projectId: fixture.projectId,
			command: { type: "task.complete", taskId: task.id, runId: execution.body.runId, artifact, files: execution.body.files },
		} });
		assert.equal(validSubmission.response.status, 200, JSON.stringify(validSubmission.body));
		await fixture.killHard();
		await fixture.launch();
		const recoveredRuns = (await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs;
		assert.equal(recoveredRuns[0].status, "completed", "提交审核后的重启应根据 Run 哈希对账并收尾");
		assert.ok(recoveredRuns[0].objectiveChecks.some((item) => item.id === "output_integrity" && item.status === "passed"));
	} finally { await fixture.stop(); }
});

test("Runtime recovers when workspace JSON commits but the SQLite marker transaction fails", async () => {
	const fixture = await makeFixture();
	try {
		let stored = await fixture.workspaceStore.read();
		let result = await fixture.workspaceStore.command(stored.revision, fixture.projectId, { type: "meeting.confirm-requirements" });
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.generate", tasks: [{ title: "验证跨存储提交恢复", group: "研发组", assignee: "测试 Agent", summary: "创建一份可核验的任务产物" }] });
		const planId = result.workspace.projects[0].meeting.plan.id;
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.approve", planId });
		const task = result.workspace.projects[0].tasks[0];
		const prepared = await fixture.prepare("task.execute", { taskId: task.id });
		assert.equal(prepared.response.status, 200);
		assert.equal((await approve(fixture, prepared.body.authorizationId)).response.status, 200);
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "task.start", taskId: task.id });
		await fixture.setProviderMode("agent-read-audit");
		const execution = await fixture.json("/api/model-runtime/execute", { body: { authorizationId: prepared.body.authorizationId } });
		assert.equal(execution.response.status, 200, JSON.stringify(execution.body));
		const artifact = { id: "fixture-cross-store-artifact", name: "跨存储提交恢复.md", kind: "测试报告", taskId: task.id, owner: task.assignee, version: "Run 1", status: "待审核", updatedAt: "现在", size: "1 KB", content: execution.body.content };
		const runId = execution.body.runId;
		const databasePath = join(fixture.stateDirectory, "task-runs.sqlite");
		const database = new DatabaseSync(databasePath);
		database.exec("CREATE TRIGGER injected_workspace_marker_failure BEFORE UPDATE OF workspace_committed ON task_runs BEGIN SELECT RAISE(ABORT, 'fixture injected marker failure'); END");
		database.close();

		stored = await fixture.workspaceStore.read();
		const failedMarker = await fixture.json("/api/workspace/command", { body: {
			expectedRevision: stored.revision,
			projectId: fixture.projectId,
			command: { type: "task.complete", taskId: task.id, runId, artifact, files: execution.body.files },
		} });
		assert.notEqual(failedMarker.response.status, 200, "SQLite 提交标记故障应让请求失败，不能误报完整成功");
		stored = await fixture.workspaceStore.read();
		assert.equal(stored.workspace.projects[0].tasks[0].status, "待审核", "工作空间 JSON 已在 SQLite 标记失败前提交");
		assert.ok(stored.workspace.projects[0].artifacts.some((item) => item.id === artifact.id));

		await fixture.killHard();
		const recoveryDatabase = new DatabaseSync(databasePath);
		const markerRow = recoveryDatabase.prepare("SELECT status, workspace_committed FROM task_runs WHERE id = ?").get(runId);
		assert.equal(markerRow.status, "agent_completed");
		assert.equal(markerRow.workspace_committed, 0, "注入后 SQLite 标记仍保持未提交");
		recoveryDatabase.exec("DROP TRIGGER injected_workspace_marker_failure");
		recoveryDatabase.close();

		await fixture.launch();
		const recoveredRuns = (await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs;
		assert.equal(recoveredRuns[0].status, "completed", "启动恢复应对账 JSON、任务产物和 Run 哈希并完成 SQLite 状态");
		assert.equal(recoveredRuns[0].workspaceCommitted, true);
		assert.equal(recoveredRuns[0].outputFiles.length, execution.body.files.length);
		stored = await fixture.workspaceStore.read();
		assert.equal(stored.workspace.projects[0].tasks[0].status, "待审核");
	} finally { await fixture.stop(); }
});

test("forced Runtime restart recovers an active TaskRun once without output or Git side effects", async () => {
	const fixture = await makeFixture();
	try {
		let stored = await fixture.workspaceStore.read();
		let result = await fixture.workspaceStore.command(stored.revision, fixture.projectId, { type: "meeting.confirm-requirements" });
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.generate", tasks: [{ title: "验证强制重启恢复", group: "研发组", assignee: "测试 Agent", summary: "运行期间强制终止 Runtime 后核对恢复状态" }] });
		const planId = result.workspace.projects[0].meeting.plan.id;
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.approve", planId });
		const task = result.workspace.projects[0].tasks[0];

		const prepared = await fixture.prepare("task.execute", { taskId: task.id });
		assert.equal(prepared.response.status, 200);
		assert.equal((await approve(fixture, prepared.body.authorizationId)).response.status, 200);
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "task.start", taskId: task.id });
		const initialGitStatus = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: fixture.projectDirectory });

		await fixture.setProviderMode("hold");
		const activeRequest = fixture.request("/api/model-runtime/execute", { body: { authorizationId: prepared.body.authorizationId } }).catch(() => null);
		await fixture.waitForProviderCalls(1);
		stored = await fixture.workspaceStore.read();
		assert.equal(stored.workspace.projects[0].tasks[0].status, "执行中");
		await fixture.killHard();
		await activeRequest;
		await fixture.launch();

		stored = await fixture.workspaceStore.read();
		let recoveredTask = stored.workspace.projects[0].tasks[0];
		assert.equal(recoveredTask.status, "待分配");
		assert.equal(recoveredTask.progress, 0);
		assert.match(recoveredTask.reviewNote, /Runtime 重启后发现 Run 1 中断/);
		assert.equal(stored.workspace.projects[0].agents[0].status, "空闲");
		const outputDirectory = join(fixture.projectDirectory, task.outputDirectory, task.id, "Run-1");
		assert.deepEqual(await readdir(outputDirectory), [], "被中断的模拟模型调用尚未生成产物文件");
		assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: fixture.projectDirectory })).stdout, initialGitStatus.stdout);
		let runs = (await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs;
		assert.equal(runs.length, 1);
		assert.equal(runs[0].status, "interrupted");
		assert.equal(runs[0].runNumber, 1);
		assert.deepEqual(runs[0].outputFiles, []);
		let records = (await fixture.audit()).filter((record) => record.id === prepared.body.authorizationId);
		assert.equal(records.length, 1);
		assert.equal(records[0].status, "interrupted");
		assert.equal(records[0].providerRequestCount, 1);
		assert.equal(records[0].events.filter((event) => event.type === "model_operation_interrupted").length, 1);

		await fixture.killHard();
		await fixture.launch();
		stored = await fixture.workspaceStore.read();
		recoveredTask = stored.workspace.projects[0].tasks[0];
		assert.equal(recoveredTask.status, "待分配");
		assert.equal(recoveredTask.logs.filter((entry) => entry.includes("Runtime 重启后发现 Run 1 中断")).length, 1);
		runs = (await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs;
		assert.equal(runs.length, 1, "重复启动不能复制 TaskRun");
		records = (await fixture.audit()).filter((record) => record.id === prepared.body.authorizationId);
		assert.equal(records.length, 1);
		assert.equal(records[0].events.filter((event) => event.type === "model_operation_interrupted").length, 1);
		assert.deepEqual(await readdir(outputDirectory), []);
		assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: fixture.projectDirectory })).stdout, initialGitStatus.stdout);
	} finally { await fixture.stop(); }
});

test("forced restart reconciles files written before an AgentSession was interrupted", async () => {
	const fixture = await makeFixture();
	try {
		let stored = await fixture.workspaceStore.read();
		let result = await fixture.workspaceStore.command(stored.revision, fixture.projectId, { type: "meeting.confirm-requirements" });
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.generate", tasks: [{ title: "验证中断产物恢复", group: "研发组", assignee: "测试 Agent", summary: "先写一个文件，再让模型请求保持运行" }] });
		const planId = result.workspace.projects[0].meeting.plan.id;
		result = await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "plan.approve", planId });
		const task = result.workspace.projects[0].tasks[0];
		const prepared = await fixture.prepare("task.execute", { taskId: task.id });
		assert.equal(prepared.response.status, 200);
		assert.equal((await approve(fixture, prepared.body.authorizationId)).response.status, 200);
		await fixture.workspaceStore.command(result.revision, fixture.projectId, { type: "task.start", taskId: task.id });

		await fixture.setProviderMode("agent-write-then-hold");
		const activeRequest = fixture.request("/api/model-runtime/execute", { body: { authorizationId: prepared.body.authorizationId } }).catch(() => null);
		await fixture.waitForProviderCalls(2);
		const relativePath = "04_测试报告/TASK-001/Run-1/partial.md";
		const absolutePath = join(fixture.projectDirectory, ...relativePath.split("/"));
		assert.equal(await readFile(absolutePath, "utf8"), "由假 Agent 在中断前写出的部分产物");
		const outputDirectory = join(fixture.projectDirectory, "04_测试报告", task.id, "Run-1");
		await Promise.all([
			writeFile(join(outputDirectory, ".env"), "fixture-secret-must-not-be-indexed"),
			writeFile(join(outputDirectory, "binary.bin"), Buffer.from([0, 255, 1])),
			writeFile(join(outputDirectory, "oversized.md"), Buffer.alloc(1024 * 1024 + 1, 97)),
		]);
		await fixture.killHard();
		await activeRequest;
		await fixture.launch();

		stored = await fixture.workspaceStore.read();
		const recoveredTask = stored.workspace.projects[0].tasks[0];
		assert.equal(recoveredTask.status, "待分配");
		assert.match(recoveredTask.reviewNote, /1 个部分文件/);
		assert.match(recoveredTask.reviewNote, /3 个文件因路径、安全或容量限制未登记/);
		const [artifact] = stored.workspace.projects[0].artifacts;
		assert.equal(stored.workspace.projects[0].artifacts.length, 1);
		assert.equal(artifact.taskId, task.id);
		assert.equal(artifact.status, "参考");
		assert.equal(artifact.relativePath, relativePath);
		assert.equal(artifact.content, "由假 Agent 在中断前写出的部分产物");
		const runs = (await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs;
		assert.equal(runs.length, 1);
		assert.equal(runs[0].status, "interrupted");
		assert.deepEqual(runs[0].outputFiles, [{
			path: "partial.md",
			sha256: createHash("sha256").update(artifact.content, "utf8").digest("hex"),
			bytes: Buffer.byteLength(artifact.content, "utf8"),
		}]);
		const [audit] = (await fixture.audit()).filter((record) => record.id === prepared.body.authorizationId);
		assert.equal(audit.status, "interrupted");
		assert.equal(audit.providerRequestCount, 2);
		const initialGitStatus = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: fixture.projectDirectory });
		assert.match(initialGitStatus.stdout, /Run-1[\\/]partial\.md/);

		await fixture.killHard();
		await fixture.launch();
		stored = await fixture.workspaceStore.read();
		assert.equal(stored.workspace.projects[0].artifacts.length, 1, "重复重启不能重复登记部分产物");
		assert.equal(stored.workspace.projects[0].tasks[0].logs.filter((entry) => entry.includes("中断 Run 1 的部分文件")).length, 1);
		assert.equal((await fixture.json(`/api/model-runtime/runs?projectId=${fixture.projectId}&taskId=${task.id}`, { method: "GET" })).body.runs.length, 1);
		assert.equal((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: fixture.projectDirectory })).stdout, initialGitStatus.stdout);
	} finally { await fixture.stop(); }
});

 test("chat pause and interrupt abort provider requests with cancelled audit records", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.setProviderMode("hold");
    for (const mode of ["paused", "interrupted"]) {
      const prepared = await fixture.prepare();
      const id = prepared.body.authorizationId;
      await approve(fixture, id);
      const calls = (await fixture.providerCalls()).length;
      const pending = fixture.json("/api/model-runtime/chat", { body: { authorizationId: id } });
      await fixture.waitForProviderCalls(calls + 1);
      const stopped = await fixture.json("/api/model-runtime/chat/cancel", { body: { authorizationId: id, mode } });
      assert.equal(stopped.response.status, 200, JSON.stringify(stopped.body));
      const result = await pending;
      assert.equal(result.body.interrupted, true);
      assert.equal(result.body.mode, mode);
      assert.equal((await fixture.audit()).find((record) => record.id === id).status, "cancelled");
      assert.equal((await fixture.json("/api/model-runtime/chat", { body: { authorizationId: id } })).response.status, 409);
    }
  } finally { await fixture.stop(); }
});

test("multi-turn meeting replies deliver authorized project attachments to the SDK", async () => {
 const fixture = await makeFixture();
 try {
  await fixture.setProviderMode("chat-attachment");
  const stored = await fixture.workspaceStore.read();
  await fixture.workspaceStore.command(stored.revision, fixture.projectId, { type: "artifact.add", artifact: { id: "chat-file", name: "brief.txt", kind: "交付文件", taskId: "项目文件", owner: "用户", version: "v1", status: "参考", updatedAt: "现在", size: "1 KB", content: "fixture attachment text" } });
  const prepared = await fixture.prepare("meeting.reply", { request: { systemPrompt: "附件测试", attachmentIds: ["chat-file"], messages: [{ role: "user", content: "first question" }, { role: "assistant", content: "first answer" }, { role: "user", content: "read attachment" }] } });
  assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
  assert.match(prepared.body.dataScope, /brief.txt/);
  await approve(fixture, prepared.body.authorizationId);
  const result = await fixture.json("/api/model-runtime/chat", { body: { authorizationId: prepared.body.authorizationId } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.text, "OK");
  const audit = (await fixture.audit()).find((record) => record.id === prepared.body.authorizationId);
  assert.equal(audit.status, "succeeded");
  assert.equal(JSON.stringify(audit).includes("fixture attachment text"), false);
 } finally { await fixture.stop(); }
});

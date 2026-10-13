import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { createWorkspaceStore } from "../../local-runtime/src/workspace-store.mjs";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-agent-team-web-test-"));
const workspaceTestDirectory = await mkdtemp(join(process.cwd(), ".workspace-client-test-"));
const sourceUrl = new URL("../src/client/local-client.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const compiledPath = join(temporaryDirectory, "local-client.mjs");
await writeFile(compiledPath, compiled.outputText.replace('"./runtime-fetch"', '"./runtime-fetch.mjs"'), "utf8");
const runtimeFetchSource = await readFile(new URL("../src/client/runtime-fetch.ts", import.meta.url), "utf8");
await writeFile(join(temporaryDirectory, "runtime-fetch.mjs"), ts.transpileModule(runtimeFetchSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText, "utf8");

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
};
let store;
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : {};
  try {
    if (url === "/api/session" && method === "POST") return { ok: true, status: 200, json: async () => ({ token: "test-session" }) };
    if (url === "/api/workspace" && method === "GET") return { ok: true, status: 200, json: async () => store.read() };
    if (url === "/api/workspace" && method === "PUT") { const result = await store.put(body.expectedRevision, body.workspace); return { ok: true, status: 200, json: async () => ({ saved: true, ...result }) }; }
    if (url === "/api/workspace/command" && method === "POST") { const result = await store.command(body.expectedRevision, body.projectId, body.command); return { ok: true, status: 200, json: async () => ({ saved: true, ...result }) }; }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  } catch (error) {
    return { ok: false, status: error instanceof Error && (error.name === "WorkspaceConflictError" || error.name === "WorkspaceRuleError") ? 409 : 400, json: async () => ({ error: error.message, ...(error.revision === undefined ? {} : { revision: error.revision }) }) };
  }
};

const { createLocalClient } = await import(pathToFileURL(compiledPath).href);

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
  const root = resolve(process.cwd());
  const target = resolve(workspaceTestDirectory);
  const rel = relative(root, target);
  if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) await rm(target, { recursive: true, force: true });
});

const approveSingleTaskPlan = async (client, title) => {
  await client.postMeetingMessage(`${title}需求`);
  assert.equal(await client.confirmRequirements(), true);
  assert.equal(await client.generatePlan([{ id: "draft-1", title, group: "项目管理组", assignee: "项目经理 Agent", summary: `${title}的执行说明` }]), true);
  const plan = client.getSnapshot().meeting.plan;
  assert.ok(plan);
  assert.equal(await client.approvePlan(plan.id), true);
  return client.getSnapshot().tasks[0];
};

test("meeting messages retain their owning project and meeting after navigation", async () => {
  storage.clear();
  store = createWorkspaceStore(join(workspaceTestDirectory, `meeting-client-${Date.now()}.json`));
  const client = createLocalClient();
  await client.initialize();
  client.createProject({ name: "会议测试 A", goal: "总体背景 A" });
  assert.equal(await client.createMeeting("需求评审", "澄清需求范围"), true);
  const projectId = client.getSnapshot().project.id;
  const firstMeetingId = client.getSnapshot().meeting.id;
  assert.equal(await client.postMeetingMessage("第一场会议的问题"), true);
  assert.equal(await client.createMeeting("验收评审", "审查验收标准"), true);
  const secondMeetingId = client.getSnapshot().meeting.id;
  assert.equal(client.getSnapshot().meetingHistory.find((meeting) => meeting.id === firstMeetingId)?.archivedAt, undefined);
  assert.equal(await client.selectMeeting(firstMeetingId), true);
  assert.equal(client.getSnapshot().meeting.messages[0].text, "第一场会议的问题");
  client.createProject({ name: "会议测试 B", goal: "总体背景 B" });
  const otherProjectId = client.getSnapshot().project.id;
  assert.equal(await client.appendMeetingResponse("第一场会议的延迟回复", projectId, firstMeetingId), true);
  assert.equal(client.getSnapshot().project.id, otherProjectId);
  const owningProject = client.getProjectStates().find((project) => project.project.id === projectId);
  assert.equal(owningProject.meeting.messages.at(-1).text, "第一场会议的延迟回复");
  assert.equal(owningProject.meetingHistory.find((meeting) => meeting.id === secondMeetingId).messages.length, 0);
});

const createArtifact = (task, name) => ({
  id: `artifact-${name}`,
  name: `${name}.md`,
  kind: "设计文档",
  taskId: task.id,
  owner: task.assignee,
  version: `Run ${task.run}`,
  status: "待审核",
  updatedAt: "现在",
  size: "1 KB",
  content: "已生成的交付内容",
});

test("task runs reject duplicate starts and update only their owning project", async () => {
  storage.clear();
  store = createWorkspaceStore(join(workspaceTestDirectory, `client-a-${Date.now()}.json`));
  const client = createLocalClient();
  await client.initialize();

  assert.deepEqual(client.getProjects(), []);
  client.createProject({ name: "项目 A", goal: "项目 A 目标" });
  const projectAId = client.getSnapshot().project.id;
  const taskA = await approveSingleTaskPlan(client, "项目 A 任务");
  assert.equal(taskA.id, "TASK-001");

  assert.equal(await client.advanceTask(projectAId, taskA.id), true);
  assert.equal(await client.advanceTask(projectAId, taskA.id), false);
  assert.equal(await client.archiveProject(projectAId, true), false);
  assert.equal(await client.deleteProject(projectAId), false);

  client.createProject({ name: "项目 B", goal: "项目 B 目标" });
  const projectBId = client.getSnapshot().project.id;
  const taskB = await approveSingleTaskPlan(client, "项目 B 任务");
  assert.equal(taskB.id, taskA.id);

  assert.equal(client.switchProject(projectBId), true);
  assert.equal(await client.completeTaskRun(projectAId, taskA.id, createArtifact(taskA, "project-a")), true);

  const projectA = client.getProjectStates().find((project) => project.project.id === projectAId);
  const projectB = client.getProjectStates().find((project) => project.project.id === projectBId);
  assert.equal(projectA?.tasks[0]?.status, "待审核");
  assert.equal(projectA?.artifacts[0]?.taskId, taskA.id);
  assert.equal(projectB?.tasks[0]?.status, "待分配");
  assert.equal(projectB?.artifacts.length, 0);
  assert.equal(client.getSnapshot().project.id, projectBId);
});

test("a task run cannot attach an artifact to a different task", async () => {
  storage.clear();
  store = createWorkspaceStore(join(workspaceTestDirectory, `client-b-${Date.now()}.json`));
  const client = createLocalClient();
  await client.initialize();
  client.createProject({ name: "项目 C", goal: "项目 C 目标" });
  const projectId = client.getSnapshot().project.id;
  const task = await approveSingleTaskPlan(client, "项目 C 任务");
  assert.equal(await client.advanceTask(projectId, task.id), true);

  const mismatchedArtifact = { ...createArtifact(task, "wrong-task"), taskId: "TASK-999" };
  assert.equal(await client.completeTaskRun(projectId, task.id, mismatchedArtifact), false);
  assert.equal(client.getSnapshot().tasks[0]?.status, "执行中");
  assert.equal(client.getSnapshot().artifacts.length, 0);
});

test("startup replaces the exact legacy acceptance demo workspace with an empty workspace", async () => {
  storage.clear();
  store = createWorkspaceStore(join(workspaceTestDirectory, `client-demo-${Date.now()}.json`));
  await store.put(0, {
    activeProjectId: "legacy-acceptance-demo",
    projects: [{
      project: { id: "legacy-acceptance-demo", name: "验收演示项目", goal: "演示需求确认、计划审批、返工和本地交付验收。", status: "已验收", updatedAt: "刚刚" },
      agents: [], groups: [],
      meeting: { id: "legacy-meeting", title: "验收会议", status: "已批准", needsConfirmed: true, openQuestions: [], messages: [], plan: null },
      tasks: [], artifacts: [], versions: [], deliveryStatus: "已验收", settings: {}, activities: [], teamSaved: true,
    }],
  });

  const client = createLocalClient();
  await client.initialize();

  assert.deepEqual(client.getProjects(), []);
  assert.notEqual(client.getSnapshot().project.id, "legacy-acceptance-demo");
  assert.equal(client.getSnapshot().project.name, "未创建项目");
  assert.equal(client.getSnapshot().tasks.length, 0);
  assert.equal(client.getBackendStatus(), "connected", client.getBackendMessage());
  const stored = await store.read();
  assert.equal(stored.revision, 2);
  assert.deepEqual(stored.workspace, { activeProjectId: "", projects: [] });
});

test("startup removes an automatically generated empty project shell", async () => {
  storage.clear();
  store = createWorkspaceStore(join(workspaceTestDirectory, `client-empty-shell-${Date.now()}.json`));
  const bootstrap = {
    project: { id: "empty-bootstrap", name: "未命名项目", goal: "", status: "配置中", updatedAt: "刚刚" },
    agents: [], groups: ["项目管理组"],
    meeting: { id: "meeting-kickoff", title: "需求会议", status: "需求确认中", needsConfirmed: false, openQuestions: [], messages: [], plan: null },
    tasks: [],
    artifacts: [{ id: "minutes-meeting-kickoff", name: "需求会议纪要.md", kind: "会议记录", taskId: "会议记录", owner: "项目经理 Agent", version: "v1", status: "参考", updatedAt: "刚刚", size: "1 KB", content: "" }],
    versions: [], deliveryStatus: "未发布", settings: {}, activities: [], teamSaved: true,
  };
  await store.put(0, { activeProjectId: bootstrap.project.id, projects: [bootstrap] });

  const client = createLocalClient();
  await client.initialize();

  assert.deepEqual(client.getProjects(), []);
  assert.equal(client.getBackendStatus(), "connected", client.getBackendMessage());
  assert.deepEqual((await store.read()).workspace, { activeProjectId: "", projects: [] });
});

test("startup removes a legacy acceptance demo project while preserving real projects", async () => {
  storage.clear();
  store = createWorkspaceStore(join(workspaceTestDirectory, `client-demo-mixed-${Date.now()}.json`));
  const demo = {
    project: { id: "legacy-demo", name: "验收演示项目", goal: "演示需求确认、计划审批、返工和本地交付验收。", status: "已验收", updatedAt: "刚刚" },
    agents: [], groups: [],
    meeting: { id: "legacy-meeting", title: "验收会议", status: "已批准", needsConfirmed: true, openQuestions: [], messages: [], plan: null },
    tasks: [], artifacts: [], versions: [], deliveryStatus: "已验收", settings: {}, activities: [], teamSaved: true,
  };
  const realProject = {
    project: { id: "real-project", name: "正式项目", goal: "实际工作目标", status: "配置中", updatedAt: "刚刚" },
    agents: [], groups: [],
    meeting: { id: "real-meeting", title: "需求会议", status: "需求确认中", needsConfirmed: false, openQuestions: [], messages: [], plan: null },
    tasks: [], artifacts: [], versions: [], deliveryStatus: "未发布", settings: {}, activities: [], teamSaved: true,
  };
  await store.put(0, { activeProjectId: demo.project.id, projects: [demo, realProject] });

  const client = createLocalClient();
  await client.initialize();

  assert.equal(client.getBackendStatus(), "connected", client.getBackendMessage());
  assert.equal(client.getSnapshot().project.id, realProject.project.id);
  assert.deepEqual(client.getProjects().map((project) => project.name), ["正式项目"]);
  const stored = await store.read();
  assert.equal(stored.revision, 2);
  assert.deepEqual(stored.workspace.projects.map((project) => project.project.id), ["real-project"]);
});

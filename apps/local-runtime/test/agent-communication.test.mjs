import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createAgentMessageStore, createAgentCommunicationTools } from "../src/agent-communication.mjs";

async function setup(t) {
  const root = resolve(process.cwd());
  const directory = await mkdtemp(join(root, ".agent-communication-test-"));
  const workspace = { projects: [
    { project: { id: "project-a" }, groups: ["研发组", "测试组"], agents: [
      { id: "alice", name: "Alice", role: "研发", group: "研发组" },
      { id: "bob", name: "Bob", role: "研发", group: "研发组" },
      { id: "manager", name: "项目经理", templateId: "project-manager", group: "测试组" },
    ] },
    { project: { id: "project-b" }, groups: ["研发组"], agents: [{ id: "other-project", name: "Other", group: "研发组" }] },
  ] };
  const path = join(directory, "messages.sqlite");
  const readWorkspace = async () => ({ workspace: structuredClone(workspace) });
  const store = createAgentMessageStore(path, readWorkspace);
  t.after(async () => {
    store.close();
    const target = resolve(directory);
    const rel = relative(root, target);
    assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
    await rm(target, { recursive: true, force: true });
  });
  return { workspace, store, path, readWorkspace };
}

test("same-group agents exchange persistent messages; cross-group and cross-project communication is denied", async (t) => {
  const { store, path, readWorkspace } = await setup(t);
  assert.deepEqual((await store.listPeers("project-a", "alice")).agents.map((agent) => agent.id), ["bob"]);
  const sent = await store.send("project-a", "alice", "bob", "请确认接口定义");
  assert.equal(sent.status, "已送达收件箱");
  assert.equal((await store.readInbox("project-a", "bob")).messages[0].text, "请确认接口定义");
  assert.equal((await store.readInbox("project-a", "alice")).messages.length, 0);
  await store.send("project-a", "bob", "alice", "接口定义已确认");
  assert.equal((await store.readInbox("project-a", "alice")).messages[0].senderId, "bob");
  await assert.rejects(store.send("project-a", "alice", "manager", "跨组发送"), /跨组/);
  await assert.rejects(store.send("project-a", "manager", "alice", "项目经理跨组发送"), /跨组/);
  await assert.rejects(store.send("project-a", "alice", "other-project", "跨项目发送"), /跨组/);
  await assert.rejects(store.send("project-a", "alice", "alice", "发送给自己"), /跨组/);
  await assert.rejects(store.readInbox("project-a", "alice", sent.id), /游标无效/);
  await assert.rejects(store.send("project-a", "alice", "bob", " "), /消息/);
  await assert.rejects(store.send("project-a", "alice", "bob", "x".repeat(4001)), /消息/);
  store.close();
  const restarted = createAgentMessageStore(path, readWorkspace);
  try { assert.equal((await restarted.readInbox("project-a", "bob")).messages[0].id, sent.id); }
  finally { restarted.close(); }
});

test("tool-bound sender identity cannot be forged and membership is checked on every call", async (t) => {
  const { store, workspace } = await setup(t);
  const tools = Object.fromEntries(createAgentCommunicationTools({ store, projectId: "project-a", agentId: "alice" }).map((tool) => [tool.name, tool]));
  await tools.send_agent_message.execute("send", { recipientId: "bob", text: "来自 Alice", senderId: "manager", projectId: "project-b" });
  assert.equal((await store.readInbox("project-a", "bob")).messages[0].senderId, "alice");
  const forgedRead = await tools.read_agent_messages.execute("read", { agentId: "bob" });
  assert.deepEqual(JSON.parse(forgedRead.content[0].text).messages, []);
  workspace.projects[0].agents[0].group = "测试组";
  await assert.rejects(tools.send_agent_message.execute("stale-send", { recipientId: "bob", text: "旧组消息" }), /跨组/);
  assert.deepEqual((await store.readInbox("project-a", "bob")).messages, []);
  assert.deepEqual((await store.listPeers("project-a", "alice")).agents.map((agent) => agent.id), ["manager"]);
  await tools.send_agent_message.execute("new-group", { recipientId: "manager", text: "新组消息" });
  assert.equal((await store.readInbox("project-a", "manager")).messages[0].text, "新组消息");
  workspace.projects[0].agents = workspace.projects[0].agents.filter((agent) => agent.id !== "alice");
  await assert.rejects(tools.list_group_agents.execute("removed", {}), /有效的项目小组/);
  workspace.projects[0].project.archivedAt = new Date().toISOString();
  await assert.rejects(store.readInbox("project-a", "bob"), /有效的项目小组/);
});

test("inbox pagination preserves concurrent deliveries and cancelled runs cannot send", async (t) => {
  const { store } = await setup(t);
  await Promise.all(Array.from({ length: 55 }, (_, index) => store.send("project-a", "alice", "bob", `消息 ${index}`)));
  const first = await store.readInbox("project-a", "bob");
  const second = await store.readInbox("project-a", "bob", first.nextCursor);
  assert.equal(first.messages.length, 50);
  assert.equal(second.messages.length, 5);
  assert.equal(new Set([...first.messages, ...second.messages].map((message) => message.id)).size, 55);
  const controller = new AbortController();
  controller.abort();
  const send = createAgentCommunicationTools({ store, projectId: "project-a", agentId: "alice", signal: controller.signal }).find((tool) => tool.name === "send_agent_message");
  await assert.rejects(send.execute("cancelled", { recipientId: "bob", text: "不应发送" }));
  assert.equal((await store.readInbox("project-a", "bob", second.nextCursor)).messages.length, 0);
});

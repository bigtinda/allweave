import type {
  Agent,
  AgentTool,
  AppState,
  Artifact,
  CreateProjectInput,
  ProductClient,
  ProjectActivity,
  AppSettings,
  McpServerSetting,
  MeetingMessage,
  MeetingState,
  RoleTemplate,
  ManagedSkillSetting,
} from "./types";
import { runtimeFetch } from "./runtime-fetch";

const STORAGE_KEY = "ai-agent-team.workspace.v1";
const LEGACY_STORAGE_KEYS = ["ai-agent-team.prototype.v2", "ai-agent-team.prototype.v1"];

interface StoredWorkspace {
  activeProjectId: string;
  projects: AppState[];
  settings?: AppSettings;
}

type WorkspaceWriteStatus = "connecting" | "saving" | "connected" | "offline" | "error" | "conflict";

const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const objectValue = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const normalizeActivities = (value: unknown): ProjectActivity[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item): ProjectActivity | null => {
    if (typeof item === "string") return { message: item.replace(/模拟|演示/g, ""), createdAt: "" };
    if (!objectValue(item) || typeof item.message !== "string") return null;
    return {
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      message: item.message.replace(/模拟|演示/g, ""),
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      ...(item.kind === "task-status" ? {
        kind: "task-status" as const,
        ...(typeof item.taskId === "string" ? { taskId: item.taskId } : {}),
        ...(typeof item.taskTitle === "string" ? { taskTitle: item.taskTitle } : {}),
        ...(typeof item.previousStatus === "string" ? { previousStatus: item.previousStatus as ProjectActivity["previousStatus"] } : {}),
        ...(typeof item.status === "string" ? { status: item.status as ProjectActivity["status"] } : {}),
      } : {}),
    };
  }).filter((item): item is ProjectActivity => item !== null).slice(0, 40);
};
const itemKey = (value: unknown): string => objectValue(value)
  ? typeof value.id === "string" ? value.id : objectValue(value.project) && typeof value.project.id === "string" ? value.project.id : ""
  : "";

const mergeConcurrentChanges = (base: unknown, remote: unknown, local: unknown, path = ""): unknown => {
  if (sameValue(remote, base)) return local;
  if (sameValue(local, base)) return remote;
  if (base === undefined) return local === undefined ? remote : local;
  if (remote === undefined) return sameValue(local, base) ? undefined : local;
  if (local === undefined) return sameValue(remote, base) ? undefined : remote;
  if (Array.isArray(base) && Array.isArray(remote) && Array.isArray(local)) {
    const allKeyed = [...base, ...remote, ...local].every((item) => Boolean(itemKey(item)));
    if (!allKeyed) return local;
    const baseById = new Map(base.map((item) => [itemKey(item), item]));
    const remoteById = new Map(remote.map((item) => [itemKey(item), item]));
    const localById = new Map(local.map((item) => [itemKey(item), item]));
    const order = [...remote.map(itemKey), ...local.map(itemKey).filter((id) => !remoteById.has(id))];
    return order.map((id) => mergeConcurrentChanges(baseById.get(id), remoteById.get(id), localById.get(id), `${path}/${id}`)).filter((item) => item !== undefined);
  }
  if (objectValue(base) && objectValue(remote) && objectValue(local)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(remote), ...Object.keys(local)]);
    return Object.fromEntries([...keys].map((key) => [key, mergeConcurrentChanges(base[key], remote[key], local[key], `${path}/${key}`)]).filter(([, value]) => value !== undefined));
  }
  if (/(^|\/)(status|archivedAt|deliveryStatus|needsConfirmed)$/.test(path)) return remote;
  return local;
};

const readResponse = async (response: Response): Promise<Record<string, unknown>> => {
  try { return await response.json() as Record<string, unknown>; }
  catch { return {}; }
};

const defaultTools = (): AgentTool[] => [
  { id: "file-read", label: "读取项目文件", detail: "查看项目普通文本文件，凭据路径会自动隐藏", enabled: true },
  { id: "file-write", label: "修改任务文件", detail: "仅修改当前任务 Run 目录中的文件", enabled: true },
  { id: "file-create", label: "创建任务文件", detail: "当前 Run 交付必需；仅在任务目录中新建", enabled: true },
  { id: "file-delete", label: "删除任务文件", detail: "仅删除当前任务 Run 目录中的普通文件，每次删除前确认", enabled: true },
  { id: "web-search", label: "联网搜索", detail: "使用公共网页搜索，受项目网络开关控制", enabled: true },
  { id: "command", label: "执行指令", detail: "在当前任务 Run 目录执行，每条命令都需确认", enabled: true },
];

const createDefaultWpsOfficeMcp = (existingServers: McpServerSetting[] = []): McpServerSetting => {
	const existingNamespaces = new Set(existingServers.map((server) => server.name.toLowerCase().replaceAll("-", "_")));
	let name = "wps-office-local";
	let suffix = 2;
	while (existingNamespaces.has(name.replaceAll("-", "_"))) name = `wps-office-local-${suffix++}`;
	return {
	id: "wps-office-local",
	name,
	type: "stdio",
	command: "python",
	args: [],
	url: "",
	env: {},
	headers: {},
	description: "本机 Office 文档能力（兼容 WPS）：读取项目中的 .docx、.xlsx、.pptx 文件；新建和修改结果保存在当前任务 Run 目录，进入任务审核。",
	enabled: true,
};
};

const ROLE_SKILL_IDS: Record<string, string[]> = {
  "project-manager": ["project-requirements-and-scope", "project-planning-and-delegation"],
  "research-lead": ["research-design-and-review"],
  researcher: ["source-research-and-evidence"],
  "java-backend": ["java-backend-api-delivery"],
  "frontend-developer": ["frontend-accessible-ui"],
  "qa-engineer": ["risk-based-testing-and-evidence"],
  "technical-writer": ["technical-documentation-and-minutes"],
  "database-engineer": ["database-schema-and-migrations"],
  "security-reviewer": ["secure-design-review"],
};

const BUILT_IN_ROLE_SKILLS: ManagedSkillSetting[] = [
  {
    id: "project-requirements-and-scope", name: "project-requirements-and-scope", displayName: "项目需求与范围澄清", enabled: true,
    description: "澄清项目经理负责的目标、范围、约束和可验收标准。",
    content: `# 需求澄清与范围管理\n\n你负责把讨论转成明确、可追溯的需求。\n\n- 先区分项目总体目标与当前会议主题，不要把历史目标自动当成本次会议结论。\n- 按目标、用户、场景、范围内事项、明确排除项、约束、验收标准和未决问题整理信息。\n- 只有缺失信息会改变交付范围或验收结果时才追问；其他不确定项采用保守假设并标注。\n- 每次复述确认时列明变更点，并说明确认后的下一阶段。\n- 不宣称已完成尚未执行的工作；结论要能追溯到用户消息或项目文件。`,
  },
  {
    id: "project-planning-and-delegation", name: "project-planning-and-delegation", displayName: "项目计划与任务分派", enabled: true,
    description: "依据组织架构、角色能力和最小权限生成可调整的任务计划。",
    content: `# 计划拆分与任务分派\n\n将已确认需求转成边界清楚、可审核的阶段任务。\n\n- 根据交付成果和依赖关系决定拆分粒度，避免为凑数量过度拆分。\n- 只从当前组织架构中选择执行人，并使任务小组与执行人所属小组一致。\n- 按角色 Skills 和实际工具能力分派；优先复用适合的单一执行人，必要时拆成有明确交接物的子任务。\n- 为每项任务选择最小必要权限，默认不给联网或命令权限。\n- 使用相对工期和阶段顺序；没有日历依据时不编造具体日期。\n- 在用户确认前保留为草案，列出假设、风险和可微调项。`,
  },
  {
    id: "research-design-and-review", name: "research-design-and-review", displayName: "研究方案与阶段评审", enabled: true,
    description: "规划研究问题、方法、证据质量和阶段评审。",
    content: `# 研究设计与评审\n\n组织研究工作并检查结论是否由证据支持。\n\n- 将主题拆为研究问题、范围、方法、信息来源、分析步骤和预期交付物。\n- 为组员明确检索范围、记录格式和引用要求；关键结论保留来源和日期。\n- 评估样本偏差、来源可信度、方法限制和可能的反例。\n- 阶段评审聚焦问题是否回答、证据是否充分、结论是否越界及下一步验证。\n- 明确区分事实、推断与待验证假设，不把搜索摘要当作已核实事实。`,
  },
  {
    id: "source-research-and-evidence", name: "source-research-and-evidence", displayName: "资料检索与证据整理", enabled: true,
    description: "开展可复核的资料检索、证据摘录和研究摘要整理。",
    content: `# 资料研究与证据整理\n\n以可复核的来源支持研究结论。\n\n- 先依据研究问题制定关键词和纳入、排除条件，再开始检索。\n- 优先使用原始论文、官方文档、标准和一手数据；记录标题、作者或机构、日期与链接。\n- 摘录结论时保留上下文和证据位置，区分来源原话与自己的归纳。\n- 对相互矛盾的资料并列说明，不隐藏反例或样本局限。\n- 输出结构化摘要：问题、方法、主要发现、证据、局限和仍需确认事项。`,
  },
  {
    id: "java-backend-api-delivery", name: "java-backend-api-delivery", displayName: "Java 后端 API 交付", enabled: true,
    description: "按项目约定实现和审查 Java 服务端接口、校验、错误处理及测试。",
    content: `# Java 后端交付\n\n在现有项目结构和约定内完成服务端变更。\n\n- 先检查构建方式、模块边界、Java 版本、依赖和现有接口风格，再确定改动方案。\n- 明确请求与响应契约、输入校验、认证授权、错误语义和兼容性。\n- 保持控制器、业务逻辑和数据访问职责清楚；避免无关重构和新增不必要依赖。\n- 为关键逻辑补充适当的测试或验证步骤，并如实记录实际执行结果。\n- 变更说明中列出文件、接口行为、配置影响、风险和未验证事项。`,
  },
  {
    id: "frontend-accessible-ui", name: "frontend-accessible-ui", displayName: "前端界面与交互实现", enabled: true,
    description: "实现一致、响应式且可访问的前端界面与交互。",
    content: `# 前端界面实现\n\n遵循项目现有设计系统，交付稳定可理解的界面。\n\n- 先确认框架、路由、组件和主题变量，复用现有模式，不引入平行设计系统。\n- 覆盖加载、空、成功、错误和禁用状态；交互应有清楚反馈。\n- 布局适应常见窗口宽度，长文本和窄屏内容可读且不造成页面横向溢出。\n- 使用语义化控件、可见焦点、键盘操作和适当的辅助标签。\n- 完成后列出改动界面、关键交互及实际验证情况。`,
  },
  {
    id: "risk-based-testing-and-evidence", name: "risk-based-testing-and-evidence", displayName: "风险优先测试与证据", enabled: true,
    description: "围绕验收标准设计风险优先的测试，并记录可复现证据。",
    content: `# 风险优先测试与证据\n\n优先验证高影响路径和边界行为。\n\n- 从需求与验收标准生成正向、边界、异常、权限和回归场景。\n- 每个缺陷记录前置条件、复现步骤、预期结果、实际结果和影响范围。\n- 区分未执行、通过、失败和受环境阻塞；没有运行的检查不得标记通过。\n- 复测修复点并检查相邻功能，保留命令、日志或截图等必要证据。\n- 输出风险清单和残余风险，避免用覆盖率数字代替质量判断。`,
  },
  {
    id: "technical-documentation-and-minutes", name: "technical-documentation-and-minutes", displayName: "技术文档与会议纪要", enabled: true,
    description: "撰写与实际产品一致的技术文档、操作说明和结构化会议纪要。",
    content: `# 技术文档与会议纪要\n\n让文档准确反映已确认决定和实际产物。\n\n- 先识别目标读者、使用场景、已有文档结构和需要维护的事实来源。\n- 技术说明覆盖前置条件、步骤、参数、结果、错误处理和安全注意事项。\n- 会议纪要总结主题、决策、依据、待办事项、负责人和时间，不逐条复制聊天记录。\n- 将已确认事实、提议、未决问题分开标注，未执行事项不得写成已完成。\n- 修改现有文档时保留有效内容，并指出新增、修订和需要后续维护的部分。`,
  },
  {
    id: "database-schema-and-migrations", name: "database-schema-and-migrations", displayName: "数据模型与迁移", enabled: true,
    description: "设计安全可回滚的数据模型、查询和数据库迁移。",
    content: `# 数据模型与迁移\n\n根据业务不变量设计可演进的数据结构。\n\n- 先检查现有数据库类型、命名约定、访问层、迁移工具和数据规模假设。\n- 明确主外键、唯一约束、空值语义、索引依据和生命周期，不重复存储可推导数据。\n- 迁移应考虑旧数据、锁表风险、分批回填、兼容窗口和回滚路径。\n- 查询优化以执行计划或明确的访问模式为依据，避免未经测量的复杂化。\n- 说明数据影响、迁移顺序、验证方式和恢复方案。`,
  },
  {
    id: "secure-design-review", name: "secure-design-review", displayName: "安全设计审查", enabled: true,
    description: "审查身份、授权、敏感数据处理和高风险变更边界。",
    content: `# 安全设计审查\n\n识别可利用风险并给出可验证的修复建议。\n\n- 明确资产、信任边界、用户角色、数据流和攻击面。\n- 检查认证与授权是否分离，是否存在越权、注入、敏感信息泄露和不安全默认值。\n- 凭据不得写入源码、日志或文档；检查错误消息、导出和审计记录中的敏感字段。\n- 按可利用性、影响和暴露面排序发现，并提供文件位置、触发条件和修复方向。\n- 对无法证实的风险标注假设；修复建议应避免扩大权限或引入新的信任边界。`,
  },
];

const skillsForRole = (roleId: string): string[] => [...(ROLE_SKILL_IDS[roleId] ?? [])];
const mergeBuiltInSkills = (skills: ManagedSkillSetting[] = []): ManagedSkillSetting[] => {
  const result = skills.map((skill) => ({ ...skill }));
  const ids = new Set(result.map((skill) => skill.id));
  for (const skill of BUILT_IN_ROLE_SKILLS) {
    if (ids.has(skill.id) || result.length >= 40) continue;
    result.push({ ...skill });
    ids.add(skill.id);
  }
  return result;
};

const createDefaultSettings = (): AppSettings => ({
  providerName: "",
  modelName: "",
  endpoint: "",
  connectionStatus: "未连接",
  egressApproval: "项目范围内",
  excludedPaths: [".env*", "**/secrets/**", "**/*credential*"],
  localModel: false,
  networkEnabled: true,
  commandApproval: true,
  defaultProviderId: "",
  defaultModelId: "",
	mcpServers: [createDefaultWpsOfficeMcp()],
	wpsOfficeMcpInstalled: true,
	  agentSkills: mergeBuiltInSkills(),
});

const createInitialState = (project?: CreateProjectInput, inheritedSettings: AppSettings = createDefaultSettings()): AppState => {
  const projectName = project?.name.trim() || "未命名项目";
  const projectGoal = project?.goal.trim() || "";
  return {
    toolPolicyVersion: 1,
    project: {
      id: `project-${Date.now().toString(36)}`,
      name: projectName,
      goal: projectGoal,
      workspacePath: project?.workspacePath,
      status: "配置中",
      updatedAt: "刚刚",
    },
    agents: [],
    groups: [],
    meeting: {
      id: "meeting-kickoff",
      title: "需求会议",
      status: "需求确认中",
      needsConfirmed: false,
      openQuestions: [],
      messages: [],
      plan: null,
    },
    meetingHistory: [],
    roleLibrary: ROLE_TEMPLATES.map((role) => ({ ...role, skills: [...role.skills], skillIds: [...(role.skillIds ?? [])] })),
    customRoles: [],
    tasks: [],
    artifacts: [],
    workspaceFolders: [],
    versions: [],
    deliveryStatus: "未发布",
    settings: {
      ...inheritedSettings,
      excludedPaths: [...inheritedSettings.excludedPaths],
      mcpServers: inheritedSettings.mcpServers.map((server) => ({ ...server, args: [...server.args], env: { ...server.env }, headers: { ...server.headers } })),
      agentSkills: inheritedSettings.agentSkills.map((skill) => ({ ...skill })),
    },
    activities: [],
    teamSaved: true,
  };
};

const normalizeSettings = (settings?: Partial<AppSettings>): AppSettings => {
  const defaults = createDefaultSettings();
	const savedMcpServers = Array.isArray(settings?.mcpServers) ? settings.mcpServers : [];
	const hasWpsOfficeMcp = savedMcpServers.some((server) => server.id === "wps-office-local");
	const installDefaultWpsOfficeMcp = settings?.wpsOfficeMcpInstalled !== false && !hasWpsOfficeMcp;
  return {
    ...defaults,
    ...settings,
    egressApproval: settings?.egressApproval ?? defaults.egressApproval,
    networkEnabled: settings?.networkEnabled ?? defaults.networkEnabled,
    excludedPaths: Array.isArray(settings?.excludedPaths) ? [...settings.excludedPaths] : [...defaults.excludedPaths],
    defaultProviderId: settings?.defaultProviderId ?? "",
    defaultModelId: settings?.defaultModelId ?? "",
	mcpServers: [
		...savedMcpServers.map((server) => ({ ...server, args: Array.isArray(server.args) ? [...server.args] : [], env: { ...(server.env ?? {}) }, headers: { ...(server.headers ?? {}) } })),
		...(installDefaultWpsOfficeMcp ? [createDefaultWpsOfficeMcp(savedMcpServers)] : []),
	],
	wpsOfficeMcpInstalled: settings?.wpsOfficeMcpInstalled ?? true,
    agentSkills: mergeBuiltInSkills(Array.isArray(settings?.agentSkills) ? settings.agentSkills : []),
  };
};

const summarizeMeetingMessages = (messages: MeetingMessage[], sender: MeetingMessage["sender"]): string[] => {
  const candidates: { point: string; score: number; order: number }[] = [];
  const seen = new Set<string>();
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
};

const meetingMinutesArtifact = (state: AppState, meeting: MeetingState): Artifact => {
  const userPoints = summarizeMeetingMessages(meeting.messages, "用户");
  const managerPoints = summarizeMeetingMessages(meeting.messages, "项目经理 Agent");
  const tasks = meeting.plan?.tasks ?? [];
  const attachmentNames = [...new Set(meeting.messages.flatMap((message) => (message.attachments ?? []).map((file) => file.name)))];
  const content = `# ${meeting.title}\n\n## 会议概览\n- 会议主题：${meeting.topic || "未设置"}\n- 项目目标：${state.project.goal || "尚未填写项目目标"}\n- 讨论消息：共 ${meeting.messages.length} 条（用户 ${meeting.messages.filter((message) => message.sender === "用户").length} 条，项目经理 Agent ${meeting.messages.filter((message) => message.sender === "项目经理 Agent").length} 条）\n\n## 需求与补充\n${userPoints.join("\n") || "- 暂无用户补充内容。"}\n\n## 项目经理分析与建议\n${managerPoints.join("\n") || "- 项目经理 Agent 尚未给出分析或建议。"}\n\n## 确认状态与后续行动\n- 需求范围：${meeting.needsConfirmed ? "已确认" : "待确认"}\n- 任务计划：${meeting.plan ? `v${meeting.plan.version} · ${meeting.plan.status} · ${tasks.length} 项任务` : "尚未生成"}\n${tasks.length ? tasks.map((task) => `- ${task.id} ${task.title} · 负责人：${task.assignee} · 小组：${task.group} · 工期：${task.timeEstimate || "未设置"} · 时间安排：${task.timeline || "未设置"}\n  ${task.summary}`).join("\n") : "- 暂无后续任务；计划获批前不会创建执行任务。"}\n\n## 待确认问题\n${meeting.openQuestions.length ? meeting.openQuestions.map((question) => `- ${question}`).join("\n") : meeting.needsConfirmed ? "- 当前没有待决问题。" : "- 尚待确认需求范围。"}\n\n## 相关附件\n${attachmentNames.length ? attachmentNames.map((name) => `- ${name}`).join("\n") : "- 本次会议没有上传附件。"}\n`;
  return {
    id: `minutes-${meeting.id}`, name: `${meeting.title}纪要.md`, kind: "会议记录", taskId: "会议记录", owner: "项目经理 Agent",
    version: `v${meeting.plan?.version ?? 1}`, status: "参考", updatedAt: new Date().toLocaleString("zh-CN"),
    size: `${Math.max(1, Math.ceil(new TextEncoder().encode(content).length / 1024))} KB`, content,
  };
};

const templateFromAgent = (agent: Agent): RoleTemplate => ROLE_TEMPLATES.find((role) => role.id === agent.templateId) ?? {
  id: agent.templateId,
  name: agent.name,
  role: agent.role,
  category: agent.category ?? "文档",
  description: agent.description,
  skills: [...agent.skills],
  skillIds: [...(agent.skillIds ?? skillsForRole(agent.roleTemplateId ?? agent.templateId))],
  model: agent.model,
  providerId: agent.providerId,
  modelId: agent.modelId,
  color: agent.color,
};

const normalizeState = (saved: AppState, recoverInterrupted = true): AppState => ({
  ...saved,
  toolPolicyVersion: 1,
  meetingHistory: Array.isArray(saved.meetingHistory) ? saved.meetingHistory : [],
  roleLibrary: (Array.isArray(saved.roleLibrary) ? saved.roleLibrary : [...new Map(saved.agents.map((agent) => {
    const role = templateFromAgent(agent);
    return [role.id, role] as const;
  })).values()]).map((role) => ({ ...role, skills: [...(role.skills ?? [])], skillIds: Array.isArray(role.skillIds) ? [...role.skillIds] : skillsForRole(role.id) })),
  customRoles: (Array.isArray(saved.customRoles) ? saved.customRoles : [...new Map(saved.agents.filter((agent) => !ROLE_TEMPLATES.some((role) => role.id === agent.templateId)).map((agent) => {
    const role = templateFromAgent(agent);
    return [role.id, role] as const;
  })).values()]).map((role) => ({ ...role, skills: [...(role.skills ?? [])], skillIds: Array.isArray(role.skillIds) ? [...role.skillIds] : skillsForRole(role.id) })),
  workspaceFolders: Array.isArray(saved.workspaceFolders) ? saved.workspaceFolders : [...new Set((saved.artifacts ?? []).map((artifact) => artifact.relativePath?.split(/[\\/]/)[0] ?? "").filter(Boolean))],
  agents: saved.agents.map((agent) => ({ ...agent, skillIds: Array.isArray(agent.skillIds) ? [...agent.skillIds] : skillsForRole(agent.roleTemplateId ?? agent.templateId), tools: defaultTools().map((tool) => {
    const savedTool = saved.toolPolicyVersion === 1 && Array.isArray(agent.tools) ? agent.tools.find((item) => item.id === tool.id) : undefined;
    return { ...tool, enabled: savedTool ? savedTool.enabled === true : saved.toolPolicyVersion !== 1 || tool.enabled };
  }), model: /演示|模拟|^demo-/i.test(agent.model) ? "未配置" : agent.model, status: recoverInterrupted && agent.status === "运行中" ? "空闲" as const : agent.status })),
  settings: { ...normalizeSettings(saved.settings), modelName: /演示|模拟|^demo-/i.test(saved.settings.modelName) ? "" : saved.settings.modelName, endpoint: saved.settings.endpoint === "https://example.invalid/v1" ? "" : saved.settings.endpoint, connectionStatus: "未连接" },
  activities: normalizeActivities(saved.activities),
  meeting: { ...saved.meeting, messages: saved.meeting.messages.map((message) => message.sender === "项目经理 Agent" ? { ...message, text: message.text.replace("项模拟任务", "项任务") } : message) },
  tasks: saved.tasks.map((task) => ({ ...task, title: task.title.replace("实现对话接口原型", "实现对话接口"), summary: task.summary.replace("演示接口实现", "接口实现"), reviewNote: recoverInterrupted && task.status === "执行中" ? "上次运行未完成，可重新运行任务。" : task.reviewNote.replace("演示产物已记录", "交付物已记录"), status: recoverInterrupted && task.status === "执行中" ? "待分配" as const : task.status, logs: recoverInterrupted && task.status === "执行中" ? [...(task.logs ?? []), `${new Date().toLocaleString("zh-CN")} · 页面关闭时运行中断`] : task.logs ?? [] })),
  artifacts: saved.artifacts.map((artifact) => ({
    ...artifact,
    kind: artifact.taskId === "TASK-003" && artifact.kind === "源代码" ? "设计文档" : artifact.kind,
    content: artifact.content.replace(/\n\n此内容仅用于浏览器交互演示。没有生成本机文件，也没有运行构建或测试命令。/, "").replace("执行状态：模拟提交审核", "执行状态：提交审核"),
  })),
});

const isLegacyAcceptanceDemo = (project: AppState): boolean => project.project.name.trim() === "验收演示项目"
  && project.project.goal.trim() === "演示需求确认、计划审批、返工和本地交付验收。";

const isLegacyDemoWorkspace = (projects: AppState[]): boolean => projects.length > 0 && projects.every(isLegacyAcceptanceDemo);
const isEmptyBootstrapProject = (project: AppState): boolean => project.project.name.trim() === "未命名项目"
  && !project.project.goal.trim() && !project.project.workspacePath
  && project.tasks.length === 0 && project.artifacts.every((artifact) => artifact.id === "minutes-meeting-kickoff" && artifact.kind === "会议记录" && artifact.taskId === "会议记录" && artifact.owner === "项目经理 Agent") && project.versions.length === 0
  && !project.meeting.plan && project.meeting.messages.length === 0;

const createCleanWorkspace = (): StoredWorkspace => {
  return { activeProjectId: "", projects: [], settings: createDefaultSettings() };
};

const loadInitialWorkspace = (): StoredWorkspace => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const workspace = JSON.parse(stored) as StoredWorkspace;
      const projects = Array.isArray(workspace.projects)
        ? workspace.projects.filter((project) => Boolean(project?.project?.id)).map((project) => normalizeState(project))
        : [];
      if (isLegacyDemoWorkspace(projects)) return createCleanWorkspace();
      if (projects.length === 1 && isEmptyBootstrapProject(projects[0]!)) return createCleanWorkspace();
      if (projects.length) {
        const activeProject = projects.find((project) => project.project.id === workspace.activeProjectId) ?? projects[0]!;
        return { activeProjectId: activeProject.project.id, projects, settings: normalizeSettings(workspace.settings ?? activeProject.settings) };
      }
      if (Array.isArray(workspace.projects)) return { ...createCleanWorkspace(), settings: normalizeSettings(workspace.settings) };
    }

    for (const legacyKey of LEGACY_STORAGE_KEYS) {
      const legacy = window.localStorage.getItem(legacyKey);
      if (!legacy) continue;
      const savedValue = JSON.parse(legacy) as AppState | StoredWorkspace;
      if ("projects" in savedValue && Array.isArray(savedValue.projects)) {
        const projects = savedValue.projects.filter((item) => Boolean(item?.project?.id)).map((item) => normalizeState(item));
        if (isLegacyDemoWorkspace(projects)) return createCleanWorkspace();
        if (projects.length === 1 && isEmptyBootstrapProject(projects[0]!)) return createCleanWorkspace();
        if (projects.length) {
          const active = projects.find((item) => item.project.id === savedValue.activeProjectId) ?? projects[0]!;
          return { activeProjectId: active.project.id, projects, settings: normalizeSettings((savedValue as StoredWorkspace).settings ?? active.settings) };
        }
      } else {
        const saved = normalizeState(savedValue as AppState);
        if (saved.project?.id) return { activeProjectId: saved.project.id, projects: [saved], settings: saved.settings };
      }
    }
  } catch {
    // Invalid or unavailable browser storage falls back to fresh workspace data.
  }
  return createCleanWorkspace();
};

const createEmptyState = (settings: AppSettings = createDefaultSettings()): AppState => ({
  toolPolicyVersion: 1,
  project: { id: "", name: "未创建项目", goal: "", status: "配置中", updatedAt: "" },
  agents: [], groups: [], meetingHistory: [], roleLibrary: [], customRoles: [],
  meeting: { id: "", title: "", status: "需求确认中", needsConfirmed: false, openQuestions: [], messages: [], plan: null },
  tasks: [], artifacts: [], workspaceFolders: [], versions: [], deliveryStatus: "未发布",
  settings: { ...settings, excludedPaths: [...settings.excludedPaths] },
  activities: [], teamSaved: true,
});

const templateToAgent = (template: RoleTemplate, group: string, manager: string, instanceNumber: number): Agent => ({
  id: `agent-${template.id}-${crypto.randomUUID()}`,
  templateId: template.id,
  roleTemplateId: template.id,
  name: instanceNumber > 1 ? `${template.name} ${instanceNumber}` : template.name,
  role: template.role,
  category: template.category,
  description: template.description,
  group,
  manager,
  model: template.model,
  providerId: template.providerId,
  modelId: template.modelId,
  skills: [...template.skills],
  skillIds: [...(template.skillIds ?? skillsForRole(template.id))],
  status: "空闲",
  tools: defaultTools(),
  reviewRule: "按已批准需求检查范围、结果和来源证据。",
  color: template.color,
});

export const createLocalClient = (): ProductClient => {
  const initialWorkspace = loadInitialWorkspace();
  let projects = initialWorkspace.projects;
  let activeProjectId = initialWorkspace.activeProjectId;
  let workspaceSettings = initialWorkspace.settings ?? projects.find((project) => project.project.id === activeProjectId)?.settings ?? createDefaultSettings();
  let state = projects.find((project) => project.project.id === activeProjectId) ?? projects[0] ?? createEmptyState(workspaceSettings);
  const listeners = new Set<() => void>();
  let backendStatus: WorkspaceWriteStatus = "connecting";
  let backendMessage = "";
  let workspaceRevision = 0;
  let writesBlockedByConflict = false;
  let initialized = false;
  let dirtyBeforeInitialization = false;
  let backendWriteChain = Promise.resolve();
  const notify = (): void => listeners.forEach((listener) => listener());
  const setBackendStatus = (status: WorkspaceWriteStatus, message = ""): void => {
    backendStatus = status;
    backendMessage = message;
    notify();
  };

  const currentWorkspace = (): StoredWorkspace => ({ activeProjectId, projects, settings: workspaceSettings });
  const cacheWorkspace = (): void => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentWorkspace())); } catch { /* The current tab remains usable if browser storage is unavailable. */ }
  };

  const applyWorkspace = (remote: StoredWorkspace, base: StoredWorkspace): void => {
    const normalizedRemote = { ...remote, settings: normalizeSettings(remote.settings ?? workspaceSettings) };
    const merged = mergeConcurrentChanges(base, normalizedRemote, currentWorkspace()) as StoredWorkspace;
    const normalized = merged.projects
      .filter((project) => Boolean(project?.project?.id))
      .map((project) => normalizeState(project, false));
    projects = normalized;
    workspaceSettings = merged.settings ?? createDefaultSettings();
    activeProjectId = normalized.some((project) => project.project.id === merged.activeProjectId)
      ? merged.activeProjectId
      : normalized[0]?.project.id ?? "";
    state = projects.find((project) => project.project.id === activeProjectId) ?? projects[0] ?? createEmptyState(workspaceSettings);
    cacheWorkspace();
    notify();
  };

  const parseWriteFailure = async (response: Response): Promise<Error> => {
    const result = await readResponse(response);
    if (response.status === 409 && Number.isSafeInteger(result.revision)) {
      writesBlockedByConflict = true;
      setBackendStatus("conflict", typeof result.error === "string" ? result.error : "工作空间已在其他窗口更新；当前浏览器更改尚未同步");
      return new Error(backendMessage);
    }
    if (response.status === 409) setBackendStatus("connected", typeof result.error === "string" ? result.error : "Runtime 拒绝了当前状态转换");
    const error = new Error(typeof result.error === "string" ? result.error : "工作空间写入失败");
    if (response.status === 409) error.name = "WorkspaceRuleError";
    return error;
  };

  const persistWorkspace = (): void => {
    cacheWorkspace();
    if (!initialized) {
      dirtyBeforeInitialization = true;
      return;
    }
    backendWriteChain = backendWriteChain.then(async () => {
      if (writesBlockedByConflict) return;
      setBackendStatus("saving");
      const response = await runtimeFetch("/api/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: workspaceRevision, workspace: currentWorkspace() }),
      });
      if (!response.ok) throw await parseWriteFailure(response);
      const result = await readResponse(response);
      if (!Number.isSafeInteger(result.revision)) throw new Error("工作空间服务未返回有效版本号");
      workspaceRevision = result.revision as number;
      setBackendStatus("connected");
    }).catch((error: unknown) => {
      if (!writesBlockedByConflict) setBackendStatus("error", error instanceof Error ? error.message : "工作空间保存失败");
    });
  };

  const runCommand = (projectId: string, command: Record<string, unknown>): Promise<boolean> => {
    const base = currentWorkspace();
    const operation = backendWriteChain.then(async () => {
      if (!initialized) throw new Error("本机工作空间服务尚未完成初始化");
      if (writesBlockedByConflict) throw new Error(backendMessage || "工作空间版本冲突，请重新加载本机版本");
      setBackendStatus("saving");
      for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtimeFetch("/api/workspace/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: workspaceRevision, projectId, command }),
      });
      if (response.status === 409) {
        const conflict = await readResponse(response.clone());
        if (Number.isSafeInteger(conflict.revision) && conflict.workspace && attempt < 2) {
          workspaceRevision = conflict.revision as number;
          applyWorkspace(conflict.workspace as StoredWorkspace, base);
          continue;
        }
      }
      if (!response.ok) throw await parseWriteFailure(response);
      const result = await readResponse(response);
      if (!Number.isSafeInteger(result.revision) || !result.workspace || typeof result.workspace !== "object") throw new Error("工作空间服务返回了无效命令结果");
      workspaceRevision = result.revision as number;
      applyWorkspace(result.workspace as StoredWorkspace, base);
      setBackendStatus("connected");
      return true;
      }
      return false;
    });
    backendWriteChain = operation.then(() => {}, (error: unknown) => {
      if (!writesBlockedByConflict && (!(error instanceof Error) || error.name !== "WorkspaceRuleError")) setBackendStatus("error", error instanceof Error ? error.message : "Runtime 命令执行失败");
    });
    return operation.catch(() => false);
  };

  const commit = (next: AppState): void => {
    if (!activeProjectId || !projects.some((project) => project.project.id === activeProjectId)) {
      workspaceSettings = { ...next.settings, excludedPaths: [...next.settings.excludedPaths] };
      state = createEmptyState(workspaceSettings);
      persistWorkspace();
      notify();
      return;
    }
    state = next;
    projects = projects.some((project) => project.project.id === activeProjectId)
      ? projects.map((project) => project.project.id === activeProjectId ? next : project)
      : [next, ...projects];
    persistWorkspace();
    notify();
  };

  const withActivity = (current: AppState, activity: string): AppState => ({
    ...current,
    activities: [{ id: `activity-${crypto.randomUUID()}`, message: activity, createdAt: new Date().toISOString() }, ...current.activities].slice(0, 40),
    project: { ...current.project, updatedAt: "刚刚" },
  });

  return {
    initialize: async () => {
      setBackendStatus("connecting");
      try {
        const response = await runtimeFetch("/api/workspace", { cache: "no-store" });
        if (!response.ok) throw new Error("工作空间服务不可用");
        const result = await response.json() as { workspace?: StoredWorkspace | null; revision?: number };
        workspaceRevision = Number.isSafeInteger(result.revision) && (result.revision ?? -1) >= 0 ? result.revision! : 0;
        if (result.workspace && !dirtyBeforeInitialization) {
          let remoteProjects = Array.isArray(result.workspace.projects)
            ? result.workspace.projects.filter((item) => Boolean(item?.project?.id)).map((item) => normalizeState(item, false))
            : [];
          if (isLegacyDemoWorkspace(remoteProjects) || (remoteProjects.length === 1 && isEmptyBootstrapProject(remoteProjects[0]!))) {
            const cleanWorkspace = createCleanWorkspace();
            const resetResponse = await runtimeFetch("/api/workspace/command", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                expectedRevision: workspaceRevision,
                projectId: "",
                command: { type: "workspace.reset", workspace: cleanWorkspace },
              }),
            });
            if (!resetResponse.ok) throw await parseWriteFailure(resetResponse);
            const reset = await readResponse(resetResponse);
            if (!Number.isSafeInteger(reset.revision) || !objectValue(reset.workspace) || !Array.isArray(reset.workspace.projects)) throw new Error("Runtime 未返回清理后的工作空间");
            workspaceRevision = reset.revision as number;
            remoteProjects = reset.workspace.projects.filter((item): item is AppState => objectValue(item) && objectValue(item.project) && typeof item.project.id === "string").map((item) => normalizeState(item, false));
          } else {
            for (const demo of remoteProjects.filter(isLegacyAcceptanceDemo)) {
              const canDelete = Boolean(demo.project.archivedAt) || remoteProjects.filter((project) => !project.project.archivedAt).length > 1;
              if (!canDelete || demo.tasks.some((task) => task.status === "执行中")) continue;
              const deleteResponse = await runtimeFetch("/api/workspace/command", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ expectedRevision: workspaceRevision, projectId: demo.project.id, command: { type: "project.delete" } }),
              });
              if (!deleteResponse.ok) throw await parseWriteFailure(deleteResponse);
              const deleted = await readResponse(deleteResponse);
              if (!Number.isSafeInteger(deleted.revision) || !objectValue(deleted.workspace) || !Array.isArray(deleted.workspace.projects)) throw new Error("Runtime 未返回已清理的工作空间");
              workspaceRevision = deleted.revision as number;
              remoteProjects = deleted.workspace.projects.filter((item): item is AppState => objectValue(item) && objectValue(item.project) && typeof item.project.id === "string").map((item) => normalizeState(item, false));
            }
          }
          projects = remoteProjects;
          const rawWorkspaceSettings = result.workspace.settings ?? remoteProjects.find((project) => project.project.id === result.workspace?.activeProjectId)?.settings ?? workspaceSettings;
          workspaceSettings = normalizeSettings(rawWorkspaceSettings);
          const rawMcpServers = Array.isArray(rawWorkspaceSettings.mcpServers) ? rawWorkspaceSettings.mcpServers : [];
          const rawProjectsForMigration = Array.isArray(result.workspace.projects) ? result.workspace.projects : [];
          const shouldPersistSettingsMigration = !result.workspace.settings
            || (rawWorkspaceSettings.wpsOfficeMcpInstalled !== false && !rawMcpServers.some((server) => server.id === "wps-office-local"));
          const shouldPersistSkillMigration = JSON.stringify(workspaceSettings.agentSkills) !== JSON.stringify(rawWorkspaceSettings.agentSkills ?? [])
            || rawProjectsForMigration.some((project) => (project.agents ?? []).some((agent) => !Array.isArray(agent.skillIds))
              || (project.roleLibrary ?? []).some((role) => !Array.isArray(role.skillIds))
              || (project.customRoles ?? []).some((role) => !Array.isArray(role.skillIds)));
          activeProjectId = remoteProjects.some((project) => project.project.id === result.workspace?.activeProjectId)
            ? result.workspace.activeProjectId
            : remoteProjects[0]?.project.id ?? "";
          state = projects.find((project) => project.project.id === activeProjectId) ?? projects[0] ?? createEmptyState(workspaceSettings);
          cacheWorkspace();
          notify();
          if (shouldPersistSettingsMigration || shouldPersistSkillMigration) {
            const migrationResponse = await runtimeFetch("/api/workspace", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ expectedRevision: workspaceRevision, workspace: currentWorkspace() }),
            });
            if (!migrationResponse.ok) throw await parseWriteFailure(migrationResponse);
            const migrated = await readResponse(migrationResponse);
            if (!Number.isSafeInteger(migrated.revision)) throw new Error("工作空间服务未返回有效版本号");
            workspaceRevision = migrated.revision as number;
          }
        } else {
          const saveResponse = await runtimeFetch("/api/workspace", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: workspaceRevision, workspace: currentWorkspace() }) });
          if (!saveResponse.ok) throw await parseWriteFailure(saveResponse);
          const saved = await readResponse(saveResponse);
          if (!Number.isSafeInteger(saved.revision)) throw new Error("工作空间服务未返回有效版本号");
          workspaceRevision = saved.revision as number;
        }
        initialized = true;
        setBackendStatus("connected");
      } catch (error) {
        initialized = true;
        if (!writesBlockedByConflict) setBackendStatus("offline", error instanceof Error ? error.message : "本机运行时未连接");
      }
    },
    refreshWorkspace: async () => {
      const operation = backendWriteChain.then(async () => {
        if (!initialized || writesBlockedByConflict) return false;
        const base = currentWorkspace();
        const response = await runtimeFetch("/api/workspace", { cache: "no-store" });
        if (!response.ok) return false;
        const result = await response.json() as { revision: number; workspace: StoredWorkspace };
        if (Number.isSafeInteger(result.revision) && result.revision > workspaceRevision && result.workspace) {
          workspaceRevision = result.revision;
          applyWorkspace(result.workspace, base);
        }
        setBackendStatus("connected");
        return true;
      });
      backendWriteChain = operation.then(() => {}, () => {});
      return operation.catch(() => false);
    },
    getBackendStatus: () => backendStatus,
    getBackendMessage: () => backendMessage,
    getSnapshot: () => state,
    flushWorkspace: async () => {
      let pendingWrite: Promise<void>;
      do {
        pendingWrite = backendWriteChain;
        await pendingWrite;
      } while (pendingWrite !== backendWriteChain);
      if (!initialized || backendStatus !== "connected") {
        throw new Error(backendMessage || "工作空间配置尚未同步到 Runtime");
      }
    },
    getWorkspaceSettings: () => normalizeSettings(workspaceSettings),
    getProjects: () => projects.map((project) => project.project),
    getProjectStates: () => projects,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createProject: (input) => {
      const fresh = createInitialState(input, workspaceSettings);
      const created = { ...fresh, activities: [{ message: `创建了「${fresh.project.name}」项目草稿`, createdAt: new Date().toISOString() }, ...fresh.activities] };
      projects = [created, ...projects];
      activeProjectId = created.project.id;
      state = created;
      persistWorkspace();
      notify();
    },
    archiveProject: async (projectId, archived) => {
      const target = projects.find((project) => project.project.id === projectId);
      if (!target || Boolean(target.project.archivedAt) === archived) return false;
      if (archived && target.tasks.some((task) => task.status === "执行中")) return false;
      return runCommand(projectId, { type: "project.archive", archived });
    },
    deleteProject: async (projectId) => {
      const target = projects.find((project) => project.project.id === projectId);
      if (!target) return false;
      if (target.tasks.some((task) => task.status === "执行中")) return false;
      return runCommand(projectId, { type: "project.delete" });
    },
    updateProject: (projectId, input) => {
      const name = input.name.trim();
      const target = projects.find((project) => project.project.id === projectId);
      if (!name || !target) return false;
      const updated = withActivity({
        ...target,
        project: { ...target.project, name, goal: input.goal.trim(), updatedAt: new Date().toLocaleString("zh-CN") },
      }, "更新了项目名称和目标");
      projects = projects.map((project) => project.project.id === projectId ? updated : project);
      if (activeProjectId === projectId) state = updated;
      else {
        state = { ...state };
        projects = projects.map((project) => project.project.id === activeProjectId ? state : project);
      }
      persistWorkspace();
      notify();
      return true;
    },
    switchProject: (projectId) => {
      const nextProject = projects.find((project) => project.project.id === projectId);
      if (!nextProject) return false;
      activeProjectId = projectId;
      state = nextProject;
      persistWorkspace();
      notify();
      return true;
    },
    createMeeting: (title, topic) => runCommand(state.project.id, { type: "meeting.create", title, topic }),
    selectMeeting: (meetingId) => runCommand(state.project.id, { type: "meeting.select", meetingId }),
    archiveMeeting: (meetingId) => runCommand(state.project.id, { type: "meeting.archive", meetingId }),
    deleteArchivedMeeting: (meetingId) => runCommand(state.project.id, { type: "meeting.delete", meetingId }),
    renameMeeting: (meetingId, title) => runCommand(state.project.id, { type: "meeting.rename", meetingId, title }),
    saveMeetingMinutes: async (meetingId) => {
      const meeting = meetingId ? state.meetingHistory.find((item) => item.id === meetingId) ?? (state.meeting.id === meetingId ? state.meeting : null) : state.meeting;
      if (!meeting) return null;
      const existing = state.artifacts.find((artifact) => artifact.id === `minutes-${meeting.id}`);
      if (existing) return existing;
      const artifact = meetingMinutesArtifact(state, meeting);
      const saved = await runCommand(state.project.id, { type: "artifact.add", artifact });
      if (!saved) return null;
      return state.artifacts.find((item) => item.id === artifact.id) ?? { ...artifact, relativePath: `01_需求文档/${artifact.name}` };
    },
    subscribeRole: (template) => {
      if (state.roleLibrary.some((role) => role.id === template.id)) return;
      commit(withActivity({ ...state, roleLibrary: [...state.roleLibrary, { ...template, skills: [...template.skills], skillIds: [...(template.skillIds ?? skillsForRole(template.id))] }] }, `将${template.name}加入角色组件库`));
    },
    createCustomRole: (template) => {
      const customRoles = state.customRoles.some((role) => role.id === template.id) ? state.customRoles : [...state.customRoles, { ...template, skills: [...template.skills], skillIds: [...(template.skillIds ?? skillsForRole(template.id))] }];
      const roleLibrary = state.roleLibrary.some((role) => role.id === template.id) ? state.roleLibrary : [...state.roleLibrary, { ...template, skills: [...template.skills], skillIds: [...(template.skillIds ?? skillsForRole(template.id))] }];
      commit(withActivity({ ...state, customRoles, roleLibrary }, `创建了自定义角色「${template.name}」`));
    },
    unsubscribeRole: (templateId) => {
      const template = state.roleLibrary.find((role) => role.id === templateId);
      if (!template) return;
      commit(withActivity({ ...state, roleLibrary: state.roleLibrary.filter((role) => role.id !== templateId) }, `从角色组件库取消订阅${template.name}`));
    },
    updateRoleTemplate: (template) => {
      if (!state.roleLibrary.some((role) => role.id === template.id)) return;
      commit(withActivity({
        ...state,
        roleLibrary: state.roleLibrary.map((role) => role.id === template.id ? { ...template, skills: [...template.skills], skillIds: [...(template.skillIds ?? [])] } : role),
        customRoles: state.customRoles.map((role) => role.id === template.id ? { ...template, skills: [...template.skills], skillIds: [...(template.skillIds ?? [])] } : role),
      }, `更新了角色模板「${template.name}」`));
    },
    addAgent: (template, group) => {
      if (template.id === "project-manager" || !state.groups.includes(group) || !state.roleLibrary.some((role) => role.id === template.id)) return null;
      const currentTemplate = state.roleLibrary.find((role) => role.id === template.id) ?? template;
      const instanceNumber = state.agents.filter((agent) => agent.templateId === template.id).length + 1;
      const manager = state.agents.find((agent) => agent.templateId === "project-manager")?.name ?? "用户（项目发起人）";
      const agent = templateToAgent(currentTemplate, group, manager, instanceNumber);
      commit(withActivity({ ...state, agents: [...state.agents, agent], teamSaved: false }, `将${agent.name}加入「${group}」`));
      return agent.id;
    },
    removeAgent: (agentId) => {
      const agent = state.agents.find((item) => item.id === agentId);
      if (!agent) return false;
      commit(withActivity({
        ...state,
        agents: state.agents.filter((item) => item.id !== agentId).map((item) => item.manager === agent.name ? { ...item, manager: "用户（项目发起人）" } : item),
        teamSaved: false,
      }, `将${agent.name}移出团队`));
      return true;
    },
    createGroup: (name) => {
      const groupName = name.trim();
      if (!groupName || state.groups.includes(groupName)) return;
      commit(withActivity({ ...state, groups: [...state.groups, groupName], teamSaved: false }, `创建了「${groupName}」`));
    },
    removeGroup: (name) => {
      if (!state.groups.includes(name) || state.groups.length <= 1) return false;
      const destination = state.groups.find((group) => group !== name);
      if (!destination) return false;
      const movedCount = state.agents.filter((agent) => agent.group === name).length;
      commit(withActivity({
        ...state,
        groups: state.groups.filter((group) => group !== name),
        agents: state.agents.map((agent) => agent.group === name ? { ...agent, group: destination } : agent),
        teamSaved: false,
      }, movedCount ? `移除了「${name}」，并将 ${movedCount} 名成员转入「${destination}」` : `移除了空小组「${name}」`));
      return true;
    },
    moveAgentToGroup: (agentId, group) => {
      if (!state.groups.includes(group)) return;
      commit({
        ...state,
        agents: state.agents.map((agent) => agent.id === agentId ? { ...agent, group } : agent),
        teamSaved: false,
      });
    },
    updateAgent: (input) => {
      const currentAgent = state.agents.find((agent) => agent.id === input.id);
      const renamed = currentAgent?.name !== input.name;
      commit({
        ...state,
        agents: state.agents.map((agent) => agent.id === input.id
          ? { ...agent, name: input.name, description: input.description, manager: input.manager, model: input.model, providerId: input.providerId, modelId: input.modelId, skills: [...input.skills], skillIds: [...input.skillIds], reviewRule: input.reviewRule, tools: input.tools }
          : renamed && currentAgent && agent.manager === currentAgent.name ? { ...agent, manager: input.name } : agent),
        teamSaved: false,
      });
    },
    replaceProjectManagerRole: (templateId) => {
      const template = state.roleLibrary.find((role) => role.id === templateId);
      const manager = state.agents.find((agent) => agent.templateId === "project-manager");
      if (!template) return false;
      if (!manager) {
        const created = templateToAgent(template, "", "用户（项目发起人）", 1);
        commit(withActivity({
          ...state,
          agents: [...state.agents, { ...created, templateId: "project-manager", roleTemplateId: template.id, status: "待命" }],
          teamSaved: false,
        }, `配置项目经理 Agent 为「${template.name}」`));
        return true;
      }
      if ((manager.roleTemplateId ?? manager.templateId) === template.id) return false;
      commit(withActivity({
        ...state,
        agents: state.agents.map((agent) => {
          if (agent.id === manager.id) return {
            ...agent,
            roleTemplateId: template.id,
            name: template.name,
            role: template.role,
            category: template.category,
            description: template.description,
            skills: [...template.skills],
            skillIds: [...(template.skillIds ?? skillsForRole(template.id))],
            color: template.color,
          };
          return agent.manager === manager.name ? { ...agent, manager: template.name } : agent;
        }),
        teamSaved: false,
      }, `替换了项目经理 Agent 职责模板为「${template.name}」`));
      return true;
    },
    saveTeam: () => commit(withActivity({ ...state, teamSaved: true }, "保存了团队配置")),
    postMeetingMessage: (text, projectId = state.project.id, meetingId = state.meeting.id, attachmentIds = []) => runCommand(projectId, { type: "meeting.message", meetingId, text, sender: "用户", attachmentIds }),
    editMeetingMessage: (messageId, text, projectId, meetingId, attachmentIds = []) => runCommand(projectId, { type: "meeting.message.edit", meetingId, messageId, text, attachmentIds }),
    appendMeetingResponse: (text, projectId = state.project.id, meetingId = state.meeting.id) => runCommand(projectId, { type: "meeting.message", meetingId, text, sender: "项目经理 Agent" }),
    confirmRequirements: () => state.meeting.needsConfirmed ? Promise.resolve(false) : runCommand(state.project.id, { type: "meeting.confirm-requirements" }),
    generatePlan: (tasks) => runCommand(state.project.id, { type: "plan.generate", tasks }),
    proposeTaskPlan: (tasks) => runCommand(state.project.id, { type: "plan.propose", tasks }),
    updatePlan: (planId, tasks) => runCommand(state.project.id, { type: "plan.update", planId, tasks }),
    confirmPlanDraft: (planId) => runCommand(state.project.id, { type: "plan.confirm-draft", planId }),
    approvePlan: (planId) => runCommand(state.project.id, { type: "plan.approve", planId }),
    advanceTask: (projectId, taskId, automaticRetry = false) => runCommand(projectId, { type: "task.start", taskId, automaticRetry }),
    completeTaskRun: (projectId, taskId, runId, artifact, files) => artifact.taskId === taskId ? runCommand(projectId, { type: "task.complete", taskId, runId, artifact, files }) : Promise.resolve(false),
    failTaskRun: (projectId, taskId, error, runNumber) => runCommand(projectId, { type: "task.fail", taskId, error, runNumber }),
    pauseTaskRecovery: (projectId, taskId) => runCommand(projectId, { type: "task.recovery.pause", taskId }),
    reviewTask: (taskId, decision, note) => {
      const task = state.tasks.find((item) => item.id === taskId);
      return task ? runCommand(state.project.id, { type: "task.review", taskId, decision, note }) : Promise.resolve(false);
    },
    addArtifact: (artifact) => runCommand(state.project.id, { type: "artifact.add", artifact: { ...artifact, updatedAt: new Date().toLocaleString("zh-CN") } }),
    updateArtifact: (artifactId, changes) => runCommand(state.project.id, { type: "artifact.update", artifactId, ...changes }),
    deleteArtifact: (artifactId) => runCommand(state.project.id, { type: "artifact.delete", artifactId }),
    publishVersion: () => runCommand(state.project.id, { type: "delivery.publish" }),
    acceptDelivery: (versionId) => runCommand(state.project.id, { type: "delivery.accept", versionId }),
    updateSettings: (settings: AppSettings) => {
      workspaceSettings = {
        ...settings,
        excludedPaths: [...settings.excludedPaths],
        mcpServers: settings.mcpServers.map((server) => ({ ...server, args: [...server.args], env: { ...server.env }, headers: { ...server.headers } })),
        agentSkills: settings.agentSkills.map((skill) => ({ ...skill })),
      };
      commit(withActivity({ ...state, settings: normalizeSettings(settings) }, "更新了设置"));
    },
    resetWorkspace: () => {
      return runCommand("", { type: "workspace.reset", workspace: createCleanWorkspace() });
    },
  };
};

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { id: "project-manager", name: "项目经理 Agent", role: "项目管理", category: "项目管理", description: "负责需求澄清、计划拆解、进度协调与审核。", skills: ["需求澄清", "计划拆解"], skillIds: skillsForRole("project-manager"), model: "未配置", color: "blue" },
  { id: "research-lead", name: "研究生导师 Agent", role: "研究指导", category: "研究", description: "组织资料调研、研究方法讨论与阶段复盘。", skills: ["资料调研", "研究规划"], skillIds: skillsForRole("research-lead"), model: "未配置", color: "violet" },
  { id: "researcher", name: "研究生 Agent", role: "研究分析", category: "研究", description: "整理资料、归纳证据并输出研究摘要。", skills: ["文献整理", "证据归纳"], skillIds: skillsForRole("researcher"), model: "未配置", color: "purple" },
  { id: "java-backend", name: "Java 后端 Agent", role: "后端开发", category: "研发", description: "负责服务端接口、数据模型与业务逻辑。", skills: ["Spring Boot", "REST API"], skillIds: skillsForRole("java-backend"), model: "未配置", color: "violet" },
  { id: "frontend-developer", name: "前端开发 Agent", role: "前端开发", category: "研发", description: "负责页面组件、交互状态与前端集成。", skills: ["React", "TypeScript"], skillIds: skillsForRole("frontend-developer"), model: "未配置", color: "cyan" },
  { id: "qa-engineer", name: "测试 Agent", role: "质量保障", category: "测试", description: "设计验收用例，关注边界状态和缺陷证据。", skills: ["验收设计", "回归检查"], skillIds: skillsForRole("qa-engineer"), model: "未配置", color: "green" },
  { id: "technical-writer", name: "文档撰写 Agent", role: "技术文档", category: "文档", description: "输出接口说明、操作手册和会议纪要。", skills: ["技术写作", "接口文档"], skillIds: skillsForRole("technical-writer"), model: "未配置", color: "orange" },
  { id: "database-engineer", name: "数据库开发 Agent", role: "数据工程", category: "研发", description: "负责数据结构、查询性能和迁移方案。", skills: ["SQL", "数据建模"], skillIds: skillsForRole("database-engineer"), model: "未配置", color: "blue" },
  { id: "security-reviewer", name: "安全审核 Agent", role: "安全审核", category: "测试", description: "审阅敏感数据、权限边界与高风险变更。", skills: ["威胁建模", "权限审阅"], skillIds: skillsForRole("security-reviewer"), model: "未配置", color: "red" },
];

export const localClient = createLocalClient();

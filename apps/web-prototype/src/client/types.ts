export type PageId = "dashboard" | "team" | "meeting" | "tasks" | "roles" | "delivery" | "settings";
export type TaskStatus = "待分配" | "执行中" | "待审核" | "返工中" | "失败" | "已完成" | "已撤销";

export interface Project {
  id: string;
  name: string;
  goal: string;
  workspacePath?: string;
  archivedAt?: string;
  status: "配置中" | "进行中" | "已验收";
  updatedAt: string;
}

export type AgentToolId = "file-read" | "file-write" | "file-create" | "file-delete" | "web-search" | "command";

export interface AgentTool {
  id: AgentToolId;
  label: string;
  detail: string;
  enabled: boolean;
}

export interface Agent {
  id: string;
  templateId: string;
  roleTemplateId?: string;
  name: string;
  role: string;
  category?: string;
  description: string;
  group: string;
  manager: string;
  model: string;
  providerId?: string;
  modelId?: string;
  skills: string[];
  /** IDs of workspace Skills explicitly assigned to this Agent. */
  skillIds?: string[];
  status: "空闲" | "待命" | "运行中";
  tools: AgentTool[];
  reviewRule: string;
  color: string;
}

export interface RoleTemplate {
  id: string;
  name: string;
  role: string;
  category: string;
  description: string;
  skills: string[];
  /** IDs of workspace Skills selected for this role. */
  skillIds?: string[];
  model: string;
  providerId?: string;
  modelId?: string;
  color: string;
}

export interface MeetingMessage {
  attachments?: { artifactId: string; name: string }[];
  id: string;
  sender: "用户" | "项目经理 Agent" | "系统";
  text: string;
  time: string;
}

export interface PlanTask {
  id: string;
  title: string;
  group: string;
  assignee: string;
  summary: string;
  /** Least-privilege tool grants, selected from the assigned Agent's enabled tools. */
  permissions?: string[];
  /** Proposed effort and relative sequence; neither is a calendar deadline. */
  timeEstimate?: string;
  timeline?: string;
  rationale?: string;
  /** Tasks that must finish before this task can be scheduled. Empty means it can run in parallel. */
  dependsOn?: string[];
}

export interface MeetingPlan {
  id: string;
  version: number;
  status: "草案" | "指派待确认" | "已批准";
  /** A conversational proposal can be approved in one step after the user reviews it. */
  directApproval?: boolean;
  createdAt: string;
  tasks: PlanTask[];
}

export interface MeetingState {
  id: string;
  sourceMeetingId?: string;
  providerSessionId?: string;
  title: string;
  topic?: string;
  archivedAt?: string;
  status: "需求确认中" | "计划待审批" | "已批准";
  needsConfirmed: boolean;
  openQuestions: string[];
  messages: MeetingMessage[];
  /** Compact, automatically refreshed context for continuing long project-manager conversations. */
  contextSummary?: string;
  plan: MeetingPlan | null;
  fileArtifactIds?: string[];
  reportForPlanId?: string;
  reportForStage?: string;
}

export interface Task {
  id: string;
  title: string;
  group: string;
  assignee: string;
  summary: string;
  permissions?: string[];
  timeEstimate?: string;
  timeline?: string;
  rationale?: string;
  dependsOn?: string[];
  sourceMeetingId?: string;
  sourcePlanId?: string;
  sourcePlanVersion?: number;
  outputDirectory?: string;
  status: TaskStatus;
  progress: number;
  run: number;
  reworkCount: number;
  recovery?: { kind: string; attempts: number; limit: number; action: string; nextRetryAt: string | null };
  reviewNote: string;
  logs: string[];
}

export interface ObjectiveCheck {
  id: string;
  label: string;
  status: "passed" | "failed" | "not_run" | "not_applicable";
  details: string;
  evidence: Array<{ path?: string; scope?: string; sha256?: string; bytes?: number; authorizationId?: string; operation?: string; command?: string; exitCode?: number; durationMs?: number }>;
}

export interface Artifact {
  id: string;
  name: string;
  kind: "会议记录" | "设计文档" | "源代码" | "测试报告" | "交付文件";
  taskId: string;
  owner: string;
  version: string;
  status: "参考" | "待审核" | "已通过";
  updatedAt: string;
  size: string;
  content: string;
  contentEncoding?: "base64";
  relativePath?: string;
}

export interface DeliveryVersion {
  id: string;
  label: string;
  createdAt: string;
  artifactCount: number;
  status: "待验收" | "已验收";
  gitTag?: string;
  gitCommit?: string;
}

export interface ProjectActivity {
  id?: string;
  message: string;
  createdAt: string;
  kind?: "task-status";
  taskId?: string;
  taskTitle?: string;
  previousStatus?: TaskStatus | "新建";
  status?: TaskStatus;
}

export interface AppSettings {
  providerName: string;
  modelName: string;
  endpoint: string;
  connectionStatus: "未连接" | "已连接";
  egressApproval: "每次确认" | "项目范围内";
  excludedPaths: string[];
  localModel: boolean;
  networkEnabled: boolean;
  commandApproval: boolean;
  defaultProviderId: string;
  defaultModelId: string;
  mcpServers: McpServerSetting[];
  wpsOfficeMcpInstalled: boolean;
  agentSkills: ManagedSkillSetting[];
}

export interface McpServerSetting {
  id: string;
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  description: string;
  enabled: boolean;
}

export interface ManagedSkillSetting {
  id: string;
  name: string;
  displayName?: string;
  description: string;
  content: string;
  enabled: boolean;
}

export interface AppState {
  toolPolicyVersion?: 1;
  project: Project;
  agents: Agent[];
  groups: string[];
  meeting: MeetingState;
  meetingHistory: MeetingState[];
  roleLibrary: RoleTemplate[];
  customRoles: RoleTemplate[];
  tasks: Task[];
  artifacts: Artifact[];
  workspaceFolders: string[];
  versions: DeliveryVersion[];
  deliveryStatus: "未发布" | "待验收" | "已验收";
  settings: AppSettings;
  activities: ProjectActivity[];
  teamSaved: boolean;
}

export interface CreateProjectInput {
  name: string;
  goal: string;
  workspacePath?: string;
}

export interface AgentUpdate {
  id: string;
  name: string;
  description: string;
  manager: string;
  model: string;
  providerId?: string;
  modelId?: string;
  skills: string[];
  skillIds: string[];
  reviewRule: string;
  tools: AgentTool[];
}

export interface ProductClient {
  initialize(): Promise<void>;
  refreshWorkspace(): Promise<boolean>;
  pauseTaskRecovery(projectId: string, taskId: string): Promise<boolean>;
  getBackendStatus(): "connecting" | "saving" | "connected" | "offline" | "error" | "conflict";
  getBackendMessage(): string;
  getSnapshot(): AppState;
  flushWorkspace(): Promise<void>;
  getWorkspaceSettings(): AppSettings;
  getProjects(): Project[];
  getProjectStates(): AppState[];
  subscribe(listener: () => void): () => void;
  createProject(input: CreateProjectInput): void;
  archiveProject(projectId: string, archived: boolean): Promise<boolean>;
  deleteProject(projectId: string): Promise<boolean>;
  updateProject(projectId: string, input: CreateProjectInput): boolean;
  switchProject(projectId: string): boolean;
  createMeeting(title: string, topic: string): Promise<boolean>;
  selectMeeting(meetingId: string): Promise<boolean>;
  archiveMeeting(meetingId: string): Promise<boolean>;
  deleteArchivedMeeting(meetingId: string): Promise<boolean>;
  renameMeeting(meetingId: string, title: string): Promise<boolean>;
  saveMeetingMinutes(meetingId?: string): Promise<Artifact | null>;
  subscribeRole(template: RoleTemplate): void;
  createCustomRole(template: RoleTemplate): void;
  unsubscribeRole(templateId: string): void;
  updateRoleTemplate(template: RoleTemplate): void;
  addAgent(template: RoleTemplate, group: string): string | null;
  removeAgent(agentId: string): boolean;
  createGroup(name: string): void;
  removeGroup(name: string): boolean;
  moveAgentToGroup(agentId: string, group: string): void;
  updateAgent(input: AgentUpdate): void;
  replaceProjectManagerRole(templateId: string): boolean;
  saveTeam(): void;
  postMeetingMessage(text: string, projectId?: string, meetingId?: string, attachmentIds?: string[]): Promise<boolean>;
  editMeetingMessage(messageId: string, text: string, projectId: string, meetingId: string, attachmentIds?: string[]): Promise<boolean>;
  appendMeetingResponse(text: string, projectId?: string, meetingId?: string): Promise<boolean>;
  confirmRequirements(): Promise<boolean>;
  generatePlan(tasks: PlanTask[]): Promise<boolean>;
  proposeTaskPlan(tasks: PlanTask[]): Promise<boolean>;
  updatePlan(planId: string, tasks: PlanTask[]): Promise<boolean>;
  confirmPlanDraft(planId: string): Promise<boolean>;
  approvePlan(planId: string): Promise<boolean>;
  advanceTask(projectId: string, taskId: string, automaticRetry?: boolean): Promise<boolean>;
  completeTaskRun(projectId: string, taskId: string, runId: string, artifact: Artifact, files: Array<{ path: string; content: string; contentEncoding?: "base64" }>): Promise<boolean>;
  failTaskRun(projectId: string, taskId: string, error: string, runNumber?: number): Promise<boolean>;
  reviewTask(taskId: string, decision: "通过" | "返工", note: string): Promise<boolean>;
  addArtifact(artifact: Artifact): Promise<boolean>;
  updateArtifact(artifactId: string, changes: { name: string; kind: Artifact["kind"]; content: string }): Promise<boolean>;
  deleteArtifact(artifactId: string): Promise<boolean>;
  publishVersion(): Promise<boolean>;
  acceptDelivery(versionId: string): Promise<boolean>;
  updateSettings(settings: AppSettings): void;
  resetWorkspace(): Promise<boolean>;
}

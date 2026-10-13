# Web Client 与本机 Runtime 契约

状态：本机 Web Runtime v2（版本化快照 + 关键业务命令）。

## 页面业务对象

页面从 `AppState` 读取项目、Agent、小组、会议、计划、任务、活动、设置、产物及版本状态。页面操作调用 `ProductClient`；凭证不进入 `AppState` 或浏览器缓存。

## 接口

| 接口 | 用途 |
|---|---|
| `GET /api/workspace` | 获取本机工作空间和单调递增的 `revision`；首次启动返回空值及版本 0。 |
| `PUT /api/workspace` | 传入 `expectedRevision` 保存非关键资料快照；版本不匹配返回 409，普通快照不能直接更改计划审批、任务状态、项目归档/删除或交付验收状态。 |
| `POST /api/workspace/command` | 传入 `expectedRevision`、项目 ID 和业务命令；Runtime 校验当前状态、执行转换、原子保存并返回新版本和工作空间。 |
| `POST /api/workspace/select-folder` | 打开系统文件夹选择器，供新项目选择存放目录。 |
| `POST /api/workspace/create-project-folder` | 在选定目录下创建项目专属文件夹、初始化 Git 仓库和敏感路径排除规则，并返回绝对路径。 |
| `GET /api/health` | 返回 Pi Runtime 状态和供应商目录数量。 |
| `GET/POST /api/model-runtime/providers` | 读取和保存 Pi 支持的供应商、模型及端点配置。 |
| `POST /api/model-runtime/providers/:providerId/models` | 新增、编辑、删除自定义模型，编辑 Pi 内置模型参数，或保存模型启用状态。 |
| `/api/model-runtime/auth/*` | 通过 Pi 的 API Key/OAuth 流程配置凭证。 |
| `POST /api/model-runtime/chat` | 使用选定模型回答会议消息。 |
| `POST /api/model-runtime/plan` | 根据当前需求、小组和 Agent 生成结构化计划草案。 |
| `POST /api/model-runtime/execute` | 启动 Pi AgentSession 任务运行、受限工具和 Run 产物核验。 |
| `GET /api/model-runtime/agent-approvals` | 查询当前浏览器会话待处理的 Agent 命令/文件删除确认。 |
| `POST /api/model-runtime/agent-approvals/decision` | 批准或拒绝单条 Agent 命令/文件删除操作。 |

Vite 代理把同源 `/api/*` 请求转发到只监听回环地址的 Pi Runtime。项目状态保存在 `~/.pi/agent/ai-agent-team-workspace.json`；浏览器 `localStorage` 用作缓存和旧版数据迁移来源。

当前 Runtime 命令包括会议确认/新建、计划生成/批准、任务启动/完成/失败/审核、交付物提交、版本发布/验收、项目归档/删除和工作空间重置。工作空间允许零个项目；项目文件树初始为空。批准计划时按负责人创建必要分类目录，产物与上传文本写入项目目录，Artifact 保存相对路径。发布交付版本会创建 Git commit 和 `v0.x` tag，并生成交付清单。Runtime 会拒绝单个 Agent 并发执行多个任务、快照伪造目录或新增产物、直接提交已通过状态的新增交付物、非空白新项目和不符合当前任务状态的转换。业务拒绝返回 409 错误；过期 revision 返回 409 及 Runtime 当前 revision。快照和命令共享同一串行写入队列，成功后递增 revision。

## 行为和边界

- 没有配置默认模型时，会议消息仍会保存；模型回复和计划生成会提示先配置模型与认证。
- 模型出站设为“每次确认”时，每次会议回复、计划生成或任务运行都会在发送前询问；“项目范围内”会沿用项目设置。
- 任务先通过 Runtime 命令进入执行中，再调用模型接口；任务完成/失败由单独命令写入。任务审核、版本发布/验收也由 Runtime 命令校验并持久化。
- 计划批准命令会在 Runtime 检查计划版本、负责人和小组后创建任务。计划内容由已确认需求下的模型请求生成，再通过命令保存为草案。
- 审核驳回必须填写原因。任务状态转换、审核意见、返工次数、活动记录、产物内容和交付版本仍保存于同一个本机 JSON 文件；目前没有独立 TaskRun 表或数据库事务。
- 新项目必须选择本机存放目录；Runtime 按项目名称创建专属文件夹、初始化 Git 仓库并把路径记录到项目状态。计划批准后动态建立 `01_需求文档` 至 `04_测试报告` 中实际需要的目录；发布时创建 `05_最终交付` 和清单。归档状态保存在项目记录中；删除会从工作空间移除项目状态和应用内内容，二次确认会提示磁盘文件夹保留。
- Pi 注册的供应商模型直接作为模型目录；单模型启用状态写入 `ai-agent-team-provider-settings.json`，新增模型和内置模型覆盖写入 Pi `models.json`。
- Client 仍通过快照保存团队、会议消息、设置和其他非关键编辑；Runtime 对快照执行 revision 冲突检测及关键状态变更拒绝。受保护的审批、任务和交付转换使用逐条业务命令。普通快照写入仍是异步反馈，冲突后的自动合并/恢复尚未实现。
- 任务运行启用按 Agent 角色授权的 AgentSession 工具：读取项目普通文本；在当前任务 Run 目录创建、修改和删除任务文件；按项目网络开关进行公共网页检索；在 Run 目录通过本机命令执行程序。删除文件和每条命令都必须在 Web 应用中逐项确认；文件路径限制、凭据/依赖隐藏和任务产物哈希核验仍由 Runtime 执行。命令子进程使用本机账户运行，确认弹窗展示具体命令与工作目录。
- 发布版本提交项目目录中的文件并创建 Git tag。Git 版本记录的是发布时的项目文件快照，Runtime 状态仍保存在本机 JSON 工作空间。

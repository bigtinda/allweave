# Pi Runtime 技术验证记录

日期：2026-10-11。状态：部分完成。Web 页面现已通过 Vite 同源代理调用本机 Pi Runtime，包括供应商配置、认证、会议回复、计划生成和 AgentSession 任务执行。Pi Provider Guard 烟测与 Runtime 假 Provider HTTP 集成测试已覆盖 SDK 拒绝路径和产品授权/审计主流程；本轮新增 Runtime 客观检查证据、送审文件绑定、两类跨存储提交窗口恢复及目录联接替换故障注入。它们不能代替真实供应商、原子目录句柄安全、命令执行、完整任务崩溃恢复或完整审核与 Git 溯源验收。

## 源码与依赖基线

- Pi 源码位于 `../../pi-main`，该目录没有 Git 元数据，因此不能记录或声称上游 commit。
- Pi Coding Agent 包声明版本 `1.1.0`，要求 Node `>=22.19.0`。本机 Pi 源码快照 SHA-256 为 `a9e95a4532cc70f97051ff35badd6389315762bfa022ad11f000933dd187fb40`，清单见 [`p0/pi-source-baseline.json`](p0/pi-source-baseline.json)。该哈希只标识当前工作区内容。
- Pi 工作区依赖构建和产品侧 SDK 导入已通过；Pi `npm run check`、离线构建均通过。产品 Runtime 通过 `apps/local-runtime` 使用当前 Pi 源码依赖。
- 依赖安装输出报告 2 项 high severity advisory，影响范围尚未完成审阅。

## 已验证的出站拦截路径

- Pi `ModelRuntime` 增加可选 `providerRequestGuard`。它在既有 `onPayload` 转换之后检查最终 Provider 载荷；检查抛错时不会发送请求。
- `npm run smoke:provider-guard` 通过 Pi `createAgentSession` 发起 OpenAI Responses 假请求。测试会话没有内置或可调用工具，Guard 在 Fetch 前阻断请求，全局 Fetch 调用次数为 0，并在清理路径执行 `session.dispose()`。
- 烟测仅使用内存凭证和假 Fetch；没有真实密钥、模型调用或外部网络请求。
- `apps/local-runtime/test/model-provider-egress.test.mjs` 通过隔离 Runtime 子进程和同源测试代理覆盖 Runtime HTTP 路径：未准备/被拒授权零 Fetch、一次性授权、防策略放宽后的再确认、批准后假 Provider 调用与请求计数、取消、过期、运行中及已批准授权的重启状态。重启故障注入覆盖无输出 Run、已写部分文件的 Run，以及工作空间审核产物已提交但 Run 尚未最终收尾的窗口。后者验证 Runtime 重启后重新核对工作空间产物与磁盘 SHA-256，再把中断 Run 幂等收尾；客户端篡改提交内容会被拒绝。Runtime TaskRun 的 Provider 失败和运行中取消也走实际 HTTP API。
- `apps/local-runtime/test/project-agent-tools.test.mjs` 在隔离文件树验证实际 Pi Agent 文件工具拒绝路径逃逸、绝对路径和外部目录联接符号链接，隐藏凭据/依赖目录，拒绝二进制和超限文件，限制任务输出到专属 Run 目录，限制输出为 1 MB 和最多 8 层，并核对重复写入的索引行为。新增确定性竞态钩子，在目录列举/文件读取/文件写入完成初步校验后替换目录为 junction；工具拒绝返回外部目录结果、读取外部文件或创建外部文件。文件读取先打开句柄再复核文件身份与真实路径；文件写入使用同目录独占临时文件、刷新后原子替换，并复核目录身份和最终路径。此测试此前发现并促成修复：文件工具原先未限制路径深度。
- 假 Provider 还会驱动 Pi AgentSession 实际调用 `read_project_file` 和 `write_deliverable`。集成用例验证 SQLite 出站审计记录读取文件的项目相对路径、字节数与 SHA-256，正文不落库；模型请求计数覆盖工具执行前后的三个 Provider 请求。
- `apps/local-runtime/src/objective-checker.mjs` 由 Runtime 实际核对执行授权与项目/任务绑定、任务 Run 目录、必需产物、磁盘文件的实际字节数和 SHA-256。Agent 现可申请执行本机指令，但执行结果不会自动标记编译、Lint 或测试通过；没有真实检查证据时状态仍为 `not_run`。`task-runs.sqlite` 保存检查记录及事件；`/api/workspace/command` 的任务提交要求 runId 匹配并将客户端文件列表与 Run 哈希证据逐项比对。
- 任务详情与运行日志展示每项检查状态、说明及文件路径/字节数/SHA-256 摘要。失败检查仍保存在失败 Run 中，但该 Run 不能进入待审核。
- `apps/local-runtime/test/task-run-store.test.mjs` 覆盖检查证据持久化、失败检查阻断审核、工作空间提交标记和提交后中断 Run 的恢复收尾，以及 SQLite 出站审计字段不包含提示正文。`model-provider-egress.test.mjs` 新增 SQLite 触发器故障注入：Workspace JSON 和磁盘 Run 文件已提交后，令 `workspace_committed` 更新事务失败；强制重启后，Runtime 依据审核状态及实际 Run 文件哈希恢复 TaskRun 为 `completed`。工作空间单测也覆盖 Run 写入目录和恢复扫描文件在初步校验后切换成外部 junction。
- 本轮 local-runtime 全量测试 26/26 通过，Web `npm run typecheck` 通过。测试仅使用隔离临时项目和假 Provider；没有访问真实凭证或供应商。
- 集成测试使用临时 `PI_CODING_AGENT_DIR`、fixture API key、fixture 模型和被全量截获的 Fetch；没有访问用户凭证、线上模型服务或真实 Provider 网络。

## 未验证范围

- Pi Provider Guard 直接烟测只覆盖 OpenAI Responses；产品 HTTP 假 Provider 集成覆盖 OpenAI Chat Completions。其他内置 Provider、自定义 Provider、WebSocket、内部重试和扩展网络调用尚未覆盖。
- 尚未覆盖真实供应商流式响应、供应商中断后的续跑、摘要/压缩请求、Git 发布跨存储恢复，或真实供应商请求。JSON 工作区已提交但 SQLite TaskRun 标记失败的故障窗口已通过触发器注入和重启恢复验证。已有部分产物时的中断恢复已覆盖安全文本文件，恢复扫描遇到校验后的 junction 切换会跳过。Node 的路径式文件系统 API 无法将最后一次路径复核和随后的打开/重命名组合为单一原子操作；当前复核与原子替换缩窄了窗口，但仍留有竞态。本机句柄式后端的方案已记录于 `workspace-path-safety-design.md`，原生实现和操作级验收仍未开始。
- 工作空间业务权威状态仍为带 revision 的原子 JSON 快照；SQLite 独立保存 TaskRun 状态/事件和出站授权审计。多标签冲突恢复、工作空间 SQLite 迁移、队列/Lease、断点续跑尚未完成。
- AgentSession 工具现可列出/读取授权项目文本，在当前 Run 输出目录创建、修改和删除普通文件，调用公共网页搜索，以及在本机执行经用户逐项确认的命令。文件写入仍受任务输出路径约束，删除只接受当前 Run 内的普通文件。此前的读取与 Run 写入路径安全矩阵仍有效；本次新增搜索、删除审批、命令执行及 Agent 角色权限开关尚未经过测试或运行时验证。残留文件系统限制是最后一次路径校验到路径式系统调用之间的窄竞态；尚未实现句柄相对后端。其详细方案和验收条件见 `workspace-path-safety-design.md`。
- Runtime 已实现服务端出站授权、最终请求 Guard 和 SQLite 审计；现有假 Provider 用例覆盖主要一次性授权规则，但“项目范围内”仍是整个项目操作级授权，没有目录/数据类型粒度的可配置授权范围。

## 后续验证顺序

1. 按 `workspace-path-safety-design.md` 先验证 Koffi 对 Windows 句柄相对打开/重命名的封装与 Node 22.19/26 兼容性；通过后实现统一句柄适配层并迁移 Agent、Run 恢复/提交、交付物和手动文件 CRUD。失效时文件操作 fail closed；保留现有 junction 替换用例并补充操作级竞争门槛。
2. 继续独立记录 Review 决议、返工和 Run/文件/Git commit 关系，并验证 Git 发布跨存储故障恢复；在明确开放安全命令工具之前，编译、Lint 与测试保持“未运行”。
3. 扩展 Provider Guard 的重试、其他传输和自定义 Provider 假服务覆盖，并验证真实流式取消与 Session 清理；在 Web 浏览器验收设置页审计呈现和文件访问事件。
4. 之后再评估更细的授权范围和真实供应商调用；任何真实调用均需使用用户明确指定的供应商/模型及凭证限制。

所有真实模型调用都应单独获批并使用明确配置的凭证；默认开发过程使用假 Provider。

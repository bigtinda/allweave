# AllWeave · 万象成序

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> 一念成潮，万象成序。让智能形成组织，让协作突破边界。

一个以 Web 应用方式实现的 **AI 虚拟项目团队**：把项目经理、成员 Agent、会议、计划、任务与交付验收放进同一条可追溯的流水线。React + Vite 前端通过同源代理连接本机 Pi Runtime，项目、任务与交付物落盘在真实目录中，并以 Git commit 与 `v0.x` 标签留痕。

---

## 架构

```text
┌─────────────────────────────────────────┐
│  Browser  http://127.0.0.1:5173         │
│  Vite + React 19  (apps/web-prototype)  │
└───────────────┬─────────────────────────┘
                │ 同源代理 /api/*
                ▼
┌─────────────────────────────────────────┐
│  Pi Runtime  127.0.0.1:5192             │
│  (apps/local-runtime)                    │
│  工作空间存储 · 状态机 · 供应商/凭证     │
└───────────────┬─────────────────────────┘
                ▼
        项目目录（独立 Git 仓库）
        会议纪要 / 任务产物 / 交付版本
```

- **前端** 负责页面交互与乐观反馈，业务写入一律走 Runtime 命令。
- **Runtime** 负责版本化快照、状态转换校验、供应商与模型配置；跨组、跨项目通信每次按最新归属鉴权。
- **项目目录** 是交付物的唯一事实来源，发布版本时创建 Git commit 与 tag。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 · TypeScript 6 · Vite 8 · `@vitejs/plugin-react` |
| 运行时 | Node.js `>=22.19.0` · ESM · `node:test` |
| 运行时依赖 | `@earendil-works/pi-*`（Pi Coding Agent SDK，见 [依赖前提](#依赖前提)） |
| 辅助能力 | Python（会议附件抽取、WPS Office MCP） |
| 服务托管 | PowerShell + Node 后台进程脚本（仅 Windows） |

---

## 快速开始

### 环境要求

- Node.js `>=22.19.0`
- Windows + PowerShell（`start/stop/status` 依赖 `scripts/dev-service.ps1`；macOS/Linux 可改用 `npm run dev` 前台运行）

### 启动 Web 应用

```powershell
cd apps/web-prototype
npm install --ignore-scripts
npm run start
```

`npm run start` 会把 Web 页面与 Pi Runtime 作为隐藏后台进程启动，关闭终端后仍继续运行。

- Web 页面：`http://127.0.0.1:5173/`
- Pi Runtime：`127.0.0.1:5192`

Vite 固定监听 5173。若 5173 已被占用，启动会打印日志并如实报告端口归属，不会结束无关进程或悄悄切换地址。旧的 Pi Runtime 已在运行时，新 Web 实例会先做健康检查并复用它。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run start` | 后台启动 Web + Runtime |
| `npm run dev` | 当前终端前台运行，适合调试 |
| `npm run status` | 查看本项目服务状态与日志 |
| `npm run restart` | 重启并检查 HTTP 可用性 |
| `npm run stop` | 停止本项目托管的服务 |
| `npm run typecheck` | TypeScript 类型检查（Web） |
| `npm test` | Web 侧脚本测试 |

后台日志与进程记录写入 `apps/web-prototype/.dev-runtime/`（已忽略，不入库）。

> **启动可靠性**：启动与状态检查会实际请求 Web 页面、Runtime 健康端点及 Web 同源代理，全部通过才报告可用。仅看到监听地址或启动日志不足以判定服务可用，应以 `npm run status` 的 HTTP 200 为准。

---

## 目录结构

```text
ai-agent-team/
├── apps/
│   ├── local-runtime/          # 本机 Pi Runtime（状态机 + 存储 + 供应商网关）
│   │   ├── src/                # 19 个运行时模块（.mjs，含一个 WPS MCP Python 服务）
│   │   ├── scripts/            # 基线记录、Provider Guard 烟测
│   │   └── test/               # 18 组 node:test 用例
│   └── web-prototype/          # Vite + React 前端
│       ├── src/                # App、client 适配层、组件与主题
│       ├── scripts/            # dev-service.ps1、dev.mjs 及其测试
│       └── public/             # AllWeave 品牌图形
└── docs/                       # 契约、实施记录、审计与设计文档
```

---

## 当前能力

- **Agent 协作通信**：同组成员可查询成员、发送协作消息、读写收件箱。消息落本机 Runtime 数据库；接收方在运行时读取，不会因收到消息而自动调用模型。跨组、跨项目通信一律拒绝，项目经理无例外。
- **工作空间与版本控制**：项目、团队、会议、任务、设置、交付数据保存在本机 JSON 工作空间，版本号防止旧快照覆盖。审批、任务、审核、归档与验收由 Runtime 命令校验。
- **模型与凭证**：Runtime 提供供应商目录、模型设置与凭证授权；会议回复、计划生成、任务文本生成均使用所选 Pi 模型。凭证不进入页面状态或浏览器缓存。
- **计划 → 任务 → 交付闭环**：计划经人工批准后由 Runtime 校验版本并创建待分配任务；生成的交付文本进入待审核，审核、返工与本地版本验收均由 Runtime 状态命令持久化。
- **真实项目目录**：创建项目时选择目录并初始化独立 Git 仓库；任务产物、会议纪要与上传文件按角色写入对应目录。发布交付版本时创建 commit、`v0.x` 标签与交付清单。
- **WPS Office 集成**：内置 WPS Office MCP 要求与运行时桥接，用于办公文档处理。

## 已知限制

- 任务运行**不会**创建 Pi AgentSession，不会直接改写任意源码，也不执行项目命令或测试；目前没有真实的暂停、取消与持久 Run 恢复。
- 交付文件上传仅支持 1 MB 以内的文本内容。
- 项目文件树只显示已创建的目录。
- 面向 Windows 编写；服务端脚本依赖 PowerShell。

---

## 验证

```powershell
# Web 应用
cd apps/web-prototype
npm run typecheck
npm test

# Runtime 状态转换与集成测试
cd ../local-runtime
npm test
```

---

## 依赖前提

> ⚠️ **克隆本仓库后 `apps/local-runtime` 无法直接 `npm install`。**

`apps/local-runtime/package.json` 的 `dependencies` 与 `overrides` 指向**工作区外的本地 tarball**：

```json
"@earendil-works/pi-coding-agent": "file:./../../../pi-main/.artifacts/pi-packages-taskfix-v2-20261012/tarballs/earendil-works-pi-coding-agent-1.1.0-f3c540e1b9ac.tgz"
```

该路径指向 Pi 源码快照的构建产物，不随本仓库分发。拉取代码后需要：

1. 准备 `pi-main/.artifacts/pi-packages-taskfix-v2-20261012/tarballs/` 下的 13 个 `@earendil-works/*` tarball，或
2. 将上述 `file:` 依赖替换为 npm 上的可用版本。

`apps/web-prototype` 的依赖全部来自公共 registry，可直接安装。

源码基线与校验信息见 [`docs/pi-runtime-validation.md`](docs/pi-runtime-validation.md) 与 [`docs/p0/pi-source-baseline.json`](docs/p0/pi-source-baseline.json)。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/client-contract.md`](docs/client-contract.md) | Web Client 与本机 Runtime 的接口契约 |
| [`docs/implementation-status.md`](docs/implementation-status.md) | 实施记录与当前状态 |
| [`docs/interaction-audit.md`](docs/interaction-audit.md) | 全系统交互逻辑审计、优先级与未完成项 |
| [`docs/design-baseline.md`](docs/design-baseline.md) | W0 设计基线与 W1 原型交互 |
| [`docs/pi-runtime-validation.md`](docs/pi-runtime-validation.md) | Pi Runtime 技术验证记录 |
| [`docs/workspace-path-safety-design.md`](docs/workspace-path-safety-design.md) | 本机项目路径安全的句柄式文件系统方案 |
| [`AGENTS.md`](AGENTS.md) | 启动本机服务的操作约定（供 AI 助手遵守） |

---

## License

本项目基于 [Apache License 2.0](LICENSE) 开源，版权归 Litind 所有。
使用、修改或分发本项目时，请保留许可证文件及版权声明。

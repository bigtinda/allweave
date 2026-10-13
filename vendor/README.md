# vendor 说明

本目录收录 AllWeave 依赖的**第三方上游源码**，以保证仓库可自证、可离线构建。

## `pi-main/` —— Pi Coding Agent

| 项 | 值 |
| --- | --- |
| 上游仓库 | <https://github.com/earendil-works/pi> |
| 官网 | <https://pi.dev> |
| npm 包 | `@earendil-works/pi-coding-agent` 等 14 个 |
| 根包版本 | `pi-monorepo@0.0.3` |
| 包版本 | `1.1.0` |
| 许可证 | **MIT License — Copyright (c) 2025 Mario Zechner** |
| Node 要求 | `>=22.19.0` |
| 入库规模 | 14 个 packages · 1988 个文件 · 约 23.3 MB |

源码基线 SHA-256（标识入库快照内容）：

```text
a9e95a4532cc70f97051ff35badd6389315762bfa022ad11f000933dd187fb40
```

完整基线清单见 [`../docs/p0/pi-source-baseline.json`](../docs/p0/pi-source-baseline.json)。

### 入库范围

按上游自身的 `.gitignore` 规则收录，**上游文件零改动**：

- **已收录** — `packages/*` 源码、`.pi/`（extensions / prompts / skills）、`scripts/`、`.github/`、构建与检查配置（`package.json`、`tsconfig*.json`、`biome.json`、`flake.nix`、`.husky/`）、项目文档
- **已排除** — `node_modules/`、`.artifacts/`（打包产物）、`packages/*/dist/`（编译输出）、`.env`、日志与缓存

`.pi/` 与示例目录下的 `build/` 预编译 wasm 属于上游源码的一部分，已通过根 `.gitignore` 的 `/.pi/`、`/build/` 锚定规则确保不被误排除。

### 为什么 vendoring

`apps/local-runtime` 的 `dependencies` 与 `overrides` 指向 `file:../../../pi-main/.artifacts/.../tarballs/*.tgz` 这类**工作区外的本地 tarball**。把源码入库后，上游依赖有了仓库内的权威来源，排查 SDK 行为、定位 SDK 变更不再依赖本机残留目录。

### 许可与合规

`vendor/pi-main/LICENSE` 是上游 MIT 许可证，**必须原样保留**。本仓库根目录的 Apache-2.0 只适用于 AllWeave 自研部分，不覆盖 `vendor/` 下的第三方代码。MIT 与 Apache-2.0 兼容，允许在 Apache-2.0 项目中分发，但需保留原版权声明与许可文本。

### 使用方式

```powershell
cd vendor/pi-main
npm install          # 安装 14 个 workspaces 的依赖
npm run build        # 按依赖顺序编译全部 packages
npm test             # 运行全部测试
```

> 安装建议加 `--ignore-scripts`：上游 `prepare` 会调用 husky 安装 Git hooks，在 Windows 上对普通使用者无必要。

### 修改约定

`vendor/` 下**不接收 AllWeave 的功能改动**。如需修复上游缺陷：

1. 在 `vendor/pi-main/` 内完成修改并保持上游目录结构
2. 在 AllWeave 侧（`apps/`）验证通过后，于 `docs/implementation-status.md` 记录改动原因
3. 若上游已发布对应版本，优先升级到 npm 上的正式版本，撤销本地 vendor 改动

---

本目录暂无其他 vendored 组件。

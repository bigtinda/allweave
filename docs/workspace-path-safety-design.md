# 本机项目路径安全：句柄式文件系统方案

日期：2026-10-11。状态：技术评估已完成，实施尚未开始。本文解决 Node 路径式文件系统调用在最终校验和实际操作之间仍有 TOCTOU 竞态的问题。

## 结论

把项目目录访问收敛到 `ConfinedWorkspaceFs` 适配层。该层以已打开的项目根目录句柄为授权锚点，后续目录遍历和文件打开/创建均相对父目录句柄执行；拒绝重解析点（reparse point）、目录联接和不符合文件类型/身份约束的对象。读取使用已核验的文件句柄，新增或覆盖先写入同一父目录中的唯一临时文件，再通过父目录句柄发出一次相对重命名请求提交。这样消除最终操作重新解析一条可被换接的绝对路径所造成的越界竞态；不会把运行中的所有目录项变化或不同存储间的提交变成一个事务。

Windows 的相对打开需要 `NtCreateFile` 的 `OBJECT_ATTRIBUTES.RootDirectory`；该接口文档说明子项名称可相对已有目录句柄解析，并支持 `FILE_OPEN_REPARSE_POINT`。最终临时文件提交使用 `SetFileInformationByHandle` 和 `FILE_RENAME_INFO.RootDirectory`，让目标名称相对已固定的父目录句柄解析。[NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile) · [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)。`CreateFileW` 的 `FILE_FLAG_OPEN_REPARSE_POINT` 可打开重解析点本身，打开目录还需 `FILE_FLAG_BACKUP_SEMANTICS`，可用于取得并核验项目根目录句柄。[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)

Node `fs` 的常规读写接口以路径为操作目标；当前项目在 Node 26.7.0 下也没有可用于这条路径的 `NOFOLLOW`/`OPEN_REPARSE` 常量。单纯增加更多 `lstat`、`realpath` 和身份复核仍是缩小竞态窗口，不能把校验和后续路径式系统调用合成一个原子操作。[Node.js FS API](https://nodejs.org/api/fs.html)

## 安全边界

- 防护目标：并发进程在校验后替换子目录、文件或目录联接时，Runtime 不因该替换读取项目根目录外内容，也不向根目录外写入、覆盖或删除文件。
- 项目根目录是用户明确授权的边界。创建/绑定项目时保存根目录卷标识与 File ID；每次操作重新打开根目录并核对身份，拒绝根目录变成重解析点或身份改变。用户迁移项目目录时需通过项目管理操作重新绑定。
- 操作期间保持根目录及遍历过的目录句柄打开，并在共享模式中拒绝删除/重命名共享；若其他进程持有冲突句柄，操作失败并提示重试，不退回路径式写入。
- 对文件句柄核验卷标识、File ID、类型、大小及链接数。存在多个硬链接的文件拒绝 Agent 读取/写入和恢复，以免通过工作区内硬链接读写工作区外的同一文件对象。
- 保护对象还包括 Windows 符号链接、junction、挂载点及其他重解析点；不得只检测符号链接这一种类型。
- 目标保证是“路径解析与操作相对于已固定句柄”，不是把整个 Run、JSON、SQLite、文件系统和 Git 跨存储提交合成一个全局事务。断电耐久性、SMB/第三方文件系统语义、被攻陷的 Runtime、管理员/内核级攻击，以及 Git 子进程的独立信任边界仍分别处理。

## 适配层职责

适配层只暴露高层、有限 API，不向调用方泄漏原始句柄或裸指针。`writeAtomic` 表示同目录临时文件加句柄相对重命名的应用写入策略。新增采用 no-clobber。Windows 重命名接口按父目录句柄约束目标名称，但没有基于预期 File ID 的目录项 compare-and-swap：若恶意并发方替换同一个目录中的目标名称，仍可能覆盖那个目录项；这不会把访问带出授权根目录，但不能声称实现了对所有并发修改的原子冲突检测。当前应用内用 Runtime 串行化与 revision 校验保持协作式一致性；如验收要求防御同目录的恶意覆盖竞争，先采用不可变 Run 文件名/版本化目标并通过元数据选择版本，或在产品层阻止对既有文件的 Agent 覆盖，不能用路径式检查伪装成原子 CAS：

| API | 必须由句柄完成的步骤 |
|---|---|
| `list(rootIdentity, relativeDirectory)` | 根句柄核验、逐段相对打开目录、从该目录句柄枚举；每个子目录继续以句柄打开后才递归。 |
| `readText(rootIdentity, relativeFile, limits)` | 相对父句柄以禁止跟随重解析点的方式打开普通文件；由同一文件句柄读取并执行大小、硬链接数、文本检查。 |
| `ensureDirectories(rootIdentity, relativeDirectory)` | 每层相对父句柄原子创建或打开；已存在对象必须经句柄核验为普通目录且非重解析点。 |
| `writeAtomic(rootIdentity, relativeFile, content, policy)` | 相对父句柄创建唯一临时文件、写入并 flush；由临时文件句柄相对同一个父句柄重命名到目标名称。创建与覆盖策略明确区分。 |
| `deleteFile(rootIdentity, relativeFile)` | 相对父句柄打开目标并核验普通文件后，通过该文件句柄执行删除处置；不再用拼接路径调用 `unlink`。 |

应用范围：Pi Agent 的列举/读取/Run 输出；中断 Run 扫描、提交前磁盘核验；分类目录创建和交付物写入；项目文件手动列举、预览、上传/新增、修改、删除。项目目录之外的用户目录选择和应用自身 `.dev-runtime` 数据目录不属于该授权根目录 API。

## 实施路径

### 阶段 A：FFI 可行性验证

先在隔离模块验证 `koffi` 对当前 Node 版本和 Windows x64 的本机 API 调用，封装 `NtCreateFile`、句柄信息查询、目录枚举、句柄读取/写入、`SetFileInformationByHandle` 和句柄关闭。Koffi 官方文档支持 Windows x64/ARM64、C 结构体和函数调用，并为已支持组合提供 npm 预编译二进制，当前机器无需临时安装 C++ 编译器。[Koffi 支持矩阵](https://koffi.dev/) · [Koffi Win32 调用示例](https://koffi.dev/start)。

验证以下内容后再通过决策门：

1. 在项目要求的 Node 最低版本 22.19 与当前 26.7 均能安装、加载并调用；不能只依据 Node 26 的实验性 `node:ffi`，因为它需要实验开关且 Node 22 不提供该 API。[Node.js FFI](https://nodejs.org/api/ffi.html)
2. 用隔离临时目录验证相对句柄打开、重解析点拒绝、句柄相对重命名、覆盖策略、错误码和句柄释放。
3. 对照独立 C/Win32 小程序或官方 API 参数布局核对 Koffi 结构体尺寸、对齐、宽字符串、`NTSTATUS` 与句柄签名；所有原生定义留在一个模块内。
4. 若 FFI 结构体/句柄管理无法达到可审查标准，改用一个窄接口 Node-API 原生适配器；届时把 Windows C++ Build Tools 作为开发构建依赖记录，不生成桌面安装包或分发包。

阶段 A 只验证技术，不用于生产文件操作，也不降低现有路径保护。

该原生桥接只作为本机 Runtime 的依赖，以 Web 开发服务方式加载；不生成 Web 静态打包、桌面安装包或分发包。Koffi 的预编译依赖与产品打包是两回事，但仍需在项目锁文件中固定版本并审查其平台二进制来源。

### 阶段 B：实现 Windows 句柄后端

先支持本地 NTFS/ReFS 场景：根目录身份绑定；路径组件校验；重解析点/硬链接拒绝；逐层相对打开和创建；句柄枚举与读取；同目录唯一临时文件写入、flush 和相对句柄重命名；通过文件句柄删除。任何不支持的文件系统、API 错误或身份变化均 fail closed，并返回 Runtime 可解释错误。

适配器启动状态单独暴露在 Runtime 健康/诊断信息中。即使句柄后端不可用，Web 和 Runtime 仍可启动；涉及授权项目目录的 Agent/文件读写操作显示不可用原因并拒绝执行，不会悄悄回落到 Node 路径实现。

### 阶段 C：迁移业务入口

先迁移 Agent 工具、任务提交核验和中断恢复；再迁移交付物以及项目文件手工管理。删除已有竞态钩子测试不在本阶段范围；旧路径检查保留为输入约束和纵深检查，但不得作为原子安全保证的依据。Git 命令仅在明确的项目根目录工作，仍需单独审查仓库配置/Hook 等子进程威胁。

### 阶段 D：验收和降级行为

在 Windows CI 和本地临时卷上验证：静态逃逸；校验后替换 junction/符号链接/挂载点；父目录移动；目标文件替换；根目录身份替换；硬链接；并发创建/覆盖/删除；目录枚举中的替换；错误退出时临时文件清理；句柄全路径关闭。保留当前 Node 路径竞态注入作为旧防护回归，再为原生层增加操作级竞争注入。

只有迁移范围中的文件操作都通过相同矩阵，且 Node 22/26 启动状态、失效关闭提示和实际文件产物一致性均经验证，才把该安全项标为完成。测试应覆盖标准目录、junction 与符号链接；网络/第三方文件系统能力不支持时明确拒绝，不宣称通用支持。

## 当前环境与风险

- 本机：Windows x64、Node 26.7.0；`apps/local-runtime` 要求 Node >=22.19.0。当前没有 Node 22.19、nvm/fnm/nvs 或 npm 缓存中的 Koffi；Node 22 兼容性需通过 CI/独立 Node 安装矩阵确认，安装 Koffi 需要可访问 npm registry。
- 当前 PATH 无 MSVC `cl`、CMake 或 node-gyp；`.NET SDK` 也不可用。已安装 Rust 但只有 MSVC target 且未发现链接器。因此现在直接写自定义原生模块不能在本机完成构建验收。
- Koffi 的 FFI 定义错误可能导致 Runtime 崩溃或内存破坏；通过窄接口、固定签名、有限输入、隔离模块和竞争注入降低风险。若不能通过结构布局与错误路径审查，阶段 A 必须停止并切换自定义 Node-API 后端。
- `NtCreateFile` 是 Windows 专用底层接口，文件系统差异和系统版本兼容性需通过目标环境矩阵验证；不把单一 NTFS 结果泛化为所有卷。
- 原子句柄操作仍不等于跨 SQLite/JSON/Git 的业务事务；后者继续走当前 TaskRun 对账与恢复设计。

## 决策记录

推荐顺序：先做 Koffi 隔离 POC，因为它避免当前环境安装 C++ 构建链；若所有 Node 22/26 和竞态验收通过，就把它作为 Windows 句柄后端依赖，并将原生调用严格限制在该模块。否则使用窄接口 Node-API 实现并补足本机构建工具。两条路径都禁止在后端失效时退回路径式写入。


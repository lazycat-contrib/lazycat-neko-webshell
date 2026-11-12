# Remoted 原生客户端公开发布接入方案

状态：仅调查与方案，未修改公开仓库、触发 workflow 或创建 Release。检查日期：2026-11-12。

原生 Android APK 已完成构建，Android 实际测试正在进行；该进展尚不代表平台验收、生产签名验证或公开发布完成。

## 已核实的现状

通过只读 `gh api` 检查了私有源码仓库 `ca-x/lazycat-neko-webshell` 与公开仓库 `lazycat-contrib/lazycat-neko-webshell`。公开 main 检查时为 `4b4dc466cb9f7a353cfd89d3806050e7275900c4`；私有 main 为 `692e088108242f556c2024443c0578ef315257b3`。本地未提交的 Remoted 工作不等于这两个远端已具备对应能力。

私有 `.github/workflows/lazycat.yml` 在 `v*` tag 或手动触发时校验 `package.yml` 版本，通过 `ca-x/lazycat-github-action@v1.3.6` 构建 LPK，仅上传 `neko-lpk-v<version>`，保留 3 天。它没有原生客户端构建/签名任务。

公开仓库只有 `components/neko`。`publish-neko.yml` 每小时第 9、39 分钟轮询，或手动指定来源 run，调用通用 `publish-lpk.yml`。后者用私有来源凭据选取成功构建、下载唯一未过期组件 artifact、检查 LPK 结构/ID/版本/架构/SHA256，再发布 Release 并提交商店。手动触发默认 dry run；定时任务会走实际发布。

`scripts/release.cjs` 的组件允许列表为 `neko`、`client`、`server`，但目前仅 `neko` 有实际 profile。来源校验拒绝 PR/fork、不可信事件、错误 workflow/branch/tag；发布逻辑回读远端附件验证 SHA256，恢复中断时不覆盖内容不同的既有附件。`check.yml` 运行 Python/Node 测试和 actionlint。最新公开 Release `v0.12.2` 的附件为 `community.lazycat.webshell.neko-v0.12.2.lpk` 和 `checksums.txt`，没有 APK 或桌面原生产物。

这些路径是现有事实，不能把 `client` 允许值直接解释为“Remoted 客户端已接入”。LPK 解包校验与商店提交也不适用于 APK/桌面安装包。

## 建议的独立组件

1. **版本和身份独立。** 新组件明确命名 `remoted-client`，不占用含义不明确的 `client`。以 `remoted/client/Cargo.toml` 和 `nsh.json` 的一致版本为来源，tag 使用 `neoko-terminal-android-v<version>`；现有 WebShell `v*` 和 LPK 发布保持原语义。协议版本独立校验，不能仅靠应用版本判兼容。
2. **私有构建先落地。** 新建独立原生构建 workflow，源码仍在私有仓库。客户端拥有自己的 workspace，不能依赖根 workspace 的普通构建覆盖；固定 NSH git revision，使用自己的 Cargo.lock。先在 Android arm64-v8a 的实际 runner 上验证 NSH 打包命令、SDK/NDK/JDK、系统最低版本与运行能力，再固定 CI。源码 `nsh.json` 当前 targetSdk 为 35；设计中的 API 28+ 仍需实际产物验证。桌面矩阵逐平台补齐依赖、签名和启动测试，通过后才宣告支持。
3. **签名是发布门槛。** Android 用稳定生产签名并验证证书指纹、包名 `community.lazycat.neko.remoted`、版本及 ABI；debug APK 不得进入正式 Release。macOS/Windows 对应签名、公证或安装验证单独处理。密钥仅在受保护构建环境中注入，不进入源码、artifact 或日志。
4. **定义原生产物合同。** 建议 artifact 前缀 `neoko-terminal-android-v`，附件例如 `neoko-terminal-v<version>-android-arm64.apk`。用精确允许列表包含原生产物、`checksums.txt` 与来源清单（来源仓库/commit/workflow/run、版本、平台/架构、签名身份）。只上传已验证安装包；不得导出私有源码、完整工作区、构建缓存或签名材料。保留时间需覆盖发布轮询和故障恢复，不能不加判断照搬 3 天。
5. **公开仓库新增原生发布路径。** 新增 `components/remoted-client/profile.json`、单独的原生验证/发布脚本与 `publish-neoko-terminal-android.yml`；不要把 APK 交给 `prepare-lpk.py` 或 LPK 商店 action。复用可信来源选择、按组件串行发布、版本/tag 一致性、唯一 artifact、附件回读 hash 与幂等恢复等约束；重构共享逻辑时补齐现有 neko 回归测试。
6. **先 dry run，再独立发布。** 初期仅手动指定已验证的来源 run，默认 dry run，检查工作流身份、私有源权限、manifest/hash/签名、版本/tag、产物数量和类型。成功后经授权开启写 Release；只写 `neoko-terminal-android-v*`，不修改已有 LPK Release，不调用懒猫商店。定时发布需在人工验证整个链路之后另行开启。
7. **同步公开部署文档。** 将 `remoted/relay` 可部署源码（含 lockfile、Wrangler 配置和测试）与本目录部署指南经过审核后同步到公开仓库，让用户能实际执行 `npm ci` 和部署。文档与源码固定到同一来源 commit，去除内部凭据/路径；仅复制指南而缺少 Relay 源码不能称为可自行部署。Cloudflare token 和可选 registration key 由部署者管理，原生 Release 不内置公共 Relay 或通用密钥。

## 接入前验收

需要验证真实 Android 安装、终端输入与渲染、中文 IME、扫码拒绝/取消、Keystore 密钥重用与失效、文件选择、前后台切换与网络断线重连。协议侧覆盖配对过期、错误指纹、只读限制、撤销、目标身份变化与输出缺口；发布侧覆盖不可信来源、过期/重复 artifact、错误签名、hash 不匹配、附件冲突和中途失败恢复。每个平台只宣告已验证的能力。

## 实施状态（2026-11-12）

上述内容保留为发布接入前的基线评估。现已实现私有 `neoko-terminal-android.yml` 构建工作流、稳定 Android 发布签名、严格的三文件产物合同，以及公开仓库的独立原生验证/发布路径。真实签名 APK 已在 API 35 模拟器完成九组平台验证；设备端完整平台连接、中文 IME 和物理扫码验收的边界见 `android.md`。Relay 和原生源码将随公开仓库提交提供。

正式发布以实际 GitHub 构建、公开发布工作流和附件回读结果为准；本文不把本地测试或方案视为已发布证据。

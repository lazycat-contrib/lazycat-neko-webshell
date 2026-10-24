# 001：复用远程设备 TokenProvider，不复用用户授权结果

- 基线：`c3d51c0`，2026-10-24；P1，M，中风险；DONE，0.9.2，无依赖。
- 范围：`src/client_terminal.rs`、必要的 AppState 生命周期接入、小型独立认证缓存模块与测试；遵守 AGENTS.md，不在 main.ts 扩展逻辑。
- 不包括：更换 SDK/签名/设备认证 proto、缓存用户可见性结果、绕过 ticket、改变 terminal wire、合并 pane sockets、修改 Agent 版本、发布版本。

## 现状

`client_terminal_dial_info` 每次 authorize_client、request_terminal_ticket 后执行：

```rust
let credentials = ClientCredentials::load(CredentialPaths::runtime()).await?;
let token_provider = TokenProvider::connect(device_api_url.as_str(), credentials).await?;
let auth_token = token_provider.token().await?;
```

实际代码带 ClientTerminalError 映射与 timeout，必须保留。锁定 SDK 的 TokenProvider 为 Clone/Arc，拥有 mTLS channel、凭据和 Mutex<Option<Arc<AuthToken>>>；token() 已实现过期前刷新和 singleflight。新建 provider 会得到空缓存。不要在消费者复制 SDK 认证实现。

## 有序步骤

1. `git diff --stat c3d51c0..HEAD -- src/client_terminal.rs src/state.rs Cargo.lock`。相关行为已变化先复核。运行 README 中 7 个前端契约测试及 `cargo test --locked client_terminal::tests`，要求通过；使用仓库 rust-toolchain，不切换全局工具链。
2. 先给认证工厂建立可注入 seam 和测试 fake，记录加载凭据、connect、刷新 token 次数。沿用当前模块 tests 的 Rust 单测模式，假票据和假通道不得引用生产凭据或网络。
3. 明确 cache key：完整经验证的 device API endpoint/目标设备身份、应用凭据 generation，以及 SDK 要求的身份维度。不能仅用 hostname；不能将用户 ticket 缓存到此对象。若不能证明 token 是应用级且不会跨用户授权，停止并补规格。
4. 用有上限、可过期的 cache 复用 TokenProvider。并发首次建立必须 singleflight；创建失败不永久缓存；慢连接不能阻塞所有其他设备的全局锁。保留每次 authorize_client、ticket 获取/验证与用户 selector 检查。
5. 每次仍调用 SDK token()，不自己实现 token TTL。证书轮换、设备地址变化、注销/撤销、401/403 分开建模；最多受控失效重建，不无限重试非幂等 workspace action。
6. 补测试：同 endpoint 并发 connect 一次；不同设备/身份不复用；失败后重试；缓存淘汰；过期交给 SDK；凭据 generation 改变；无权用户即使已有热缓存仍被拒绝；取消一个请求不让共享连接初始化永久损坏。
7. 运行 `cargo test --locked client_terminal::tests`、新增缓存模块 tests、README 前端契约测试；必要的 Rust race/lifecycle 条件使用并发 fake 确认。运行仓库现有格式检查，不自动改无关文件。

## Done 与验证边界

- 热缓存时 N 个相同设备合法请求只建立一次有效 provider，且每次仍执行用户授权与票据检查；计数测试证明。
- 不输出 token、ticket、私钥或可识别终端内容，错误脱敏保持。
- 无活动请求的缓存项有数量和时间上限；错误不会造成重连风暴。
- 真机验证需单独授权：记录同目标 state/action/attach 的冷/热阶段 p50/p95 与认证连接次数；确认平台拒绝/撤权即时生效。没有设备时只能报告 mock 验证，不能声称真实链路已变快。
- 若共享 SDK 本身需要新失效接口，先在 SDK 制定最小变更，禁止在 WebShell 手写 token 认证替代。

## 执行结果

- 已实现 SDK 对象复用、并发初始化合并、失败/取消重试、有界缓存、文件 generation 检查和旧失败不误删新缓存实例。
- 额外以账号和设备 ID 隔离缓存，不依赖“所有用户可以共享同一设备 token”的假设。新请求仍执行可见性校验与 ticket 获取。
- 新增 11 项缓存/文件轮换测试；客户端终端模块新增 5 项有界写和鉴权前置测试，总计新增 16 项。缓存回归和慢消费者测试均经过 RED→GREEN。
- Ruling: 本次不实施控制面长连接、core UDS、紧凑 envelope、消费 ACK 或输出批次调优；这些变化需要真实链路性能数据和额外兼容规格，贸然并入会扩大协议或 Agent 升级风险。
- 原计划的“不发布”边界已由用户后续明确要求测试后发新版覆盖；发布版为 0.9.2，Agent 元数据保持 19/11。
- 本轮没有真实设备冷热连接数据，mock 与文件 fixture 验证不能代替设备证书轮换及 WAN 测量。

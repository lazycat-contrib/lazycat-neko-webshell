# 002：先验证交互输出与转发，再决定控制面重构

基线：`5563be5`，2026-10-24。状态：实施与本地验证完成，待发布流程核验。此前认证缓存和转发超时已落地；上游两个仅更新 Cargo.lock 的依赖补丁已保留合并。

## 本轮验证与实施顺序

1. 在修改批处理策略前，测本地真实 reader/channel 的稀疏输出延迟，保留原始结果；该数字不代表网络或实际屏幕呈现延迟。
2. 对首段/空闲后立即输出、连续输出合并、64KiB 上限、错误与 EOF 尾部、背压与 VT 字节顺序写回归测试，先观察旧实现失败，再实现。
3. 保持 binary 和 output-sequence 原有 wire 格式，测试同一输出事务只 flush 一次；在慢消费者、错误、取消与双向转发情况下验证顺序和清理。未验证前不引入新 envelope 或全 pane 复用。
4. 测量并验证控制面 bridge 的进程复用、安全回退和取消契约，只有明确支持的能力才复用。命令发送后的未知结果不得自动重放；旧 Agent 必须兼容，不能为优化强制重启会话。
5. 完整 Rust/前端/脚本测试、静态构建与独立最终复核后才提交发布。当前 v0.9.2 tag 尚未创建，不能将候选构建称为已发布。

## 不变边界

- 不修改 LightOS 授权边界，不直接调用未证实的 core 私有协议。
- 不丢弃或合并解释 VT 字节，不在 replay 回答终端查询，不引入无界队列。
- 目标内 Agent 行为或依赖变化必须提高 AGENT_VERSION；最低版本只因必要兼容修复提高，不能仅为性能强制升级。
- Restty 官方最新正式版仍为 0.3.0，不改未发布代码。

## 停止条件

如果某项方案无法证明取消后不会串响应、旧版本可回退或待处理字节有上限，保留现有行为并记录结果，不以“代码已经写完”为理由强行启用。

## 已落地与实测

- PTY 首段和闲置后输出立即发，持续输出仍按 16ms/64KiB 合并；保留有界 reader/channel、EOF/error 尾部和原始 VT 字节顺序。真实本地 UnixStream reader/channel 稀疏输出 20 次采样：修改前 median 16.179ms、p95 16.284ms；修改后 median 0.065ms、p95 0.153ms。仅是输出阶段，不是端到端回显或 WAN 提升。
- 原有 binary 与 output-sequence 分帧不变，通过 feed 后一次 flush 合并发送事务；远程 replay-tail 同样按已收集的一批发送，整批共享截止时间。真实 loopback WebSocket、flush 错误和阻塞测试通过。
- 控制面按 selector/username 复用串行 helper，不复用用户授权结果；最多 8 个 helper，每个队列 4 项，64KiB 请求准入预算，3 秒握手、8 秒请求（含排队）、30 秒空闲回收。只在 hello 支持后发送请求，旧 helper 启动失败或不支持时回退 one-shot；已发送后失败、超时或调用取消均不重放。
- helper 沿用现有 protobuf framing，每次请求仍单独连接原 daemon Unix socket，拒绝 ATTACH。bootstrap、升级检查与 ping 保持原 one-shot。Agent 为 20，最低支持仍为 11，协议仍为 v4；旧兼容会话无需为本轮优化重启。
- 同一 debug helper 在本地 mock Unix socket 上连续 100 次：one-shot 启动 100 次，median 1.611ms、p95 2.048ms；stream 启动 1 次，median 0.050ms、p95 0.057ms，首次启动 1.650ms。没有 LightOS exec/WAN 测量，不能据此宣称真实设备加速比例。
- 9 项 pool 测试覆盖并发同键单实例、身份/目标隔离、容量、取消后响应归属且不重复执行、握手与发送后阻塞的不同回退、旧 helper、空闲回收、关闭池及子进程回收、超预算不启动。
- 跳转列表以品牌/终端图标直接承载状态颜色，去掉重复的状态 glyph 和当前项勾选；保留当前项背景/ARIA，以及同名区分和紧凑模式所需序号。提醒详情与跳转行为不变，普通终端标签同步图标表达。
- 全量 Rust workspace 564 项通过，4 项 ignored（两个原有忽略与两个 binary 下的局部延迟测量）；前端 592 项、发布脚本 8 项通过。Clippy exit 0，保留既有警告，本轮新模块无 Clippy 警告。
- 浏览器 herdr-activity、herdr-notifications、program-status、workspace-sync 通过，包含真实 Agent/PTY/OSC 与桌面/375px 紧凑视口；不等于真实 LightOS 或物理手机认证。

- 最终静态 musl Agent/provider 构建通过，状态 hook、协议/版本/最低支持元数据一致性通过。静态 provider 启动后 healthz、runtime 0.9.2、嵌入 JS 和 SIGINT 优雅退出通过。
- 真实静态 helper → 本地 daemon 的同流 STATE/CREATE_TAB/RENAME_TAB/SNAPSHOT/CLOSE_TAB/EOF 测试通过；helper 正常退出不停止 daemon。静态 helper 同构建 100 次 mock 对比：one-shot median 0.632ms、p95 0.938ms、启动 100 次；stream median 0.047ms、p95 0.080ms、启动 1 次，首次启动 0.691ms。
- 独立最终只读复核无确认的发布阻断项，另独立运行 40 项定向测试通过、1 项 measurement ignored。真实 LightOS/WAN、远端 lightosctl 子进程生命周期及证书轮换尚未真机验证。

上述记录是本地候选验证，不表示商店已上架；GitHub CI/LPK 和双商店结果须在实际发布流程完成后单独核验。

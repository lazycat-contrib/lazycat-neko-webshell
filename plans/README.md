# WebShell 架构与性能审阅（2026-10-24）

审阅基线 `c3d51c00f880f91efc99077abb74ce8e86ecbc78`。优先级是优化建议，不表示已复现生产故障。用户批准后，0.9.2 落实认证对象复用和远程转发有界写；其他项目仍是测量或设计候选。

## 判断

保留 provider / 目标实例内轻量 Agent / 浏览器 renderer 的分工，也保留 Herdr 独立会话所有权。主要收益来自鉴权对象复用、控制面减少启动进程、交互批处理调优和真实全链路测量，不是整体切换 HTTP/3 或把终端搬进宿主特权进程。

```text
LightOS 目标：浏览器 WS → provider → lightosctl exec 管道 → 轻量 Agent → PTY
远程设备：浏览器 WS → provider → 平台设备鉴权 / ticket → 远端 terminal WS
Herdr：独立后端与 socket bridge，不能混同原生 Agent 协议
控制面：Connect RPC / workspace action → provider → CLI 执行 Agent request
```

## 建议排序

| 优先级 | 项目 | 证据 | 建议与风险 |
| --- | --- | --- | --- |
| P1 | 复用远程设备 TokenProvider | `src/client_terminal.rs:1224` 每次 dial 加载凭据、connect、token；锁定 `lzc-sdk 0.1.1/src/auth.rs:67` 的缓存与 singleflight 归属 TokenProvider 实例 | 见 001；缓存认证通道，不绕过逐请求用户可见性检查，不把终端 ticket 当永久通行证 |
| P1 | 控制面减少 lightosctl / Agent helper 启动 | `src/agent_client.rs:984` 每次 state/action 请求执行 lightosctl exec，protobuf 先 base64 放命令行；`src/lightos.rs:471` 授权读取 ps 也调用 CLI | 先分阶段测量；优先每目标长期控制 bridge，带 requestID、并发/超时/字节预算；数据流初期仍每 pane 独立 |
| P1/P2 | 远程 WS 转发的慢消费者截止时间 | `src/client_terminal.rs:796` 和 `:815` 直接 await send；原生路径 `src/terminal.rs:2386` 已有有界发送 | 统计阻塞与队列字节，增加可恢复的连接失败/清理策略；不能断慢浏览器时杀远端 PTY；不把 await 本身误称为无界缓存 |
| P2 | 稀疏输出低延迟 flush | `src/config.rs:27` 固定 16ms；`src/pty_io.rs:223` 首段也进入批次计时 | 对比首段立即发 + 持续输出合并，或短窗口自适应；仅解释该阶段可能等待约 16ms，不能声称端到端必快 16ms |
| P2 | 回放按时间与可见性调度 | `src/frontend/src/main.ts:536` 每 pane 128KiB 预算；`terminal-replay-controller.ts:240` 按 rAF 批处理 | 已有分批和边界保护，不重新实现；测 1/4/多窗格、后台页面、手机。writeMeasured 的同步调用时间不是 GPU 实际呈现完成时间 |
| P2/P3 | 协商式紧凑输出 envelope | `src/terminal.rs:2447` 每段 binary 输出后另发 JSON output-sequence | 若剖析确认帧/JSON开销，再协商版本将 sequence+payload 合帧，保持旧客户端与重放语义；不能把减少 WS 帧数当成相同比例的包数/带宽收益 |
| 研究项 | LightOS core UDS 直接适配器 | 近期目标设备活体验证显示 HTTP/1.1 JSON 引导后使用裸 yamux，而非 gRPC/h2c/WS；仍需逐版本复核 | 能力探测 + CLI 回退，只在合法应用身份环境内试验。inspect 路由和退出码不可沿用旧静态推断；未知 exit code 不能填 0。暂不作为默认替换 |

## 先建立全链路证据

现有默认关闭的 terminal-diagnostics 及匿名有界 trace 已实现，不建议再增加常驻面板。应在现有诊断能力上补充：

1. 连接：selector 授权、ticket、设备通道/取 token、Agent 检查、helper 启动、ready/replay 各阶段耗时。
2. 输入：发送到回显 marker 的 p50/p95/p99；不要在不同机器时钟未校准时相减计算单程耗时。
3. 输出：PTY 批次、Agent/provider/浏览器各阶段待处理字节、慢发送与序列 gap、重连/恢复次数。
4. 呈现：区分收到、交给 renderer、解析/渲染确认（若 renderer 提供）和 paint opportunity；不能把同步 write 返回当消费 ACK。
5. 场景：真机 LAN/远程、慢消费者、1/4/多 pane、350KiB replay、持续输出、断网/睡眠/多设备只读附着。

`docs/superpowers/plans/2026-09-07-terminal-output-benchmark.md` 已决定保留每 pane WS，且 loopback renderer 基准不足以支持新增 consumption ACK。本轮不推翻该结论。只有真实 provider/LightOS/Agent 链路显示 outstanding bytes 持续增长或输入被回放饿死，才考虑 generation-scoped credit/ACK。

## 不建议做

- 不把轻量 Agent 合并进完整 provider 再传到目标；继续独立协议/最低版本与内容寻址 payload。
- 不为减少连接数先把所有 pane 强行复用一个 WS；未证明收益前不要扩大故障范围和跨 pane 排队。
- 不把 Cloudflare tunnel 使用的 QUIC/Cap'n Proto 依赖当成终端已具备 WebTransport 支持。
- 不无条件扩大 16MiB/pane 历史上限，也不为图省事丢弃任意 VT 字节；多个 pane 需要总预算与明确 gap 恢复。
- 不在 replay 重跑探测或回答终端查询；保留目标端唯一 reply authority 和原生 OSC 优先级。

## 审阅阶段验证（实施前）

7 个相关前端 test 文件合计 30/30 通过：replay buffer/controller/cursor、protocol、performance、remote-client-terminal、diagnostics trace。命令：

```sh
mise exec node@24 -- node --test src/frontend/src/terminal-replay-buffer.test.mjs src/frontend/src/terminal-replay-controller.test.mjs src/frontend/src/terminal-replay-cursor.test.mjs src/frontend/src/diagnostics/terminal-trace.test.mjs src/frontend/src/terminal-protocol.test.mjs src/frontend/src/terminal-performance.test.mjs src/frontend/src/remote-client-terminal.test.mjs
```

未重跑完整 Rust 构建、未连接生产实例、未运行真实网络或浏览器性能基准。本文没有宣称固定性能提升百分比。

## 执行索引

| 计划 | 依赖 | 状态 |
| --- | --- | --- |
| [001 认证对象复用](001-reuse-device-token-provider.md) | 无；先建立 fake 与计数基线 | DONE，0.9.2 |

其他建议保留为后续测量/设计候选，没有创建公开 issue。0.9.2 未修改 Agent 的协议、版本或最低兼容版本，也未调整 PTY 的 16ms 批次窗口。

## 0.9.2 执行记录

- `src/client_terminal_auth.rs` 按账号、设备 ID、完整认证端点和三个凭据文件的 generation 缓存 SDK TokenProvider；最多 32 项，5 分钟闲置项在访问时清理。应用状态销毁时释放缓存，不新增后台清理任务。
- 网络连接初始化不持有全局缓存锁；同键并发只初始化一次，失败或取消后可以重试。读取凭据前后核对 generation，轮换期间失败而不缓存混合材料。
- 每个请求仍检查账号与设备可见性，并重新获取和验证终端 ticket。SDK 继续负责 token 刷新；401 仅移除相同缓存实例，不自动重放操作，403 不清除应用级认证通道。
- 双向 WebSocket 转发、Herdr 引导写入和连接失败通知均使用 10 秒写截止时间，包括共享 writer 锁等待。超时结束连接而不调用远端会话关闭接口。
- 认证缓存的并发复用/取消回归先观察到失败，再实现并通过；模拟慢消费者测试先因超过 deadline 失败，再加入 timeout 并通过。
- 本地完整 Rust workspace 测试 541 项通过，另有 2 项既有忽略；前端 588 项和发布脚本 8 项测试通过。独立只读复核没有发现确认的阻断问题。
- 真实设备证书轮换、LAN/WAN 延迟、实际远端终端重连仍需设备回归；不宣称固定百分比的性能提升。
- 另按用户要求检查前端终端库：2026-10-24 官方 npm registry 的 latest 与上游 GitHub 最新正式发布均为 Restty 0.3.0，项目已锁定此版本；内嵌 1,058,249 字节 WASM 与安装包提取结果一致，因此没有为了“更新”切换未发布提交。


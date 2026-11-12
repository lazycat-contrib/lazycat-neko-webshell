# Remoted Relay 0.2.0 · v2

这是应用自有的 Cloudflare Worker Relay，入口为 `src/worker.mjs`。`TUNNELS` 绑定 `Tunnel`，每个 route 一个 Durable Object；`ADMISSION` 绑定单个全局连接准入对象 `Admission`。`wrangler.jsonc` 已包含两个 SQLite 类的 `v1` migration。

本目录实现 **v2 only**：路径 `/v2/...`，WebSocket 子协议 `neko.remoted.v2`，逐帧精确 ACK，无 v1 回退。升级 v2 时需要同时更新主机和原生客户端；0.1.2 及更早的 Relay 使用 v1。部署状态以实例根路径的实际响应为准。

部署步骤、版本核对、协议、限额和关闭竞争说明均见 [DEPLOY.md](DEPLOY.md)，本目录可独立部署。

部署前必须验证 provider、shared protocol、native client/network worker 均使用 v2，由主控统一部署。以下命令只做本地验证与打包检查，不部署：

```bash
npm ci
npm test
npm run test:integration
npm run check
```

`check` 是部署 dry run，不代表远端运行验证。已有 `v1` migration tag 是 Durable Object 存储迁移身份，不应随传输协议版本改名。

## 版本诊断

`GET /` 返回 `application/json`，设置 `Cache-Control: no-store`：

```json
{
  "service": "neko-remoted-relay",
  "package_version": "0.2.0",
  "relay_protocol": "neko.remoted.v2",
  "protocol_version": 2,
  "build_commit": "unknown",
  "build_time": "unknown"
}
```

`service` 与 `package_version` 从 `package.json` 单一来源读取。部署时通过 Worker bindings `RELAY_BUILD_COMMIT`、`RELAY_BUILD_TIME` 提供实际 commit 和构建时间；缺失、空白或非字符串时返回 `unknown`。响应不含设备、route、credential 或终端数据。根路径带非空 query 返回 404；非 GET（包括 HEAD）返回 405，错误响应同样为 JSON、`no-store`。

`GET /healthz` 不带 query 时返回 `{"protocol":"neko.remoted.v2","version":2}`，HTTP 响应设置 `no-store`。WebSocket 健康检查要求 v2 子协议，发送相同结构的一帧后以 1000 关闭。health 只检查 Relay 协议，不验证主机在线或端到端授权；部署后应同时读回根路径的实际构建信息。

## 路由与认证

| 请求 | 条件 |
| --- | --- |
| `GET /` | 不带 query；返回 package、协议与构建信息 |
| `GET /healthz` | 不带 query；返回协议版本 |
| `GET /v2/host/<route>` | WebSocket；`Sec-WebSocket-Protocol: neko.remoted.v2`；`Authorization: Bearer <routing_secret>` |
| `GET /v2/client/<route>` | WebSocket；相同子协议；该 route 的主机必须在线，peer 数小于 16 |

v1 路由返回 404，旧子协议返回 400，不自动降级。

`route` 是原始 32 字节 routing secret 的 SHA-256，二者都采用无 padding 的规范 base64url 编码（43 字符）。不是对 secret 的 base64url 文本做 hash。主机必须持有 secret 才能接管该 route；客户端没有此凭据。可选 `REGISTRATION_KEY` 仅在 route 首次注册时检查 `x-remoted-registration-key`，主机通过可选的 `registrationKey` 配置发送该头，具体设置方式见部署指南。

Relay 处理明文路由元数据、握手控制帧与 Noise 密文，不拥有设备审批权。它能看见 IP、route、主机 routing secret、连接关系、消息大小和时序；不能将它描述为不接触任何秘密或完全看不见元数据的服务。

## 逐帧精确 ACK 与背压

每条转发的 data 帧获得接收 socket 独立分配的正安全整数 `sequence`。接收方消费该帧后，发送仅含以下三个字段的 ACK：

```json
{"type":"acknowledge","peer":"host","sequence":9}
```

host 的 ACK `peer` 必须为 `host`；client 的 ACK `peer` 必须为 Relay 分配给它的 UUID。token 必须是当前接收 socket 已发放的正安全整数（`0 < sequence <= sent`）。若 token 仍在 `pending`，ACK 只删除对应条目，向该帧原始发送方归还一个 credit（`delivered.count = 1`），不累计确认更早的帧，也不归还其他 peer 的 credit。例如 slow 的 1–8 尚未消费，fast 的 9 已消费：ACK 9 只释放 fast 的一个 credit；之后仍可独立 ACK 3。已消费或因 peer 关闭而退休的 token 再次 ACK 为幂等 no-op，不发送额外 `delivered`，不修改其他 pending 或 credit。

错误 peer、未来或非法 token，以及额外字段均使 ACK 发送方以 1008 关闭。窗口按 `pending.size` 计算：单 client 上行 8、host 聚合 `16 × 8 = 128`、每个下游 client 8。peer 关闭会从 host pending 清理该来源的 token；send 失败回滚并清理失败目标。慢下游 client 被隔离，host 与其他 client 继续工作。host 入站聚合帧率仍为每秒 256，所有 ACK（包括 no-op）及 control 也计入。

peer 关闭与 host inbox 消费/Receipt 释放可能交叉。退休 token 的迟到 ACK 安全忽略，因此 A 关闭后，ACK A 的旧 token 不会关闭 host，也不会给 B 归还 credit。socket 内 token 单调递增且不复用，仅需 `sent` 与有界 `pending`，无需保存 tombstone 集合；旧连接仍受 generation 与 socket 身份检查约束。详见 [精确 ACK 协议](DEPLOY.md#精确-ack-与-credit-不变量)。ACK 只确认该帧消费，不保证业务执行成功、持久化或端到端 exactly-once。

## 本地验证

```bash
npm ci
npm test
npm run test:integration
```

`npm test` 运行 `test/*.test.mjs` 的 authority、精确 ACK、版本诊断测试。`npm run test:integration` 自动选择本地空闲端口，启动隔离的 Wrangler/workerd 实例，等待 v2 健康检查通过，再运行 `test/runtime.mjs`，结束后关闭实例；无需手动启动开发服务器。集成测试的本地持久化目录为 `.wrangler/integration`。

真实 WebSocket/DO 集成测试覆盖跨 peer 乱序精确 ACK、关闭清理后 16×8 窗口、A 关闭后迟到 ACK 不影响 host/B、下游乱序额度恢复、慢客户端隔离、重复 ACK 幂等无额外 credit、错误 peer/未来 ACK 拒绝、错误凭据拒绝、host 替换后的 generation 清理、主机离线，以及根路径 metadata 和 HTTP/WS health。单元测试另覆盖 send 失败回滚、credit 隔离、构建 bindings 和 host 聚合帧率预算。

自动命令会为测试设置本地 `REMOTED_TEST_RELAY`，不会使用外部同名环境变量指定的生产 Relay。应用的 Relay 地址解析仍要求 HTTPS/WSS，本地 HTTP 测试并不代表应用允许不安全连接。

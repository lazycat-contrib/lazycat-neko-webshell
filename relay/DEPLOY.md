# Cloudflare Remoted Relay v3 部署说明

本目录包含可独立部署的 Cloudflare Worker 与 SQLite Durable Objects。需要可使用 Workers 和 Durable Objects 的 Cloudflare 账号、Node.js 24 和 npm。原生应用与 WebShell 主机均主动向 Relay 建立出站 WSS 连接，Relay 只转发连接控制、会话密文与加密信令。

## 部署

从公开仓库克隆后进入 `relay/`；私有源码仓库对应目录为 `remoted/relay/`：

```sh
npm ci
npx wrangler login
npx wrangler whoami
npm test
npm run test:integration
npm run check
npx wrangler deploy \
  --var RELAY_BUILD_COMMIT:$(git rev-parse HEAD) \
  --var RELAY_BUILD_TIME:$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

首次部署按 `wrangler.jsonc` 创建 `Tunnel` 和 `Admission` 两个 SQLite Durable Object 类。已有部署保持原 migration tag `v1`，不要因为传输升级为 v3 就重写已应用的存储迁移。

部署后会得到 Workers 地址；自定义域名可在 Cloudflare Worker 的 Domains & Routes 中添加，并指向同一个 Worker。`https://neko-relay.czyt.eu.org` 是现有公共实例。两端配置相同 HTTPS/WSS origin，不附带 `/v3` 或 `/healthz` 路径。先在主机设置中保存 Relay 地址、开启远程控制并确认在线，再生成设备码。在客户端填写同一地址后扫码或输入设备码，最后由主机核对指纹、选择资源和只读／可操作权限并批准。

```sh
curl -fsS https://你的域名/
curl -fsS https://你的域名/healthz
```

根路径应显示本次提交与构建时间，health 应显示 v3。健康检查只说明中转可用，不代表某个主机已在线或设备已获授权。旧协议客户端无法连接 v3；部署升级应与新版主机和客户端协调。

首次主机注册可选部署级 `REGISTRATION_KEY`（`npx wrangler secret put REGISTRATION_KEY`）。启用后首次注册需要主机支持并配置同一注册密钥。此密钥不代替设备的端到端身份验证和主机审批。保留默认关闭的 observability，不在日志中记录设备码、routing secret、授权头或终端内容。

本实现使用非休眠 WebSocket。长连接和 Durable Object 会产生平台计费；请按账号套餐确认额度和费用，并按实际访问需求配置域名及注册限制。下文列出内置的连接、帧率和缓冲限制。

## 版本诊断

`GET /` 返回 `application/json`，并设置 `Cache-Control: no-store`：

```json
{
  "service": "neko-remoted-relay",
  "package_version": "0.3.0",
  "relay_protocol": "neko.remoted.v3",
  "protocol_version": 3,
  "build_commit": "unknown",
  "build_time": "unknown"
}
```

`service`、`package_version` 直接来自 ESM 导入的 `package.json`，没有另一份
手写版本常量。部署者通过 Worker bindings `RELAY_BUILD_COMMIT`、
`RELAY_BUILD_TIME` 提供本次实际源码 commit 和实际构建时间；缺失、空值或
非字符串返回 `unknown`，不会根据请求时间或运行环境编造。部署后由主控
对真实根路径读回并核对这两个字段。响应仅包含上述六个字段，不访问
Durable Object，也不返回设备、route、routing secret、注册凭据或终端数据。

根路径带非空 query 返回 JSON 404；GET 以外的方法（包括 HEAD）返回 JSON
405。本版本不实现 HEAD。错误响应同样设置 `no-store`，不会回显请求内容。

`GET /healthz` 保留客户端协议检查的最小结构：

```json
{"protocol":"neko.remoted.v3","version":3}
```

HTTP 响应也设置 `no-store`。WebSocket 健康检查要求 v3 子协议，返回相同
结构的一帧，然后以 1000 关闭。它只证明 Relay 协议在线，不证明 host 在线
或设备已授权。根路径包含 package/build 诊断信息，health 不包含这些额外字段。

## 接入

| 入口 | 要求 |
| --- | --- |
| `/v3/host/<route>` | GET WebSocket，`Sec-WebSocket-Protocol: neko.remoted.v3`，有效 host Bearer credential |
| `/v3/client/<route>` | GET WebSocket，同一子协议，host 已在线，peer 数小于 16 |

v1/v2 路由返回 404，旧子协议返回 400；没有版本探测回退。route 仍是 32 字节
routing secret 的 SHA-256，以无 padding 的规范 base64url 编码。鉴权仍在
入口与 Tunnel authority 两处检查。首次注册的 `REGISTRATION_KEY` 约束保留。
连接准入对象名称保留 `admission-v2`；不需要创建新的 Durable Object 类。
已有 `wrangler.jsonc` 的 migration tag `v1` 是存储迁移身份，不是传输协议
版本，不能仅为协议升级重写已经应用的 migration。

## 精确 ACK 与 credit 不变量

Relay 为每个接收方 WebSocket 独立分配单调递增的正安全整数 `sequence`。
它是这一条 data 帧的精确 token，不是累计 offset。hello/control 不分配 token。
token 只对当前接收 socket 和 generation 有效；接收方必须在消费对应帧后
才发送 ACK，不能因另一帧已经消费而确认未消费的帧。

```json
{"type":"acknowledge","peer":"host","sequence":9}
```

host 的 ACK `peer` 必须等于 `host`。client 的 ACK `peer` 必须等于 Relay 为
该 client 分配的连接 UUID。ACK 只允许 `type`、`peer`、`sequence` 三个字段，
要求 token 是当前接收 socket 已发放的正安全整数：`0 < sequence <= sent`。
缺失字段、错误 peer、额外字段、未来 token、非正数、非安全整数均拒绝并
关闭 ACK 发送方，代码 1008。host 连接关闭时其 clients 也会关闭；错误
client ACK 只关闭该 client。允许 ACK 9 后 ACK 3，分别独立处理。

ACK 幂等：token 仍在 `pending` map 才产生以下 credit 变更；已消费或因
peer 关闭而退休的 token 不在 pending，直接 no-op，不发送 `delivered`，
不修改其他 token、inflight 或 credit。重复 ACK 不会再次归还 credit。

每个 pending 条目保存原始发送连接。命中 pending 的 ACK 只执行以下动作：

1. 删除这个 token 对应的唯一条目。
2. 若原始发送方是 client，只减少该 client 的一个 `inflight`。
3. 向原始发送方发送一条 `delivered`，`peer` 指向该 client，`count` 恒为 1。

例如 slow 发出的 1–8 尚未消费，fast 发出的 9 已消费：host ACK 9 只会给
fast 返回一个 credit。slow 的八个 token 和八个 inflight 全部保留；之后
ACK 3 才能给 slow 返回一个 credit。ACK 不是业务操作成功、持久化、Noise
认证或端到端 exactly-once 执行保证，重连也不会把 Relay 变成持久消息日志。

窗口由 `pending.size` 决定，绝不使用 `sent - acknowledged`：

- 每个 client 到 host 至多八条未消费 data，彼此隔离。
- host 的聚合 pending 上限为 `MAX_PEERS * 8 = 128`，容纳全部 16 个 peer。
- 每个下游 client 的 pending 上限为八条；第九条使这个慢 client 关闭，
  host 和其他 client 继续工作。
- 发送失败会回滚本次 pending/inflight 预留，并清理失败的目标连接。
  尝试过的 token 不复用；关闭目标会清理它持有的剩余 pending。
- client 的远端关闭、host 主动关闭、超限拒绝和 send 失败均走同一清理路径：
  删除该连接，并从 host.pending 中移除所有来源恰为该连接的条目。
  不给其他 peer 发 credit，也不留下幽灵槽位。host 替换清空旧代状态；
  旧代 close 回调不能清理新 host。

关闭与 ACK 在异步网络中可能交叉：client 关闭后，host 之前已收到但尚未
确认的该 client token 会立即退休。host bounded inbox 中的消费、Receipt
Drop/dequeue 或在途 ACK 仍可能随后确认它；这些 ACK 按已发放 token 的
幂等规则安全忽略，不会关闭 host，也不会归还其他 peer 的 credit。
每个 socket 内 token 单调递增且不复用，所以 `sent` 足以限定已发放范围，
仅需有界 pending，无需 tombstone 集合。重连后的 socket 和 generation
隔离仍保留，旧连接消息不能操作新代 token。回归覆盖 A 发八帧未消费后
关闭、B 发满八帧，再 ACK A 的全部旧 token：host 存活、B 仍占八个 credit；
之后独立 ACK B 的一帧才归还一个 credit，B 可继续发送。

## 限额评估

保留每 socket 每秒 256 帧、单帧 98,304 UTF-8 字节、缓冲量 512 KiB 的
现有限额。host 的 256 是所有 peer 聚合后，由 host **发送给 Relay** 的
data/ACK/control 总数（包括 no-op ACK）；Relay 发给 host 的数据不重复记入这个计数。
unit fixture 验证同一秒内 host 的 128 条 data 与 128 条精确 ACK 可以共存。
额外 heartbeat/control 仍占额度。这不是每 peer 256，也不是吞吐保证；
没有实际负载测量证据前不扩大限额。窗口负责内存与背压隔离，帧率限额
负责入站请求预算，二者作用不同。

## 本地验证

```sh
cd remoted/relay
npm test
npm run test:integration
```

集成命令选择本机空闲端口，启动本地 Wrangler/workerd + 真实 WebSocket/DO，
检查 v3 readiness，运行测试并关闭该实例；持久化目录仅为本地
`.wrangler/integration`。它不会连接公共 Relay，也不执行 deploy。
覆盖跨 peer 乱序消费、16×8 host 窗口/关闭清理、A 关闭后迟到 ACK 隔离、
反序下游 ACK、慢 client 隔离、重复 ACK 幂等、错误 peer/未来 ACK 拒绝、
host 替换、根路径和 HTTP/WS health。
单元测试另覆盖模拟 send 失败、精确 credit 不变量及传入 build bindings。

取消竞争修复的红测记录为 `/tmp/neko-relay-v3-idempotent-red.log`（三个
单元回归失败）与 `/tmp/neko-relay-v3-idempotent-integration-red.log`（两个
真实集成回归失败）；修复后结果记录在同名前缀的 `unit.log`、`integration.log`。

私有 package 版本已设为 0.2.0。本次限定写集不含 `package-lock.json`、
其他部署文档或公共仓库；主控在统一发布时同步 lockfile 根版本和其余
文档，并验证所有客户端协议，再设置真实构建 bindings、部署及线上读回。

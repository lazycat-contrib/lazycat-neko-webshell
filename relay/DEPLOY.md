# 在 Cloudflare 部署 Remoted Relay

本指南对应 `relay/src/worker.mjs`、`wrangler.jsonc` 与当前主机实现。Relay 是 Cloudflare Worker + SQLite Durable Objects，不是 Cloudflare Tunnel，也不需要运行 cloudflared。部署 Worker 只完成中转服务，之后还需手动配置 WebShell 和原生客户端。

## 1. 准备并部署

需要 Cloudflare 账号、可创建 SQLite Durable Objects 的 Workers 方案，以及能运行仓库锁定 Wrangler 的 Node.js/npm。仓库的现有 CI 使用 Node.js 24；Relay 的 lockfile 锁定 Wrangler，使用 `npm ci`，不要依赖机器上另装的全局版本。

从仓库根目录执行：

```bash
cd relay
npm ci
npm test
npm run test:integration
npx wrangler login
npm run check
npm run deploy
```

在自己的账号中确认 `wrangler.jsonc` 的 Worker 名称 `neko-remoted-relay` 可用。多账号时明确选择要部署的账号，例如设置 `CLOUDFLARE_ACCOUNT_ID`。自动化部署可使用权限足够且范围受限的 `CLOUDFLARE_API_TOKEN` 替代交互登录；不要提交 token。

保留 `TUNNELS` / `Tunnel`、`ADMISSION` / `Admission` 绑定，以及现有 `v1` SQLite migration；不要因重新部署而改写已应用 migration 的含义。`npm run test:integration` 自动启动隔离的本地 workerd，运行真实 WebSocket/DO 集成测试并关闭实例，覆盖连接隔离、host 替换、离线错误、ACK 额度恢复、慢客户端隔离及未认证 peer 洪泛隔离等行为，无需另开终端启动服务。`npm run check` 执行 `wrangler deploy --dry-run`，`npm run deploy` 才会部署到 Cloudflare。

使用部署输出中真实的 HTTPS origin。可先使用 Cloudflare 分配的 workers.dev 域名，也可在 Cloudflare 配置自有域名。下面通过交互输入实际地址，避免把示例域名误当成公共服务：

```bash
read -r -p 'Relay HTTPS origin: ' RELAY_ORIGIN
curl --fail --show-error --silent "${RELAY_ORIGIN%/}/healthz"
```

预期 JSON：

```json
{"protocol":"neko.remoted.v1","version":1}
```

Web 设置在启用前会通过同一个 `/healthz` 入口进行 WebSocket 健康检查，子协议为 `neko.remoted.v1`；收到版本响应后立即关闭，不创建主机或设备连接。若更新小橘后出现健康检查失败，请先同步部署本仓库的 Relay 版本。关闭远程控制不要求 Relay 在线。

此检查只证明 Worker 入口可访问。还需用实际应用验证 WebSocket、主机注册、Noise 配对与权限；HTML 登录页、反向代理挑战或无法透传升级请求的代理都不能替代此协议。

## 2. 手动配置两端

1. 在具备 LightOS 认证与归属查询能力的小橘终端部署中，以部署所有者身份打开远程控制设置，填写刚部署的 Relay origin 并启用。等待主机状态变为在线。
2. 在原生客户端单独填写相同 Relay origin。允许 `https://` 或 `wss://`，内部规范为 `wss://`。仅允许 origin，可带端口，不允许账号密码、子路径、query 或 fragment；不要填写 `/healthz` 或 `/v1/host/...`。
3. 主机在线后生成设备码，在客户端手动输入。设备码绑定 Relay 地址，不能从码中自动切换 Relay；域名或端口不同也会导致绑定不符。扫码是否可用取决于平台适配和实际设备验证，手动输入是独立流程。
4. 设备码有效期为 300 秒；生成新码会替换当前邀请。客户端发起配对后，主机端待审批请求有效期为 120 秒。核对设备名称、身份指纹和客户端展示的主机身份，再选择会话与只读/可操作权限并批准。
5. 用只读设备检查资源列表和终端输出，再按需验证写权限、文件根目录限制与撤销。已绑定设备使用保存的身份重连，不重复使用设备码。

更换 Relay 前必须移除已绑定设备，随后重新配对。保留主机持久化数据才能保留 routing secret、身份和设备授权；更换身份或丢失客户端密钥不能靠复制旧设备码恢复信任。

主机要求平台权威确认当前部署和目标归属。支持范围限于获批的现有 `webshell`、`ssh`、`herdr`、`hc`、`zellij` 会话。物理客户端的短期票据目标和 MicroVM 不受支持；不能把 Relay 当成绕过平台认证、任意 SSH 跳板或任意 Herdr RPC 代理。实际能力及权限以主机设置中明确授权的资源为准。

## 3. 可选的新主机注册 key

默认不设置 `REGISTRATION_KEY`。主机自行生成并持久化独立 32 字节 routing secret，每次注册都发送：

```http
GET /v1/host/<route> HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: neko.remoted.v1
Authorization: Bearer <routing_secret>
```

其中 `<route>` 和 `<routing_secret>` 是应用实际生成的值。WebSocket 库还会生成标准握手头；不能用普通 curl GET 代替完整握手。Worker 先验证 `SHA256(decode_base64url(routing_secret)) == decode_base64url(route)`，再允许注册或替换 host。

若需要限制全新 route 的登记，可在本目录通过交互方式设置 Worker secret：

```bash
npx wrangler secret put REGISTRATION_KEY
```

此时首次注册还必须带精确的额外请求头：

```http
x-remoted-registration-key: <部署时设置的 REGISTRATION_KEY>
```

主机 `configure` 操作接受可选 `registrationKey`，保存后由 `src/remoted/relay.rs` 注入上述头。值最多 256 字节，只允许不含控制字符的 ASCII 文本；建议使用随机生成的高熵值。字段省略或为 `null` 表示保留原值，空字符串表示清除；查询仅返回 `has_registration_key`，不回传密钥。不要把 key 放进 Relay URL、设备码或客户端设置。

配置 API 的调用示例：在**已认证的 WebShell 页面**开发者控制台执行下面的同源请求。两个输入框分别填写实际 Relay origin 和与 Worker 一致的 key；这会保存配置并启用远程控制。不要将实际 key 粘贴到共享脚本、聊天或截图中。

```javascript
const relay = prompt('Relay HTTPS/WSS origin');
const registrationKey = prompt('Relay registration key（空字符串清除）');
if (relay !== null && registrationKey !== null) {
  const response = await fetch(new URL('./api/remoted', window.location.href), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Neko-Remoted-Request': '1',
    },
    body: JSON.stringify({ action: 'configure', enabled: true, relay, registrationKey }),
  });
  if (!response.ok) throw new Error(`配置失败：HTTP ${response.status}`);
}
```

此请求仍依赖平台为当前认证会话注入 `X-HC-User-ID` 与 `X-HC-User-Ticket`，并通过部署所有者校验；不要手动伪造或复制这些头。Worker 设置了 `REGISTRATION_KEY` 时，主机需配置相同值；首次注册缺少该头或值不匹配会得到 `403 REGISTRATION_DENIED`。

`Tunnel` 将 `registered=true` 写入持久存储。此 key 只限制首次登记，不检查已登记 route 的重连；轮换它不会撤销既有 route、设备或 routing secret。它也不限制 client 连接，不能代替设备配对或防护全部滥用。如误启用，可执行 `npx wrangler secret delete REGISTRATION_KEY`，然后等待主机重试连接。

## 4. 生命周期与费用

当前代码调用 `socket.accept()`，将连接保存在 DO 内存中，并通过标准 WebSocket 事件监听器转发；**没有使用 Durable Object WebSocket Hibernation API**。在线主机即使没有客户端，也会保持 socket 并发送心跳。不要把“没有终端操作”等同于“没有 duration 用量”。

Cloudflare 对标准 WebSocket API 的 Durable Object 活跃时长有相应计费规则；持续连接可持续产生 duration 用量。还需考虑 Worker/DO 请求、消息和存储等方案规则。免费额度、上限与单价以 Cloudflare 当前账号和官方说明为准，不承诺免费常驻，也不把休眠 API 的节省效果套用于此实现。上线前设置用量通知并观察低流量下的 duration；每个常在线 route 都需要纳入估算。

参考 Cloudflare 官方文档：[Durable Objects 计费](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[WebSocket 最佳实践与 Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。

连接丢失、DO 重建或部署导致 socket 关闭时，旧 Noise 会话结束，必须重新连接并握手。主机每 10 秒发心跳，30 秒无响应视为离线，失败后以 1–30 秒退避并带抖动重试。新的有效 host 注册会替换同 route 旧 host，关闭全部旧 peer；旧连接的 close 不应清理新 generation。Relay 不保存离线业务消息，也不提供输出 replay；底层终端是否仍存在由主机及其后端决定，不能承诺网络重连后无损回放。

## 5. 当前限额与安全边界

| 边界 | 当前代码行为 |
| --- | --- |
| 每 route 客户端连接 | 最多 16 个 peer；不含 host |
| 主机设备 / 待审批 | 最多 32 个已绑定设备 / 8 个待审批请求 |
| 连接准入 | 每来源 IP、每分钟 host 30 次，client 60 次；在分配 route DO 前检查 |
| 准入计数表 | 单个全局 Admission 对象，最多 4096 个 role/IP key；内存窗口，不是持久全局配额 |
| 帧速率 | 每条 socket 每秒最多 256 个收到的消息，包含控制帧 |
| Relay 消息 | 文本 JSON 最多 98,304 UTF-8 字节（同时限制字符串长度）；data 字段最长 81,944 个 ASCII 字符 |
| 协议载荷 | 明文最多 61,440 字节，密文最多 61,456 字节；应用 WebSocket 消息上限 98,304 字节 |
| 背压 | `bufferedAmount` 大于 512 KiB 时拒绝；未 ACK 的 data 对 client 最多 8 条、对 host 最多 64 条；每个来源 client 还单独限制最多 8 条 |

超限连接会被拒绝或关闭，不保证排队重试。上述是代码内限额，不是 Cloudflare 账单上限，也不是对分布式攻击的完整防护；匿名 client 尝试、准入 DO 和被拒请求仍可能消耗资源。自建者须控制 Relay 分享范围，并按实际流量配置平台侧防护。

配对使用 `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`，已配对连接使用 `Noise_IK_25519_ChaChaPoly_BLAKE2s`。Relay 能看到 IP、route、routing secret、连接关系、消息大小与时序，以及明文控制帧；终端和文件业务内容由两端加密。Relay 持有 routing secret 不等于持有设备身份，但仍能阻断、替换连接或观察元数据。部署者应保护 Cloudflare 账号、TLS、主机持久化数据和客户端密钥，不记录设备码、密钥、Authorization 或平台票据。当前 Wrangler 配置关闭 observability；以后开启日志时也须维持这一边界。

## 6. 故障排查

| 现象 | 检查方向 |
| --- | --- |
| `404 NOT_FOUND` | 路径、route 规范编码；接口禁止 query |
| `426 WEBSOCKET_REQUIRED` / `400 PROTOCOL_REQUIRED` | 是否正确执行 WebSocket 升级及发送 `neko.remoted.v1` 子协议 |
| `401 BAD_HOST_CREDENTIAL` | host 的 routing secret 是否与 route 匹配；不要把设备码当 Bearer token |
| `403 REGISTRATION_DENIED` | 是否误设 `REGISTRATION_KEY`，以及主机是否具备额外头支持 |
| `503 HOST_OFFLINE` | 当前 route 的主机未连上；healthz 正常也可能出现 |
| `429 RATE_LIMITED` / `PEER_LIMIT` | 来源连接频率、Admission 容量或 route 的客户端数 |
| WebSocket close `1008` | 无效帧、速率或背压限制 |
| close `1012` / `4000` | host 离线/重连或被新 host 替换，旧会话需重握手 |
| 配对或资源授权被拒 | 地址绑定、邀请/审批过期、设备撤销、平台归属查询或目标身份变化；不要通过放宽认证解决 |

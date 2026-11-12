# Remoted Relay

这是应用自有的 Cloudflare Worker Relay，入口为 `src/worker.mjs`。`TUNNELS` 绑定 `Tunnel`，每个 route 一个 Durable Object；`ADMISSION` 绑定单个全局连接准入对象 `Admission`。`wrangler.jsonc` 已包含两个 SQLite 类的 `v1` migration。

完整中文操作步骤、费用、注册限制及两端配对见 [Cloudflare 部署指南](DEPLOY.md)。从本目录部署：

```bash
npm ci
npx wrangler login
npm run check
npm run deploy
```

`check` 是部署 dry run，不代表远端运行验证。部署后访问实际域名的 `/healthz`，预期为 `{"protocol":"neko.remoted.v1","version":1}`；健康检查不验证主机在线或端到端授权。

## 路由与认证

| 请求 | 条件 |
| --- | --- |
| `GET /healthz` | 不带 query；返回协议版本 |
| `GET /v1/host/<route>` | WebSocket；`Sec-WebSocket-Protocol: neko.remoted.v1`；`Authorization: Bearer <routing_secret>` |
| `GET /v1/client/<route>` | WebSocket；相同子协议；该 route 的主机必须在线 |

`route` 是原始 32 字节 routing secret 的 SHA-256，二者都采用无 padding 的规范 base64url 编码（43 字符）。不是对 secret 的 base64url 文本做 hash。主机必须持有 secret 才能接管该 route；客户端没有此凭据。可选 `REGISTRATION_KEY` 仅在 route 首次注册时检查 `x-remoted-registration-key`，主机通过可选的 `registrationKey` 配置发送该头，具体设置方式见部署指南。

Relay 处理明文路由元数据、握手控制帧与 Noise 密文，不拥有设备审批权。它能看见 IP、route、主机 routing secret、连接关系、消息大小和时序；不能将它描述为不接触任何秘密或完全看不见元数据的服务。

## 本地验证

```bash
npm ci
npm test
npm run test:integration
```

`npm test` 运行 `test/*.test.mjs` 的 authority 测试。`npm run test:integration` 自动选择本地空闲端口，启动隔离的 Wrangler/workerd 实例，等待健康检查通过，再运行 `test/runtime.mjs`，结束后关闭实例；无需手动启动开发服务器。集成测试的本地持久化目录为 `.wrangler/integration`。

真实 WebSocket/DO 集成测试覆盖多客户端隔离、错误凭据拒绝、host 替换后的 generation 清理、主机离线错误、ACK 额度恢复、慢客户端隔离、无效累计 ACK 的发送者隔离，以及未认证 peer 洪泛时的连接隔离回归。

自动命令会为测试设置本地 `REMOTED_TEST_RELAY`，不会使用外部同名环境变量指定的生产 Relay。应用的 Relay 地址解析仍要求 HTTPS/WSS，本地 HTTP 测试并不代表应用允许不安全连接。

## 版本诊断

`GET /` 返回 JSON：`service`、`package_version`、`relay_protocol`、`protocol_version`、`build_commit`、`build_time`。响应设置 `Cache-Control: no-store`，不包含设备、路由或凭据。版本来自 `package.json`；构建信息由部署时注入，未配置时显示 `unknown`。`GET /healthz` 保持协议健康检查。

部署应在已提交且干净的 Relay 源码上执行，填写该源码的完整 commit 和实际 UTC 构建时间：

```bash
npx wrangler deploy --var RELAY_BUILD_COMMIT:<完整commit> --var RELAY_BUILD_TIME:<UTC时间>
```

后续手动部署也应传入这两个参数，以便根路径准确标识部署源码；缺失时会明确显示 `unknown`。

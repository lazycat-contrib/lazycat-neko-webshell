# 小橘远程协议 v1

本协议用于小橘主机与原生客户端间的远程终端、Herdr 和文件操作。它使用独立的应用消息封装，不声称与 TMP `tmp.pb.v1` 或 Alma Relay 的线协议兼容。共享类型及严格解析器位于 `protocol/src`；线上兼容判断以类型、常量与测试为准。

## 连接与路由

两端先手动配置同一个 HTTPS/WSS **origin**。拒绝 HTTP、用户信息、路径、查询和 fragment。HTTPS 与 WSS 规范化为同一个 WSS origin，不从设备码自动切换中转。

主机独立生成 32 字节 routing secret；route 为该 secret 的 SHA-256 完整摘要。所有二进制字段使用不带 padding 的规范 base64url。主机连接 `wss://<origin>/v1/host/<route>`，在 Authorization 中携带 `Bearer <routing-secret>`；客户端连接 `/v1/client/<route>`。双方必须协商 WebSocket 子协议 `neko.remoted.v1`。Worker 每次注册或替换主机均重新验证 secret，错误凭据不能踢下现有主机。可选部署级 registration key 只限制首次注册，不参与设备认证。

Relay 可看到路由凭据、连接元数据、流量大小和握手/密文，不保存应用私钥、邀请 PSK 或懒猫用户票据。TLS 信任中转服务，但中转不能代替主机批准设备；已绑定客户端使用钉住的 Noise 主机公钥重连。

Worker 为每个客户端分配连接级 UUID，发送 `connected` 给客户端及 `opened` 给主机。客户端发送 `hello`，mode 为 `pair` 或 `connect`。Worker 使用实际连接替换所有客户端声明的 peer；peer 不是已认证设备身份。主机替换使旧 generation 的全部客户端断开，旧 close 事件不得影响新主机。主机离线返回 HTTP 503。

## 加密与绑定

客户端固定作为 Noise initiator，主机作为 responder：

- 首次配对：`Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`，32 字节随机 PSK。
- 已批准设备重连：`Noise_IK_25519_ChaChaPoly_BLAKE2s`，客户端钉住主机 static key，主机验证批准列表中的客户端 static key。

Prologue 为 JSON 编码的数组：`["neko-remoted",1,mode,route,relayDigest]`，relayDigest 是规范 WSS origin 的 SHA-256 前 8 字节的 base64url。握手消息不含业务 payload。任意认证、重复密文或解密错误使整个 Channel 失效，不能继续发送或接收。

设备码形如 `NR1.<route>.<psk>.<relayDigest>.<checksum>`，checksum 为前四段连接字符串的 SHA-256 前 5 字节。设备码是高熵短期秘密，扫码与手输得到相同内容。校验仅用于输入损坏检查。邀请有效期 5 分钟，一次有效配对即消耗；主机界面仍须明确批准，等待批准最多 120 秒。

加密业务请求为 `{id,operation}`，响应为 `{id,event}`。操作与事件均使用 `type` 标记的 snake_case 枚举；未知字段和未知操作拒绝。请求 id 为递增正整数，同一连接不重复。握手成功后首先发送 `identify`；待审批返回 `pending`，主机批准后返回 `approved`。客户端先将身份、Relay、路由及钉住主机公钥存入系统保护存储，再发送 `acknowledge_pairing`，之后主机才返回 `ready`。解密成功不代表获得业务授权。

## 有界消息与交付确认

外层消息为 JSON 文本，最多 98,304 字节。握手记录最多 256 字节；业务明文最多 61,440 字节，Noise 密文最多 61,456 字节；文件 chunk 最多 32,768 字节。不得把大文件作为单条消息或完整内存对象转发。

应用发送 `{type:"data",peer,data}`。Worker 在转发时添加接收连接级、从 1 递增的 `sequence`。接收方把记录放入有界队列后发送 `{type:"acknowledge",peer,sequence}`；ACK 是累积确认，必须大于先前确认且不大于已发送序号。Worker 释放对应待确认项，并向每项的发送方返回 `{type:"delivered",peer,count:1}`。主机对每个 peer 以及客户端对主机最多同时发送 8 条未确认记录；主机接收连接聚合窗口为 64。

慢客户端只会使其自己的连接关闭，不使主机和其它客户端掉线。客户端传输任务持续消费交付确认，不能把 `delivered` 当业务事件或 Noise 密文。队列满、发送超时和序号错误均关闭连接；操作不自动重试。`delivered` 只确认转发队列接收，**不证明远端业务操作已执行**。

## 授权与控制权

主机用平台 SDK 的应用 `deploy_id` 和 `owner` 验证当前应用部署所有者。发现列表中的“可见”不代表“拥有”。授权资源使用主机产生的不透明 grant id，固定绑定后端、完整 selector、目标用户及会话身份。远端不能提交替代 selector、平台票据、任意命令或任意 HTTP 目标。

首版长期委派只覆盖部署所有者自己的 LightOS 及明确配置的 SSH 会话。需要短期平台票据的物理客户端和 MicroVM 不进入长期授权。

设备权限为 `read_only` 或 `operate`。所有写操作默认拒绝，只读不能输入、缩放、上传或控制终端；Herdr 另有明确的方法 allowlist，未知方法拒绝。`events.subscribe` 与 `agent.prompt` 不在首版远程 allowlist 中；Herdr 输出由受控终端适配器传输，pane 写入仍须持有对应终端的控制权。普通终端旁观者不加入控制权竞争，可操作设备仍须明确取得控制权。客户端终端模拟器生成的 probe Reply 必须丢弃，不能回写真实 PTY。

设备断开只结束当前连接，允许再次认证；移除设备永久撤销其 static key 授权。权限变化使旧 generation 的连接断开。关闭总开关断开全部连接、失效邀请，保留批准记录。撤销阻止新提交并取消连接，已经提交到目标的副作用无法被召回，不把网络错误报告为操作成功。

## 文件与终端

文件路径相对于批准的根目录。目标用户下的 Python helper 使用 dirfd 和 O_NOFOLLOW 逐段解析，根目录的 device/inode/uid 固定校验，不通过中转读取主机提供方的本地文件。下载按 offset 拉取并计算 SHA-256；上传按 offset 接收 chunk，核对长度与 hash 后提交。默认不覆盖，显式覆盖才替换，禁止跟随目标符号链接。中断与取消清理 staging，崩溃遗留项按期限清理。主机最大单文件 4 GiB；客户端可施加更小上限，必须在选择文件时说明。

终端 attach 只附加已存在的授权会话。输出具有 sequence、replay、reset 和 gap；客户端按增量 UTF-8 解码，reset 开启新的屏幕 epoch，gap 不能伪装成连续输出。断开网络不会关闭持久终端。Herdr pane 与普通终端采用同一渲染规则，控制与只读权限同样生效。

## 活性与限制

Relay ping/pong 测得的是主机↔Relay RTT；加密应用 ping/pong 测得的是客户端↔主机端到端 RTT。二者不得混用，过期或离线显示不可用。Worker 首版使用非休眠 WebSocket，不承诺部署或 DO 重启后保留业务连接；应用重连必须重新握手。部署文档应说明长连接 duration 成本、平台配额与被滥用的费用风险。

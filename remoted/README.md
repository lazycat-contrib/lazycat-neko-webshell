# 小橘远程（Remoted）

Remoted 将小橘终端中明确授权的会话，通过自建 Relay 提供给独立的 NSH 原生客户端。主机和客户端均主动连接 Relay，不需要把终端服务端口直接暴露到公网。

Android 首发包名为 `community.lazycat.neko.remoted`，支持 Android 9 / API 28 及以上的 arm64 设备。客户端、协议及 Relay 独立版本；主机能力由小橘终端新版提供。两端均需显式配置同一个 Relay 并由主机用户批准设备；可以填写自建地址，或点击“使用公共中转”填入 `https://neko-relay.czyt.eu.org`，不会自动连接或配对。
| 目录 | 职责 |
| --- | --- |
| `protocol/` | 地址与设备码、Noise 握手、加密消息及协议边界 |
| `relay/` | Cloudflare Worker + SQLite Durable Objects，转发连接控制帧和密文 |
| `client/` | 独立 NSH 原生客户端及平台适配；拥有自己的 Cargo workspace |

WebShell 主机的配对、审批、授权、会话与文件适配由已安装的小橘终端应用提供。其实现位于私有源码仓库的 `src/remoted/`，不包含在本公开仓库中；此处路径仅作源码位置说明，不是本仓库的相对链接。

部署从 [Cloudflare 部署指南](docs/deploy-cloudflare.md) 开始；Relay 的入口和测试见 [Relay README](relay/README.md)。原生客户端的构建、签名和 Android 平台验证见 [Android 指南](docs/android.md)，Windows、macOS 和 Linux deb 的构建与安装见 [桌面指南](docs/native-desktop.md)，线协议见 [协议说明](docs/protocol.md)。

## 支持范围与授权

当前主机实现要求 LightOS 提供当前应用的部署身份、认证用户和权威归属查询。只有部署所有者可以管理远程设备；普通 Docker 或无平台身份的开发环境不能通过伪造请求头获得相同能力。

授权对象是已存在的会话，绑定完整 selector、目标登录用户、后端及目标身份。当前后端允许列表为 `webshell`、`ssh`、`herdr`、`hc`、`zellij`，仍须通过每次操作的身份与归属检查。SSH 必须是当前应用中启用的配置，配置变化会使旧授权失效；其他目标要求完整 `name@owner_deploy_id` 及可验证归属。依赖短期平台票据的物理客户端目标不能持久委托；MicroVM 也不在当前允许列表内。

设备默认不能浏览所有目标。所有者需要选择资源并授予只读或可操作权限；文件访问还需要明确的根目录和目标端 Python 3 helper；上传要求目标端能读取 `/proc/self/fdinfo` 验证挂载边界。Herdr 授权绑定整个获批 session，不能理解为某个 pane 的独立安全隔离，也不开放完整 SockAPI 管理能力。

设备码是短期配对凭据，不是账号密码。客户端和主机需要先分别配置同一个 Relay，再交换设备码并由主机所有者核对指纹、审批。已绑定设备依赖自己的 Noise 身份重连；撤销设备后必须重新配对。请保护主机持久化身份和客户端密钥，勿把设备码、routing secret、平台票据放入日志、截图或工单。

## 验证与边界

验证覆盖真实本地 workerd/DO WebSocket、Noise 两种握手、发送窗口及超时拒绝、只读方法集合、目标文件沙箱、原生状态机和 NSH headless 交互。Android API 35 模拟器使用实际发布签名 APK 验证了 NshView/JNI、Keystore 加密与篡改拒绝、SAF 流式读写/取消、相机权限与预览、生命周期及明暗主题。

这不等于已验证所有物理设备或线上懒猫部署。部署者应按部署指南完成真实归属查询、主机批准、普通终端/Herdr 和文件收发验收；实际扫码成像、不同云文件提供方、4 GiB 文件和 API 28/16 KiB 内存页硬件仍需各自验证。APK 的签名、ZIP 及 ELF 对齐检查与运行平台验证分开记录。

原生客户端与 Relay 的本目录代码采用 [MIT License](LICENSE)。NSH 和 ZXing 的声明随 Android 包提供；相关第三方许可见 `client/android/licenses/`。

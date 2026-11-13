# 小橘终端

小橘终端是一款面向懒猫微服的浏览器终端工作台。无论在电脑还是手机上，都能随时进入应用实例，运行命令、查看日志和处理文件。

## 功能

- 多标签与分屏窗格，同时管理多个终端任务。
- 恢复工作区、终端会话和最近输出，便于继续之前的工作。
- 手机辅助键盘，提供 Ctrl、Alt、Tab、方向键和常用符号。
- 上传、下载和浏览文件，支持将剪贴板图片送入终端工作流程。
- SSH 远程连接，并可使用设备已有的 OpenSSH 配置。
- AI Chat 辅助分析终端输出、整理命令和排查步骤。
- 可选微信离线语音识别，模型一键下载，电脑和手机通过小橘服务端转写；原有 API 语音提供方继续保留。
- HTTP 服务预览与端口转发；可与 Herdr 工作区配合使用。

## 安装

可通过喵喵商店或懒猫官方商店安装，也可以在本仓库的 Releases 下载 `community.lazycat.webshell.neko-v<版本>.lpk` 手动安装。`checksums.txt` 提供 SHA256 校验信息。

要求懒猫系统 1.6.0 或更新版本。安装后，从系统 WebShell 入口选择目标应用实例即可使用。

## neoko-terminal 原生客户端

neoko-terminal 是支持 Windows、macOS、Linux 和 Android 的原生终端客户端。桌面 0.4.1 起可以独立使用本机终端、hc 持久化终端和本机 Herdr，在偏好设置中选择默认会话后端；默认值只影响本机新建会话，已有会话保持原后端。hc 和 Herdr 需要单独安装，程序提供相应引导。

桌面端支持互相配对和共享会话，主机明确批准设备并配置只读或操作权限。Android 仅用于远程连接，提供 ARM64 版本，最低支持 Android 9（API 28）。远程主机和客户端需填写同一 Relay v3 地址，使用 WebShell 0.15.0 或桌面 0.5.0 主机；自行部署 Relay 请参阅 [Cloudflare 部署指南](relay/DEPLOY.md)。

桌面 0.5.0 和 Android 0.4.0 使用固定字符格绘制终端，内嵌 WebShell 同款终端字体；远程设备默认显示主机名称，也可以设置本地别名。会话统一采用终端交互，移动端保留输入栏和快捷键。连接类型以图标显示，点按可查看详情。

两端均主动连接公共 Relay，并在配对认证后自动尝试 NAT 穿透。无需公网 IP 或端口映射；网络不支持直连时继续走加密中转，直连中断也会回退。Relay v3 不兼容旧协议，需要同时更新主机与客户端；应用 ID、生产签名和已有配对身份保持不变。

原生 APK 使用独立的 `neoko-terminal-android-v<版本>` 发布标签，与小橘终端的 LPK 和商店发布分开管理。发布流程默认仅验证，检查来源、校验值及固定生产证书后才能正式发布；详见 [原生客户端发布说明](components/neoko-terminal/README.md)。

桌面发布使用独立的 `neoko-terminal-desktop-v<版本>` 标签，包名以 `neoko-terminal-<版本>-<target>` 开头。Android 应用 ID 与生产签名证书保持不变，已有安装可以沿用原有身份升级。

公开仓库的 Android 和桌面发布流程都从 `ca-x/lazycat-neko-webshell` 拉取对应 Actions 构建产物，校验来源、校验值及各平台产物合同后发布。来源仓库可以是公开或私有仓库。桌面统一发布 Release 构建的稳定正式包，须齐备 Windows x64、macOS Apple Silicon、macOS Intel 和 Linux amd64 deb 的产物，上传后逐一回读校验；草稿和预发布版本不算发布完成。

本仓库维护 GitHub Actions 发布流程、产物校验脚本，以及 [Relay 源码](relay) 和部署说明。应用与原生客户端由来源仓库构建，安装包在 Releases 下载。

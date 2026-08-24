# Neko Webshell / 小橘 WebShell

[English](./README.en.md)

当前版本：`0.7.23`

Neko Webshell 是浏览器里的 WebShell 工作台。它默认面向 LazyCat / LightOS 的应用实例，也可以关闭 LightOS 初始化后作为通用 WebShell 使用，并通过 SSH profile 管理远程终端目标。

它更像一个随手可用的远程工作台：桌面端适合长时间开发和排查，手机上也保留了常用按键、上下滚动查看历史输出和标签切换能力。

## 适合做什么

- 临时进入某个应用实例，执行命令、查看日志或排查问题。
- 在浏览器里保留多个终端标签，同时处理几件事。
- 把一个终端标签拆成多个窗格，一边看输出，一边继续输入命令。
- 关闭浏览器或重启 WebShell 后，继续回到原来的标签、窗格和最近输出。
- 在手机上用辅助按键输入 Ctrl、Alt、Tab、方向键、F1-F12 和常用 shell 符号。
- 上传、下载、查看目标实例里的文件，或把剪贴板图片保存到实例里再送进终端。
- 使用 AI Chat 分析最近输出、整理命令思路、生成排查步骤。
- 通过 LightOS 端口转发预览实例内 HTTP 服务。
- 通过 Cloudflare Quick Tunnel 或带认证配置的 Tunnel 服务，把本地 HTTP 预览地址临时公开出去。
- 播放设备本地的白噪音和环境音，声音文件放在 `/lzcapp/var/sounds`。
- 添加 SSH profile，把远程主机作为一等终端目标打开。
- 如果设备里安装了 Herdr，可以在同一个界面里切换 Herdr 的空间和标签。

## 打开和使用

在 LightOS 的 WebShell 入口选择目标应用实例，页面会打开对应终端。

顶部区域用于切换实例、新建标签、调整布局和打开菜单。中间是终端输出和输入区域。底部或菜单里会根据屏幕大小收起常用操作，避免占用终端空间。

原生 WebShell 会话由目标实例内的后台 agent 持有。浏览器刷新、关闭 WebShell 页面，甚至 WebShell 后端重启后，正在运行的 shell 程序也会尽量保留；重新打开页面时会恢复工作区并回放最近输出。目标实例停止或 agent 被杀掉时，对应会话会丢失。

## 通用 WebShell 和 SSH 后端

默认运行模式是 `lightos`，会加载 LightOS 终端初始化，并显示 LightOS Home、Herdr、LightOS 端口转发等入口。通用部署可以设置：

```bash
NEKO_WEBSHELL_TTY_INIT=generic cargo run
```

`generic` 模式不会加载 `/run/catlink/shell-env.sh`，也会隐藏 LightOS 专属菜单和接口。未设置时默认仍是 `lightos`，保持 LazyCat / LightOS 包内行为。

SSH 后端通过设置里的 SSH profiles 管理目标，当前支持两类：

- `Managed key`：WebShell 为 profile 生成并保存 ed25519 密钥，公钥由用户部署到目标主机。
- `OpenSSH`：直接调用设备上的 `ssh <target>`，可以使用设备已有的 `~/.ssh/config`、ssh-agent 和系统 OpenSSH 行为。

如果设备用户目录下存在 `~/.ssh/config`，设置页会读取其中可直接选择的 `Host` alias，并可一键填入 OpenSSH profile。连接时仍由设备上的 OpenSSH 解析完整配置，包括 `IdentityFile`、`CertificateFile`、`ProxyJump`、ssh-agent 等证书和密钥认证行为；WebShell 不复制这些 OpenSSH 语义，也不会把证书或私钥内容保存到自己的数据库。

托管密钥默认保存在 `/lzcapp/var/ssh/keys`，也可以用 `NEKO_WEBSHELL_SSH_KEY_DIR` 覆盖。OpenSSH config 默认读取当前进程用户的 `~/.ssh/config`，也可以用 `NEKO_WEBSHELL_SSH_CONFIG_FILE` 指向其他 config 文件。

也可以通过 URL 参数快速创建或复用 OpenSSH profile，并自动打开 SSH WebShell：

```text
https://<webshell-domain>/?sshTarget=cert-box
https://<webshell-domain>/?sshTarget=deploy@example.com&sshName=prod&sshPort=2222
```

参数说明：

- `sshTarget`：必填，传给设备 OpenSSH 的目标，等价于执行 `ssh <target>`；可以是 `~/.ssh/config` 里的 `Host` alias，也可以是 `user@host`。
- `sshName`：可选，profile 显示名称；未设置时使用 `sshTarget`。
- `sshHost`：可选，只作为界面显示用的主机名；实际连接仍由 `sshTarget` 决定。
- `sshUser`：可选，只作为界面显示和工作区元数据用的用户名；实际连接仍由 `sshTarget` 决定。
- `sshPort`：可选，保存为 profile 端口并在连接时传给 `ssh -p`。如果 `sshTarget` 是 `~/.ssh/config` 的 `Host` alias，通常不要传这个参数，避免覆盖 OpenSSH config 里的端口。
- `sshStrictHostKeyChecking`：可选，支持 `accept-new`、`yes`、`no`，默认 `accept-new`。

页面消费这些参数后，会把地址栏替换成普通工作区地址 `?name=<profile-id>@ssh`，避免刷新时重复创建。已经存在相同 `sshTarget` 和端口的 OpenSSH profile 时会复用；证书、私钥、ProxyJump、agent 等认证配置仍只由设备 OpenSSH 读取和处理。

## 终端体验

Neko Webshell 支持多标签和分屏。每个标签可以有自己的终端窗格，你可以重命名标签、关闭不需要的会话，也可以把当前窗格提升为新标签。

历史输出可以向上滚动查看。桌面端支持鼠标滚轮；移动端支持手指上下滑动。进入全屏编辑器或其他会接管鼠标的程序时，终端会优先把鼠标和滚动交给程序本身。

你也可以调整终端主题、字体、字号、行高、光标样式、背景图、透明度和模糊效果。软件界面的配色和终端配色分开设置，深色和浅色使用习惯都可以照顾到。

## 移动端操作

手机上输入终端命令时，系统键盘往往不够用，所以 Neko Webshell 提供了辅助按键区。

- `Main` 放常用修饰键和操作键，比如 Ctrl、Alt、Shift、Tab、Return、方向键、复制和粘贴。
- `Ops` 放标签、分屏、字号等界面操作。
- `Nav` 放 Home、End、PageUp、PageDown、Delete 和 Backspace。
- `Fn` 放 F1-F12。
- `Sym` 放常用 shell 符号。

你可以先点辅助区里的 Ctrl，再按系统键盘上的字母，输入 Ctrl+C、Ctrl+A、Ctrl+E 这类组合键。双击终端区域可以唤起系统键盘，左右滑动可以切换标签。

## 文件、图片和上传进度

内置文件面板会尽量跟随当前终端的工作目录。你可以在文件面板里进入目录、返回上级目录、刷新列表、上传本地文件、下载远端文件，也可以直接查看文本文件内容和文件信息。

粘贴图片时，Neko Webshell 会先把图片保存到目标实例，再把保存后的路径输入到终端。这样你可以把截图、剪贴板图片或手机里的图片交给正在运行的命令或工具处理。

上传图片时，WebShell 顶部会显示一条细进度条。上传完成后进度条会自动隐藏；在 Herdr 场景下，也会尽量通过 Herdr 通知提示上传开始和完成。

## AI Chat

AI Chat 是内置的聊天面板，用来辅助理解和整理终端工作。它不会自动控制你的终端。

你可以配置多个 AI 服务商配置，并在聊天界面里切换使用。当前支持 OpenAI-compatible、OpenAI Responses 和 Anthropic Claude 这几类接口格式。回复会以流式方式逐步显示，Markdown 内容会按格式渲染，代码块可以直接复制。

是否携带最近终端上下文由你决定。开启后，聊天会带上最近终端输出，并在 AI 头像旁边用一个小终端预览当前上下文；关闭后，聊天请求不会附带终端内容。

AI Chat 也支持连接远程 MCP 服务，让聊天可以使用外部工具。当前支持 Streamable HTTP 和 SSE 类型的远程 MCP 服务；本地 stdio 类型 MCP 暂不支持。

## Herdr 支持

如果目标设备安装了 Herdr，Neko Webshell 会在新建标签和设置里显示 Herdr 入口。你可以在 WebShell 界面里切换 Herdr 空间、查看当前空间下的标签、创建新标签、创建新空间或刷新状态。

Herdr 会话由 Herdr 自己持有。关闭 WebShell 软件再重新打开时，Neko Webshell 会重新连接 Herdr，并尽量恢复最近看到的位置和输出。

终端设置里可以开启 Herdr 懒猫通知。当前页面订阅对应 Herdr 终端期间，Agent 完成任务或等待输入时会通过懒猫通知提醒当前设备。

WebShell 只调用内置白名单里的 Herdr SockAPI 方法，并接受不低于最低兼容版本的更新协议；协议号变大不会单独阻止连接。若已安装的 Herdr 客户端协议高于正在运行的服务端，且服务端支持 live handoff，界面会在用户确认后提供无损切换按钮。客户端较旧、协议未知或服务端不支持 handoff 时不会自动替换。

没有安装 Herdr 时，这些入口不会打扰普通 WebShell 使用。

## 端口转发和 Public Tunnel

LightOS 端口转发可以把目标实例内的 HTTP 端口转到 WebShell 后端本地地址，适合预览实例里的服务。例如把实例内的 `127.0.0.1:3000` 转成 WebShell 后端可访问的本地 URL。

Public Tunnel 可以把这个本地 HTTP URL 临时发布出去：

- Cloudflare Quick Tunnel 无需认证配置，选择后可以直接启动。
- 需要 token 的 Tunnel 服务商，需要先在工具设置里添加 Tunnel 认证配置。
- 当前实现支持 Cloudflare Quick Tunnel 和 ngrok。
- Tunnel 和端口转发会话会在 WebShell 后端运行期间保持，后端进程退出后需要重新启动。

Tunnel 认证配置保存在 WebShell 后端数据库里。工具面板只选择已配置的认证配置，不直接输入 token。

这些能力是 WebShell 内置工具，不是独立分发的第三方插件。当前不支持外部插件市场、插件包安装或热加载。

## 白噪音和本地声音

白噪音工具不会把音频文件打包进前端。后端会从 `/lzcapp/var/sounds` 读取音频，第一层目录会作为分类显示。默认资源包：

```text
https://share.pushcat.eu.org/sounds.zip
```

压缩包顶层需要包含 `sounds/` 目录，例如：

```text
sounds/
  rain/
    light-rain.mp3
  noise/
    white-noise.wav
  custom/
    my-focus-sound.ogg
```

在设备上解压：

```bash
curl -L -o /tmp/sounds.zip https://share.pushcat.eu.org/sounds.zip
unzip -o /tmp/sounds.zip -d /lzcapp/var
```

最终文件路径应该类似 `/lzcapp/var/sounds/noise/white-noise.wav`。支持 `.mp3`、`.wav`、`.ogg`、`.flac`、`.m4a`、`.webm`。自定义音频只要按目录放进 `sounds/` 下，再在工具里刷新即可。

## 外观和设置

设置里可以调整：

- 界面语言和界面风格。
- 默认新建终端类型：原生 WebShell、Herdr 或 zellij。
- 终端主题、字体、字号、行高、光标。
- 编程连字、字体微调和终端特效。
- 终端背景图、透明度和模糊效果。
- 历史输出保留数量。
- 移动端触控选择方式。
- 内置工具启用状态。
- AI 服务商、MCP 服务和终端上下文选项。
- Tunnel 认证配置。

设置菜单里也提供“关于”页面，用于查看软件版本和基本信息。

## 技术说明

这一节给开发者和打包维护者看，普通使用不需要理解这些内容。

- 前端：TypeScript、Vite、Restty。
- 后端：Rust、Axum、Tokio。
- 终端渲染：Restty，使用原生插件和 Shader stage 扩展上下文收集、输入光效、扫描线和暗角效果。
- 原生 WebShell 会话：目标实例内 agent daemon 管理 workspace、tab、pane、PTY 和 bounded history。
- 终端协议：WebSocket 数据面，ConnectRPC 控制面，agent 内部协议使用 protobuf frame。
- 数据保存：SQLite，保存工作区、会话元数据、最近输出、Herdr 回放位置、内置工具设置、SSH profiles 和 Tunnel 认证配置。
- 文件能力：通过当前会话的目标实例执行文件读写和上传。
- 网络能力：LightOS 端口转发、Cloudflare Quick Tunnel、ngrok。
- LazyCat Rust SDK：[GitHub 源码](https://github.com/lib-x/lzc-sdk-rs)、[crates.io](https://crates.io/crates/lzc-sdk)、[API 文档](https://docs.rs/lzc-sdk)。
- 可选集成：SSH backend、Herdr socket bridge、zellij 后端检测。
- 打包目标：LazyCat LPK，导出 LightOS WebShell provider。

本地构建：

```bash
npm install
npm run build
cargo test
cargo run
```

通用 WebShell 部署时使用 `NEKO_WEBSHELL_TTY_INIT=generic`。可选值包括 `lightos` 和 `generic`；未设置时默认 `lightos`。白噪音目录可以通过 `NEKO_WEBSHELL_SOUNDS_DIR` 覆盖。SSH 托管密钥目录可以通过 `NEKO_WEBSHELL_SSH_KEY_DIR` 覆盖，OpenSSH config 文件可以通过 `NEKO_WEBSHELL_SSH_CONFIG_FILE` 覆盖。

开发前端界面：

```bash
npm run dev
```

默认打开 `http://127.0.0.1:5173`。Vite 会把接口请求转发到本地后端。

构建 LazyCat LPK：

```bash
lzc-cli project release
```

安装后，LightOS 会通过 WebShell 入口打开：

```text
https://<provider-domain>/?name=<name>@<owner_deploy_id>
```

目标实例里的命令执行由 LightOS 和目标实例内 agent 配合完成；SSH 目标由本机 OpenSSH 进程连接。Neko Webshell 负责界面、工作区恢复、输入输出转发、内置工具能力和移动端体验。

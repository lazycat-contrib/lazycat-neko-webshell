# 可选 Agent 状态 hook

普通 WebShell 默认使用前台进程和终端画面识别 Agent 状态，无需配置。
需要更明确的授权等待、开始工作和回合结束信号时，可以手动配置 Claude Code / Codex 的 hook。
WebShell 不自动改写 Agent 配置，不添加通知，不读取 prompt、命令或其他终端的会话文件。

## 使用条件

- Linux 目标上安装了实现版本 **19 或以上**的轻量 agent。
  `/usr/local/bin/lazycat-neko-webshell-agent agent-version` 显示启动入口的版本；
  若已准备升级但旧进程仍在运行，应以设置中的运行版本为准，等待下次轻量 agent 启动后再启用。
- Agent 运行在自己的前台 PTY 中。无控制终端、后台运行、不同进程组或不能核实身份的 hook 会被忽略。
- Agent CLI 本身支持下表中的 hook。Codex 需要在自身的 hook 审核界面确认配置；不要绕过其审核。

已有兼容的旧轻量 agent 不会因此被强制重启或升级，最低兼容版本仍为 11。
若需使用此功能，先通过现有升级入口准备新版，在下一次轻量 agent 启动后使用。

## 配置

将下列 command hook **合并**到 Agent 的已有配置中，不要覆盖已有 hook。
Claude Code 使用其 `settings.json`，Codex 使用支持 hook 的版本所提供的 `hooks.json`。
命令中的 `claude` 在 Codex 配置里改成 `codex`。

```json
{
  "type": "command",
  "command": "/usr/local/bin/lazycat-neko-webshell-agent status-hook claude >/dev/null 2>&1 || true",
  "timeout": 1
}
```

例如，Claude Code 的最小配置片段如下。需要继续工作状态时也应配置 `PreToolUse`。

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "/usr/local/bin/lazycat-neko-webshell-agent status-hook claude >/dev/null 2>&1 || true", "timeout": 1}]}],
    "PreToolUse": [{"matcher": ".*", "hooks": [{"type": "command", "command": "/usr/local/bin/lazycat-neko-webshell-agent status-hook claude >/dev/null 2>&1 || true", "timeout": 1}]}],
    "Notification": [{"matcher": ".*", "hooks": [{"type": "command", "command": "/usr/local/bin/lazycat-neko-webshell-agent status-hook claude >/dev/null 2>&1 || true", "timeout": 1}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "/usr/local/bin/lazycat-neko-webshell-agent status-hook claude >/dev/null 2>&1 || true", "timeout": 1}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "/usr/local/bin/lazycat-neko-webshell-agent status-hook claude >/dev/null 2>&1 || true", "timeout": 1}]}]
  }
}
```

| hook | Agent | 状态 |
|---|---|---|
| `SessionStart` | Claude / Codex | 空闲 |
| `UserPromptSubmit`、`PreToolUse` | Claude / Codex | 工作中 |
| `Notification`，类型为 `permission_prompt` | Claude | 等待授权 |
| `Notification`，类型为 `elicitation_dialog`、`elicitation_url_dialog`、`agent_needs_input` | Claude | 等待回答 |
| `PermissionRequest` | Codex | 等待授权 |
| `Stop` | Claude / Codex | 本轮完成 |
| `Interrupt` | Codex | 空闲 |
| `SessionEnd` | Claude / Codex | 清除 hook 状态，恢复自动检测 |

Codex 使用相同 command 结构，参数改成 `codex`，授权事件注册为 `PermissionRequest`，不注册 `Notification`。
未知事件、延迟 idle 通知、单个工具结束和子 Agent 结束不改变主 Agent 的状态。
不同 CLI 版本的事件顺序和支持范围可能不同；漏报时可关闭增强，继续使用默认检测。

配置后，只为需要增强的那次运行启用：

```sh
NEKO_WEBSHELL_AGENT_STATUS=1 claude
# 或
NEKO_WEBSHELL_AGENT_STATUS=1 codex
```

不加这个环境变量时 helper 静默退出。删除对应 hook 配置即可完全移除接入。

## 边界

helper 从 stdin 读取 hook JSON，最多保留 64 KiB，读取预算为 100 ms。
它验证同 UID、session、TTY、前台进程组及到 Agent 的父进程链，并在写入前重新核实进程启动身份。
只向自己的 `/dev/tty` 非阻塞写入一个短 OSC 7501 状态，不写 hook stdout/stderr、不等待回复。
无法读取、数据过大、超时、终端繁忙或身份变化时放弃上报；配置命令的 `|| true` 也兼容未提供此子命令的旧 agent。

优先级为原生 OSC 7501、可选 hook、画面推断。`_neko_hook` 是桥接器保留的 OSC record ID，
不会作为前端的新会话 ID。原生报告开始后，hook 不再覆盖它。
PTY 更换前台 Agent 后清理旧状态，Ctrl+C 清理 hook 状态；等待处理时收到用户输入后交回画面推断，避免授权后仍显示阻塞。
历史回放不重新处理 hook。
状态仍通过现有替换表发送，重复报告不会造成额外状态更新。

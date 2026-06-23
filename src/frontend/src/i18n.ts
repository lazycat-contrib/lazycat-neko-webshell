import type { LocaleSetting } from "./types";

type Language = "en" | "zh-CN";

export type MessageKey =
  | "ai.accessHelp"
  | "ai.providerOpenAICompatible"
  | "action.aiChat"
  | "action.aiClear"
  | "action.aiComplete"
  | "action.aiCopy"
  | "action.aiExplain"
  | "action.aiFetchModels"
  | "action.aiInsert"
  | "action.aiNl2cmd"
  | "action.aiTest"
  | "action.closeActiveSession"
  | "action.closeSettings"
  | "action.copySelection"
  | "action.focusTerminal"
  | "action.fullscreen"
  | "action.lightosHome"
  | "action.newHerdrTab"
  | "action.newTab"
  | "action.pasteClipboard"
  | "action.pluginFileDownload"
  | "action.pluginFileList"
  | "action.pluginFileRead"
  | "action.pluginFileStat"
  | "action.pluginFileUpload"
  | "action.promoteSessionToTab"
  | "action.refreshHerdr"
  | "action.refreshInstances"
  | "action.refreshPlugins"
  | "action.removeFont"
  | "action.removeTerminalBackground"
  | "action.removeTheme"
  | "action.saveTheme"
  | "action.settings"
  | "action.settingsMenu"
  | "action.closeTab"
  | "action.renameTab"
  | "action.splitDown"
  | "action.splitLeft"
  | "action.splitRight"
  | "action.splitUp"
  | "action.switchInstance"
  | "action.uploadFont"
  | "action.uploadTerminalBackground"
  | "app.title"
  | "cursor.bar"
  | "cursor.block"
  | "cursor.underline"
  | "field.cursor"
  | "field.font"
  | "field.fontPreview"
  | "field.fontSize"
  | "field.aiApiKey"
  | "field.aiBaseUrl"
  | "field.aiModel"
  | "field.aiPrompt"
  | "field.aiProvider"
  | "field.interfaceStyle"
  | "field.language"
  | "field.lineHeight"
  | "field.outputBuffer"
  | "field.pluginPath"
  | "field.scrollback"
  | "field.tabs"
  | "field.terminalBackgroundBlur"
  | "field.terminalBackgroundOpacity"
  | "field.theme"
  | "field.themeName"
  | "field.themeSource"
  | "field.touchBehavior"
  | "font.builtIn"
  | "font.noUploaded"
  | "font.uploaded"
  | "interfaceStyle.brass"
  | "interfaceStyle.geek"
  | "interfaceStyle.glass"
  | "interfaceStyle.spectrum"
  | "interfaceStyle.steel"
  | "layout.horizontal"
  | "layout.vertical"
  | "locale.auto"
  | "locale.en"
  | "locale.zhCN"
  | "menu.instances"
  | "menu.mobileShortcuts"
  | "menu.pane"
  | "plugin.aiControl.description"
  | "plugin.aiControl.block"
  | "plugin.aiControl.name"
  | "plugin.aiControl.output"
  | "plugin.fileTransfer.help"
  | "plugin.fileTransfer.output"
  | "plugin.fileTransfer.description"
  | "plugin.fileTransfer.name"
  | "plugin.meta.control"
  | "plugin.meta.filesystem"
  | "plugin.meta.session"
  | "plugin.meta.transfer"
  | "section.appearance"
  | "section.aiAccess"
  | "section.fileTransfer"
  | "section.fonts"
  | "section.herdr"
  | "section.herdrTabs"
  | "section.herdrWorkspaces"
  | "section.plugins"
  | "section.terminalBackground"
  | "section.themes"
  | "setting.autoRestartSessions"
  | "setting.copyOnSelect"
  | "setting.cursorBlink"
  | "setting.debugAdapter"
  | "setting.pluginDisabled"
  | "setting.pluginEnabled"
  | "setting.terminalBackground"
  | "setting.useResttyClipboard"
  | "tab.appearance"
  | "tab.fonts"
  | "tab.fontSettings"
  | "tab.fontUpload"
  | "tab.plugins"
  | "tab.themes"
  | "status.closed"
  | "status.connected"
  | "status.connectFailed"
  | "status.copyFailed"
  | "status.creatingSession"
  | "status.fontDeleteFailed"
  | "status.fontLoadFailed"
  | "status.fontReady"
  | "status.fontsReady"
  | "status.fontRegistrationFailed"
  | "status.fontRemoved"
  | "status.fontUploadFailed"
  | "status.backgroundReady"
  | "status.backgroundRemoved"
  | "status.backgroundUploadFailed"
  | "status.backgroundDeleteFailed"
  | "status.herdrActionFailed"
  | "status.herdrUnavailable"
  | "status.idle"
  | "status.instance"
  | "status.instanceLoadFailed"
  | "status.instancesLoaded"
  | "status.instanceFallback"
  | "status.lightosHomeFailed"
  | "status.lightosHomeLoading"
  | "status.loadingGhostty"
  | "status.loadingInstances"
  | "status.noInstances"
  | "status.noInstancesVisible"
  | "status.noPlugins"
  | "status.noSelection"
  | "status.noSessions"
  | "status.noTarget"
  | "status.pasteFailed"
  | "status.aiInserted"
  | "status.aiModelsReady"
  | "status.aiNoOutput"
  | "status.aiTestOk"
  | "status.aiWorking"
  | "status.pluginDisableFailed"
  | "status.pluginDisabled"
  | "status.pluginEnableFailed"
  | "status.pluginEnabled"
  | "status.pluginFileDone"
  | "status.pluginFileNoSession"
  | "status.pluginFileUploadDone"
  | "status.pluginLoadFailed"
  | "status.pluginsLoading"
  | "status.pluginsReady"
  | "status.processExited"
  | "status.reconnecting"
  | "status.selectRunningInstance"
  | "status.selectionCopied"
  | "status.shellReady"
  | "status.socketError"
  | "status.startupFailed"
  | "status.sessionStopped"
  | "status.terminalError"
  | "status.themeInvalid"
  | "status.themeRemoved"
  | "status.themeSaved"
  | "theme.builtIn"
  | "theme.custom"
  | "theme.gallery"
  | "theme.noCustom"
  | "theme.recommended"
  | "touch.drag"
  | "touch.longPress"
  | "touch.off"
  | "validation.fontExtension"
  | "validation.fontMime"
  | "validation.fontSize"
  | "validation.backgroundExtension"
  | "validation.backgroundMime"
  | "validation.backgroundSize"
  | "validation.aiAccess"
  | "validation.aiPrompt"
  | "validation.pluginPath"
  | "validation.themeName"
  | "validation.themeSource";

const messages: Record<Language, Record<MessageKey, string>> = {
  en: {
    "action.aiChat": "Chat",
    "action.aiClear": "Clear",
    "action.aiComplete": "Complete",
    "action.aiCopy": "Copy",
    "action.aiExplain": "Explain",
    "action.aiFetchModels": "Fetch models",
    "action.aiInsert": "Insert",
    "action.aiNl2cmd": "NL to cmd",
    "action.aiTest": "Test",
    "action.closeActiveSession": "Close active session",
    "action.closeSettings": "Close settings",
    "action.copySelection": "Copy selection",
    "action.focusTerminal": "Focus terminal",
    "action.fullscreen": "Full screen",
    "action.lightosHome": "LightOS home",
    "action.newHerdrTab": "New Herdr tab",
    "action.newTab": "New terminal tab",
    "action.pasteClipboard": "Paste",
    "action.pluginFileDownload": "Download",
    "action.pluginFileList": "List",
    "action.pluginFileRead": "Read",
    "action.pluginFileStat": "Stat",
    "action.pluginFileUpload": "Upload file",
    "action.promoteSessionToTab": "Move session to new tab",
    "action.refreshHerdr": "Refresh Herdr",
    "action.refreshInstances": "Refresh instances",
    "action.refreshPlugins": "Refresh plugins",
    "action.removeFont": "Remove selected font",
    "action.removeTerminalBackground": "Remove terminal background",
    "action.removeTheme": "Remove custom theme",
    "action.saveTheme": "Save custom theme",
    "action.settings": "Settings",
    "action.settingsMenu": "Settings menu",
    "action.closeTab": "Close tab",
    "action.renameTab": "Rename tab",
    "action.splitDown": "Split down",
    "action.splitLeft": "Split left",
    "action.splitRight": "Split right",
    "action.splitUp": "Split up",
    "action.switchInstance": "Switch instance",
    "action.uploadFont": "Upload font",
    "action.uploadTerminalBackground": "Upload terminal background",
    "app.title": "Neko Webshell",
    "cursor.bar": "Bar",
    "cursor.block": "Block",
    "cursor.underline": "Underline",
    "field.cursor": "Cursor",
    "field.font": "Font",
    "field.fontPreview": "Font preview",
    "field.fontSize": "Font size",
    "field.aiApiKey": "API key",
    "field.aiBaseUrl": "Base URL",
    "field.aiModel": "Model",
    "field.aiPrompt": "Prompt",
    "field.aiProvider": "Provider",
    "field.interfaceStyle": "Interface style",
    "field.language": "Language",
    "field.lineHeight": "Line height",
    "field.outputBuffer": "History lines",
    "field.pluginPath": "Path",
    "field.scrollback": "Scrollback",
    "field.tabs": "Tabs",
    "field.terminalBackgroundBlur": "Background blur",
    "field.terminalBackgroundOpacity": "Background opacity",
    "field.theme": "Terminal theme",
    "field.themeName": "Theme name",
    "field.themeSource": "Ghostty theme",
    "field.touchBehavior": "Touch behavior",
    "font.builtIn": "Built in",
    "font.noUploaded": "No uploaded fonts",
    "font.uploaded": "Uploaded",
    "interfaceStyle.brass": "Brass",
    "interfaceStyle.geek": "Geek",
    "interfaceStyle.glass": "Glass",
    "interfaceStyle.spectrum": "Spectrum",
    "interfaceStyle.steel": "Steel",
    "layout.horizontal": "Horizontal",
    "layout.vertical": "Vertical",
    "locale.auto": "Auto",
    "locale.en": "English",
    "locale.zhCN": "Chinese",
    "menu.instances": "Instances",
    "menu.mobileShortcuts": "Terminal shortcuts",
    "menu.pane": "Pane menu",
    "ai.accessHelp": "Configure the OpenAI-compatible endpoint used by AI workflows. Results stay in this panel and are inserted into the terminal only when you choose.",
    "ai.providerOpenAICompatible": "OpenAI-compatible",
    "plugin.aiControl.block": "AI output",
    "plugin.aiControl.description": "Chat, command generation, completion, and session control helpers through the action WebSocket.",
    "plugin.aiControl.name": "AI control",
    "plugin.aiControl.output": "AI output",
    "plugin.fileTransfer.description": "Read, write, list, and inspect files inside the selected LightOS instance.",
    "plugin.fileTransfer.help": "Uses the active terminal session's LightOS instance and login user.",
    "plugin.fileTransfer.name": "File transfer",
    "plugin.fileTransfer.output": "File transfer output",
    "plugin.meta.control": "Control",
    "plugin.meta.filesystem": "Filesystem",
    "plugin.meta.session": "Session",
    "plugin.meta.transfer": "Transfer",
    "section.appearance": "Appearance",
    "section.aiAccess": "AI access",
    "section.fileTransfer": "File transfer",
    "section.fonts": "Fonts",
    "section.herdr": "Herdr controls",
    "section.herdrTabs": "Herdr tabs",
    "section.herdrWorkspaces": "Herdr workspaces",
    "section.plugins": "Plugins",
    "section.terminalBackground": "Terminal background",
    "section.themes": "Terminal themes",
    "setting.autoRestartSessions": "Restart sessions after provider restart",
    "setting.copyOnSelect": "Copy on select",
    "setting.cursorBlink": "Cursor blink",
    "setting.debugAdapter": "Debug adapter",
    "setting.pluginDisabled": "Disabled",
    "setting.pluginEnabled": "Enabled",
    "setting.terminalBackground": "Use background image",
    "setting.useResttyClipboard": "Use restty clipboard",
    "tab.appearance": "Appearance",
    "tab.fonts": "Fonts",
    "tab.fontSettings": "Font settings",
    "tab.fontUpload": "Font upload",
    "tab.plugins": "Plugins",
    "tab.themes": "Terminal",
    "status.closed": "Closed",
    "status.connected": "Connected",
    "status.connectFailed": "Connect failed: {message}",
    "status.copyFailed": "Copy failed: {message}",
    "status.creatingSession": "Creating session...",
    "status.fontDeleteFailed": "Font delete failed: {message}",
    "status.fontLoadFailed": "Font load failed: {message}",
    "status.fontReady": "{name} ready",
    "status.fontsReady": "{count} uploaded font(s) ready",
    "status.fontRegistrationFailed": "font registration failed",
    "status.fontRemoved": "{name} removed",
    "status.fontUploadFailed": "Font upload failed: {message}",
    "status.backgroundReady": "Terminal background ready",
    "status.backgroundRemoved": "Terminal background removed",
    "status.backgroundUploadFailed": "Background upload failed: {message}",
    "status.backgroundDeleteFailed": "Background delete failed: {message}",
    "status.herdrActionFailed": "Herdr action failed: {message}",
    "status.herdrUnavailable": "Herdr socket unavailable",
    "status.idle": "Idle",
    "status.instance": "Instance",
    "status.instanceLoadFailed": "Instance load failed: {message}",
    "status.instancesLoaded": "Instances loaded",
    "status.instanceFallback": "Requested instance is not running. Opened {selector}.",
    "status.lightosHomeFailed": "LightOS home failed: {message}",
    "status.lightosHomeLoading": "Opening LightOS home...",
    "status.loadingGhostty": "Loading terminal renderer...",
    "status.loadingInstances": "Loading instances...",
    "status.noInstances": "No instances returned",
    "status.noInstancesVisible": "No LightOS instances visible.",
    "status.noPlugins": "No plugins returned",
    "status.noSelection": "No selection to copy",
    "status.noSessions": "No sessions",
    "status.noTarget": "No instance selected",
    "status.pasteFailed": "Paste failed: {message}",
    "status.aiInserted": "Inserted into terminal",
    "status.aiModelsReady": "{count} model(s) loaded",
    "status.aiNoOutput": "No AI output to insert",
    "status.aiTestOk": "AI test passed",
    "status.aiWorking": "AI request running...",
    "status.pluginDisableFailed": "Disable failed: {message}",
    "status.pluginDisabled": "{name} disabled",
    "status.pluginEnableFailed": "Enable failed: {message}",
    "status.pluginEnabled": "{name} enabled",
    "status.pluginFileDone": "{operation} complete",
    "status.pluginFileNoSession": "Open or select a terminal session first.",
    "status.pluginFileUploadDone": "Uploaded {name}",
    "status.pluginLoadFailed": "Plugin load failed: {message}",
    "status.pluginsLoading": "Loading plugins...",
    "status.pluginsReady": "{count} plugin(s) ready",
    "status.processExited": "Process exited: {code}",
    "status.reconnecting": "Disconnected. Reconnecting in {seconds}s...",
    "status.selectRunningInstance": "Select a running instance first.",
    "status.selectionCopied": "Selection copied",
    "status.shellReady": "Shell ready",
    "status.socketError": "Socket error",
    "status.startupFailed": "Startup failed: {message}",
    "status.sessionStopped": "Session stopped",
    "status.terminalError": "Terminal error",
    "status.themeInvalid": "Theme invalid: {message}",
    "status.themeRemoved": "{name} removed",
    "status.themeSaved": "{name} saved",
    "theme.builtIn": "Built in",
    "theme.custom": "Custom",
    "theme.gallery": "Ghostty Style Gallery",
    "theme.noCustom": "No custom themes",
    "theme.recommended": "Recommended",
    "touch.drag": "Drag to select",
    "touch.longPress": "Pan first, long-press select",
    "touch.off": "Touch selection off",
    "validation.fontExtension": "only .woff, .woff2, .ttf, and .otf are allowed",
    "validation.fontMime": "unsupported font MIME type: {mimeType}",
    "validation.fontSize": "font must be between 1 byte and 10 MB",
    "validation.backgroundExtension": "only .png, .jpg, .jpeg, and .webp are allowed",
    "validation.backgroundMime": "unsupported background image MIME type: {mimeType}",
    "validation.backgroundSize": "background image must be between 1 byte and 10 MB",
    "validation.aiAccess": "enter Base URL and API key",
    "validation.aiPrompt": "enter a prompt",
    "validation.pluginPath": "enter a target path",
    "validation.themeName": "theme name is required",
    "validation.themeSource": "paste a Ghostty theme with background, foreground, or palette entries",
  },
  "zh-CN": {
    "action.aiChat": "对话",
    "action.aiClear": "清空",
    "action.aiComplete": "补全",
    "action.aiCopy": "复制",
    "action.aiExplain": "解释",
    "action.aiFetchModels": "获取模型",
    "action.aiInsert": "插入",
    "action.aiNl2cmd": "转命令",
    "action.aiTest": "测试",
    "action.closeActiveSession": "关闭当前活动会话",
    "action.closeSettings": "关闭设置",
    "action.copySelection": "复制选区",
    "action.focusTerminal": "聚焦终端",
    "action.fullscreen": "全屏",
    "action.lightosHome": "LightOS 首页",
    "action.newHerdrTab": "新建 Herdr 标签",
    "action.newTab": "新建终端标签",
    "action.pasteClipboard": "粘贴",
    "action.pluginFileDownload": "下载",
    "action.pluginFileList": "列出",
    "action.pluginFileRead": "查看",
    "action.pluginFileStat": "信息",
    "action.pluginFileUpload": "上传文件",
    "action.promoteSessionToTab": "将会话提升为新标签",
    "action.refreshHerdr": "刷新 Herdr",
    "action.refreshInstances": "刷新实例",
    "action.refreshPlugins": "刷新插件",
    "action.removeFont": "移除当前字体",
    "action.removeTerminalBackground": "移除终端背景",
    "action.removeTheme": "删除自定义主题",
    "action.saveTheme": "保存自定义主题",
    "action.settings": "设置",
    "action.settingsMenu": "设置菜单",
    "action.closeTab": "关闭标签",
    "action.renameTab": "重命名标签",
    "action.splitDown": "向下拆分",
    "action.splitLeft": "向左拆分",
    "action.splitRight": "向右拆分",
    "action.splitUp": "向上拆分",
    "action.switchInstance": "切换实例",
    "action.uploadFont": "上传字体",
    "action.uploadTerminalBackground": "上传终端背景",
    "app.title": "小橘Web Shell",
    "cursor.bar": "竖线",
    "cursor.block": "块",
    "cursor.underline": "下划线",
    "field.cursor": "光标",
    "field.font": "字体",
    "field.fontPreview": "字体预览",
    "field.fontSize": "字号",
    "field.aiApiKey": "API Key",
    "field.aiBaseUrl": "Base URL",
    "field.aiModel": "模型",
    "field.aiPrompt": "输入",
    "field.aiProvider": "服务商",
    "field.interfaceStyle": "界面风格",
    "field.language": "语言",
    "field.lineHeight": "行高",
    "field.outputBuffer": "历史行数",
    "field.pluginPath": "路径",
    "field.scrollback": "回滚行数",
    "field.tabs": "标签栏",
    "field.terminalBackgroundBlur": "背景模糊",
    "field.terminalBackgroundOpacity": "背景透明度",
    "field.theme": "终端主题",
    "field.themeName": "主题名称",
    "field.themeSource": "Ghostty 主题",
    "field.touchBehavior": "触控行为",
    "font.builtIn": "内置",
    "font.noUploaded": "暂无上传字体",
    "font.uploaded": "已上传",
    "interfaceStyle.brass": "黄铜",
    "interfaceStyle.geek": "Geek 风",
    "interfaceStyle.glass": "磨砂玻璃",
    "interfaceStyle.spectrum": "五彩缤纷",
    "interfaceStyle.steel": "钢铁风",
    "layout.horizontal": "横向",
    "layout.vertical": "竖向",
    "locale.auto": "跟随系统",
    "locale.en": "English",
    "locale.zhCN": "中文",
    "menu.instances": "实例",
    "menu.mobileShortcuts": "终端快捷键",
    "menu.pane": "终端面板菜单",
    "ai.accessHelp": "配置 AI 工作流使用的 OpenAI-compatible 接口。结果保留在面板内，只有手动点击插入才会写入终端。",
    "ai.providerOpenAICompatible": "OpenAI-compatible",
    "plugin.aiControl.block": "AI 输出",
    "plugin.aiControl.description": "通过动作 WebSocket 提供对话、命令生成、补全、解释和会话控制辅助。",
    "plugin.aiControl.name": "AI 控制",
    "plugin.aiControl.output": "AI 输出",
    "plugin.fileTransfer.description": "在当前选择的 LightOS 实例内读取、写入、列出和查看文件信息。",
    "plugin.fileTransfer.help": "使用当前活动终端会话对应的 LightOS 实例和登录用户。",
    "plugin.fileTransfer.name": "文件传输",
    "plugin.fileTransfer.output": "文件传输输出",
    "plugin.meta.control": "控制",
    "plugin.meta.filesystem": "文件系统",
    "plugin.meta.session": "会话",
    "plugin.meta.transfer": "传输",
    "section.appearance": "外观",
    "section.aiAccess": "AI 接入",
    "section.fileTransfer": "文件传输",
    "section.fonts": "字体",
    "section.herdr": "Herdr 控件",
    "section.herdrTabs": "Herdr 标签",
    "section.herdrWorkspaces": "Herdr 工作区",
    "section.plugins": "插件",
    "section.terminalBackground": "终端背景",
    "section.themes": "终端主题",
    "setting.autoRestartSessions": "Provider 重启后自动恢复会话",
    "setting.copyOnSelect": "选中即复制",
    "setting.cursorBlink": "光标闪烁",
    "setting.debugAdapter": "调试适配器",
    "setting.pluginDisabled": "已关闭",
    "setting.pluginEnabled": "已启用",
    "setting.terminalBackground": "使用背景图片",
    "setting.useResttyClipboard": "使用 restty 剪贴板",
    "tab.appearance": "外观",
    "tab.fonts": "字体",
    "tab.fontSettings": "字体设置",
    "tab.fontUpload": "字体上传",
    "tab.plugins": "插件",
    "tab.themes": "终端",
    "status.closed": "已关闭",
    "status.connected": "已连接",
    "status.connectFailed": "连接失败：{message}",
    "status.copyFailed": "复制失败：{message}",
    "status.creatingSession": "正在创建会话...",
    "status.fontDeleteFailed": "字体删除失败：{message}",
    "status.fontLoadFailed": "字体加载失败：{message}",
    "status.fontReady": "{name} 已就绪",
    "status.fontsReady": "{count} 个上传字体已就绪",
    "status.fontRegistrationFailed": "字体注册失败",
    "status.fontRemoved": "{name} 已移除",
    "status.fontUploadFailed": "字体上传失败：{message}",
    "status.backgroundReady": "终端背景已就绪",
    "status.backgroundRemoved": "终端背景已移除",
    "status.backgroundUploadFailed": "背景上传失败：{message}",
    "status.backgroundDeleteFailed": "背景删除失败：{message}",
    "status.herdrActionFailed": "Herdr 操作失败：{message}",
    "status.herdrUnavailable": "Herdr socket 不可用",
    "status.idle": "空闲",
    "status.instance": "实例",
    "status.instanceLoadFailed": "实例加载失败：{message}",
    "status.instancesLoaded": "实例已加载",
    "status.instanceFallback": "请求的实例未运行，已打开 {selector}。",
    "status.lightosHomeFailed": "返回 LightOS 首页失败：{message}",
    "status.lightosHomeLoading": "正在打开 LightOS 首页...",
    "status.loadingGhostty": "正在加载终端渲染器...",
    "status.loadingInstances": "正在加载实例...",
    "status.noInstances": "没有返回实例",
    "status.noInstancesVisible": "没有可见的 LightOS 实例。",
    "status.noPlugins": "没有返回插件",
    "status.noSelection": "没有可复制的选区",
    "status.noSessions": "没有会话",
    "status.noTarget": "未选择实例",
    "status.pasteFailed": "粘贴失败：{message}",
    "status.aiInserted": "已插入终端",
    "status.aiModelsReady": "已加载 {count} 个模型",
    "status.aiNoOutput": "没有可插入的 AI 输出",
    "status.aiTestOk": "AI 测试通过",
    "status.aiWorking": "AI 请求中...",
    "status.pluginDisableFailed": "关闭失败：{message}",
    "status.pluginDisabled": "{name} 已关闭",
    "status.pluginEnableFailed": "启用失败：{message}",
    "status.pluginEnabled": "{name} 已启用",
    "status.pluginFileDone": "{operation} 完成",
    "status.pluginFileNoSession": "请先打开或选择一个终端会话。",
    "status.pluginFileUploadDone": "已上传 {name}",
    "status.pluginLoadFailed": "插件加载失败：{message}",
    "status.pluginsLoading": "正在加载插件...",
    "status.pluginsReady": "{count} 个插件已就绪",
    "status.processExited": "进程已退出：{code}",
    "status.reconnecting": "连接已断开，{seconds}s 后重连...",
    "status.selectRunningInstance": "请先选择运行中的实例。",
    "status.selectionCopied": "选区已复制",
    "status.shellReady": "Shell 已就绪",
    "status.socketError": "Socket 错误",
    "status.startupFailed": "启动失败：{message}",
    "status.sessionStopped": "会话已停止",
    "status.terminalError": "终端错误",
    "status.themeInvalid": "主题无效：{message}",
    "status.themeRemoved": "{name} 已删除",
    "status.themeSaved": "{name} 已保存",
    "theme.builtIn": "内置",
    "theme.custom": "自定义",
    "theme.gallery": "Ghostty 主题库",
    "theme.noCustom": "暂无自定义主题",
    "theme.recommended": "推荐",
    "touch.drag": "拖动选区",
    "touch.longPress": "滑动优先，长按选区",
    "touch.off": "关闭触控选区",
    "validation.fontExtension": "只允许 .woff、.woff2、.ttf 和 .otf",
    "validation.fontMime": "不支持的字体 MIME 类型：{mimeType}",
    "validation.fontSize": "字体大小必须在 1 字节到 10 MB 之间",
    "validation.backgroundExtension": "只允许 .png、.jpg、.jpeg 和 .webp",
    "validation.backgroundMime": "不支持的背景图片 MIME 类型：{mimeType}",
    "validation.backgroundSize": "背景图片大小必须在 1 字节到 10 MB 之间",
    "validation.aiAccess": "请输入 Base URL 和 API Key",
    "validation.aiPrompt": "请输入内容",
    "validation.pluginPath": "请输入目标路径",
    "validation.themeName": "请输入主题名称",
    "validation.themeSource": "请粘贴包含 background、foreground 或 palette 的 Ghostty 主题",
  },
};

export function resolveLanguage(locale: LocaleSetting): Language {
  if (locale === "en" || locale === "zh-CN") return locale;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function translate(locale: LocaleSetting, key: MessageKey, values: Record<string, string | number> = {}): string {
  const template = messages[resolveLanguage(locale)][key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}

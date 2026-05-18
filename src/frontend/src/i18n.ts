import type { LocaleSetting } from "./types";

type Language = "en" | "zh-CN";

export type MessageKey =
  | "action.closeActiveSession"
  | "action.closeSettings"
  | "action.copySelection"
  | "action.focusTerminal"
  | "action.fullscreen"
  | "action.lightosHome"
  | "action.newTab"
  | "action.pasteClipboard"
  | "action.promoteSessionToTab"
  | "action.refreshInstances"
  | "action.removeFont"
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
  | "app.title"
  | "cursor.bar"
  | "cursor.block"
  | "cursor.underline"
  | "field.cursor"
  | "field.font"
  | "field.fontPreview"
  | "field.fontSize"
  | "field.language"
  | "field.lineHeight"
  | "field.outputBuffer"
  | "field.scrollback"
  | "field.tabs"
  | "field.theme"
  | "field.themeName"
  | "field.themeSource"
  | "field.touchBehavior"
  | "font.builtIn"
  | "font.noUploaded"
  | "font.uploaded"
  | "layout.horizontal"
  | "layout.vertical"
  | "locale.auto"
  | "locale.en"
  | "locale.zhCN"
  | "menu.instances"
  | "menu.mobileShortcuts"
  | "menu.pane"
  | "section.appearance"
  | "section.fonts"
  | "section.themes"
  | "setting.autoRestartSessions"
  | "setting.copyOnSelect"
  | "setting.cursorBlink"
  | "setting.debugAdapter"
  | "setting.useResttyClipboard"
  | "tab.appearance"
  | "tab.fonts"
  | "tab.fontSettings"
  | "tab.fontUpload"
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
  | "status.noSelection"
  | "status.noSessions"
  | "status.noTarget"
  | "status.pasteFailed"
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
  | "validation.themeName"
  | "validation.themeSource";

const messages: Record<Language, Record<MessageKey, string>> = {
  en: {
    "action.closeActiveSession": "Close active session",
    "action.closeSettings": "Close settings",
    "action.copySelection": "Copy selection",
    "action.focusTerminal": "Focus terminal",
    "action.fullscreen": "Full screen",
    "action.lightosHome": "LightOS home",
    "action.newTab": "New terminal tab",
    "action.pasteClipboard": "Paste",
    "action.promoteSessionToTab": "Move session to new tab",
    "action.refreshInstances": "Refresh instances",
    "action.removeFont": "Remove selected font",
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
    "app.title": "LazyCat Neko WebShell",
    "cursor.bar": "Bar",
    "cursor.block": "Block",
    "cursor.underline": "Underline",
    "field.cursor": "Cursor",
    "field.font": "Font",
    "field.fontPreview": "Font preview",
    "field.fontSize": "Font size",
    "field.language": "Language",
    "field.lineHeight": "Line height",
    "field.outputBuffer": "Output buffer",
    "field.scrollback": "Scrollback",
    "field.tabs": "Tabs",
    "field.theme": "Theme",
    "field.themeName": "Theme name",
    "field.themeSource": "Ghostty theme",
    "field.touchBehavior": "Touch behavior",
    "font.builtIn": "Built in",
    "font.noUploaded": "No uploaded fonts",
    "font.uploaded": "Uploaded",
    "layout.horizontal": "Horizontal",
    "layout.vertical": "Vertical",
    "locale.auto": "Auto",
    "locale.en": "English",
    "locale.zhCN": "Chinese",
    "menu.instances": "Instances",
    "menu.mobileShortcuts": "Terminal shortcuts",
    "menu.pane": "Pane menu",
    "section.appearance": "Appearance",
    "section.fonts": "Fonts",
    "section.themes": "Themes",
    "setting.autoRestartSessions": "Restart sessions after provider restart",
    "setting.copyOnSelect": "Copy on select",
    "setting.cursorBlink": "Cursor blink",
    "setting.debugAdapter": "Debug adapter",
    "setting.useResttyClipboard": "Use restty clipboard",
    "tab.appearance": "Appearance",
    "tab.fonts": "Fonts",
    "tab.fontSettings": "Font settings",
    "tab.fontUpload": "Font upload",
    "tab.themes": "Themes",
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
    "status.noSelection": "No selection to copy",
    "status.noSessions": "No sessions",
    "status.noTarget": "No instance selected",
    "status.pasteFailed": "Paste failed: {message}",
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
    "validation.themeName": "theme name is required",
    "validation.themeSource": "paste a Ghostty theme with background, foreground, or palette entries",
  },
  "zh-CN": {
    "action.closeActiveSession": "关闭当前活动会话",
    "action.closeSettings": "关闭设置",
    "action.copySelection": "复制选区",
    "action.focusTerminal": "聚焦终端",
    "action.fullscreen": "全屏",
    "action.lightosHome": "LightOS 首页",
    "action.newTab": "新建终端标签",
    "action.pasteClipboard": "粘贴",
    "action.promoteSessionToTab": "将会话提升为新标签",
    "action.refreshInstances": "刷新实例",
    "action.removeFont": "移除当前字体",
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
    "app.title": "LazyCat Neko WebShell",
    "cursor.bar": "竖线",
    "cursor.block": "块",
    "cursor.underline": "下划线",
    "field.cursor": "光标",
    "field.font": "字体",
    "field.fontPreview": "字体预览",
    "field.fontSize": "字号",
    "field.language": "语言",
    "field.lineHeight": "行高",
    "field.outputBuffer": "输出缓冲",
    "field.scrollback": "回滚行数",
    "field.tabs": "标签栏",
    "field.theme": "主题",
    "field.themeName": "主题名称",
    "field.themeSource": "Ghostty 主题",
    "field.touchBehavior": "触控行为",
    "font.builtIn": "内置",
    "font.noUploaded": "暂无上传字体",
    "font.uploaded": "已上传",
    "layout.horizontal": "横向",
    "layout.vertical": "竖向",
    "locale.auto": "跟随系统",
    "locale.en": "English",
    "locale.zhCN": "中文",
    "menu.instances": "实例",
    "menu.mobileShortcuts": "终端快捷键",
    "menu.pane": "终端面板菜单",
    "section.appearance": "外观",
    "section.fonts": "字体",
    "section.themes": "主题",
    "setting.autoRestartSessions": "Provider 重启后自动恢复会话",
    "setting.copyOnSelect": "选中即复制",
    "setting.cursorBlink": "光标闪烁",
    "setting.debugAdapter": "调试适配器",
    "setting.useResttyClipboard": "使用 restty 剪贴板",
    "tab.appearance": "外观",
    "tab.fonts": "字体",
    "tab.fontSettings": "字体设置",
    "tab.fontUpload": "字体上传",
    "tab.themes": "主题",
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
    "status.noSelection": "没有可复制的选区",
    "status.noSessions": "没有会话",
    "status.noTarget": "未选择实例",
    "status.pasteFailed": "粘贴失败：{message}",
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

import type { LocaleSetting } from "./types";

type Language = "en" | "zh-CN";

export type MessageKey =
  | "ai.accessHelp"
  | "ai.mcpEmpty"
  | "ai.mcpHeadersHelp"
  | "ai.mcpHelp"
  | "ai.providerAnthropic"
  | "ai.providerOpenAICompatible"
  | "ai.providerOpenAIResponses"
  | "about.description"
  | "about.note"
  | "about.session"
  | "about.sessionValue"
  | "about.title"
  | "about.tools"
  | "about.toolsValue"
  | "about.version"
  | "action.about"
  | "action.aiChat"
  | "action.aiClear"
  | "action.aiConfigure"
  | "action.aiCopy"
  | "action.aiExport"
  | "action.aiFetchModels"
  | "action.aiNewChat"
  | "action.aiProviderAdd"
  | "action.aiProviderEdit"
  | "action.aiProviderRemove"
  | "action.aiProviderSelect"
  | "action.aiSend"
  | "action.aiTest"
  | "action.cancel"
  | "action.close"
  | "action.closeActiveSession"
  | "action.closeHerdrSpace"
  | "action.closePlugins"
  | "action.closeSettings"
  | "action.copySelection"
  | "action.detectLocalFonts"
  | "action.focusTerminal"
  | "action.fullscreen"
  | "action.lightosHome"
  | "action.mcpAdd"
  | "action.mcpEdit"
  | "action.mcpRemove"
  | "action.newHerdrSpace"
  | "action.newHerdrTab"
  | "action.newTab"
  | "action.pasteClipboard"
  | "action.pluginFileDownload"
  | "action.pluginFileHome"
  | "action.pluginFileList"
  | "action.pluginFileOpen"
  | "action.pluginFileParent"
  | "action.pluginFileRead"
  | "action.pluginFileRefresh"
  | "action.pluginFileStat"
  | "action.pluginFileSyncCwd"
  | "action.pluginFileUpload"
  | "action.promoteSessionToTab"
  | "action.refreshHerdr"
  | "action.refreshInstances"
  | "action.refreshPlugins"
  | "action.removeFont"
  | "action.removeTerminalBackground"
  | "action.removeTheme"
  | "action.saveTheme"
  | "action.save"
  | "action.settings"
  | "action.settingsMenu"
  | "action.shortcutHelp"
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
  | "backend.herdr"
  | "backend.webshell"
  | "backend.zellij"
  | "confirm.closeTab"
  | "cursor.bar"
  | "cursor.block"
  | "cursor.underline"
  | "field.cursor"
  | "field.font"
  | "field.fontHintTarget"
  | "field.fontPreview"
  | "field.fontSize"
  | "field.aiApiKey"
  | "field.aiBaseUrl"
  | "field.aiModel"
  | "field.aiProfileName"
  | "field.aiPrompt"
  | "field.aiProvider"
  | "field.aiSession"
  | "field.defaultSessionBackend"
  | "field.herdrActiveBackgroundDark"
  | "field.herdrActiveBackgroundLight"
  | "field.interfaceStyle"
  | "field.language"
  | "field.lineHeight"
  | "field.mcpAuthorization"
  | "field.mcpHeaders"
  | "field.mcpName"
  | "field.mcpTransport"
  | "field.mcpUrl"
  | "field.outputBuffer"
  | "field.panes"
  | "field.pluginPath"
  | "field.scrollback"
  | "field.tabs"
  | "field.terminalBackgroundBlur"
  | "field.terminalBackgroundOpacity"
  | "field.terminalShaderEffect"
  | "field.theme"
  | "field.themeName"
  | "field.themeSource"
  | "field.touchBehavior"
  | "fileKind.directory"
  | "fileKind.file"
  | "fileKind.hardlink"
  | "fileKind.other"
  | "fileKind.symlink"
  | "font.builtIn"
  | "font.local"
  | "font.noLocal"
  | "font.noUploaded"
  | "font.uploaded"
  | "hint.auto"
  | "hint.light"
  | "hint.normal"
  | "interfaceStyle.brass"
  | "interfaceStyle.candy"
  | "interfaceStyle.champagne"
  | "interfaceStyle.frost"
  | "interfaceStyle.geek"
  | "interfaceStyle.glass"
  | "interfaceStyle.lab"
  | "interfaceStyle.porcelain"
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
  | "mcp.transportHttp"
  | "mcp.transportSse"
  | "plugin.aiChat.description"
  | "plugin.aiChat.block"
  | "plugin.aiChat.name"
  | "plugin.aiChat.output"
  | "plugin.fileTransfer.help"
  | "plugin.fileTransfer.output"
  | "plugin.fileTransfer.description"
  | "plugin.fileTransfer.name"
  | "plugin.meta.ai"
  | "plugin.meta.filesystem"
  | "plugin.meta.session"
  | "plugin.meta.transfer"
  | "section.appearance"
  | "section.aiAccess"
  | "section.fileTransfer"
  | "section.fonts"
  | "section.desktopShortcuts"
  | "section.herdr"
  | "section.herdrTabs"
  | "section.herdrWorkspaces"
  | "section.plugins"
  | "section.herdrHighlight"
  | "section.mobileShortcuts"
  | "section.sessionBackend"
  | "section.shortcuts"
  | "section.terminalBackground"
  | "section.themes"
  | "setting.autoRestartSessions"
  | "setting.copyOnSelect"
  | "setting.cursorBlink"
  | "setting.debugAdapter"
  | "setting.defaultSessionBackendHelp"
  | "setting.aiTerminalContext"
  | "setting.fontHinting"
  | "setting.fontLigatures"
  | "setting.fontRenderingHelp"
  | "setting.herdrHighlightHelp"
  | "setting.pluginDisabled"
  | "setting.pluginEnabled"
  | "setting.terminalBackground"
  | "setting.terminalShaderHelp"
  | "setting.useResttyClipboard"
  | "shader.interactiveGlow"
  | "shader.off"
  | "shader.scanline"
  | "shader.softVignette"
  | "shortcut.closeTab"
  | "shortcut.copyPaste"
  | "shortcut.mobileFont"
  | "shortcut.mobileKeyboard"
  | "shortcut.mobileKeys"
  | "shortcut.mobileTab"
  | "shortcut.newTab"
  | "shortcut.resetFont"
  | "shortcut.splitPane"
  | "shortcut.zoomFont"
  | "tab.appearance"
  | "tab.fonts"
  | "tab.fontSettings"
  | "tab.fontUpload"
  | "tab.aiProvider"
  | "tab.mcp"
  | "tab.plugins"
  | "tab.themes"
  | "status.closed"
  | "status.connected"
  | "status.connectFailed"
  | "status.copyFailed"
  | "status.creatingSession"
  | "status.defaultBackend"
  | "status.fontDeleteFailed"
  | "status.fontLoadFailed"
  | "status.localFontsLoaded"
  | "status.localFontsUnavailable"
  | "status.fontReady"
  | "status.fontsReady"
  | "status.fontRegistrationFailed"
  | "status.fontRemoved"
  | "status.fontUploadFailed"
  | "status.backgroundReady"
  | "status.backgroundRemoved"
  | "status.backgroundUploadFailed"
  | "status.backgroundDeleteFailed"
  | "status.backendActionFailed"
  | "status.backendActionUnavailable"
  | "status.herdrActionFailed"
  | "status.herdrEvent"
  | "status.herdrEventAgent"
  | "status.herdrEntryRestored"
  | "status.herdrNotification"
  | "status.herdrUnavailable"
  | "status.herdrWorkspaceFocused"
  | "status.idle"
  | "status.imageUploadDone"
  | "status.imageUploadFailed"
  | "status.imageUploadStarted"
  | "status.instance"
  | "status.instanceLoadFailed"
  | "status.instancesLoaded"
  | "status.instanceFallback"
  | "status.lightosHomeFailed"
  | "status.lightosHomeLoading"
  | "status.loadingGhostty"
  | "status.loadingInstances"
  | "status.mcpServerRemoved"
  | "status.mcpServerSaved"
  | "status.noInstances"
  | "status.noInstancesVisible"
  | "status.noPlugins"
  | "status.noSelection"
  | "status.noSessions"
  | "status.noTarget"
  | "status.pasteFailed"
  | "status.aiConfigSaved"
  | "status.aiModelsReady"
  | "status.aiNoOutput"
  | "status.aiTestOk"
  | "status.aiWorking"
  | "status.pluginDisableFailed"
  | "status.pluginDisabled"
  | "status.pluginEnableFailed"
  | "status.pluginEnabled"
  | "status.pluginFileDone"
  | "status.pluginFileEmpty"
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
  | "validation.mcpUrl"
  | "validation.pluginPath"
  | "validation.themeName"
  | "validation.themeSource";

const messages: Record<Language, Record<MessageKey, string>> = {
  en: {
    "about.description": "Browser terminal for LightOS devices.",
    "about.note": "Built for fast terminal access from desktop and mobile browsers.",
    "about.session": "Sessions",
    "about.sessionValue": "Native WebShell and Herdr spaces",
    "about.title": "About Neko Webshell",
    "about.tools": "Tools",
    "about.toolsValue": "Files, themes, fonts, and chat",
    "about.version": "Version",
    "action.about": "About",
    "action.aiChat": "Chat",
    "action.aiClear": "Clear",
    "action.aiConfigure": "Configure",
    "action.aiCopy": "Copy",
    "action.aiExport": "Export chat",
    "action.aiFetchModels": "Fetch models",
    "action.aiNewChat": "New chat",
    "action.aiProviderAdd": "Add provider",
    "action.aiProviderEdit": "Edit provider",
    "action.aiProviderRemove": "Remove provider",
    "action.aiProviderSelect": "Switch provider",
    "action.aiSend": "Send",
    "action.aiTest": "Test",
    "action.cancel": "Cancel",
    "action.close": "Close",
    "action.closeActiveSession": "Close active session",
    "action.closeHerdrSpace": "Close Herdr space",
    "action.closePlugins": "Close plugins",
    "action.closeSettings": "Close settings",
    "action.copySelection": "Copy selection",
    "action.detectLocalFonts": "Detect local fonts",
    "action.focusTerminal": "Focus terminal",
    "action.fullscreen": "Full screen",
    "action.lightosHome": "LightOS home",
    "action.mcpAdd": "Add MCP server",
    "action.mcpEdit": "Edit MCP server",
    "action.mcpRemove": "Remove MCP server",
    "action.newHerdrSpace": "New Herdr space",
    "action.newHerdrTab": "New Herdr tab",
    "action.newTab": "New terminal tab",
    "action.pasteClipboard": "Paste",
    "action.pluginFileDownload": "Download",
    "action.pluginFileHome": "Home",
    "action.pluginFileList": "List",
    "action.pluginFileOpen": "Open",
    "action.pluginFileParent": "Parent",
    "action.pluginFileRead": "Read",
    "action.pluginFileRefresh": "Refresh",
    "action.pluginFileStat": "Stat",
    "action.pluginFileSyncCwd": "Use terminal cwd",
    "action.pluginFileUpload": "Upload file",
    "action.promoteSessionToTab": "Move session to new tab",
    "action.refreshHerdr": "Refresh Herdr",
    "action.refreshInstances": "Refresh instances",
    "action.refreshPlugins": "Refresh plugins",
    "action.removeFont": "Remove selected font",
    "action.removeTerminalBackground": "Remove terminal background",
    "action.removeTheme": "Remove custom theme",
    "action.save": "Save",
    "action.saveTheme": "Save custom theme",
    "action.settings": "Settings",
    "action.settingsMenu": "Settings menu",
    "action.shortcutHelp": "Keyboard shortcuts",
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
    "backend.herdr": "Herdr",
    "backend.webshell": "WebShell native",
    "backend.zellij": "zellij",
    "confirm.closeTab": "Close terminal tab \"{name}\"?",
    "cursor.bar": "Bar",
    "cursor.block": "Block",
    "cursor.underline": "Underline",
    "field.cursor": "Cursor",
    "field.font": "Font",
    "field.fontHintTarget": "Hinting mode",
    "field.fontPreview": "Font preview",
    "field.fontSize": "Font size",
    "field.aiApiKey": "API key",
    "field.aiBaseUrl": "Base URL",
    "field.aiModel": "Model",
    "field.aiProfileName": "Profile name",
    "field.aiPrompt": "Prompt",
    "field.aiProvider": "Provider",
    "field.aiSession": "Chat",
    "field.defaultSessionBackend": "New tab backend",
    "field.herdrActiveBackgroundDark": "Dark highlight",
    "field.herdrActiveBackgroundLight": "Light highlight",
    "field.interfaceStyle": "Interface style",
    "field.language": "Language",
    "field.lineHeight": "Line height",
    "field.mcpAuthorization": "Authorization",
    "field.mcpHeaders": "Headers",
    "field.mcpName": "Name",
    "field.mcpTransport": "Transport",
    "field.mcpUrl": "MCP URL",
    "field.outputBuffer": "History lines",
    "field.panes": "Panes",
    "field.pluginPath": "Path",
    "field.scrollback": "Scrollback",
    "field.tabs": "Tabs",
    "field.terminalBackgroundBlur": "Background blur",
    "field.terminalBackgroundOpacity": "Background opacity",
    "field.terminalShaderEffect": "Terminal effect",
    "field.theme": "Terminal theme",
    "field.themeName": "Theme name",
    "field.themeSource": "Ghostty theme",
    "field.touchBehavior": "Touch behavior",
    "fileKind.directory": "Directory",
    "fileKind.file": "File",
    "fileKind.hardlink": "Hard link",
    "fileKind.other": "Other",
    "fileKind.symlink": "Symlink",
    "font.builtIn": "Built in",
    "font.local": "Local",
    "font.noLocal": "No local fonts detected",
    "font.noUploaded": "No uploaded fonts",
    "font.uploaded": "Uploaded",
    "hint.auto": "Auto",
    "hint.light": "Light",
    "hint.normal": "Normal",
    "interfaceStyle.brass": "Brass",
    "interfaceStyle.candy": "Candy",
    "interfaceStyle.champagne": "Champagne",
    "interfaceStyle.frost": "Frost",
    "interfaceStyle.geek": "Geek",
    "interfaceStyle.glass": "Glass",
    "interfaceStyle.lab": "Lab",
    "interfaceStyle.porcelain": "Porcelain",
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
    "mcp.transportHttp": "Streamable HTTP",
    "mcp.transportSse": "SSE",
    "ai.accessHelp": "Configure the OpenAI-compatible endpoint used by WebShell Chat. Chat does not control the terminal.",
    "ai.mcpEmpty": "No MCP servers configured",
    "ai.mcpHeadersHelp": "Add one header per line, for example: X-Header: value.",
    "ai.mcpHelp": "Connect remote MCP servers so chat can use their tools. Local stdio servers are not supported in this version.",
    "ai.providerAnthropic": "Anthropic Claude",
    "ai.providerOpenAICompatible": "OpenAI-compatible",
    "ai.providerOpenAIResponses": "OpenAI Responses",
    "plugin.aiChat.block": "Chat",
    "plugin.aiChat.description": "Chat tool inside WebShell for command help, troubleshooting, and notes.",
    "plugin.aiChat.name": "AI Chat",
    "plugin.aiChat.output": "AI chat output",
    "plugin.fileTransfer.description": "Browse device files, upload multiple local files, and download selected device paths.",
    "plugin.fileTransfer.help": "Device side uses the active terminal session and login user. The browser can choose local files, but cannot expose a local directory tree.",
    "plugin.fileTransfer.name": "File transfer",
    "plugin.fileTransfer.output": "File transfer output",
    "plugin.meta.ai": "AI",
    "plugin.meta.filesystem": "Filesystem",
    "plugin.meta.session": "Session",
    "plugin.meta.transfer": "Transfer",
    "section.appearance": "Appearance",
    "section.aiAccess": "AI access",
    "section.fileTransfer": "File transfer",
    "section.fonts": "Fonts",
    "section.desktopShortcuts": "Desktop",
    "section.herdr": "Herdr controls",
    "section.herdrTabs": "Herdr tabs",
    "section.herdrWorkspaces": "Herdr spaces",
    "section.herdrHighlight": "Herdr selection",
    "section.mobileShortcuts": "Mobile",
    "section.plugins": "Plugins",
    "section.sessionBackend": "Session backend",
    "section.shortcuts": "Shortcuts",
    "section.terminalBackground": "Terminal background",
    "section.themes": "Terminal themes",
    "setting.autoRestartSessions": "Restart sessions after provider restart",
    "setting.copyOnSelect": "Copy on select",
    "setting.cursorBlink": "Cursor blink",
    "setting.debugAdapter": "Debug adapter",
    "setting.defaultSessionBackendHelp": "The + button uses this backend. If Herdr already has an engine pane, + creates a new Herdr workspace inside that session.",
    "setting.aiTerminalContext": "Terminal context",
    "setting.fontHinting": "Font hinting",
    "setting.fontLigatures": "Programming ligatures",
    "setting.fontRenderingHelp": "Ligatures shape operators such as => and !=. Font hinting can sharpen small text, but may cost extra rasterization time.",
    "setting.herdrHighlightHelp": "Customize the active Herdr workspace and tab background for dark and light interface styles.",
    "setting.pluginDisabled": "Disabled",
    "setting.pluginEnabled": "Enabled",
    "setting.terminalBackground": "Use background image",
    "setting.terminalShaderHelp": "GPU effects are off by default. Enable them only when you want extra terminal feedback.",
    "setting.useResttyClipboard": "Use restty clipboard",
    "shader.interactiveGlow": "Input glow",
    "shader.off": "Off",
    "shader.scanline": "Scanline",
    "shader.softVignette": "Soft vignette",
    "shortcut.closeTab": "Close tab",
    "shortcut.copyPaste": "Copy or paste",
    "shortcut.mobileFont": "Adjust terminal font",
    "shortcut.mobileKeyboard": "Open system keyboard",
    "shortcut.mobileKeys": "Send terminal keys",
    "shortcut.mobileTab": "Switch or create tabs",
    "shortcut.newTab": "New terminal tab",
    "shortcut.resetFont": "Reset terminal font",
    "shortcut.splitPane": "Split pane",
    "shortcut.zoomFont": "Adjust terminal font",
    "tab.appearance": "Appearance",
    "tab.fonts": "Fonts",
    "tab.fontSettings": "Font settings",
    "tab.fontUpload": "Font upload",
    "tab.aiProvider": "AI provider",
    "tab.mcp": "MCP",
    "tab.plugins": "Plugins",
    "tab.themes": "Terminal",
    "status.closed": "Closed",
    "status.connected": "Connected",
    "status.connectFailed": "Connect failed: {message}",
    "status.copyFailed": "Copy failed: {message}",
    "status.creatingSession": "Creating session...",
    "status.defaultBackend": "Default",
    "status.fontDeleteFailed": "Font delete failed: {message}",
    "status.fontLoadFailed": "Font load failed: {message}",
    "status.localFontsLoaded": "{count} local font(s) detected",
    "status.localFontsUnavailable": "Local fonts unavailable: {message}",
    "status.fontReady": "{name} ready",
    "status.fontsReady": "{count} uploaded font(s) ready",
    "status.fontRegistrationFailed": "font registration failed",
    "status.fontRemoved": "{name} removed",
    "status.fontUploadFailed": "Font upload failed: {message}",
    "status.backgroundReady": "Terminal background ready",
    "status.backgroundRemoved": "Terminal background removed",
    "status.backgroundUploadFailed": "Background upload failed: {message}",
    "status.backgroundDeleteFailed": "Background delete failed: {message}",
    "status.backendActionFailed": "{backend} action failed: {message}",
    "status.backendActionUnavailable": "{backend} does not support this pane action",
    "status.herdrActionFailed": "Herdr action failed: {message}",
    "status.herdrEvent": "Herdr {event}: {subject}",
    "status.herdrEventAgent": "Herdr {agent}: {status}",
    "status.herdrEntryRestored": "Herdr entry restored",
    "status.herdrNotification": "Herdr: {message}",
    "status.herdrUnavailable": "Herdr socket unavailable",
    "status.herdrWorkspaceFocused": "Herdr workspace focused",
    "status.idle": "Idle",
    "status.imageUploadDone": "Image uploaded",
    "status.imageUploadFailed": "Image upload failed: {message}",
    "status.imageUploadStarted": "Uploading image...",
    "status.instance": "Instance",
    "status.instanceLoadFailed": "Instance load failed: {message}",
    "status.instancesLoaded": "Instances loaded",
    "status.instanceFallback": "Requested instance is not running. Opened {selector}.",
    "status.lightosHomeFailed": "LightOS home failed: {message}",
    "status.lightosHomeLoading": "Opening LightOS home...",
    "status.loadingGhostty": "Loading terminal renderer...",
    "status.loadingInstances": "Loading instances...",
    "status.mcpServerRemoved": "MCP server removed",
    "status.mcpServerSaved": "MCP server saved",
    "status.noInstances": "No instances returned",
    "status.noInstancesVisible": "No LightOS instances visible.",
    "status.noPlugins": "No plugins returned",
    "status.noSelection": "No selection to copy",
    "status.noSessions": "No sessions",
    "status.noTarget": "No instance selected",
    "status.pasteFailed": "Paste failed: {message}",
    "status.aiConfigSaved": "AI settings saved",
    "status.aiModelsReady": "{count} model(s) loaded",
    "status.aiNoOutput": "No AI output",
    "status.aiTestOk": "AI test passed",
    "status.aiWorking": "AI request running...",
    "status.pluginDisableFailed": "Disable failed: {message}",
    "status.pluginDisabled": "{name} disabled",
    "status.pluginEnableFailed": "Enable failed: {message}",
    "status.pluginEnabled": "{name} enabled",
    "status.pluginFileDone": "{operation} complete",
    "status.pluginFileEmpty": "This directory is empty",
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
    "validation.mcpUrl": "enter an MCP server URL",
    "validation.pluginPath": "enter a target path",
    "validation.themeName": "theme name is required",
    "validation.themeSource": "paste a Ghostty theme with background, foreground, or palette entries",
  },
  "zh-CN": {
    "about.description": "面向 LightOS 设备的浏览器终端。",
    "about.note": "为桌面和移动浏览器上的快速终端访问而构建。",
    "about.session": "会话",
    "about.sessionValue": "原生 WebShell 和 Herdr Spaces",
    "about.title": "关于小橘Web Shell",
    "about.tools": "工具",
    "about.toolsValue": "文件、主题、字体和 Chat",
    "about.version": "版本",
    "action.about": "关于",
    "action.aiChat": "对话",
    "action.aiClear": "清空",
    "action.aiConfigure": "配置",
    "action.aiCopy": "复制",
    "action.aiExport": "导出聊天",
    "action.aiFetchModels": "获取模型",
    "action.aiNewChat": "新建聊天",
    "action.aiProviderAdd": "添加服务",
    "action.aiProviderEdit": "编辑服务",
    "action.aiProviderRemove": "删除服务",
    "action.aiProviderSelect": "切换服务",
    "action.aiSend": "发送",
    "action.aiTest": "测试",
    "action.cancel": "取消",
    "action.close": "关闭",
    "action.closeActiveSession": "关闭当前活动会话",
    "action.closeHerdrSpace": "关闭 Herdr Space",
    "action.closePlugins": "关闭插件",
    "action.closeSettings": "关闭设置",
    "action.copySelection": "复制选区",
    "action.detectLocalFonts": "检测本地字体",
    "action.focusTerminal": "聚焦终端",
    "action.fullscreen": "全屏",
    "action.lightosHome": "LightOS 首页",
    "action.mcpAdd": "添加 MCP 服务",
    "action.mcpEdit": "编辑 MCP 服务",
    "action.mcpRemove": "移除 MCP 服务",
    "action.newHerdrSpace": "新建 Herdr Space",
    "action.newHerdrTab": "新建 Herdr 标签",
    "action.newTab": "新建终端标签",
    "action.pasteClipboard": "粘贴",
    "action.pluginFileDownload": "下载",
    "action.pluginFileHome": "根目录",
    "action.pluginFileList": "列出",
    "action.pluginFileOpen": "打开",
    "action.pluginFileParent": "上级",
    "action.pluginFileRead": "查看",
    "action.pluginFileRefresh": "刷新",
    "action.pluginFileStat": "信息",
    "action.pluginFileSyncCwd": "使用终端目录",
    "action.pluginFileUpload": "上传文件",
    "action.promoteSessionToTab": "将会话提升为新标签",
    "action.refreshHerdr": "刷新 Herdr",
    "action.refreshInstances": "刷新实例",
    "action.refreshPlugins": "刷新插件",
    "action.removeFont": "移除当前字体",
    "action.removeTerminalBackground": "移除终端背景",
    "action.removeTheme": "删除自定义主题",
    "action.save": "保存",
    "action.saveTheme": "保存自定义主题",
    "action.settings": "设置",
    "action.settingsMenu": "设置菜单",
    "action.shortcutHelp": "快捷键",
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
    "backend.herdr": "Herdr",
    "backend.webshell": "WebShell 原生",
    "backend.zellij": "zellij",
    "confirm.closeTab": "关闭终端标签“{name}”？",
    "cursor.bar": "竖线",
    "cursor.block": "块",
    "cursor.underline": "下划线",
    "field.cursor": "光标",
    "field.font": "字体",
    "field.fontHintTarget": "微调模式",
    "field.fontPreview": "字体预览",
    "field.fontSize": "字号",
    "field.aiApiKey": "API Key",
    "field.aiBaseUrl": "Base URL",
    "field.aiModel": "模型",
    "field.aiProfileName": "配置名称",
    "field.aiPrompt": "输入",
    "field.aiProvider": "服务商",
    "field.aiSession": "聊天",
    "field.defaultSessionBackend": "新建入口后端",
    "field.herdrActiveBackgroundDark": "深色高亮",
    "field.herdrActiveBackgroundLight": "浅色高亮",
    "field.interfaceStyle": "界面风格",
    "field.language": "语言",
    "field.lineHeight": "行高",
    "field.mcpAuthorization": "Authorization",
    "field.mcpHeaders": "请求头",
    "field.mcpName": "名称",
    "field.mcpTransport": "传输方式",
    "field.mcpUrl": "MCP URL",
    "field.outputBuffer": "历史行数",
    "field.panes": "面板",
    "field.pluginPath": "路径",
    "field.scrollback": "回滚行数",
    "field.tabs": "标签栏",
    "field.terminalBackgroundBlur": "背景模糊",
    "field.terminalBackgroundOpacity": "背景透明度",
    "field.terminalShaderEffect": "终端特效",
    "field.theme": "终端主题",
    "field.themeName": "主题名称",
    "field.themeSource": "Ghostty 主题",
    "field.touchBehavior": "触控行为",
    "fileKind.directory": "目录",
    "fileKind.file": "文件",
    "fileKind.hardlink": "硬链接",
    "fileKind.other": "其他",
    "fileKind.symlink": "软链接",
    "font.builtIn": "内置",
    "font.local": "本地",
    "font.noLocal": "尚未检测本地字体",
    "font.noUploaded": "暂无上传字体",
    "font.uploaded": "已上传",
    "hint.auto": "自动",
    "hint.light": "轻微",
    "hint.normal": "标准",
    "interfaceStyle.brass": "黄铜",
    "interfaceStyle.candy": "糖果彩",
    "interfaceStyle.champagne": "浅黄铜",
    "interfaceStyle.frost": "晴空玻璃",
    "interfaceStyle.geek": "Geek 风",
    "interfaceStyle.glass": "磨砂玻璃",
    "interfaceStyle.lab": "实验室",
    "interfaceStyle.porcelain": "瓷白",
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
    "mcp.transportHttp": "Streamable HTTP",
    "mcp.transportSse": "SSE",
    "ai.accessHelp": "配置 WebShell Chat 使用的 OpenAI-compatible 接口。聊天不会控制终端。",
    "ai.mcpEmpty": "还没有配置 MCP 服务",
    "ai.mcpHeadersHelp": "每行填写一个请求头，例如：X-Header: value。",
    "ai.mcpHelp": "连接远程 MCP 服务，让 Chat 可以调用这些服务提供的工具。本版本暂不支持本地 stdio 服务。",
    "ai.providerAnthropic": "Anthropic Claude",
    "ai.providerOpenAICompatible": "OpenAI-compatible",
    "ai.providerOpenAIResponses": "OpenAI Responses",
    "plugin.aiChat.block": "聊天",
    "plugin.aiChat.description": "WebShell 内的 Chat 工具，可用于命令辅助、问题排查和记录整理。",
    "plugin.aiChat.name": "AI Chat",
    "plugin.aiChat.output": "AI 聊天输出",
    "plugin.fileTransfer.description": "浏览设备文件，上传多个本地文件，并下载选中的设备路径。",
    "plugin.fileTransfer.help": "设备侧使用当前活动终端会话和登录用户；浏览器可以选择本地文件，但不能暴露本地目录树。",
    "plugin.fileTransfer.name": "文件传输",
    "plugin.fileTransfer.output": "文件传输输出",
    "plugin.meta.ai": "AI",
    "plugin.meta.filesystem": "文件系统",
    "plugin.meta.session": "会话",
    "plugin.meta.transfer": "传输",
    "section.appearance": "外观",
    "section.aiAccess": "AI 接入",
    "section.fileTransfer": "文件传输",
    "section.fonts": "字体",
    "section.desktopShortcuts": "桌面端",
    "section.herdr": "Herdr 控件",
    "section.herdrTabs": "Herdr 标签",
    "section.herdrWorkspaces": "Herdr Spaces",
    "section.herdrHighlight": "Herdr 选中态",
    "section.mobileShortcuts": "移动端",
    "section.plugins": "插件",
    "section.sessionBackend": "会话后端",
    "section.shortcuts": "快捷键",
    "section.terminalBackground": "终端背景",
    "section.themes": "终端主题",
    "setting.autoRestartSessions": "Provider 重启后自动恢复会话",
    "setting.copyOnSelect": "选中即复制",
    "setting.cursorBlink": "光标闪烁",
    "setting.debugAdapter": "调试适配器",
    "setting.defaultSessionBackendHelp": "+ 按钮使用这个后端创建。Herdr 已有引擎入口时，再点 + 会在同一个 Herdr session 里新建 Workspace。",
    "setting.aiTerminalContext": "终端上下文",
    "setting.fontHinting": "字体微调",
    "setting.fontLigatures": "编程连字",
    "setting.fontRenderingHelp": "编程连字会渲染 =>、!= 这类符号；字体微调可以让小字号更锐利，但可能增加一点字体栅格化开销。",
    "setting.herdrHighlightHelp": "分别设置深色和浅色界面风格下，Herdr 当前工作区和标签的背景色。",
    "setting.pluginDisabled": "已关闭",
    "setting.pluginEnabled": "已启用",
    "setting.terminalBackground": "使用背景图片",
    "setting.terminalShaderHelp": "GPU 特效默认关闭。需要额外的输入反馈时再开启。",
    "setting.useResttyClipboard": "使用 restty 剪贴板",
    "shader.interactiveGlow": "输入光效",
    "shader.off": "关闭",
    "shader.scanline": "扫描线",
    "shader.softVignette": "柔和暗角",
    "shortcut.closeTab": "关闭标签",
    "shortcut.copyPaste": "复制或粘贴",
    "shortcut.mobileFont": "调整终端字号",
    "shortcut.mobileKeyboard": "弹出系统键盘",
    "shortcut.mobileKeys": "发送终端按键",
    "shortcut.mobileTab": "切换或新建标签",
    "shortcut.newTab": "新建终端标签",
    "shortcut.resetFont": "重置终端字号",
    "shortcut.splitPane": "拆分面板",
    "shortcut.zoomFont": "调整终端字号",
    "tab.appearance": "外观",
    "tab.fonts": "字体",
    "tab.fontSettings": "字体设置",
    "tab.fontUpload": "字体上传",
    "tab.aiProvider": "AI 服务",
    "tab.mcp": "MCP",
    "tab.plugins": "插件",
    "tab.themes": "终端",
    "status.closed": "已关闭",
    "status.connected": "已连接",
    "status.connectFailed": "连接失败：{message}",
    "status.copyFailed": "复制失败：{message}",
    "status.creatingSession": "正在创建会话...",
    "status.defaultBackend": "默认",
    "status.fontDeleteFailed": "字体删除失败：{message}",
    "status.fontLoadFailed": "字体加载失败：{message}",
    "status.localFontsLoaded": "已检测到 {count} 个本地字体",
    "status.localFontsUnavailable": "本地字体不可用：{message}",
    "status.fontReady": "{name} 已就绪",
    "status.fontsReady": "{count} 个上传字体已就绪",
    "status.fontRegistrationFailed": "字体注册失败",
    "status.fontRemoved": "{name} 已移除",
    "status.fontUploadFailed": "字体上传失败：{message}",
    "status.backgroundReady": "终端背景已就绪",
    "status.backgroundRemoved": "终端背景已移除",
    "status.backgroundUploadFailed": "背景上传失败：{message}",
    "status.backgroundDeleteFailed": "背景删除失败：{message}",
    "status.backendActionFailed": "{backend} 操作失败：{message}",
    "status.backendActionUnavailable": "{backend} 不支持这个面板操作",
    "status.herdrActionFailed": "Herdr 操作失败：{message}",
    "status.herdrEvent": "Herdr {event}：{subject}",
    "status.herdrEventAgent": "Herdr {agent}：{status}",
    "status.herdrEntryRestored": "已恢复 Herdr 入口",
    "status.herdrNotification": "Herdr：{message}",
    "status.herdrUnavailable": "Herdr socket 不可用",
    "status.herdrWorkspaceFocused": "已切换 Herdr 工作区",
    "status.idle": "空闲",
    "status.imageUploadDone": "图片上传完成",
    "status.imageUploadFailed": "图片上传失败：{message}",
    "status.imageUploadStarted": "正在上传图片...",
    "status.instance": "实例",
    "status.instanceLoadFailed": "实例加载失败：{message}",
    "status.instancesLoaded": "实例已加载",
    "status.instanceFallback": "请求的实例未运行，已打开 {selector}。",
    "status.lightosHomeFailed": "返回 LightOS 首页失败：{message}",
    "status.lightosHomeLoading": "正在打开 LightOS 首页...",
    "status.loadingGhostty": "正在加载终端渲染器...",
    "status.loadingInstances": "正在加载实例...",
    "status.mcpServerRemoved": "MCP 服务已移除",
    "status.mcpServerSaved": "MCP 服务已保存",
    "status.noInstances": "没有返回实例",
    "status.noInstancesVisible": "没有可见的 LightOS 实例。",
    "status.noPlugins": "没有返回插件",
    "status.noSelection": "没有可复制的选区",
    "status.noSessions": "没有会话",
    "status.noTarget": "未选择实例",
    "status.pasteFailed": "粘贴失败：{message}",
    "status.aiConfigSaved": "AI 设置已保存",
    "status.aiModelsReady": "已加载 {count} 个模型",
    "status.aiNoOutput": "没有 AI 输出",
    "status.aiTestOk": "AI 测试通过",
    "status.aiWorking": "AI 请求中...",
    "status.pluginDisableFailed": "关闭失败：{message}",
    "status.pluginDisabled": "{name} 已关闭",
    "status.pluginEnableFailed": "启用失败：{message}",
    "status.pluginEnabled": "{name} 已启用",
    "status.pluginFileDone": "{operation} 完成",
    "status.pluginFileEmpty": "当前目录为空",
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
    "validation.mcpUrl": "请输入 MCP 服务 URL",
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

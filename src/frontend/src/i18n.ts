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
  | "ai.voiceEnableHelp"
  | "ai.voiceEndpointAudioSpeech"
  | "ai.voiceEndpointAudioTranscriptions"
  | "ai.voiceEndpointChatAudio"
  | "ai.voiceEndpointChatInputAudio"
  | "ai.voiceFormatNotSupported"
  | "ai.voiceNotConfigured"
  | "ai.voiceProviderCompatible"
  | "ai.voiceProviderHelp"
  | "ai.voiceProviderMimo"
  | "ai.voiceProviderMimoTokenPlan"
  | "ai.voiceReplyEnableHelp"
  | "ai.voiceReplyInstructionsPlaceholder"
  | "ai.voiceReplyNotConfigured"
  | "ai.voiceReplyProviderHelp"
  | "about.description"
  | "about.note"
  | "about.session"
  | "about.sessionValue"
  | "about.title"
  | "about.tools"
  | "about.toolsValue"
  | "about.version"
  | "action.about"
  | "action.back"
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
  | "action.aiSendToTerminal"
  | "action.aiTest"
  | "action.aiVoiceHold"
  | "action.aiVoiceProviderAdd"
  | "action.aiVoiceProviderEdit"
  | "action.aiVoiceProviderRemove"
  | "action.aiVoiceProviderSelect"
  | "action.aiVoiceReplyProviderAdd"
  | "action.aiVoiceReplyProviderEdit"
  | "action.aiVoiceReplyProviderRemove"
  | "action.aiVoiceReplyProviderSelect"
  | "action.aiVoiceReplyPause"
  | "action.aiVoiceReplyPlay"
  | "action.aiVoiceReplyHideText"
  | "action.aiVoiceReplyShowText"
  | "action.aiVoiceReplyTest"
  | "action.cancel"
  | "action.close"
  | "action.closeActiveSession"
  | "action.closeHerdrSpace"
  | "action.closePlugins"
  | "action.closeSettings"
  | "action.copySelection"
  | "action.copyUrl"
  | "action.dismissNotification"
  | "action.focusTerminal"
  | "action.fullscreen"
  | "action.hideToken"
  | "action.lightosHome"
  | "action.markNotificationRead"
  | "action.mcpAdd"
  | "action.mcpEdit"
  | "action.mcpRemove"
  | "action.newHerdrSpace"
  | "action.newHerdrTab"
  | "action.newTab"
  | "action.openNotificationLink"
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
  | "action.portForwardAcquire"
  | "action.portForwardRelease"
  | "action.pomodoroAgain"
  | "action.pomodoroDismiss"
  | "action.pomodoroNextRound"
  | "action.pomodoroStart"
  | "action.pomodoroStop"
  | "action.whiteNoiseCollapse"
  | "action.whiteNoiseExpand"
  | "action.whiteNoiseHelp"
  | "action.whiteNoiseInstall"
  | "action.whiteNoisePause"
  | "action.whiteNoisePlay"
  | "action.whiteNoisePreview"
  | "action.whiteNoiseStop"
  | "action.whiteNoiseStopPreview"
  | "action.whiteNoiseVolumeDown"
  | "action.whiteNoiseVolumeUp"
  | "action.promoteSessionToTab"
  | "action.quickPhraseAdd"
  | "action.quickPhraseCancel"
  | "action.quickPhraseRemove"
  | "action.quickPhraseSave"
  | "action.refresh"
  | "action.refreshHerdr"
  | "action.refreshInstances"
  | "action.refreshPlugins"
  | "action.movePinnedTabNext"
  | "action.movePinnedTabPrevious"
  | "action.pinTab"
  | "action.removeFont"
  | "action.removeTerminalBackground"
  | "action.removeTheme"
  | "action.saveTheme"
  | "action.save"
  | "action.settings"
  | "action.settingsMenu"
  | "action.shortcutHelp"
  | "action.sshConnect"
  | "action.closeTab"
  | "action.renameTab"
  | "action.resizeDown"
  | "action.resizeLeft"
  | "action.resizeRight"
  | "action.resizeUp"
  | "action.splitDown"
  | "action.splitLeft"
  | "action.splitRight"
  | "action.splitUp"
  | "action.switchInstance"
  | "action.terminalInputActions"
  | "action.terminalInputActionsHold"
  | "action.terminalInputUploadFile"
  | "action.terminalInputUploadFileCurrent"
  | "action.terminalInputUploadFileTemporary"
  | "action.terminalInputUploadImage"
  | "action.terminalInputVoice"
  | "action.tunnelStart"
  | "action.tunnelStop"
  | "action.tunnelProfileAdd"
  | "action.tunnelProfileEdit"
  | "action.tunnelProfileRemove"
  | "action.uploadFont"
  | "action.uploadTerminalBackground"
  | "action.unpinTab"
  | "action.useForTunnel"
  | "action.showToken"
  | "action.zmodemCancel"
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
  | "field.aiTargetTerminal"
  | "field.aiVoiceEndpointType"
  | "field.aiVoiceFormat"
  | "field.aiVoiceLanguage"
  | "field.aiVoiceProfileName"
  | "field.aiVoiceProvider"
  | "field.aiVoiceReplyFormat"
  | "field.aiVoiceReplyInstructions"
  | "field.aiVoiceReplyProfileName"
  | "field.aiVoiceReplyVoice"
  | "field.defaultSessionBackend"
  | "field.sshTarget"
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
  | "field.quickPhraseLabel"
  | "field.quickPhraseText"
  | "field.remoteHost"
  | "field.remotePort"
  | "field.scrollback"
  | "field.tabs"
  | "field.terminalBackgroundBlur"
  | "field.terminalBackgroundOpacity"
  | "field.terminalShaderEffect"
  | "field.theme"
  | "field.themeName"
  | "field.themeSource"
  | "field.touchBehavior"
  | "field.secretKeepBlank"
  | "field.tunnelProfileName"
  | "field.tunnelProvider"
  | "field.upstreamUrl"
  | "field.ngrokAuthtoken"
  | "field.terminalTransferProtocol"
  | "field.zmodemDestination"
  | "field.zmodemDirection"
  | "field.zmodemFile"
  | "field.zmodemSize"
  | "fileKind.directory"
  | "fileKind.file"
  | "fileKind.hardlink"
  | "fileKind.other"
  | "fileKind.symlink"
  | "font.builtIn"
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
  | "label.currentTime"
  | "label.mobileFnKeys"
  | "label.mobileMainKeys"
  | "label.mobileNavKeys"
  | "label.mobileOpsKeys"
  | "label.mobileSymbolKeys"
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
  | "plugin.lightosPortForward.description"
  | "plugin.lightosPortForward.help"
  | "plugin.lightosPortForward.name"
  | "plugin.meta.ai"
  | "plugin.meta.filesystem"
  | "plugin.meta.lightos"
  | "plugin.meta.network"
  | "plugin.meta.productivity"
  | "plugin.meta.session"
  | "plugin.meta.sound"
  | "plugin.meta.tunnel"
  | "plugin.meta.transfer"
  | "plugin.pomodoro.description"
  | "plugin.pomodoro.name"
  | "plugin.publicTunnel.description"
  | "plugin.publicTunnel.help"
  | "plugin.publicTunnel.name"
  | "plugin.publicTunnel.settingsHelp"
  | "plugin.terminalTransfer.description"
  | "plugin.terminalTransfer.help"
  | "plugin.terminalTransfer.name"
  | "plugin.terminalTransfer.output"
  | "plugin.whiteNoise.description"
  | "plugin.whiteNoise.help"
  | "plugin.whiteNoise.name"
  | "pomodoro.completeHint"
  | "pomodoro.completeTitle"
  | "pomodoro.customMinutes"
  | "pomodoro.presets"
  | "pomodoro.preset5"
  | "pomodoro.preset15"
  | "pomodoro.preset25"
  | "pomodoro.remaining"
  | "pomodoro.roundProgress"
  | "pomodoro.roundSetup"
  | "pomodoro.rounds"
  | "pomodoro.runningHint"
  | "pomodoro.runningTitle"
  | "pomodoro.setupHint"
  | "pomodoro.title"
  | "whiteNoise.categoryCount"
  | "whiteNoise.dirMissing"
  | "whiteNoise.disabled"
  | "whiteNoise.downloadProgress"
  | "whiteNoise.downloadStarting"
  | "whiteNoise.enabled"
  | "whiteNoise.extractProgress"
  | "whiteNoise.helpCustom"
  | "whiteNoise.helpFormats"
  | "whiteNoise.helpRemotePackage"
  | "whiteNoise.helpRoot"
  | "whiteNoise.helpTitle"
  | "whiteNoise.helpUnzip"
  | "whiteNoise.helpZipTitle"
  | "whiteNoise.idle"
  | "whiteNoise.installComplete"
  | "whiteNoise.installing"
  | "whiteNoise.loadError"
  | "whiteNoise.loading"
  | "whiteNoise.masterVolume"
  | "whiteNoise.noFiles"
  | "whiteNoise.openHelp"
  | "whiteNoise.packageUrl"
  | "whiteNoise.packageUrlPlaceholder"
  | "whiteNoise.playing"
  | "whiteNoise.skippedFiles"
  | "whiteNoise.soundMix"
  | "whiteNoise.toggleTrack"
  | "whiteNoise.trackVolume"
  | "whiteNoise.unknownSize"
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
  | "section.mobileClock"
  | "section.mobileQuickInput"
  | "section.mobileShortcuts"
  | "section.notifications"
  | "section.sessionBackend"
  | "section.shortcuts"
  | "section.terminalBackground"
  | "section.themes"
  | "section.tunnelProviders"
  | "setting.autoRestartSessions"
  | "setting.aiVoiceInputEnabled"
  | "setting.aiVoiceReplyEnabled"
  | "setting.copyOnSelect"
  | "setting.cursorBlink"
  | "setting.debugAdapter"
  | "setting.defaultSessionBackendHelp"
  | "setting.aiTerminalContext"
  | "setting.fontHinting"
  | "setting.fontLigatures"
  | "setting.fontRenderingHelp"
  | "setting.herdrHighlightHelp"
  | "setting.mobileClock24Hour"
  | "setting.mobileClockEnabled"
  | "setting.mobileClockHelp"
  | "setting.mobileClockPeriod"
  | "setting.mobileQuickInputHelp"
  | "setting.pluginDisabled"
  | "setting.pluginEnabled"
  | "setting.whiteNoiseFloatingControls"
  | "setting.whiteNoiseFloatingControlsHelp"
  | "setting.whiteNoiseAutoPlayOnSelect"
  | "setting.whiteNoiseAutoPlayOnSelectHelp"
  | "setting.terminalBackground"
  | "setting.terminalShaderHelp"
  | "setting.useResttyClipboard"
  | "sshConfirm.deleteProfile"
  | "sshError.deleteProfile"
  | "sshError.loadConfig"
  | "sshError.loadKey"
  | "sshError.loadProfiles"
  | "sshError.openProfile"
  | "sshError.saveConfig"
  | "sshError.saveHost"
  | "sshError.saveKey"
  | "sshError.saveProfile"
  | "sshError.testProfile"
  | "sshSettings.acceptNewHosts"
  | "sshSettings.advanced"
  | "sshSettings.advancedNetwork"
  | "sshSettings.backupLimit"
  | "sshSettings.badgeConfig"
  | "sshSettings.badgeKey"
  | "sshSettings.badgeOpenSsh"
  | "sshSettings.badgeProfile"
  | "sshSettings.badgeSsh"
  | "sshSettings.basic"
  | "sshSettings.chooseHost"
  | "sshSettings.configSelectLabel"
  | "sshSettings.configSource"
  | "sshSettings.connectionCount"
  | "sshSettings.connectionCountFiltered"
  | "sshSettings.connectionsAria"
  | "sshSettings.currentLightosConfig"
  | "sshSettings.delete"
  | "sshSettings.deviceOpenSsh"
  | "sshSettings.displayHost"
  | "sshSettings.displayUser"
  | "sshSettings.editHostTitle"
  | "sshSettings.editKeyLabel"
  | "sshSettings.editModeAria"
  | "sshSettings.enabled"
  | "sshSettings.extraOptions"
  | "sshSettings.help"
  | "sshSettings.hide"
  | "sshSettings.host"
  | "sshSettings.hostCount"
  | "sshSettings.hostForm"
  | "sshSettings.hostKeyChecking"
  | "sshSettings.hostListAria"
  | "sshSettings.keyContent"
  | "sshSettings.keyFile"
  | "sshSettings.keyHidden"
  | "sshSettings.keyMissingHidden"
  | "sshSettings.keyPath"
  | "sshSettings.managedKey"
  | "sshSettings.managedKeyTitle"
  | "sshSettings.managedPublicKey"
  | "sshSettings.managedSubtitle"
  | "sshSettings.name"
  | "sshSettings.newConnection"
  | "sshSettings.newHost"
  | "sshSettings.newHostTitle"
  | "sshSettings.noConfigHosts"
  | "sshSettings.noConnectionMatch"
  | "sshSettings.noHostName"
  | "sshSettings.off"
  | "sshSettings.open"
  | "sshSettings.openNamedProfile"
  | "sshSettings.openSsh"
  | "sshSettings.openSshSubtitle"
  | "sshSettings.openSshTarget"
  | "sshSettings.port"
  | "sshSettings.profileTypeAria"
  | "sshSettings.providerConfig"
  | "sshSettings.publicKey"
  | "sshSettings.publicKeyPending"
  | "sshSettings.rawConfig"
  | "sshSettings.refreshHosts"
  | "sshSettings.saveAsProfile"
  | "sshSettings.saveConfig"
  | "sshSettings.saveHost"
  | "sshSettings.saveKey"
  | "sshSettings.saveNamedAsProfile"
  | "sshSettings.saveProfile"
  | "sshSettings.searchLabel"
  | "sshSettings.searchPlaceholder"
  | "sshSettings.show"
  | "sshSettings.strict"
  | "sshSettings.test"
  | "sshSettings.title"
  | "sshSettings.unsaved"
  | "sshSettings.user"
  | "sshStatus.configLoaded"
  | "sshStatus.configRefreshed"
  | "sshStatus.configSaved"
  | "sshStatus.configSavedBackup"
  | "sshStatus.hostSaved"
  | "sshStatus.keyLoaded"
  | "sshStatus.keyMissing"
  | "sshStatus.keySaved"
  | "sshStatus.keySavedBackup"
  | "sshStatus.noProfiles"
  | "sshStatus.openingProfile"
  | "sshStatus.profileDeleted"
  | "sshStatus.profileSaved"
  | "sshValidation.enableBeforeOpening"
  | "sshValidation.hostRequired"
  | "sshValidation.keyPathRequired"
  | "sshValidation.nameRequired"
  | "sshValidation.openSshTargetRequired"
  | "sshValidation.portRange"
  | "sshValidation.saveBeforeTesting"
  | "ssh.back"
  | "ssh.chooseHelp"
  | "ssh.chooseTitle"
  | "ssh.configHosts"
  | "ssh.configLoadFailed"
  | "ssh.directAction"
  | "ssh.directLightosHint"
  | "ssh.loading"
  | "ssh.manageHosts"
  | "ssh.manualConnect"
  | "ssh.manualTitle"
  | "ssh.noHosts"
  | "ssh.quickHelpLightos"
  | "ssh.quickHelpProvider"
  | "ssh.quickPlaceholder"
  | "ssh.quickTitle"
  | "ssh.savedProfiles"
  | "ssh.sourceLightosConfig"
  | "ssh.sourceManagedKey"
  | "ssh.sourceProviderConfig"
  | "ssh.sourceSavedProfile"
  | "ssh.validationTarget"
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
  | "tab.terminalSession"
  | "tab.zellijSession"
  | "tab.aiProvider"
  | "tab.aiVoice"
  | "tab.mcp"
  | "tab.mobile"
  | "tab.plugins"
  | "tab.quickPhrases"
  | "tab.remoteHosts"
  | "tab.terminal"
  | "tab.themes"
  | "status.closed"
  | "status.connected"
  | "status.connectFailed"
  | "status.copyFailed"
  | "status.creatingSession"
  | "status.defaultBackend"
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
  | "status.backendActionFailed"
  | "status.backendActionUnavailable"
  | "status.herdrActionFailed"
  | "status.herdrEvent"
  | "status.herdrEventAgent"
  | "status.herdrEntryRestored"
  | "status.herdrNotification"
  | "status.herdrProtocolNewer"
  | "status.herdrProtocolOlder"
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
  | "status.noNotifications"
  | "status.noPlugins"
  | "status.noPortForwards"
  | "status.noPublicTunnels"
  | "status.noQuickPhrases"
  | "status.noTunnelProfiles"
  | "status.noSelection"
  | "status.noSessions"
  | "status.noTarget"
  | "status.notConfigured"
  | "status.notificationActionFailed"
  | "status.notificationLoadFailed"
  | "status.pasteFailed"
  | "status.aiConfigSaved"
  | "status.aiModelsReady"
  | "status.aiNoTerminalTarget"
  | "status.aiNoOutput"
  | "status.aiSentToTerminal"
  | "status.aiTestOk"
  | "status.aiWorking"
  | "status.aiVoiceConfigRemoved"
  | "status.aiVoiceConfigSaved"
  | "status.aiVoiceEmpty"
  | "status.aiVoiceFailed"
  | "status.aiVoiceInserted"
  | "status.aiVoiceRecording"
  | "status.aiVoiceStartFailed"
  | "status.aiVoiceTranscribing"
  | "status.aiVoiceTooLarge"
  | "status.aiVoiceReplyConfigRemoved"
  | "status.aiVoiceReplyConfigSaved"
  | "status.aiVoiceReplyFailed"
  | "status.aiVoiceReplyLoading"
  | "status.aiVoiceReplyPlaying"
  | "status.aiVoiceReplyReady"
  | "status.aiVoiceReplyTestLoading"
  | "status.aiVoiceReplyTestReady"
  | "status.pluginDisableFailed"
  | "status.pluginDisabled"
  | "status.pluginEnableFailed"
  | "status.pluginEnabled"
  | "status.pluginFileDone"
  | "status.pluginFileEmpty"
  | "status.pluginFileNoSession"
  | "status.pluginFileUploadDone"
  | "status.pluginLoadFailed"
  | "status.pluginSettingsSaved"
  | "status.pluginSettingsSaveFailed"
  | "status.terminalInputFileUploadUnavailable"
  | "status.terminalInputImageUploadUnavailable"
  | "status.terminalInputNoImageFile"
  | "status.terminalInputTemporaryPathsInserted"
  | "status.whiteNoiseAudioError"
  | "status.whiteNoiseLoaded"
  | "status.whiteNoiseInstallDone"
  | "status.whiteNoiseInstallFailed"
  | "status.whiteNoiseInstalling"
  | "status.whiteNoiseLoadFailed"
  | "status.whiteNoiseNoSounds"
  | "status.whiteNoiseNoSelection"
  | "status.whiteNoisePlayFailed"
  | "status.whiteNoisePreviewFailed"
  | "status.whiteNoisePlaying"
  | "status.whiteNoiseStopped"
  | "status.portForwardReady"
  | "status.publicTunnelReady"
  | "status.quickPhraseRemoved"
  | "status.quickPhraseSaved"
  | "status.tunnelProfileRemoved"
  | "status.tunnelProfileSaved"
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
  | "status.sshUrlOpenFailed"
  | "status.sshUrlProfileReady"
  | "status.terminalError"
  | "status.themeInvalid"
  | "status.urlCopied"
  | "status.terminalTransferCancelled"
  | "status.terminalTransferComplete"
  | "status.terminalTransferDetecting"
  | "status.terminalTransferFailed"
  | "status.terminalTransferNoProtocol"
  | "status.terminalTransferReady"
  | "status.terminalTransferReadyLrzsz"
  | "status.terminalTransferReadyTrzsz"
  | "status.terminalTransferStarted"
  | "status.terminalTransferUnsupportedBackend"
  | "status.trzszDownloadDetected"
  | "status.trzszProgressInTerminal"
  | "status.trzszTransferring"
  | "status.trzszUploadDetected"
  | "status.zmodemCancelled"
  | "status.zmodemChooseSaveLocation"
  | "status.zmodemChooseSaveLocationShort"
  | "status.zmodemChooseUploadFile"
  | "status.zmodemComplete"
  | "status.zmodemDetecting"
  | "status.zmodemDownloadDetected"
  | "status.zmodemFailed"
  | "status.zmodemReady"
  | "status.zmodemReceiving"
  | "status.zmodemReceivingFallback"
  | "status.zmodemTransferCancelled"
  | "status.zmodemTransferComplete"
  | "status.zmodemTransferFailed"
  | "status.zmodemTransferStarted"
  | "status.zmodemTransferring"
  | "status.zmodemUnsupportedBackend"
  | "status.zmodemUploadDetected"
  | "status.zmodemUploadingTo"
  | "status.zmodemUploadingToCurrentDirectory"
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
  | "terminalTransfer.protocolLrzsz"
  | "terminalTransfer.protocolLrzszHelp"
  | "terminalTransfer.protocolTrzsz"
  | "terminalTransfer.protocolTrzszHelp"
  | "terminalTransfer.protocolsHelp"
  | "terminalTransfer.protocolsTitle"
  | "validation.fontExtension"
  | "validation.fontMime"
  | "validation.fontSize"
  | "validation.backgroundExtension"
  | "validation.backgroundMime"
  | "validation.backgroundSize"
  | "validation.aiAccess"
  | "validation.aiPrompt"
  | "validation.ngrokAuthtoken"
  | "validation.mcpUrl"
  | "validation.pluginPath"
  | "validation.port"
  | "validation.quickPhraseLimit"
  | "validation.quickPhraseText"
  | "validation.themeName"
  | "validation.themeSource"
  | "validation.tunnelProfile"
  | "validation.tunnelProfileName"
  | "validation.upstreamUrl"
  | "validation.whiteNoisePackageUrl"
  | "zmodem.directionDownload"
  | "zmodem.directionUpload";

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
    "action.back": "Back",
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
    "action.aiSendToTerminal": "Send to terminal",
    "action.aiTest": "Test",
    "action.aiVoiceHold": "Hold to speak",
    "action.aiVoiceProviderAdd": "Add voice provider",
    "action.aiVoiceProviderEdit": "Edit voice provider",
    "action.aiVoiceProviderRemove": "Remove voice provider",
    "action.aiVoiceProviderSelect": "Use voice provider",
    "action.aiVoiceReplyProviderAdd": "Add reply voice",
    "action.aiVoiceReplyProviderEdit": "Edit reply voice",
    "action.aiVoiceReplyProviderRemove": "Remove reply voice",
    "action.aiVoiceReplyProviderSelect": "Use reply voice",
    "action.aiVoiceReplyPause": "Pause voice reply",
    "action.aiVoiceReplyPlay": "Play voice reply",
    "action.aiVoiceReplyHideText": "Hide text",
    "action.aiVoiceReplyShowText": "Show text",
    "action.aiVoiceReplyTest": "Test reply voice",
    "action.cancel": "Cancel",
    "action.close": "Close",
    "action.closeActiveSession": "Close active session",
    "action.closeHerdrSpace": "Close Herdr space",
    "action.closePlugins": "Close tools",
    "action.closeSettings": "Close settings",
    "action.copySelection": "Copy selection",
    "action.copyUrl": "Copy URL",
    "action.dismissNotification": "Dismiss",
    "action.focusTerminal": "Focus terminal",
    "action.fullscreen": "Full screen",
    "action.hideToken": "Hide token",
    "action.lightosHome": "LightOS home",
    "action.markNotificationRead": "Mark read",
    "action.mcpAdd": "Add MCP server",
    "action.mcpEdit": "Edit MCP server",
    "action.mcpRemove": "Remove MCP server",
    "action.newHerdrSpace": "New Herdr space",
    "action.newHerdrTab": "New Herdr tab",
    "action.newTab": "New terminal tab",
    "action.openNotificationLink": "Open link",
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
    "action.portForwardAcquire": "Forward port",
    "action.portForwardRelease": "Stop forward",
    "action.pomodoroAgain": "Start another",
    "action.pomodoroDismiss": "Done",
    "action.pomodoroNextRound": "Next round",
    "action.pomodoroStart": "Start",
    "action.pomodoroStop": "End",
    "action.whiteNoiseCollapse": "Collapse white noise playback controls",
    "action.whiteNoiseExpand": "Expand white noise playback controls",
    "action.whiteNoiseHelp": "Sound setup help",
    "action.whiteNoiseInstall": "Download",
    "action.whiteNoisePause": "Pause",
    "action.whiteNoisePlay": "Play",
    "action.whiteNoisePreview": "Preview {name}",
    "action.whiteNoiseStop": "Stop",
    "action.whiteNoiseStopPreview": "Stop previewing {name}",
    "action.whiteNoiseVolumeDown": "Volume down",
    "action.whiteNoiseVolumeUp": "Volume up",
    "action.promoteSessionToTab": "Move session to new tab",
    "action.quickPhraseAdd": "Add phrase",
    "action.quickPhraseCancel": "Cancel",
    "action.quickPhraseRemove": "Remove phrase",
    "action.quickPhraseSave": "Save phrase",
    "action.refresh": "Refresh",
    "action.refreshHerdr": "Refresh Herdr",
    "action.refreshInstances": "Refresh instances",
    "action.refreshPlugins": "Refresh tools",
    "action.movePinnedTabNext": "Move pinned tab right",
    "action.movePinnedTabPrevious": "Move pinned tab left",
    "action.pinTab": "Pin tab",
    "action.removeFont": "Remove selected font",
    "action.removeTerminalBackground": "Remove terminal background",
    "action.removeTheme": "Remove custom theme",
    "action.save": "Save",
    "action.saveTheme": "Save custom theme",
    "action.settings": "Settings",
    "action.settingsMenu": "Settings menu",
    "action.shortcutHelp": "Keyboard shortcuts",
    "action.sshConnect": "Connect SSH",
    "action.closeTab": "Close tab",
    "action.renameTab": "Rename tab",
    "action.resizeDown": "Resize down",
    "action.resizeLeft": "Resize left",
    "action.resizeRight": "Resize right",
    "action.resizeUp": "Resize up",
    "action.splitDown": "Split down",
    "action.splitLeft": "Split left",
    "action.splitRight": "Split right",
    "action.splitUp": "Split up",
    "action.switchInstance": "Switch instance",
    "action.terminalInputActions": "Terminal input actions",
    "action.terminalInputActionsHold": "Tap for input actions, hold to speak",
    "action.terminalInputUploadFile": "Upload file",
    "action.terminalInputUploadFileCurrent": "Upload to current directory",
    "action.terminalInputUploadFileTemporary": "Upload to temp directory",
    "action.terminalInputUploadImage": "Upload image",
    "action.terminalInputVoice": "Voice input",
    "action.tunnelStart": "Start tunnel",
    "action.tunnelStop": "Stop tunnel",
    "action.tunnelProfileAdd": "Add configuration",
    "action.tunnelProfileEdit": "Edit configuration",
    "action.tunnelProfileRemove": "Remove configuration",
    "action.uploadFont": "Upload font",
    "action.uploadTerminalBackground": "Upload terminal background",
    "action.unpinTab": "Unpin tab",
    "action.useForTunnel": "Use for tunnel",
    "action.showToken": "Show token",
    "action.zmodemCancel": "Cancel transfer",
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
    "field.aiTargetTerminal": "Target terminal",
    "field.aiVoiceEndpointType": "Interface type",
    "field.aiVoiceFormat": "Recording format",
    "field.aiVoiceLanguage": "Speech language",
    "field.aiVoiceProfileName": "Voice profile name",
    "field.aiVoiceProvider": "Voice provider",
    "field.aiVoiceReplyFormat": "Audio format",
    "field.aiVoiceReplyInstructions": "Voice style",
    "field.aiVoiceReplyProfileName": "Reply voice name",
    "field.aiVoiceReplyVoice": "Voice",
    "field.defaultSessionBackend": "New tab backend",
    "field.sshTarget": "SSH target",
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
    "field.quickPhraseLabel": "Label",
    "field.quickPhraseText": "Text",
    "field.remoteHost": "Remote host",
    "field.remotePort": "Remote port",
    "field.scrollback": "Scrollback",
    "field.tabs": "Tabs",
    "field.terminalBackgroundBlur": "Background blur",
    "field.terminalBackgroundOpacity": "Background opacity",
    "field.terminalShaderEffect": "Terminal effect",
    "field.theme": "Terminal theme",
    "field.themeName": "Theme name",
    "field.themeSource": "Ghostty theme",
    "field.touchBehavior": "Touch behavior",
    "field.secretKeepBlank": "Leave blank to keep the saved token",
    "field.tunnelProfileName": "Profile name",
    "field.tunnelProvider": "Tunnel provider",
    "field.upstreamUrl": "Upstream URL",
    "field.ngrokAuthtoken": "Authentication token",
    "field.terminalTransferProtocol": "Protocol",
    "field.zmodemDestination": "Destination",
    "field.zmodemDirection": "Direction",
    "field.zmodemFile": "File",
    "field.zmodemSize": "Size",
    "fileKind.directory": "Directory",
    "fileKind.file": "File",
    "fileKind.hardlink": "Hard link",
    "fileKind.other": "Other",
    "fileKind.symlink": "Symlink",
    "font.builtIn": "Built in",
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
    "label.currentTime": "Current time",
    "label.mobileFnKeys": "Function keys",
    "label.mobileMainKeys": "Main shortcuts",
    "label.mobileNavKeys": "Navigation keys",
    "label.mobileOpsKeys": "Terminal actions",
    "label.mobileSymbolKeys": "Symbols",
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
    "ai.voiceEnableHelp": "When enabled, a hold-to-talk button appears above the mobile keyboard and at the bottom center on desktop.",
    "ai.voiceEndpointAudioSpeech": "Audio speech",
    "ai.voiceEndpointAudioTranscriptions": "Audio transcriptions",
    "ai.voiceEndpointChatAudio": "Chat audio",
    "ai.voiceEndpointChatInputAudio": "Chat input_audio",
    "ai.voiceFormatNotSupported": "This browser does not support the selected recording format",
    "ai.voiceNotConfigured": "Voice provider not configured",
    "ai.voiceProviderCompatible": "OpenAI-compatible",
    "ai.voiceProviderHelp": "Xiaomi presets use Chat Completions input_audio. Custom compatible providers can use either Audio Transcriptions or Chat input_audio.",
    "ai.voiceProviderMimo": "Xiaomi Mimo",
    "ai.voiceProviderMimoTokenPlan": "Xiaomi Mimo Token Plan",
    "ai.voiceReplyEnableHelp": "When enabled, assistant replies show a playback bar and the text stays collapsed by default.",
    "ai.voiceReplyInstructionsPlaceholder": "Example: Use a natural, clear Chinese narration style.",
    "ai.voiceReplyNotConfigured": "Reply voice not configured",
    "ai.voiceReplyProviderHelp": "Xiaomi presets use Chat Completions audio. Compatible providers can use Audio Speech or Chat audio depending on their API shape.",
    "plugin.aiChat.block": "Chat",
    "plugin.aiChat.description": "Chat tool inside WebShell for command help, troubleshooting, and notes.",
    "plugin.aiChat.name": "AI Chat",
    "plugin.aiChat.output": "AI chat output",
    "plugin.fileTransfer.description": "Browse device files, upload multiple local files, and download selected device paths.",
    "plugin.fileTransfer.help": "Device side uses the active terminal session and login user. The browser can choose local files, but cannot expose a local directory tree.",
    "plugin.fileTransfer.name": "File transfer",
    "plugin.fileTransfer.output": "File transfer output",
    "plugin.lightosPortForward.description": "Forward a HTTP port from the selected LightOS instance to the WebShell provider.",
    "plugin.lightosPortForward.help": "Keeps a provider-side forward alive while the WebShell backend is running. Use the local URL directly or publish it with Public Tunnel.",
    "plugin.lightosPortForward.name": "LightOS port forward",
    "plugin.meta.ai": "AI",
    "plugin.meta.filesystem": "Filesystem",
    "plugin.meta.lightos": "LightOS",
    "plugin.meta.network": "Network",
    "plugin.meta.productivity": "Productivity",
    "plugin.meta.session": "Session",
    "plugin.meta.sound": "Sound",
    "plugin.meta.tunnel": "Tunnel",
    "plugin.meta.transfer": "Transfer",
    "plugin.pomodoro.description": "Focus timer for short work sessions inside the tool panel.",
    "plugin.pomodoro.name": "Pomodoro",
    "plugin.publicTunnel.description": "Publish a local HTTP URL through Cloudflare Quick Tunnel or ngrok.",
    "plugin.publicTunnel.help": "Tunnel sessions stay alive while the WebShell backend is running. Use a LightOS forward URL for services inside the selected instance.",
    "plugin.publicTunnel.name": "Public tunnel",
    "plugin.publicTunnel.settingsHelp": "Cloudflare Quick Tunnel works without authentication. Add tunnel authentication configs here for providers that need tokens.",
    "plugin.terminalTransfer.description": "Automatically handles lrzsz (rz/sz) and trzsz (trz/tsz) transfers in native WebShell terminals.",
    "plugin.terminalTransfer.help": "Run rz/trz to upload into the current terminal directory, or sz/tsz <file> to save remote files through the browser.",
    "plugin.terminalTransfer.name": "Terminal transfer",
    "plugin.terminalTransfer.output": "Terminal transfer progress",
    "plugin.whiteNoise.description": "Play local focus sounds from /lzcapp/var/sounds.",
    "plugin.whiteNoise.help": "Mix local sounds from the provider sounds directory. Enter a package URL to download and extract it.",
    "plugin.whiteNoise.name": "White noise",
    "pomodoro.completeHint": "The focus timer is complete. Take a short break before starting another round.",
    "pomodoro.completeTitle": "Time is up",
    "pomodoro.customMinutes": "Custom minutes",
    "pomodoro.presets": "Pomodoro presets",
    "pomodoro.preset5": "5 min",
    "pomodoro.preset15": "15 min",
    "pomodoro.preset25": "25 min",
    "pomodoro.remaining": "Remaining",
    "pomodoro.roundProgress": "Round {current} of {total}",
    "pomodoro.roundSetup": "{total} round(s)",
    "pomodoro.rounds": "Rounds",
    "pomodoro.runningHint": "Focus ends at {time}.",
    "pomodoro.runningTitle": "Focus running",
    "pomodoro.setupHint": "Choose a focus length and keep the terminal in view.",
    "pomodoro.title": "Pomodoro",
    "whiteNoise.categoryCount": "{count} sound(s)",
    "whiteNoise.dirMissing": "Sound directory is not ready",
    "whiteNoise.disabled": "Off",
    "whiteNoise.downloadProgress": "Downloading {current} / {total}",
    "whiteNoise.downloadStarting": "Preparing download...",
    "whiteNoise.enabled": "On",
    "whiteNoise.extractProgress": "Extracting {current}/{total} files, {bytes}",
    "whiteNoise.helpCustom": "You can add your own category folders and audio files under sounds/. Click refresh after changing files.",
    "whiteNoise.helpFormats": "Supported audio formats: {formats}.",
    "whiteNoise.helpRemotePackage": "Default remote package",
    "whiteNoise.helpRoot": "Audio files are read from {path}. Categories come from the first directory under sounds/.",
    "whiteNoise.helpTitle": "How to add sounds",
    "whiteNoise.helpUnzip": "Download and extract on the device",
    "whiteNoise.helpZipTitle": "Zip package directory structure",
    "whiteNoise.idle": "Idle",
    "whiteNoise.installComplete": "Installed {count} sound(s)",
    "whiteNoise.installing": "Downloading",
    "whiteNoise.loadError": "Failed to load sound catalog",
    "whiteNoise.loading": "Loading sounds...",
    "whiteNoise.masterVolume": "Master volume",
    "whiteNoise.noFiles": "No supported audio files found",
    "whiteNoise.openHelp": "Open sound setup help.",
    "whiteNoise.packageUrl": "Package URL",
    "whiteNoise.packageUrlPlaceholder": "https://example.com/sounds.zip",
    "whiteNoise.playing": "Playing",
    "whiteNoise.skippedFiles": "{count} file(s) skipped",
    "whiteNoise.soundMix": "Sound mix",
    "whiteNoise.toggleTrack": "Toggle {name}",
    "whiteNoise.trackVolume": "{name} volume",
    "whiteNoise.unknownSize": "unknown size",
    "section.appearance": "Appearance",
    "section.aiAccess": "AI access",
    "section.fileTransfer": "File transfer",
    "section.fonts": "Fonts",
    "section.desktopShortcuts": "Desktop",
    "section.herdr": "Herdr controls",
    "section.herdrTabs": "Herdr tabs",
    "section.herdrWorkspaces": "Herdr spaces",
    "section.herdrHighlight": "Herdr selection",
    "section.mobileClock": "Mobile clock",
    "section.mobileQuickInput": "Mobile quick input",
    "section.mobileShortcuts": "Mobile",
    "section.notifications": "Notifications",
    "section.plugins": "Tools",
    "section.sessionBackend": "Session backend",
    "section.shortcuts": "Shortcuts",
    "section.terminalBackground": "Terminal background",
    "section.themes": "Terminal themes",
    "section.tunnelProviders": "Tunnel providers",
    "setting.autoRestartSessions": "Restart sessions after provider restart",
    "setting.aiVoiceInputEnabled": "Enable voice input",
    "setting.aiVoiceReplyEnabled": "Enable voice reply",
    "setting.copyOnSelect": "Copy on select",
    "setting.cursorBlink": "Cursor blink",
    "setting.debugAdapter": "Debug adapter",
    "setting.defaultSessionBackendHelp": "The + button uses this backend. If Herdr already has an engine pane, + creates a new Herdr workspace inside that session.",
    "setting.aiTerminalContext": "Terminal context",
    "setting.fontHinting": "Font hinting",
    "setting.fontLigatures": "Programming ligatures",
    "setting.fontRenderingHelp": "Ligatures shape operators such as => and !=. Font hinting can sharpen small text, but may cost extra rasterization time.",
    "setting.herdrHighlightHelp": "Customize the active Herdr workspace and tab background for dark and light interface styles.",
    "setting.mobileClock24Hour": "Use 24-hour time",
    "setting.mobileClockEnabled": "Show mobile clock",
    "setting.mobileClockHelp": "Controls the time shown beside the mobile shortcut tabs.",
    "setting.mobileClockPeriod": "Show AM/PM",
    "setting.mobileQuickInputHelp": "Save personal phrases for the mobile shortcut bar. They appear after Sym and are sorted by usage.",
    "setting.pluginDisabled": "Disabled",
    "setting.pluginEnabled": "Enabled",
    "setting.whiteNoiseFloatingControls": "Show left playback controls",
    "setting.whiteNoiseFloatingControlsHelp": "When white noise is enabled, show a left-side floating bar with play/pause and volume buttons.",
    "setting.whiteNoiseAutoPlayOnSelect": "Auto-play selected sounds",
    "setting.whiteNoiseAutoPlayOnSelectHelp": "When enabled, selecting a sound starts playback automatically. Clearing all selected sounds stops playback.",
    "setting.terminalBackground": "Use background image",
    "setting.terminalShaderHelp": "GPU effects are off by default. Enable them only when you want extra terminal feedback.",
    "setting.useResttyClipboard": "Use restty clipboard",
    "sshConfirm.deleteProfile": "Delete SSH profile \"{name}\"?",
    "sshError.deleteProfile": "Failed to delete SSH profile: {message}",
    "sshError.loadConfig": "Failed to load SSH config: {message}",
    "sshError.loadKey": "Failed to load SSH key file: {message}",
    "sshError.loadProfiles": "Failed to load SSH profiles: {message}",
    "sshError.openProfile": "Failed to open SSH profile: {message}",
    "sshError.saveConfig": "Failed to save SSH config: {message}",
    "sshError.saveHost": "Failed to save SSH Host: {message}",
    "sshError.saveKey": "Failed to save SSH key file: {message}",
    "sshError.saveProfile": "Failed to save SSH profile: {message}",
    "sshError.testProfile": "SSH test failed: {message}",
    "sshSettings.acceptNewHosts": "Accept new hosts",
    "sshSettings.advanced": "Advanced",
    "sshSettings.advancedNetwork": "Proxy and advanced",
    "sshSettings.backupLimit": "Keep backups",
    "sshSettings.badgeConfig": "config",
    "sshSettings.badgeKey": "key",
    "sshSettings.badgeOpenSsh": "openssh",
    "sshSettings.badgeProfile": "profile",
    "sshSettings.badgeSsh": "ssh",
    "sshSettings.basic": "Basic",
    "sshSettings.chooseHost": "Choose Host from ~/.ssh/config",
    "sshSettings.configSelectLabel": "OpenSSH config",
    "sshSettings.configSource": "Config source",
    "sshSettings.connectionCount": "{profiles} saved / {hosts} config",
    "sshSettings.connectionCountFiltered": "{shown} shown from {profiles} saved / {hosts} config",
    "sshSettings.connectionsAria": "SSH connections",
    "sshSettings.currentLightosConfig": "Current LightOS instance ~/.ssh/config",
    "sshSettings.delete": "Delete",
    "sshSettings.deviceOpenSsh": "Device OpenSSH",
    "sshSettings.displayHost": "Display host",
    "sshSettings.displayUser": "Display user",
    "sshSettings.editHostTitle": "Edit {host}",
    "sshSettings.editKeyLabel": "Edit {label}",
    "sshSettings.editModeAria": "SSH config edit mode",
    "sshSettings.enabled": "Enabled",
    "sshSettings.extraOptions": "Extra options",
    "sshSettings.help": "Manage OpenSSH config, key files, and saved SSH connections.",
    "sshSettings.hide": "Hide",
    "sshSettings.host": "Host",
    "sshSettings.hostCount": "{count} Host(s)",
    "sshSettings.hostForm": "Host form",
    "sshSettings.hostKeyChecking": "Host key checking",
    "sshSettings.hostListAria": "OpenSSH config Host",
    "sshSettings.keyContent": "Content",
    "sshSettings.keyFile": "Key file",
    "sshSettings.keyHidden": "Key content hidden ({bytes} bytes). Show to view or edit.",
    "sshSettings.keyMissingHidden": "Key file does not exist. Show to create or edit it.",
    "sshSettings.keyPath": "Path",
    "sshSettings.managedKey": "Managed key",
    "sshSettings.managedKeyTitle": "Managed key",
    "sshSettings.managedPublicKey": "Managed public key",
    "sshSettings.managedSubtitle": "Create a WebShell-managed key profile.",
    "sshSettings.name": "Name",
    "sshSettings.newConnection": "New SSH connection",
    "sshSettings.newHost": "New Host",
    "sshSettings.newHostTitle": "New Host",
    "sshSettings.noConfigHosts": "This config has no Host.",
    "sshSettings.noConnectionMatch": "No SSH connections match.",
    "sshSettings.noHostName": "HostName not configured",
    "sshSettings.off": "Off",
    "sshSettings.open": "Open",
    "sshSettings.openNamedProfile": "Open {name}",
    "sshSettings.openSsh": "OpenSSH",
    "sshSettings.openSshSubtitle": "Use an alias or target resolved by the device ssh command.",
    "sshSettings.openSshTarget": "OpenSSH target",
    "sshSettings.port": "Port",
    "sshSettings.profileTypeAria": "SSH profile type",
    "sshSettings.providerConfig": "Provider ~/.ssh/config",
    "sshSettings.publicKey": "Public key",
    "sshSettings.publicKeyPending": "A public key is generated after the profile is saved.",
    "sshSettings.rawConfig": "Raw config",
    "sshSettings.refreshHosts": "Refresh remote hosts",
    "sshSettings.saveAsProfile": "Save as profile",
    "sshSettings.saveConfig": "Save config",
    "sshSettings.saveHost": "Save Host to config",
    "sshSettings.saveKey": "Save key",
    "sshSettings.saveNamedAsProfile": "Save {name} as profile",
    "sshSettings.saveProfile": "Save profile",
    "sshSettings.searchLabel": "Search SSH connections",
    "sshSettings.searchPlaceholder": "Search saved connections or ~/.ssh/config Host",
    "sshSettings.show": "Show",
    "sshSettings.strict": "Strict",
    "sshSettings.test": "Test",
    "sshSettings.title": "Remote hosts",
    "sshSettings.unsaved": "Unsaved",
    "sshSettings.user": "User",
    "sshStatus.configLoaded": "SSH config loaded",
    "sshStatus.configRefreshed": "SSH config refreshed",
    "sshStatus.configSaved": "config saved",
    "sshStatus.configSavedBackup": "config saved, backup: {path}",
    "sshStatus.hostSaved": "Host saved to config",
    "sshStatus.keyLoaded": "Key file loaded",
    "sshStatus.keyMissing": "Key file does not exist. It will be created when saved.",
    "sshStatus.keySaved": "Key saved",
    "sshStatus.keySavedBackup": "Key saved, backup: {path}",
    "sshStatus.noProfiles": "No SSH profiles yet",
    "sshStatus.openingProfile": "Opening SSH profile: {name}",
    "sshStatus.profileDeleted": "SSH profile deleted",
    "sshStatus.profileSaved": "SSH profile saved",
    "sshValidation.enableBeforeOpening": "Enable the SSH profile before opening it",
    "sshValidation.hostRequired": "Host is required",
    "sshValidation.keyPathRequired": "Key path is required",
    "sshValidation.nameRequired": "Name is required",
    "sshValidation.openSshTargetRequired": "OpenSSH target is required",
    "sshValidation.portRange": "Port must be between 1 and 65535",
    "sshValidation.saveBeforeTesting": "Save the SSH profile before testing it",
    "ssh.back": "Back",
    "ssh.chooseHelp": "Choose a Host from {instance}'s ~/.ssh/config, or use a saved profile.",
    "ssh.chooseTitle": "Choose SSH host",
    "ssh.configHosts": "~/.ssh/config",
    "ssh.configLoadFailed": "SSH config load failed: {message}",
    "ssh.directAction": "Connect from current instance",
    "ssh.directLightosHint": "Uses the selected LightOS instance ssh",
    "ssh.loading": "Loading SSH hosts...",
    "ssh.manageHosts": "Manage remote hosts",
    "ssh.manualConnect": "Manual target",
    "ssh.manualTitle": "SSH target",
    "ssh.noHosts": "No SSH hosts yet.",
    "ssh.quickHelpLightos": "Open ssh from {instance}, using its ~/.ssh/config and keys.",
    "ssh.quickHelpProvider": "Open a saved SSH profile or create one from a target.",
    "ssh.quickPlaceholder": "Host alias or user@example.com",
    "ssh.quickTitle": "SSH remote",
    "ssh.savedProfiles": "Saved profiles",
    "ssh.sourceLightosConfig": "LightOS config",
    "ssh.sourceManagedKey": "Managed key",
    "ssh.sourceProviderConfig": "Provider config",
    "ssh.sourceSavedProfile": "Profile",
    "ssh.validationTarget": "Enter a valid SSH target.",
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
    "tab.terminalSession": "Terminal {index}",
    "tab.zellijSession": "zellij {index}",
    "tab.aiProvider": "AI provider",
    "tab.aiVoice": "Voice",
    "tab.mcp": "MCP",
    "tab.mobile": "Mobile",
    "tab.plugins": "Tools",
    "tab.quickPhrases": "Phrases",
    "tab.remoteHosts": "Remote hosts",
    "tab.terminal": "Terminal",
    "tab.themes": "Themes",
    "status.closed": "Closed",
    "status.connected": "Connected",
    "status.connectFailed": "Connect failed: {message}",
    "status.copyFailed": "Copy failed: {message}",
    "status.creatingSession": "Creating session...",
    "status.defaultBackend": "Default",
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
    "status.backendActionFailed": "{backend} action failed: {message}",
    "status.backendActionUnavailable": "{backend} does not support this pane action",
    "status.herdrActionFailed": "Herdr action failed: {message}",
    "status.herdrEvent": "Herdr {event}: {subject}",
    "status.herdrEventAgent": "Herdr {agent}: {status}",
    "status.herdrEntryRestored": "Herdr entry restored",
    "status.herdrNotification": "Herdr: {message}",
    "status.herdrProtocolNewer": "The device Herdr protocol is {actual}, newer than WebShell supports ({expected}, based on Herdr {expectedVersion}). The WebShell author may need to update Herdr protocol support.",
    "status.herdrProtocolOlder": "The device Herdr protocol is {actual}, older than WebShell expects ({expected}, based on Herdr {expectedVersion}). You may need to update Herdr on the device.",
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
    "status.noNotifications": "No notifications",
    "status.noPlugins": "No tools available",
    "status.noPortForwards": "No active port forwards",
    "status.noPublicTunnels": "No active public tunnels",
    "status.noQuickPhrases": "No quick phrases",
    "status.noTunnelProfiles": "No tunnel authentication configs",
    "status.noSelection": "No selection to copy",
    "status.noSessions": "No sessions",
    "status.noTarget": "No instance selected",
    "status.notConfigured": "Not configured",
    "status.notificationActionFailed": "Notification action failed: {message}",
    "status.notificationLoadFailed": "Notification load failed: {message}",
    "status.pasteFailed": "Paste failed: {message}",
    "status.aiConfigSaved": "AI settings saved",
    "status.aiModelsReady": "{count} model(s) loaded",
    "status.aiNoTerminalTarget": "Open or select a terminal first.",
    "status.aiNoOutput": "No AI output",
    "status.aiSentToTerminal": "Sent to {target}",
    "status.aiTestOk": "AI test passed",
    "status.aiWorking": "AI request running...",
    "status.aiVoiceConfigRemoved": "Voice provider removed",
    "status.aiVoiceConfigSaved": "Voice provider saved",
    "status.aiVoiceEmpty": "No speech text returned",
    "status.aiVoiceFailed": "Voice input failed: {message}",
    "status.aiVoiceInserted": "Voice text inserted",
    "status.aiVoiceRecording": "Recording voice...",
    "status.aiVoiceStartFailed": "Microphone failed: {message}",
    "status.aiVoiceTranscribing": "Transcribing voice...",
    "status.aiVoiceTooLarge": "Voice recording is larger than 25 MB",
    "status.aiVoiceReplyConfigRemoved": "Reply voice removed",
    "status.aiVoiceReplyConfigSaved": "Reply voice saved",
    "status.aiVoiceReplyFailed": "Voice reply failed: {message}",
    "status.aiVoiceReplyLoading": "Preparing voice reply...",
    "status.aiVoiceReplyPlaying": "Playing voice reply",
    "status.aiVoiceReplyReady": "Voice reply ready",
    "status.aiVoiceReplyTestLoading": "Testing reply voice...",
    "status.aiVoiceReplyTestReady": "Reply voice test ready",
    "status.pluginDisableFailed": "Disable failed: {message}",
    "status.pluginDisabled": "{name} disabled",
    "status.pluginEnableFailed": "Enable failed: {message}",
    "status.pluginEnabled": "{name} enabled",
    "status.pluginFileDone": "{operation} complete",
    "status.pluginFileEmpty": "This directory is empty",
    "status.pluginFileNoSession": "Open or select a terminal session first.",
    "status.pluginFileUploadDone": "Uploaded {name}",
    "status.pluginLoadFailed": "Tool load failed: {message}",
    "status.pluginSettingsSaved": "{name} settings saved",
    "status.pluginSettingsSaveFailed": "Settings save failed: {message}",
    "status.terminalInputFileUploadUnavailable": "File upload is not available for this terminal.",
    "status.terminalInputImageUploadUnavailable": "Image upload is not available for this terminal.",
    "status.terminalInputNoImageFile": "Choose an image file to upload.",
    "status.terminalInputTemporaryPathsInserted": "Temporary file path inserted",
    "status.whiteNoiseAudioError": "Cannot load sound: {name}",
    "status.whiteNoiseInstallDone": "Installed {count} sound(s)",
    "status.whiteNoiseInstallFailed": "Sound package install failed: {message}",
    "status.whiteNoiseInstalling": "Downloading sound package...",
    "status.whiteNoiseLoaded": "{count} sound(s) loaded",
    "status.whiteNoiseLoadFailed": "Sound catalog load failed: {message}",
    "status.whiteNoiseNoSounds": "Add audio files before playing sounds.",
    "status.whiteNoiseNoSelection": "Select at least one sound before playing.",
    "status.whiteNoisePlayFailed": "Playback failed: {message}",
    "status.whiteNoisePreviewFailed": "Preview failed: {name}",
    "status.whiteNoisePlaying": "White noise is playing",
    "status.whiteNoiseStopped": "White noise stopped",
    "status.portForwardReady": "{count} port forward(s) active",
    "status.publicTunnelReady": "{count} tunnel(s) active",
    "status.quickPhraseRemoved": "Phrase removed",
    "status.quickPhraseSaved": "Phrase saved",
    "status.tunnelProfileRemoved": "Tunnel profile removed",
    "status.tunnelProfileSaved": "Tunnel profile saved",
    "status.pluginsLoading": "Loading tools...",
    "status.pluginsReady": "{count} tool(s) ready",
    "status.processExited": "Process exited: {code}",
    "status.reconnecting": "Disconnected. Reconnecting in {seconds}s...",
    "status.selectRunningInstance": "Select a running instance first.",
    "status.selectionCopied": "Selection copied",
    "status.shellReady": "Shell ready",
    "status.socketError": "Socket error",
    "status.startupFailed": "Startup failed: {message}",
    "status.sessionStopped": "Session stopped",
    "status.sshUrlOpenFailed": "SSH URL open failed: {message}",
    "status.sshUrlProfileReady": "SSH profile ready: {name}",
    "status.terminalError": "Terminal error",
    "status.themeInvalid": "Theme invalid: {message}",
    "status.themeRemoved": "{name} removed",
    "status.themeSaved": "{name} saved",
    "status.urlCopied": "URL copied",
    "status.terminalTransferCancelled": "Terminal transfer cancelled",
    "status.terminalTransferComplete": "{name} complete",
    "status.terminalTransferDetecting": "Transfer detected",
    "status.terminalTransferFailed": "Terminal transfer failed: {message}",
    "status.terminalTransferNoProtocol": "No transfer protocol is enabled.",
    "status.terminalTransferReady": "Ready for rz/sz and trz/tsz in the current terminal.",
    "status.terminalTransferReadyLrzsz": "Ready for rz/sz in the current terminal.",
    "status.terminalTransferReadyTrzsz": "Ready for trz/tsz in the current terminal.",
    "status.terminalTransferStarted": "{protocol} transfer started",
    "status.terminalTransferUnsupportedBackend": "Terminal transfer is only available in WebShell native terminal tabs.",
    "status.trzszDownloadDetected": "trzsz remote download request detected.",
    "status.trzszProgressInTerminal": "trzsz progress is shown in the terminal.",
    "status.trzszTransferring": "trzsz transfer in progress.",
    "status.trzszUploadDetected": "trzsz remote upload request detected.",
    "status.zmodemCancelled": "Cancelled",
    "status.zmodemChooseSaveLocation": "Choose where to save {name}.",
    "status.zmodemChooseSaveLocationShort": "Choose save location",
    "status.zmodemChooseUploadFile": "Choose local file",
    "status.zmodemComplete": "Complete",
    "status.zmodemDetecting": "ZMODEM detected",
    "status.zmodemDownloadDetected": "Remote download request detected.",
    "status.zmodemFailed": "Failed",
    "status.zmodemReady": "Ready for rz/sz in the current terminal.",
    "status.zmodemReceiving": "Receiving remote file.",
    "status.zmodemReceivingFallback": "Receiving remote file; the browser will download it when complete.",
    "status.zmodemTransferCancelled": "ZMODEM transfer cancelled",
    "status.zmodemTransferComplete": "{name} complete",
    "status.zmodemTransferFailed": "ZMODEM transfer failed: {message}",
    "status.zmodemTransferStarted": "ZMODEM transfer started: {name}",
    "status.zmodemTransferring": "Transferring",
    "status.zmodemUnsupportedBackend": "ZMODEM is only available in WebShell terminal tabs.",
    "status.zmodemUploadDetected": "Remote upload request detected.",
    "status.zmodemUploadingTo": "Uploading into {path}.",
    "status.zmodemUploadingToCurrentDirectory": "Uploading into the current terminal directory.",
    "theme.builtIn": "Built in",
    "theme.custom": "Custom",
    "theme.gallery": "Ghostty Style Gallery",
    "theme.noCustom": "No custom themes",
    "theme.recommended": "Recommended",
    "touch.drag": "Drag to select",
    "touch.longPress": "Pan first, long-press select",
    "touch.off": "Touch selection off",
    "terminalTransfer.protocolLrzsz": "lrzsz (rz/sz)",
    "terminalTransfer.protocolLrzszHelp": "Handles classic rz upload and sz download through ZMODEM.",
    "terminalTransfer.protocolTrzsz": "trzsz (trz/tsz)",
    "terminalTransfer.protocolTrzszHelp": "Handles trz upload and tsz download through trzsz.js.",
    "terminalTransfer.protocolsHelp": "Choose which terminal transfer protocols this built-in tool should intercept. At least one protocol stays enabled.",
    "terminalTransfer.protocolsTitle": "Supported protocols",
    "validation.fontExtension": "only .woff, .woff2, .ttf, and .otf are allowed",
    "validation.fontMime": "unsupported font MIME type: {mimeType}",
    "validation.fontSize": "font must be between 1 byte and 10 MB",
    "validation.backgroundExtension": "only .png, .jpg, .jpeg, and .webp are allowed",
    "validation.backgroundMime": "unsupported background image MIME type: {mimeType}",
    "validation.backgroundSize": "background image must be between 1 byte and 10 MB",
    "validation.aiAccess": "enter Base URL and API key",
    "validation.aiPrompt": "enter a prompt",
    "validation.ngrokAuthtoken": "enter an authentication token",
    "validation.mcpUrl": "enter an MCP server URL",
    "validation.pluginPath": "enter a target path",
    "validation.port": "enter a port from 1 to 65535",
    "validation.quickPhraseLimit": "keep at most {count} phrases",
    "validation.quickPhraseText": "enter phrase text",
    "validation.themeName": "theme name is required",
    "validation.themeSource": "paste a Ghostty theme with background, foreground, or palette entries",
    "validation.tunnelProfile": "select a configured tunnel profile",
    "validation.tunnelProfileName": "enter a profile name",
    "validation.upstreamUrl": "enter a local upstream URL",
    "validation.whiteNoisePackageUrl": "enter a sound package URL",
    "zmodem.directionDownload": "Download",
    "zmodem.directionUpload": "Upload",
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
    "action.back": "返回",
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
    "action.aiSendToTerminal": "发送到终端",
    "action.aiTest": "测试",
    "action.aiVoiceHold": "按住说话",
    "action.aiVoiceProviderAdd": "添加语音服务",
    "action.aiVoiceProviderEdit": "编辑语音服务",
    "action.aiVoiceProviderRemove": "移除语音服务",
    "action.aiVoiceProviderSelect": "使用语音服务",
    "action.aiVoiceReplyProviderAdd": "添加回复音色",
    "action.aiVoiceReplyProviderEdit": "编辑回复音色",
    "action.aiVoiceReplyProviderRemove": "移除回复音色",
    "action.aiVoiceReplyProviderSelect": "使用回复音色",
    "action.aiVoiceReplyPause": "暂停语音回复",
    "action.aiVoiceReplyPlay": "播放语音回复",
    "action.aiVoiceReplyHideText": "收起文本",
    "action.aiVoiceReplyShowText": "展开文本",
    "action.aiVoiceReplyTest": "测试回复音色",
    "action.cancel": "取消",
    "action.close": "关闭",
    "action.closeActiveSession": "关闭当前活动会话",
    "action.closeHerdrSpace": "关闭 Herdr Space",
    "action.closePlugins": "关闭工具",
    "action.closeSettings": "关闭设置",
    "action.copySelection": "复制选区",
    "action.copyUrl": "复制 URL",
    "action.dismissNotification": "关闭",
    "action.focusTerminal": "聚焦终端",
    "action.fullscreen": "全屏",
    "action.hideToken": "隐藏 token",
    "action.lightosHome": "LightOS 首页",
    "action.markNotificationRead": "标为已读",
    "action.mcpAdd": "添加 MCP 服务",
    "action.mcpEdit": "编辑 MCP 服务",
    "action.mcpRemove": "移除 MCP 服务",
    "action.newHerdrSpace": "新建 Herdr Space",
    "action.newHerdrTab": "新建 Herdr 标签",
    "action.newTab": "新建终端标签",
    "action.openNotificationLink": "打开链接",
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
    "action.portForwardAcquire": "转发端口",
    "action.portForwardRelease": "停止转发",
    "action.pomodoroAgain": "再来一轮",
    "action.pomodoroDismiss": "知道了",
    "action.pomodoroNextRound": "下一轮",
    "action.pomodoroStart": "开始",
    "action.pomodoroStop": "结束番茄",
    "action.whiteNoiseCollapse": "收起白噪音播放控制条",
    "action.whiteNoiseExpand": "展开白噪音播放控制条",
    "action.whiteNoiseHelp": "声音配置帮助",
    "action.whiteNoiseInstall": "下载",
    "action.whiteNoisePause": "暂停",
    "action.whiteNoisePlay": "播放",
    "action.whiteNoisePreview": "试听 {name}",
    "action.whiteNoiseStop": "停止",
    "action.whiteNoiseStopPreview": "停止试听 {name}",
    "action.whiteNoiseVolumeDown": "音量减",
    "action.whiteNoiseVolumeUp": "音量加",
    "action.promoteSessionToTab": "将会话提升为新标签",
    "action.quickPhraseAdd": "添加短语",
    "action.quickPhraseCancel": "取消",
    "action.quickPhraseRemove": "删除短语",
    "action.quickPhraseSave": "保存短语",
    "action.refresh": "刷新",
    "action.refreshHerdr": "刷新 Herdr",
    "action.refreshInstances": "刷新实例",
    "action.refreshPlugins": "刷新工具",
    "action.movePinnedTabNext": "固定标签后移",
    "action.movePinnedTabPrevious": "固定标签前移",
    "action.pinTab": "固定标签",
    "action.removeFont": "移除当前字体",
    "action.removeTerminalBackground": "移除终端背景",
    "action.removeTheme": "删除自定义主题",
    "action.save": "保存",
    "action.saveTheme": "保存自定义主题",
    "action.settings": "设置",
    "action.settingsMenu": "设置菜单",
    "action.shortcutHelp": "快捷键",
    "action.sshConnect": "连接 SSH",
    "action.closeTab": "关闭标签",
    "action.renameTab": "重命名标签",
    "action.resizeDown": "向下调整",
    "action.resizeLeft": "向左调整",
    "action.resizeRight": "向右调整",
    "action.resizeUp": "向上调整",
    "action.splitDown": "向下拆分",
    "action.splitLeft": "向左拆分",
    "action.splitRight": "向右拆分",
    "action.splitUp": "向上拆分",
    "action.switchInstance": "切换实例",
    "action.terminalInputActions": "终端输入动作",
    "action.terminalInputActionsHold": "点按选择输入动作，长按语音输入",
    "action.terminalInputUploadFile": "上传文件",
    "action.terminalInputUploadFileCurrent": "上传到当前目录",
    "action.terminalInputUploadFileTemporary": "上传到临时目录",
    "action.terminalInputUploadImage": "上传图片",
    "action.terminalInputVoice": "语音输入",
    "action.tunnelStart": "启动 Tunnel",
    "action.tunnelStop": "停止 Tunnel",
    "action.tunnelProfileAdd": "添加配置",
    "action.tunnelProfileEdit": "编辑配置",
    "action.tunnelProfileRemove": "移除配置",
    "action.uploadFont": "上传字体",
    "action.uploadTerminalBackground": "上传终端背景",
    "action.unpinTab": "取消固定标签",
    "action.useForTunnel": "用于 Tunnel",
    "action.showToken": "显示 token",
    "action.zmodemCancel": "取消传输",
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
    "field.aiTargetTerminal": "目标终端",
    "field.aiVoiceEndpointType": "接口类型",
    "field.aiVoiceFormat": "录音格式",
    "field.aiVoiceLanguage": "语音语言",
    "field.aiVoiceProfileName": "语音配置名称",
    "field.aiVoiceProvider": "语音服务商",
    "field.aiVoiceReplyFormat": "音频格式",
    "field.aiVoiceReplyInstructions": "朗读风格",
    "field.aiVoiceReplyProfileName": "回复音色名称",
    "field.aiVoiceReplyVoice": "音色",
    "field.defaultSessionBackend": "新建入口后端",
    "field.sshTarget": "SSH 目标",
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
    "field.quickPhraseLabel": "显示名称",
    "field.quickPhraseText": "短语内容",
    "field.remoteHost": "远端主机",
    "field.remotePort": "远端端口",
    "field.scrollback": "回滚行数",
    "field.tabs": "标签栏",
    "field.terminalBackgroundBlur": "背景模糊",
    "field.terminalBackgroundOpacity": "背景透明度",
    "field.terminalShaderEffect": "终端特效",
    "field.theme": "终端主题",
    "field.themeName": "主题名称",
    "field.themeSource": "Ghostty 主题",
    "field.touchBehavior": "触控行为",
    "field.secretKeepBlank": "留空则保留已保存的 token",
    "field.tunnelProfileName": "配置名称",
    "field.tunnelProvider": "Tunnel 服务",
    "field.upstreamUrl": "上游 URL",
    "field.ngrokAuthtoken": "认证 token",
    "field.terminalTransferProtocol": "协议",
    "field.zmodemDestination": "目标位置",
    "field.zmodemDirection": "方向",
    "field.zmodemFile": "文件",
    "field.zmodemSize": "大小",
    "fileKind.directory": "目录",
    "fileKind.file": "文件",
    "fileKind.hardlink": "硬链接",
    "fileKind.other": "其他",
    "fileKind.symlink": "软链接",
    "font.builtIn": "内置",
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
    "label.currentTime": "当前时间",
    "label.mobileFnKeys": "功能键",
    "label.mobileMainKeys": "主快捷键",
    "label.mobileNavKeys": "导航键",
    "label.mobileOpsKeys": "终端操作",
    "label.mobileSymbolKeys": "符号",
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
    "ai.voiceEnableHelp": "启用后，移动端键盘上方、PC 页面底部中间会显示按住说话按钮。",
    "ai.voiceEndpointAudioSpeech": "Audio Speech",
    "ai.voiceEndpointAudioTranscriptions": "Audio Transcriptions",
    "ai.voiceEndpointChatAudio": "Chat audio",
    "ai.voiceEndpointChatInputAudio": "Chat input_audio",
    "ai.voiceFormatNotSupported": "当前浏览器不支持所选录音格式",
    "ai.voiceNotConfigured": "语音服务未配置",
    "ai.voiceProviderCompatible": "OpenAI 兼容",
    "ai.voiceProviderHelp": "小米预设使用 Chat Completions input_audio。自定义兼容服务可以选择 Audio Transcriptions 或 Chat input_audio。",
    "ai.voiceProviderMimo": "小米 Mimo",
    "ai.voiceProviderMimoTokenPlan": "小米 Mimo Token Plan",
    "ai.voiceReplyEnableHelp": "启用后，AI 回复默认显示语音播放条，文本默认折叠。",
    "ai.voiceReplyInstructionsPlaceholder": "例如：用自然、清晰的中文播报语气朗读。",
    "ai.voiceReplyNotConfigured": "回复音色未配置",
    "ai.voiceReplyProviderHelp": "小米预设使用 Chat Completions audio。兼容服务可按接口形态选择 Audio Speech 或 Chat audio。",
    "plugin.aiChat.block": "聊天",
    "plugin.aiChat.description": "WebShell 内的 Chat 工具，可用于命令辅助、问题排查和记录整理。",
    "plugin.aiChat.name": "AI Chat",
    "plugin.aiChat.output": "AI 聊天输出",
    "plugin.fileTransfer.description": "浏览设备文件，上传多个本地文件，并下载选中的设备路径。",
    "plugin.fileTransfer.help": "设备侧使用当前活动终端会话和登录用户；浏览器可以选择本地文件，但不能暴露本地目录树。",
    "plugin.fileTransfer.name": "文件传输",
    "plugin.fileTransfer.output": "文件传输输出",
    "plugin.lightosPortForward.description": "把当前 LightOS 实例里的 HTTP 端口转发到 WebShell 后端本地。",
    "plugin.lightosPortForward.help": "转发租约会在 WebShell 后端运行期间保持。可以直接使用本地 URL，也可以交给 Public Tunnel 发布。",
    "plugin.lightosPortForward.name": "LightOS 端口转发",
    "plugin.meta.ai": "AI",
    "plugin.meta.filesystem": "文件系统",
    "plugin.meta.lightos": "LightOS",
    "plugin.meta.network": "网络",
    "plugin.meta.productivity": "效率",
    "plugin.meta.session": "会话",
    "plugin.meta.sound": "声音",
    "plugin.meta.tunnel": "Tunnel",
    "plugin.meta.transfer": "传输",
    "plugin.pomodoro.description": "工具面板里的专注计时器，用于短时间工作节奏。",
    "plugin.pomodoro.name": "番茄时钟",
    "plugin.publicTunnel.description": "通过 Cloudflare Quick Tunnel 或 ngrok 发布本地 HTTP URL。",
    "plugin.publicTunnel.help": "Tunnel 租约会在 WebShell 后端运行期间保持。要发布实例内服务，请先选择 LightOS 转发得到的本地 URL。",
    "plugin.publicTunnel.name": "Public Tunnel",
    "plugin.publicTunnel.settingsHelp": "Cloudflare Quick Tunnel 无需认证配置。需要 token 的 Tunnel 服务商，请先在这里添加认证配置。",
    "plugin.terminalTransfer.description": "自动处理 WebShell 终端里的 lrzsz（rz/sz）和 trzsz（trz/tsz）传输。",
    "plugin.terminalTransfer.help": "执行 rz/trz 会上传到当前目录；执行 sz/tsz <file> 会通过浏览器保存远端文件。",
    "plugin.terminalTransfer.name": "终端传输",
    "plugin.terminalTransfer.output": "终端传输进度",
    "plugin.whiteNoise.description": "从 /lzcapp/var/sounds 播放本地专注声音。",
    "plugin.whiteNoise.help": "混合播放设备 sounds 目录里的本地音频。输入资源包地址即可自动下载并解压。",
    "plugin.whiteNoise.name": "白噪音",
    "pomodoro.completeHint": "本轮专注已经完成。休息一下，再开始下一轮。",
    "pomodoro.completeTitle": "番茄时间到了",
    "pomodoro.customMinutes": "自定义分钟",
    "pomodoro.presets": "番茄时钟预设",
    "pomodoro.preset5": "5 分钟",
    "pomodoro.preset15": "15 分钟",
    "pomodoro.preset25": "25 分钟",
    "pomodoro.remaining": "剩余时间",
    "pomodoro.roundProgress": "第 {current}/{total} 轮",
    "pomodoro.roundSetup": "共 {total} 轮",
    "pomodoro.rounds": "轮次",
    "pomodoro.runningHint": "本轮将在 {time} 结束。",
    "pomodoro.runningTitle": "番茄进行中",
    "pomodoro.setupHint": "选择一个专注时长，终端保持可见。",
    "pomodoro.title": "番茄时钟",
    "whiteNoise.categoryCount": "{count} 个声音",
    "whiteNoise.dirMissing": "声音目录还未准备好",
    "whiteNoise.disabled": "关闭",
    "whiteNoise.downloadProgress": "下载中 {current} / {total}",
    "whiteNoise.downloadStarting": "准备下载...",
    "whiteNoise.enabled": "开启",
    "whiteNoise.extractProgress": "解压中 {current}/{total} 个文件，{bytes}",
    "whiteNoise.helpCustom": "也可以在 sounds/ 下新增自己的分类目录和音频文件。修改文件后点击刷新。",
    "whiteNoise.helpFormats": "支持的音频格式：{formats}。",
    "whiteNoise.helpRemotePackage": "默认远程资源包",
    "whiteNoise.helpRoot": "音频文件从 {path} 读取。sounds/ 下第一层目录会作为分类。",
    "whiteNoise.helpTitle": "如何放置音频",
    "whiteNoise.helpUnzip": "在设备上下载并解压",
    "whiteNoise.helpZipTitle": "压缩包目录结构",
    "whiteNoise.idle": "未播放",
    "whiteNoise.installComplete": "已安装 {count} 个声音",
    "whiteNoise.installing": "下载中",
    "whiteNoise.loadError": "加载声音列表失败",
    "whiteNoise.loading": "正在加载声音...",
    "whiteNoise.masterVolume": "总音量",
    "whiteNoise.noFiles": "没有找到支持的音频文件",
    "whiteNoise.openHelp": "打开声音配置帮助。",
    "whiteNoise.packageUrl": "资源包地址",
    "whiteNoise.packageUrlPlaceholder": "https://example.com/sounds.zip",
    "whiteNoise.playing": "播放中",
    "whiteNoise.skippedFiles": "已跳过 {count} 个文件",
    "whiteNoise.soundMix": "声音混合",
    "whiteNoise.toggleTrack": "切换 {name}",
    "whiteNoise.trackVolume": "{name} 音量",
    "whiteNoise.unknownSize": "未知大小",
    "section.appearance": "外观",
    "section.aiAccess": "AI 接入",
    "section.fileTransfer": "文件传输",
    "section.fonts": "字体",
    "section.desktopShortcuts": "桌面端",
    "section.herdr": "Herdr 控件",
    "section.herdrTabs": "Herdr 标签",
    "section.herdrWorkspaces": "Herdr Spaces",
    "section.herdrHighlight": "Herdr 选中态",
    "section.mobileClock": "移动端时间显示",
    "section.mobileQuickInput": "移动端快速输入",
    "section.mobileShortcuts": "移动端",
    "section.notifications": "通知",
    "section.plugins": "工具",
    "section.sessionBackend": "会话后端",
    "section.shortcuts": "快捷键",
    "section.terminalBackground": "终端背景",
    "section.themes": "终端主题",
    "section.tunnelProviders": "Tunnel 服务商",
    "setting.autoRestartSessions": "Provider 重启后自动恢复会话",
    "setting.aiVoiceInputEnabled": "启用语音输入",
    "setting.aiVoiceReplyEnabled": "启用语音回复",
    "setting.copyOnSelect": "选中即复制",
    "setting.cursorBlink": "光标闪烁",
    "setting.debugAdapter": "调试适配器",
    "setting.defaultSessionBackendHelp": "+ 按钮使用这个后端创建。Herdr 已有引擎入口时，再点 + 会在同一个 Herdr session 里新建 Workspace。",
    "setting.aiTerminalContext": "终端上下文",
    "setting.fontHinting": "字体微调",
    "setting.fontLigatures": "编程连字",
    "setting.fontRenderingHelp": "编程连字会渲染 =>、!= 这类符号；字体微调可以让小字号更锐利，但可能增加一点字体栅格化开销。",
    "setting.herdrHighlightHelp": "分别设置深色和浅色界面风格下，Herdr 当前工作区和标签的背景色。",
    "setting.mobileClock24Hour": "使用 24 小时制",
    "setting.mobileClockEnabled": "显示移动端时间",
    "setting.mobileClockHelp": "控制移动端辅助键盘标签旁边的时间显示。",
    "setting.mobileClockPeriod": "显示上午/下午",
    "setting.mobileQuickInputHelp": "保存个人常用短语，移动端会在 Sym 后显示；点击后按使用频率排序。",
    "setting.pluginDisabled": "已关闭",
    "setting.pluginEnabled": "已启用",
    "setting.whiteNoiseFloatingControls": "显示左侧播放控制",
    "setting.whiteNoiseFloatingControlsHelp": "白噪音启用时，在左侧显示播放/暂停和音量控制浮动条。",
    "setting.whiteNoiseAutoPlayOnSelect": "选择后自动播放",
    "setting.whiteNoiseAutoPlayOnSelectHelp": "开启后，选中声音会自动开始播放；取消到 0 个声音时自动停止。",
    "setting.terminalBackground": "使用背景图片",
    "setting.terminalShaderHelp": "GPU 特效默认关闭。需要额外的输入反馈时再开启。",
    "setting.useResttyClipboard": "使用 restty 剪贴板",
    "sshConfirm.deleteProfile": "删除 SSH profile “{name}”？",
    "sshError.deleteProfile": "删除 SSH profile 失败：{message}",
    "sshError.loadConfig": "加载 SSH config 失败：{message}",
    "sshError.loadKey": "加载 SSH 密钥文件失败：{message}",
    "sshError.loadProfiles": "加载 SSH profile 失败：{message}",
    "sshError.openProfile": "打开 SSH profile 失败：{message}",
    "sshError.saveConfig": "保存 SSH config 失败：{message}",
    "sshError.saveHost": "保存 SSH Host 失败：{message}",
    "sshError.saveKey": "保存 SSH 密钥文件失败：{message}",
    "sshError.saveProfile": "保存 SSH profile 失败：{message}",
    "sshError.testProfile": "SSH 测试失败：{message}",
    "sshSettings.acceptNewHosts": "接受新主机",
    "sshSettings.advanced": "高级",
    "sshSettings.advancedNetwork": "代理和高级",
    "sshSettings.backupLimit": "保留备份",
    "sshSettings.badgeConfig": "config",
    "sshSettings.badgeKey": "key",
    "sshSettings.badgeOpenSsh": "openssh",
    "sshSettings.badgeProfile": "profile",
    "sshSettings.badgeSsh": "ssh",
    "sshSettings.basic": "基础",
    "sshSettings.chooseHost": "从 ~/.ssh/config 选择 Host",
    "sshSettings.configSelectLabel": "OpenSSH config",
    "sshSettings.configSource": "配置来源",
    "sshSettings.connectionCount": "{profiles} 个已保存 / {hosts} 个 config",
    "sshSettings.connectionCountFiltered": "显示 {shown} 个，来自 {profiles} 个已保存 / {hosts} 个 config",
    "sshSettings.connectionsAria": "SSH 连接",
    "sshSettings.currentLightosConfig": "当前 LightOS 实例 ~/.ssh/config",
    "sshSettings.delete": "删除",
    "sshSettings.deviceOpenSsh": "设备 OpenSSH",
    "sshSettings.displayHost": "显示主机",
    "sshSettings.displayUser": "显示用户",
    "sshSettings.editHostTitle": "编辑 {host}",
    "sshSettings.editKeyLabel": "编辑 {label}",
    "sshSettings.editModeAria": "SSH config 编辑模式",
    "sshSettings.enabled": "启用",
    "sshSettings.extraOptions": "其他选项",
    "sshSettings.help": "管理 OpenSSH config、密钥文件和保存的 SSH 连接。",
    "sshSettings.hide": "隐藏",
    "sshSettings.host": "主机",
    "sshSettings.hostCount": "{count} 个 Host",
    "sshSettings.hostForm": "Host 表单",
    "sshSettings.hostKeyChecking": "主机密钥检查",
    "sshSettings.hostListAria": "OpenSSH config Host",
    "sshSettings.keyContent": "内容",
    "sshSettings.keyFile": "密钥文件",
    "sshSettings.keyHidden": "密钥内容已隐藏（{bytes} bytes）。点击显示后查看或编辑。",
    "sshSettings.keyMissingHidden": "密钥文件不存在。点击显示后可以创建或编辑。",
    "sshSettings.keyPath": "路径",
    "sshSettings.managedKey": "托管密钥",
    "sshSettings.managedKeyTitle": "托管密钥",
    "sshSettings.managedPublicKey": "托管公钥",
    "sshSettings.managedSubtitle": "创建由 WebShell 托管密钥的 profile。",
    "sshSettings.name": "名称",
    "sshSettings.newConnection": "新建 SSH 连接",
    "sshSettings.newHost": "新增 Host",
    "sshSettings.newHostTitle": "新增 Host",
    "sshSettings.noConfigHosts": "当前 config 没有 Host。",
    "sshSettings.noConnectionMatch": "没有匹配的 SSH 连接。",
    "sshSettings.noHostName": "未配置 HostName",
    "sshSettings.off": "关闭",
    "sshSettings.open": "打开",
    "sshSettings.openNamedProfile": "打开 {name}",
    "sshSettings.openSsh": "OpenSSH",
    "sshSettings.openSshSubtitle": "使用设备 ssh 命令解析 Host 别名或目标。",
    "sshSettings.openSshTarget": "OpenSSH 目标",
    "sshSettings.port": "端口",
    "sshSettings.profileTypeAria": "SSH profile 类型",
    "sshSettings.providerConfig": "Provider ~/.ssh/config",
    "sshSettings.publicKey": "公钥",
    "sshSettings.publicKeyPending": "保存 profile 后会生成公钥。",
    "sshSettings.rawConfig": "原始 config",
    "sshSettings.refreshHosts": "刷新远程主机",
    "sshSettings.saveAsProfile": "保存为 profile",
    "sshSettings.saveConfig": "保存 config",
    "sshSettings.saveHost": "保存 Host 到 config",
    "sshSettings.saveKey": "保存密钥",
    "sshSettings.saveNamedAsProfile": "将 {name} 保存为 profile",
    "sshSettings.saveProfile": "保存 profile",
    "sshSettings.searchLabel": "搜索 SSH 连接",
    "sshSettings.searchPlaceholder": "搜索已保存连接或 ~/.ssh/config Host",
    "sshSettings.show": "显示",
    "sshSettings.strict": "严格",
    "sshSettings.test": "测试",
    "sshSettings.title": "远程主机",
    "sshSettings.unsaved": "未保存",
    "sshSettings.user": "用户",
    "sshStatus.configLoaded": "SSH 配置已加载",
    "sshStatus.configRefreshed": "SSH config 已刷新",
    "sshStatus.configSaved": "config 已保存",
    "sshStatus.configSavedBackup": "config 已保存，备份：{path}",
    "sshStatus.hostSaved": "Host 已保存到 config",
    "sshStatus.keyLoaded": "密钥文件已读取",
    "sshStatus.keyMissing": "密钥文件不存在，保存后会创建。",
    "sshStatus.keySaved": "密钥已保存",
    "sshStatus.keySavedBackup": "密钥已保存，备份：{path}",
    "sshStatus.noProfiles": "还没有保存的 SSH profile",
    "sshStatus.openingProfile": "正在打开 SSH profile：{name}",
    "sshStatus.profileDeleted": "SSH profile 已删除",
    "sshStatus.profileSaved": "SSH profile 已保存",
    "sshValidation.enableBeforeOpening": "请先启用 SSH profile 再打开",
    "sshValidation.hostRequired": "Host 不能为空",
    "sshValidation.keyPathRequired": "密钥路径不能为空",
    "sshValidation.nameRequired": "名称不能为空",
    "sshValidation.openSshTargetRequired": "OpenSSH 目标不能为空",
    "sshValidation.portRange": "端口必须在 1 到 65535 之间",
    "sshValidation.saveBeforeTesting": "请先保存 SSH profile 再测试",
    "ssh.back": "返回",
    "ssh.chooseHelp": "从 {instance} 的 ~/.ssh/config 选择 Host，或使用已保存的 profile。",
    "ssh.chooseTitle": "选择 SSH 主机",
    "ssh.configHosts": "~/.ssh/config",
    "ssh.configLoadFailed": "SSH config 加载失败：{message}",
    "ssh.directAction": "从当前实例连接",
    "ssh.directLightosHint": "使用当前 LightOS 实例里的 ssh",
    "ssh.loading": "正在加载 SSH 主机...",
    "ssh.manageHosts": "管理远程主机",
    "ssh.manualConnect": "手动输入目标",
    "ssh.manualTitle": "SSH 目标",
    "ssh.noHosts": "暂无 SSH 主机。",
    "ssh.quickHelpLightos": "从 {instance} 发起 ssh，使用它自己的 ~/.ssh/config 和密钥。",
    "ssh.quickHelpProvider": "打开已保存的 SSH profile，或用目标自动创建一个。",
    "ssh.quickPlaceholder": "Host 别名或 user@example.com",
    "ssh.quickTitle": "SSH 远程",
    "ssh.savedProfiles": "已保存 profile",
    "ssh.sourceLightosConfig": "LightOS config",
    "ssh.sourceManagedKey": "托管密钥",
    "ssh.sourceProviderConfig": "Provider config",
    "ssh.sourceSavedProfile": "Profile",
    "ssh.validationTarget": "请输入有效的 SSH 目标。",
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
    "tab.terminalSession": "终端 {index}",
    "tab.zellijSession": "zellij {index}",
    "tab.aiProvider": "AI 服务",
    "tab.aiVoice": "语音",
    "tab.mcp": "MCP",
    "tab.mobile": "移动端",
    "tab.plugins": "工具",
    "tab.quickPhrases": "短语",
    "tab.remoteHosts": "远程主机",
    "tab.terminal": "终端",
    "tab.themes": "主题",
    "status.closed": "已关闭",
    "status.connected": "已连接",
    "status.connectFailed": "连接失败：{message}",
    "status.copyFailed": "复制失败：{message}",
    "status.creatingSession": "正在创建会话...",
    "status.defaultBackend": "默认",
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
    "status.backendActionFailed": "{backend} 操作失败：{message}",
    "status.backendActionUnavailable": "{backend} 不支持这个面板操作",
    "status.herdrActionFailed": "Herdr 操作失败：{message}",
    "status.herdrEvent": "Herdr {event}：{subject}",
    "status.herdrEventAgent": "Herdr {agent}：{status}",
    "status.herdrEntryRestored": "已恢复 Herdr 入口",
    "status.herdrNotification": "Herdr：{message}",
    "status.herdrProtocolNewer": "设备上的 Herdr 协议为 {actual}，高于 WebShell 当前适配的 {expected}（参考 Herdr {expectedVersion}）。可能需要通知软件作者更新 Herdr protocol 适配。",
    "status.herdrProtocolOlder": "设备上的 Herdr 协议为 {actual}，低于 WebShell 当前适配的 {expected}（参考 Herdr {expectedVersion}）。可能需要更新设备上的 Herdr。",
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
    "status.noNotifications": "暂无通知",
    "status.noPlugins": "暂无可用工具",
    "status.noPortForwards": "暂无活动端口转发",
    "status.noPublicTunnels": "暂无活动 Public Tunnel",
    "status.noQuickPhrases": "暂无快速短语",
    "status.noTunnelProfiles": "暂无 Tunnel 认证配置",
    "status.noSelection": "没有可复制的选区",
    "status.noSessions": "没有会话",
    "status.noTarget": "未选择实例",
    "status.notConfigured": "未配置",
    "status.notificationActionFailed": "通知操作失败：{message}",
    "status.notificationLoadFailed": "通知加载失败：{message}",
    "status.pasteFailed": "粘贴失败：{message}",
    "status.aiConfigSaved": "AI 设置已保存",
    "status.aiModelsReady": "已加载 {count} 个模型",
    "status.aiNoTerminalTarget": "请先打开或选择一个终端。",
    "status.aiNoOutput": "没有 AI 输出",
    "status.aiSentToTerminal": "已发送到 {target}",
    "status.aiTestOk": "AI 测试通过",
    "status.aiWorking": "AI 请求中...",
    "status.aiVoiceConfigRemoved": "语音服务已移除",
    "status.aiVoiceConfigSaved": "语音服务已保存",
    "status.aiVoiceEmpty": "没有返回语音文本",
    "status.aiVoiceFailed": "语音输入失败：{message}",
    "status.aiVoiceInserted": "语音文本已输入",
    "status.aiVoiceRecording": "正在录音...",
    "status.aiVoiceStartFailed": "麦克风启动失败：{message}",
    "status.aiVoiceTranscribing": "正在转写语音...",
    "status.aiVoiceTooLarge": "语音录音超过 25 MB",
    "status.aiVoiceReplyConfigRemoved": "回复音色已移除",
    "status.aiVoiceReplyConfigSaved": "回复音色已保存",
    "status.aiVoiceReplyFailed": "语音回复失败：{message}",
    "status.aiVoiceReplyLoading": "正在准备语音回复...",
    "status.aiVoiceReplyPlaying": "正在播放语音回复",
    "status.aiVoiceReplyReady": "语音回复已就绪",
    "status.aiVoiceReplyTestLoading": "正在测试回复音色...",
    "status.aiVoiceReplyTestReady": "回复音色测试已就绪",
    "status.pluginDisableFailed": "关闭失败：{message}",
    "status.pluginDisabled": "{name} 已关闭",
    "status.pluginEnableFailed": "启用失败：{message}",
    "status.pluginEnabled": "{name} 已启用",
    "status.pluginFileDone": "{operation} 完成",
    "status.pluginFileEmpty": "当前目录为空",
    "status.pluginFileNoSession": "请先打开或选择一个终端会话。",
    "status.pluginFileUploadDone": "已上传 {name}",
    "status.pluginLoadFailed": "工具加载失败：{message}",
    "status.pluginSettingsSaved": "{name} 设置已保存",
    "status.pluginSettingsSaveFailed": "设置保存失败：{message}",
    "status.terminalInputFileUploadUnavailable": "当前终端不可上传文件。",
    "status.terminalInputImageUploadUnavailable": "当前终端不可上传图片。",
    "status.terminalInputNoImageFile": "请选择图片文件上传。",
    "status.terminalInputTemporaryPathsInserted": "临时文件路径已输入",
    "status.whiteNoiseAudioError": "无法加载声音：{name}",
    "status.whiteNoiseInstallDone": "已安装 {count} 个声音",
    "status.whiteNoiseInstallFailed": "声音资源包安装失败：{message}",
    "status.whiteNoiseInstalling": "正在下载声音资源包...",
    "status.whiteNoiseLoaded": "已加载 {count} 个声音",
    "status.whiteNoiseLoadFailed": "声音列表加载失败：{message}",
    "status.whiteNoiseNoSounds": "请先添加音频文件再播放。",
    "status.whiteNoiseNoSelection": "请至少选择一个声音再播放。",
    "status.whiteNoisePlayFailed": "播放失败：{message}",
    "status.whiteNoisePreviewFailed": "试听失败：{name}",
    "status.whiteNoisePlaying": "白噪音播放中",
    "status.whiteNoiseStopped": "白噪音已停止",
    "status.portForwardReady": "{count} 个端口转发正在运行",
    "status.publicTunnelReady": "{count} 个 Tunnel 正在运行",
    "status.quickPhraseRemoved": "快速短语已删除",
    "status.quickPhraseSaved": "快速短语已保存",
    "status.tunnelProfileRemoved": "Tunnel 配置已移除",
    "status.tunnelProfileSaved": "Tunnel 配置已保存",
    "status.pluginsLoading": "正在加载工具...",
    "status.pluginsReady": "{count} 个工具已就绪",
    "status.processExited": "进程已退出：{code}",
    "status.reconnecting": "连接已断开，{seconds}s 后重连...",
    "status.selectRunningInstance": "请先选择运行中的实例。",
    "status.selectionCopied": "选区已复制",
    "status.shellReady": "Shell 已就绪",
    "status.socketError": "Socket 错误",
    "status.startupFailed": "启动失败：{message}",
    "status.sessionStopped": "会话已停止",
    "status.sshUrlOpenFailed": "SSH URL 打开失败：{message}",
    "status.sshUrlProfileReady": "SSH profile 已就绪：{name}",
    "status.terminalError": "终端错误",
    "status.themeInvalid": "主题无效：{message}",
    "status.themeRemoved": "{name} 已删除",
    "status.themeSaved": "{name} 已保存",
    "status.urlCopied": "URL 已复制",
    "status.terminalTransferCancelled": "终端传输已取消",
    "status.terminalTransferComplete": "{name} 已完成",
    "status.terminalTransferDetecting": "检测到传输",
    "status.terminalTransferFailed": "终端传输失败：{message}",
    "status.terminalTransferNoProtocol": "未启用任何传输协议。",
    "status.terminalTransferReady": "当前终端可使用 rz/sz 和 trz/tsz。",
    "status.terminalTransferReadyLrzsz": "当前终端可使用 rz/sz。",
    "status.terminalTransferReadyTrzsz": "当前终端可使用 trz/tsz。",
    "status.terminalTransferStarted": "{protocol} 传输已开始",
    "status.terminalTransferUnsupportedBackend": "终端传输仅支持 WebShell 原生终端标签。",
    "status.trzszDownloadDetected": "检测到 trzsz 远端下载请求。",
    "status.trzszProgressInTerminal": "trzsz 进度显示在终端内。",
    "status.trzszTransferring": "trzsz 正在传输。",
    "status.trzszUploadDetected": "检测到 trzsz 远端上传请求。",
    "status.zmodemCancelled": "已取消",
    "status.zmodemChooseSaveLocation": "选择 {name} 的保存位置。",
    "status.zmodemChooseSaveLocationShort": "选择保存位置",
    "status.zmodemChooseUploadFile": "选择本地文件",
    "status.zmodemComplete": "已完成",
    "status.zmodemDetecting": "检测到 ZMODEM",
    "status.zmodemDownloadDetected": "检测到远端下载请求。",
    "status.zmodemFailed": "失败",
    "status.zmodemReady": "当前终端可使用 rz/sz。",
    "status.zmodemReceiving": "正在接收远端文件。",
    "status.zmodemReceivingFallback": "正在接收远端文件；完成后浏览器会下载它。",
    "status.zmodemTransferCancelled": "ZMODEM 传输已取消",
    "status.zmodemTransferComplete": "{name} 已完成",
    "status.zmodemTransferFailed": "ZMODEM 传输失败：{message}",
    "status.zmodemTransferStarted": "ZMODEM 传输已开始：{name}",
    "status.zmodemTransferring": "传输中",
    "status.zmodemUnsupportedBackend": "ZMODEM 仅支持 WebShell 终端标签。",
    "status.zmodemUploadDetected": "检测到远端上传请求。",
    "status.zmodemUploadingTo": "正在上传到 {path}。",
    "status.zmodemUploadingToCurrentDirectory": "正在上传到当前终端目录。",
    "theme.builtIn": "内置",
    "theme.custom": "自定义",
    "theme.gallery": "Ghostty 主题库",
    "theme.noCustom": "暂无自定义主题",
    "theme.recommended": "推荐",
    "touch.drag": "拖动选区",
    "touch.longPress": "滑动优先，长按选区",
    "touch.off": "关闭触控选区",
    "terminalTransfer.protocolLrzsz": "lrzsz（rz/sz）",
    "terminalTransfer.protocolLrzszHelp": "处理经典 rz 上传和 sz 下载，底层使用 ZMODEM。",
    "terminalTransfer.protocolTrzsz": "trzsz（trz/tsz）",
    "terminalTransfer.protocolTrzszHelp": "通过 trzsz.js 处理 trz 上传和 tsz 下载。",
    "terminalTransfer.protocolsHelp": "选择这个内置工具需要拦截的终端传输协议，至少保留一种协议启用。",
    "terminalTransfer.protocolsTitle": "支持的协议",
    "validation.fontExtension": "只允许 .woff、.woff2、.ttf 和 .otf",
    "validation.fontMime": "不支持的字体 MIME 类型：{mimeType}",
    "validation.fontSize": "字体大小必须在 1 字节到 10 MB 之间",
    "validation.backgroundExtension": "只允许 .png、.jpg、.jpeg 和 .webp",
    "validation.backgroundMime": "不支持的背景图片 MIME 类型：{mimeType}",
    "validation.backgroundSize": "背景图片大小必须在 1 字节到 10 MB 之间",
    "validation.aiAccess": "请输入 Base URL 和 API Key",
    "validation.aiPrompt": "请输入内容",
    "validation.ngrokAuthtoken": "请输入认证 token",
    "validation.mcpUrl": "请输入 MCP 服务 URL",
    "validation.pluginPath": "请输入目标路径",
    "validation.port": "请输入 1 到 65535 之间的端口",
    "validation.quickPhraseLimit": "最多保留 {count} 条短语",
    "validation.quickPhraseText": "请输入短语内容",
    "validation.themeName": "请输入主题名称",
    "validation.themeSource": "请粘贴包含 background、foreground 或 palette 的 Ghostty 主题",
    "validation.tunnelProfile": "请选择已配置的 Tunnel 配置",
    "validation.tunnelProfileName": "请输入配置名称",
    "validation.upstreamUrl": "请输入本地上游 URL",
    "validation.whiteNoisePackageUrl": "请输入声音资源包地址",
    "zmodem.directionDownload": "下载",
    "zmodem.directionUpload": "上传",
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

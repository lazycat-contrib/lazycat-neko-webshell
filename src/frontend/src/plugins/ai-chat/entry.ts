import type { PluginDescriptor } from "../../gen/lazycat/webshell/v1/capability_pb";
import type { PluginSettingsViewState } from "../../plugin-views";
import { pluginDescription } from "../../plugin-utils";
import { settingsDisabled, type CommonResources, type PluginEntry } from "../host";
import type { createAIChatController } from "./controller";
import type { createAiVoiceReplyController } from "./voice-reply";
import { renderAIChatToolView } from "./tool-view";
import { renderAIAccessSettingsView } from "./settings-view";
import { scrollAIChatToBottom } from "./dom";

type ToolState = Parameters<typeof renderAIChatToolView>[0];
export type EntryResources = CommonResources & {
  controller: ReturnType<typeof createAIChatController>;
  providerState: () => Pick<ToolState, "providerProfiles" | "activeProviderProfileId" | "providerPickerOpen" | "voiceReplyEnabled">;
  terminalContext: () => string;
  voiceReply: Pick<ReturnType<typeof createAiVoiceReplyController>, "stateFor">;
};
export function createEntry(resources: EntryResources): PluginEntry {
  return {
    id: "ai-chat",
    render: (plugin) => {
      const controller = resources.controller;
      controller.syncSessionForActiveTarget();
      const session = controller.ensureSession();
      const target = controller.activeTerminalTarget();
      return renderAIChatToolView({
        disabled: resources.disabled(plugin), title: resources.tr("plugin.aiChat.name"), description: pluginDescription(plugin, resources.tr),
        session, messages: session.messages, streaming: controller.isStreaming(), modelOptions: controller.modelValues(), selectedModel: controller.currentModel(),
        ...resources.providerState(), targetTerminalLabel: target?.label ?? resources.tr("status.noTarget"),
        sendTerminalContext: session.sendTerminalContext, terminalContextPreview: session.sendTerminalContext ? resources.terminalContext() : "",
        herdrAgentPromptAvailable: controller.canPromptHerdrAgent(),
        voiceReplyStateForMessage: (messageIndex, content) => resources.voiceReply.stateFor(session.id, messageIndex, content), tr: resources.tr,
      });
    },
    rendered: scrollAIChatToBottom,
  };
}
export function renderSettings(plugin: PluginDescriptor, state: PluginSettingsViewState): string {
  return renderAIAccessSettingsView({ ...state.aiAccess, disabled: !plugin.enabled || settingsDisabled(plugin, state), tr: state.tr });
}
export function isSettingsOpen(state: PluginSettingsViewState): boolean { return Boolean(state.aiAccess.dialog); }

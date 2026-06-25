import type { TerminalActionWSClient } from "../../action-ws-client";
import type { MessageKey } from "../../i18n";
import { metaString, metaStringArray } from "../../json-meta";
import { downloadPluginPayload } from "../../plugin-utils";
import type { AIChatMessage, AIChatSession, AIChatTerminalTarget, Tone } from "../../types";
import { errorMessage } from "../../utils";
import { replaceAIChatHistory, resizeAIChatInput } from "./dom";
import { AIChatStore } from "./store";
import {
  aiChatTranscript,
  renderAIChatMessages as renderAIChatMessagesView,
} from "./tool-view";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type AIChatControllerDeps = {
  isEnabled: () => boolean;
  accessConfigured: () => boolean;
  configuredModel: () => string;
  activeProfileId: () => string;
  setConfiguredModel: (model: string) => void;
  saveSettings: () => void;
  flushSettings: () => Promise<void>;
  terminalContext: (includeTerminalContext: boolean) => Promise<Record<string, unknown>>;
  recentTerminalContext: () => string;
  activeTerminalTarget: () => AIChatTerminalTarget | undefined;
  inputElement: () => HTMLTextAreaElement | null;
  actionClient: Pick<TerminalActionWSClient, "send">;
  tr: Translate;
  createId: () => string;
  onStatus: (message: string, tone?: Tone) => void;
  onRender: () => void;
};

export function createAIChatController(deps: AIChatControllerDeps) {
  const store = new AIChatStore();

  function currentModel(): string {
    return store.currentModel(deps.configuredModel());
  }

  function currentModelKey(): string {
    const profileId = deps.activeProfileId() || "default";
    const model = currentModel() || "default";
    return `${profileId}:${model}`;
  }

  function activeTarget(): AIChatTerminalTarget | undefined {
    return deps.activeTerminalTarget();
  }

  function ensureSession(model = currentModelKey()): AIChatSession {
    if (store.streaming) {
      const active = store.activeSession();
      if (active) return active;
    }
    return store.ensureSession(model, deps.tr("plugin.aiChat.block"), deps.createId, activeTarget());
  }

  function appendSystem(content: string, tone: Tone = "neutral") {
    store.appendSystem(content, tone, currentModelKey(), deps.tr("plugin.aiChat.block"), deps.createId, activeTarget());
    deps.onRender();
  }

  function selectSessionForCurrentModel() {
    store.activeSessionId = ensureSession(currentModelKey()).id;
  }

  function syncSessionForActiveTarget(): boolean {
    if (store.streaming) return false;
    const before = store.activeSessionId;
    store.activeSessionId = ensureSession(currentModelKey()).id;
    return store.activeSessionId !== before;
  }

  function renderMessages(): string {
    const session = ensureSession(currentModelKey());
    return renderAIChatMessagesView({
      messages: session.messages,
      streaming: store.streaming,
      sendTerminalContext: session.sendTerminalContext,
      terminalContextPreview: session.sendTerminalContext ? deps.recentTerminalContext() : "",
      tr: deps.tr,
    });
  }

  async function copyText(output: string) {
    if (!output) {
      appendSystem(deps.tr("status.aiNoOutput"), "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(output);
      deps.onStatus(deps.tr("status.selectionCopied"), "ok");
    } catch (error) {
      deps.onStatus(deps.tr("status.copyFailed", { message: errorMessage(error) }), "error");
    }
  }

  async function applyModelList(models: string[]) {
    store.modelOptions = models;
    if (!deps.configuredModel() && models[0]) {
      deps.setConfiguredModel(models[0]);
      selectSessionForCurrentModel();
      deps.saveSettings();
    }
    store.removeModelListMessages(models);
    deps.onRender();
  }

  return {
    isStreaming: () => store.streaming,
    modelOptions: () => store.modelOptions,
    activeSessionId: () => store.activeSessionId,
    setActiveSessionId(sessionId: string) {
      store.activeSessionId = sessionId;
    },
    clearModelOptions() {
      store.modelOptions = [];
    },
    selectSessionForCurrentModel,
    syncSessionForActiveTarget,
    currentModel,
    currentModelKey,
    activeTerminalTarget: activeTarget,
    activeSession: () => store.activeSession(),
    ensureSession,
    modelValues: () => store.modelValues(deps.configuredModel(), deps.tr("action.aiFetchModels")),
    sessionsForModel: (model: string) => store.sessionsForModel(model, activeTarget()),
    renderMessages,
    appendSystem,
    async fetchModels() {
      if (!deps.isEnabled()) return;
      if (!deps.accessConfigured()) {
        appendSystem(deps.tr("validation.aiAccess"), "error");
        return;
      }
      try {
        await deps.flushSettings();
        const done = await deps.actionClient.send("ai", "models", {});
        const models = metaStringArray(done.meta, "models");
        await applyModelList(models);
        deps.onStatus(deps.tr("status.aiModelsReady", { count: models.length }), "ok");
      } catch (error) {
        appendSystem(errorMessage(error), "error");
        deps.onStatus(errorMessage(error), "error");
      }
    },
    async testAccess() {
      if (!deps.isEnabled()) return;
      if (!deps.accessConfigured()) {
        appendSystem(deps.tr("validation.aiAccess"), "error");
        return;
      }
      try {
        await deps.flushSettings();
        const done = await deps.actionClient.send("ai", "test", {});
        const models = metaStringArray(done.meta, "models");
        if (models.length) {
          await applyModelList(models);
        }
        const message = metaString(done.meta, "message") || deps.tr("status.aiTestOk");
        const content = metaString(done.meta, "content");
        appendSystem([message, content].filter(Boolean).join("\n"), "ok");
        deps.onStatus(deps.tr("status.aiTestOk"), "ok");
      } catch (error) {
        appendSystem(errorMessage(error), "error");
        deps.onStatus(errorMessage(error), "error");
      }
    },
    async run() {
      if (!deps.isEnabled() || store.streaming) return;
      if (!deps.accessConfigured()) {
        appendSystem(deps.tr("validation.aiAccess"), "error");
        return;
      }
      const input = deps.inputElement();
      const prompt = input?.value.trim() ?? "";
      if (!prompt) {
        appendSystem(deps.tr("validation.aiPrompt"), "error");
        return;
      }
      if (!currentModel()) {
        appendSystem(deps.tr("action.aiFetchModels"), "error");
        return;
      }
      await deps.flushSettings();
      const session = ensureSession(currentModelKey());
      const contextSnapshot = await deps.terminalContext(session.sendTerminalContext);
      input!.value = "";
      resizeAIChatInput(input!);
      session.messages.push({ role: "user", content: prompt });
      const assistant: AIChatMessage = { role: "assistant", content: "" };
      session.messages.push(assistant);
      store.streaming = true;
      deps.onRender();
      try {
        await deps.actionClient.send("ai", "chat", {
          input: prompt,
          ctx: contextSnapshot,
          conversation: session.messages.slice(0, -1).slice(-12),
        }, {
          onStream: (chunk) => {
            assistant.content += chunk;
            replaceAIChatHistory(renderMessages());
          },
        });
        if (!assistant.content.trim()) {
          assistant.content = deps.tr("status.aiNoOutput");
          assistant.tone = "neutral";
        }
        deps.onStatus(deps.tr("status.aiTestOk"), "ok");
      } catch (error) {
        assistant.content = errorMessage(error);
        assistant.tone = "error";
        deps.onStatus(errorMessage(error), "error");
      } finally {
        store.streaming = false;
        deps.onRender();
      }
    },
    copyOutput() {
      const session = store.activeSession();
      void copyText(session ? aiChatTranscript(session) : "");
    },
    copyMessage(index: number) {
      const session = store.activeSession();
      const message = Number.isInteger(index) ? session?.messages[index] : undefined;
      void copyText(message?.content.trim() ?? "");
    },
    copyCodeBlock(button: HTMLElement) {
      const code = button.closest(".ai-code-block")?.querySelector<HTMLElement>("code");
      void copyText(code?.textContent ?? "");
    },
    clearOutput() {
      const session = store.activeSession();
      if (!session) return;
      session.messages = [];
      deps.onRender();
    },
    newSession() {
      store.newSession(currentModelKey(), deps.tr("plugin.aiChat.block"), deps.createId, activeTarget());
      deps.onRender();
    },
    toggleTerminalContext() {
      if (store.streaming) return;
      const session = ensureSession(currentModelKey());
      session.sendTerminalContext = !session.sendTerminalContext;
      deps.onRender();
    },
    export() {
      const session = store.activeSession();
      if (!session || !session.messages.length) {
        appendSystem(deps.tr("status.aiNoOutput"), "error");
        return;
      }
      const bytes = new TextEncoder().encode(aiChatTranscript(session));
      downloadPluginPayload(
        bytes,
        `${session.title.replace(/[^\w.-]+/g, "-").toLowerCase() || "ai-chat"}.md`,
        "text/markdown;charset=utf-8",
      );
    },
  };
}

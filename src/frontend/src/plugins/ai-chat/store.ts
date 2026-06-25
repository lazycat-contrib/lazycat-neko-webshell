import type { AIChatSession, AIChatTerminalTarget, Tone } from "../../types";

type CreateId = () => string;

export class AIChatStore {
  modelOptions: string[] = [];
  sessions: AIChatSession[] = [];
  activeSessionId = "";
  streaming = false;

  currentModel(configuredModel: string): string {
    return configuredModel.trim() || this.modelOptions[0] || "";
  }

  activeSession(): AIChatSession | undefined {
    return this.sessions.find((session) => session.id === this.activeSessionId);
  }

  ensureSession(
    model: string,
    titlePrefix: string,
    createId: CreateId,
    target?: AIChatTerminalTarget,
  ): AIChatSession {
    const normalizedModel = model.trim() || "default";
    const active = this.activeSession();
    if (active?.model === normalizedModel && sessionMatchesTarget(active, target)) return active;
    const existing = this.sessions.find((session) => session.model === normalizedModel && sessionMatchesTarget(session, target));
    if (existing) {
      this.activeSessionId = existing.id;
      return existing;
    }
    const session = this.createSession(normalizedModel, titlePrefix, createId, target);
    this.sessions = [...this.sessions, session];
    this.activeSessionId = session.id;
    return session;
  }

  newSession(
    model: string,
    titlePrefix: string,
    createId: CreateId,
    target?: AIChatTerminalTarget,
  ): AIChatSession {
    const session = this.createSession(model.trim() || "default", titlePrefix, createId, target);
    this.sessions = [...this.sessions, session];
    this.activeSessionId = session.id;
    return session;
  }

  appendSystem(
    content: string,
    tone: Tone,
    model: string,
    titlePrefix: string,
    createId: CreateId,
    target?: AIChatTerminalTarget,
  ): AIChatSession {
    const session = this.ensureSession(model, titlePrefix, createId, target);
    session.messages.push({ role: "system", content, tone });
    return session;
  }

  modelValues(configuredModel: string, emptyLabel: string): Array<{ value: string; label: string }> {
    const values = Array.from(new Set([configuredModel, ...this.modelOptions].map((value) => value.trim()).filter(Boolean)));
    if (!values.length) {
      return [{ value: "", label: emptyLabel }];
    }
    return values.map((model) => ({ value: model, label: model }));
  }

  sessionsForModel(model: string, target?: AIChatTerminalTarget): AIChatSession[] {
    return this.sessions.filter((item) => item.model === model && sessionMatchesTarget(item, target));
  }

  removeModelListMessages(models: string[]) {
    if (models.length < 3) return;
    const modelSet = new Set(models);
    for (const session of this.sessions) {
      session.messages = session.messages.filter((message) => {
        if (message.role !== "system" || message.tone !== "ok") return true;
        const lines = message.content.split("\n").map((line) => line.trim()).filter(Boolean);
        return lines.length < 3 || !lines.every((line) => modelSet.has(line));
      });
    }
  }

  private createSession(
    model: string,
    titlePrefix: string,
    createId: CreateId,
    target?: AIChatTerminalTarget,
  ): AIChatSession {
    const count = this.sessions.filter((session) => session.model === model && sessionMatchesTarget(session, target)).length + 1;
    return {
      id: createId(),
      model,
      title: `${titlePrefix} ${count}`,
      terminalTargetKey: target?.key,
      terminalTargetLabel: target?.label,
      sendTerminalContext: false,
      messages: [],
    };
  }
}

function sessionMatchesTarget(session: AIChatSession, target?: AIChatTerminalTarget): boolean {
  if (!target) return !session.terminalTargetKey;
  return session.terminalTargetKey === target.key;
}

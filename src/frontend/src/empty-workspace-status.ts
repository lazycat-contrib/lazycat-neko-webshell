import type { Tone } from "./types";

export type WorkspaceStatus = {
  message: string;
  tone: Tone;
};

export function statusForEmptyWorkspace(current: WorkspaceStatus, idleMessage: string): WorkspaceStatus {
  if (current.tone === "error" && current.message.trim()) {
    return current;
  }
  return {
    message: idleMessage,
    tone: "neutral",
  };
}

import { newId } from "../utils";

const ACTOR_ID_STORAGE_KEY = "lazycat-webshell.terminalControlActorId";

export type TerminalControlActor = {
  actorId: string;
  actorKind: "desktop" | "mobile";
};

export function currentTerminalControlActor(): TerminalControlActor {
  return {
    actorId: stableActorId(),
    actorKind: coarsePointer() ? "mobile" : "desktop",
  };
}

function stableActorId(): string {
  try {
    const existing = sessionStorage.getItem(ACTOR_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = newId();
    sessionStorage.setItem(ACTOR_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return newId();
  }
}

function coarsePointer(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

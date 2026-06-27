import { newId } from "../utils";

const ACTOR_ID_STORAGE_KEY = "lazycat-webshell.terminalControlActorId";
let cachedActorId: string | undefined;

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
  if (cachedActorId) return cachedActorId;
  try {
    const existing = sessionStorage.getItem(ACTOR_ID_STORAGE_KEY);
    if (existing) {
      cachedActorId = existing;
      return existing;
    }
    const created = newId();
    sessionStorage.setItem(ACTOR_ID_STORAGE_KEY, created);
    cachedActorId = created;
    return created;
  } catch {
    cachedActorId = newId();
    return cachedActorId;
  }
}

function coarsePointer(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

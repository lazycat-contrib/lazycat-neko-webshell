type RemoteReplayPane = {
  selector: string;
  term?: { reset(): void };
  decoder?: TextDecoder;
  lastOutputSequence: number;
};

export type RemoteReplayInputPolicy = "normal" | "suppress" | "immediate";

const generatedTerminalResponsePattern =
  /^(?:\x1b)?(?:\[\d{1,4};\d{1,4}R|\[\d{1,4}R|\[0n|\[\?[\d;]{1,16}c|\[>[\d;]{1,16}c)/;
const generatedTerminalResponseTailPattern =
  /^(?:\[\d{1,4};\d{1,4}R|\[\d{1,4}R|\d{1,4};\d{1,4}R|;\d{1,4}R|\d{1,4}R|\dR)+$/;

export type RemoteClientNewTabCapabilities = {
  lightosDirectAvailable: boolean;
  sshAvailable: boolean;
};

export function isRemoteClientSelector(value: unknown): boolean {
  const selector = String(value ?? "").trim();
  const id = selector.startsWith("client:") ? selector.slice("client:".length) : "";
  return Boolean(
    id
      && id.length <= 256
      && [...id].every((character) => /[A-Za-z0-9._-]/.test(character)),
  );
}

export function remoteClientNewTabCapabilities(
  selector: string,
  lightosDirectAvailable: boolean,
): RemoteClientNewTabCapabilities {
  const remoteClient = isRemoteClientSelector(selector);
  return {
    lightosDirectAvailable: lightosDirectAvailable && !remoteClient,
    sshAvailable: !remoteClient,
  };
}

export function remoteClientReplayInputPolicy(
  selector: string,
  replaying: boolean,
  allowGeneratedInput: boolean,
  data: string,
): RemoteReplayInputPolicy {
  if (!replaying || !isRemoteClientSelector(selector) || !isGeneratedTerminalResponse(data)) {
    return "normal";
  }
  return allowGeneratedInput ? "immediate" : "suppress";
}

function isGeneratedTerminalResponse(data: string): boolean {
  if (!data) return false;
  if (generatedTerminalResponseTailPattern.test(data)) return true;
  let remaining = data;
  while (remaining) {
    const match = generatedTerminalResponsePattern.exec(remaining);
    if (!match) return false;
    remaining = remaining.slice(match[0].length);
  }
  return true;
}

export function resetRemoteClientTerminalForReplay(pane: RemoteReplayPane): boolean {
  if (!isRemoteClientSelector(pane.selector)) return false;
  pane.term?.reset();
  pane.decoder = new TextDecoder();
  pane.lastOutputSequence = 0;
  return true;
}

export function filterRemoteClientPluginTools<T extends { id: string }>(
  selector: string,
  tools: T[],
  unsupportedPluginIds: ReadonlySet<string>,
): T[] {
  if (!isRemoteClientSelector(selector)) return tools;
  return tools.filter((tool) => !unsupportedPluginIds.has(tool.id));
}

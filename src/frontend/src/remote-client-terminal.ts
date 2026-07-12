type RemoteReplayPane = {
  selector: string;
  term?: { reset(): void };
  decoder?: TextDecoder;
  lastOutputSequence: number;
};

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

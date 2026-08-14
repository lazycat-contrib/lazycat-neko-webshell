type PaneInputBuffer = {
  pendingInput: string[];
  pendingInputBytes: number;
};

type PaneReplayCursor = {
  lastOutputSequence: number;
  sessionBackend: string;
};

type ByteLength = (data: string) => number;

export type PaneInputDelivery = "send" | "queue";

export function paneInputDelivery(socketOpen: boolean, _replaying: boolean): PaneInputDelivery {
  return socketOpen ? "send" : "queue";
}

export function queuePanePendingInput(
  pane: PaneInputBuffer,
  data: string,
  maxBytes: number,
  byteLength: ByteLength,
): boolean {
  const bytes = byteLength(data);
  if (bytes <= 0 || bytes > maxBytes) return false;
  while (pane.pendingInputBytes + bytes > maxBytes) {
    const dropped = pane.pendingInput.shift();
    if (!dropped) break;
    pane.pendingInputBytes = Math.max(0, pane.pendingInputBytes - byteLength(dropped));
  }
  pane.pendingInput.push(data);
  pane.pendingInputBytes += bytes;
  return true;
}

export function flushPanePendingInput(
  pane: PaneInputBuffer,
  send: (data: string) => boolean,
  byteLength: ByteLength,
): boolean {
  while (pane.pendingInput.length) {
    const data = pane.pendingInput.shift() ?? "";
    pane.pendingInputBytes = Math.max(0, pane.pendingInputBytes - byteLength(data));
    try {
      if (send(data)) continue;
    } catch {
      // Restore the unsent input below.
    }
    pane.pendingInput.unshift(data);
    pane.pendingInputBytes += byteLength(data);
    return false;
  }
  return true;
}

export function clearPanePendingInput(pane: PaneInputBuffer) {
  pane.pendingInput = [];
  pane.pendingInputBytes = 0;
}

export function paneReplayAfter(pane: PaneReplayCursor, herdrTailFrames: number): number {
  const sequence = Number.isFinite(pane.lastOutputSequence)
    ? Math.max(0, Math.trunc(pane.lastOutputSequence))
    : 0;
  if (pane.sessionBackend !== "herdr" || sequence <= 0) return sequence;
  return Math.max(0, sequence - herdrTailFrames);
}

export function resetPaneReplayCursorForNewRenderer(pane: PaneReplayCursor) {
  if (pane.sessionBackend === "herdr") pane.lastOutputSequence = 0;
}

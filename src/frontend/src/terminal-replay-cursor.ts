type ReplayOwner = object;

type SequenceMarker = {
  sequence: number;
  byteOffset: number;
};

const markers = new WeakMap<ReplayOwner, SequenceMarker[]>();

export function beginTerminalReplayCursor(owner: ReplayOwner): void {
  markers.set(owner, []);
}

export function markTerminalReplaySequence(
  owner: ReplayOwner,
  sequence: number,
  byteOffset: number,
): void {
  const pending = markers.get(owner);
  if (!pending || !Number.isFinite(sequence)) return;
  pending.push({
    sequence: Math.max(0, Math.trunc(sequence)),
    byteOffset: Math.max(0, Math.trunc(byteOffset)),
  });
}

export function takeRenderedReplaySequences(
  owner: ReplayOwner,
  renderedBytes: number,
): number[] {
  const pending = markers.get(owner);
  if (!pending?.length) return [];
  const rendered = Math.max(0, Math.trunc(renderedBytes));
  let count = 0;
  while (count < pending.length && pending[count].byteOffset <= rendered) count += 1;
  return pending.splice(0, count).map((marker) => marker.sequence);
}

export function discardTerminalReplayCursor(owner: ReplayOwner): void {
  markers.delete(owner);
}

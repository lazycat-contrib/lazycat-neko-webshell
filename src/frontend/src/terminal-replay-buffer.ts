type ReplayOwner = object;

const replayChunks = new WeakMap<ReplayOwner, Uint8Array[]>();

export function beginTerminalReplayBuffer(owner: ReplayOwner) {
  replayChunks.set(owner, []);
}

export function bufferTerminalReplayBytes(owner: ReplayOwner, bytes: Uint8Array): boolean {
  const chunks = replayChunks.get(owner);
  if (!chunks) return false;
  if (bytes.byteLength > 0) chunks.push(bytes);
  return true;
}

export function drainTerminalReplayBuffer(owner: ReplayOwner): Uint8Array | undefined {
  const chunks = replayChunks.get(owner);
  replayChunks.delete(owner);
  if (!chunks?.length) return undefined;
  if (chunks.length === 1) return chunks[0];

  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const replay = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    replay.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return replay;
}

export function discardTerminalReplayBuffer(owner: ReplayOwner) {
  replayChunks.delete(owner);
}

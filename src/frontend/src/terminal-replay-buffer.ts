type ReplayOwner = object;

type ReplayBuffer = {
  chunks: Uint8Array[];
  headIndex: number;
  headOffset: number;
  bufferedBytes: number;
  totalBytes: number;
  chunkCount: number;
};

const replayBuffers = new WeakMap<ReplayOwner, ReplayBuffer>();

export function beginTerminalReplayBuffer(owner: ReplayOwner) {
  replayBuffers.set(owner, {
    chunks: [],
    headIndex: 0,
    headOffset: 0,
    bufferedBytes: 0,
    totalBytes: 0,
    chunkCount: 0,
  });
}

export function bufferTerminalReplayBytes(owner: ReplayOwner, bytes: Uint8Array): boolean {
  const buffer = replayBuffers.get(owner);
  if (!buffer) return false;
  if (bytes.byteLength > 0) {
    buffer.chunks.push(bytes);
    buffer.bufferedBytes += bytes.byteLength;
    buffer.totalBytes += bytes.byteLength;
    buffer.chunkCount += 1;
  }
  return true;
}

export function takeTerminalReplayBatch(
  owner: ReplayOwner,
  byteBudget: number,
): Uint8Array | undefined {
  const buffer = replayBuffers.get(owner);
  if (!buffer || buffer.bufferedBytes === 0) return undefined;
  const budget = Math.max(1, Math.trunc(byteBudget));
  const slices: Uint8Array[] = [];
  let batchBytes = 0;
  while (buffer.headIndex < buffer.chunks.length && batchBytes < budget) {
    const head = buffer.chunks[buffer.headIndex];
    const available = head.byteLength - buffer.headOffset;
    const consumed = Math.min(available, budget - batchBytes);
    slices.push(head.subarray(buffer.headOffset, buffer.headOffset + consumed));
    batchBytes += consumed;
    buffer.bufferedBytes -= consumed;
    buffer.headOffset += consumed;
    if (buffer.headOffset === head.byteLength) {
      buffer.headIndex += 1;
      buffer.headOffset = 0;
    }
  }
  if (buffer.headIndex > 1024 && buffer.headIndex * 2 >= buffer.chunks.length) {
    buffer.chunks = buffer.chunks.slice(buffer.headIndex);
    buffer.headIndex = 0;
  }
  if (slices.length === 1) return slices[0];
  const batch = new Uint8Array(batchBytes);
  let offset = 0;
  for (const slice of slices) {
    batch.set(slice, offset);
    offset += slice.byteLength;
  }
  return batch;
}

export function terminalReplayBufferStats(owner: ReplayOwner) {
  const buffer = replayBuffers.get(owner);
  return buffer
    ? {
        bufferedBytes: buffer.bufferedBytes,
        totalBytes: buffer.totalBytes,
        chunkCount: buffer.chunkCount,
      }
    : undefined;
}

export function discardTerminalReplayBuffer(owner: ReplayOwner) {
  replayBuffers.delete(owner);
}

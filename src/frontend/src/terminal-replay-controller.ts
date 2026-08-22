import type { TerminalPane } from "./types.ts";
import {
  beginTerminalReplayBuffer,
  bufferTerminalReplayBytes,
  discardTerminalReplayBuffer,
  takeTerminalReplayBatch,
  terminalReplayBufferStats,
} from "./terminal-replay-buffer.ts";
import {
  beginTerminalReplayCursor,
  discardTerminalReplayCursor,
  markTerminalReplaySequence,
  takeRenderedReplaySequences,
} from "./terminal-replay-cursor.ts";
import { recordTerminalPerformance, terminalPerformanceSnapshot } from "./terminal-performance.ts";

type ReplayState = {
  socket?: WebSocket;
  timeoutMs: number;
  validated: boolean;
  completing: boolean;
  timer?: number;
  absoluteTimer?: number;
  flushFrame?: number;
  finishPromise?: Promise<boolean>;
  liveChunks: Uint8Array[];
  liveSequences: unknown[];
  liveBytes: number;
};

export type TerminalReplayControllerOptions = {
  byteBudget: number;
  writeBytes: (pane: TerminalPane, bytes: Uint8Array) => void;
  updateSequence: (pane: TerminalPane, sequence: unknown) => void;
  updateReplayBoundary?: (pane: TerminalPane, sequence: unknown) => void;
  onUnlocked: (pane: TerminalPane) => void;
  onInterrupted?: (pane: TerminalPane) => void;
  onOverflow?: (pane: TerminalPane) => void;
  debugEnabled: () => boolean;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, timeoutMs: number) => number;
  clearTimer?: (handle: number | undefined) => void;
  nextFrame?: () => Promise<void>;
  now?: () => number;
  maxLiveBytes?: number;
  maxLiveSequences?: number;
};

export function createTerminalReplayController(options: TerminalReplayControllerOptions) {
  const requestFrame = options.requestFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame = options.cancelFrame ?? window.cancelAnimationFrame.bind(window);
  const setTimer = options.setTimer ?? window.setTimeout.bind(window);
  const clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
  const nextFrame = options.nextFrame ?? (() => new Promise<void>((resolve) => requestFrame(() => resolve())));
  const now = options.now ?? performance.now.bind(performance);
  const maxLiveBytes = options.maxLiveBytes ?? Math.max(options.byteBudget * 4, 512 * 1024);
  const maxLiveSequences = options.maxLiveSequences ?? 4096;
  const states = new WeakMap<TerminalPane, ReplayState>();

  function begin(pane: TerminalPane, socket?: WebSocket, timeoutMs = 30_000): void {
    replaceState(pane, socket, timeoutMs, false);
  }

  function validate(pane: TerminalPane, socket?: WebSocket, timeoutMs = 30_000): void {
    const state = replaceState(pane, socket, timeoutMs, true);
    queueFlush(pane, state);
  }

  function replaceState(
    pane: TerminalPane,
    socket: WebSocket | undefined,
    timeoutMs: number,
    validated: boolean,
  ): ReplayState {
    const previous = states.get(pane);
    if (previous) clearState(pane, previous, true);
    const state: ReplayState = {
      socket,
      timeoutMs: Math.max(1, timeoutMs),
      validated,
      completing: false,
      liveChunks: [],
      liveSequences: [],
      liveBytes: 0,
    };
    states.set(pane, state);
    pane.replaying = true;
    beginTerminalReplayBuffer(pane);
    beginTerminalReplayCursor(pane);
    armProgressTimeout(pane, state);
    state.absoluteTimer = setTimer(
      () => finishAfterTimeout(pane, state),
      Math.min(300_000, Math.max(60_000, state.timeoutMs * 2)),
    );
    return state;
  }

  function clear(pane: TerminalPane): void {
    const state = states.get(pane);
    if (state) clearState(pane, state, true);
    pane.replaying = false;
    pane.allowGeneratedInputDuringReplay = false;
  }

  function clearState(pane: TerminalPane, state: ReplayState, interrupted: boolean): void {
    if (states.get(pane) !== state) return;
    const stats = terminalReplayBufferStats(pane);
    cancelFlush(state);
    clearTimer(state.timer);
    clearTimer(state.absoluteTimer);
    states.delete(pane);
    pane.replaying = false;
    pane.allowGeneratedInputDuringReplay = false;
    discardTerminalReplayBuffer(pane);
    discardTerminalReplayCursor(pane);
    if (interrupted && (stats?.totalBytes ?? 0) > (stats?.bufferedBytes ?? 0)) {
      options.onInterrupted?.(pane);
    }
  }

  function push(pane: TerminalPane, bytes: Uint8Array): boolean {
    const state = states.get(pane);
    if (!state || !pane.replaying) return false;
    if (state.completing) {
      if (bytes.byteLength > 0) {
        if (state.liveBytes + bytes.byteLength > maxLiveBytes) {
          overflow(pane, state);
          return true;
        }
        state.liveChunks.push(bytes);
        state.liveBytes += bytes.byteLength;
      }
      return true;
    }
    if (!bufferTerminalReplayBytes(pane, bytes)) return false;
    if (state.validated) {
      armProgressTimeout(pane, state);
      queueFlush(pane, state);
    }
    return true;
  }

  function markSequence(pane: TerminalPane, sequence: unknown): boolean {
    const state = states.get(pane);
    const stats = terminalReplayBufferStats(pane);
    if (!state || !pane.replaying || !stats || typeof sequence !== "number") return false;
    if (state.completing) {
      if (state.liveSequences.length >= maxLiveSequences) {
        overflow(pane, state);
        return true;
      }
      state.liveSequences.push(sequence);
      return true;
    }
    markTerminalReplaySequence(pane, sequence, stats.totalBytes);
    applyRenderedSequences(pane, stats);
    return true;
  }

  function finish(pane: TerminalPane, replayBoundary?: unknown): Promise<boolean> {
    const state = states.get(pane);
    if (!state?.validated) return Promise.resolve(false);
    if (state.finishPromise) return state.finishPromise;
    state.completing = true;
    cancelFlush(state);
    clearTimer(state.timer);
    const pending = finishPrepared(pane, state, replayBoundary);
    const tracked = pending.finally(() => {
      if (states.get(pane) === state) state.finishPromise = undefined;
    });
    state.finishPromise = tracked;
    return tracked;
  }

  async function finishPrepared(
    pane: TerminalPane,
    state: ReplayState,
    replayBoundary: unknown,
  ): Promise<boolean> {
    while (states.get(pane) === state && pane.replaying) {
      if (!flushBatch(pane)) break;
      if ((terminalReplayBufferStats(pane)?.bufferedBytes ?? 0) > 0) await nextFrame();
    }
    if (states.get(pane) !== state || !pane.replaying) return false;
    if (replayBoundary !== undefined) {
      (options.updateReplayBoundary ?? options.updateSequence)(pane, replayBoundary);
    }
    // Output received after replay-complete is live data. Drain the bounded
    // handoff queue synchronously so an active process cannot hold input locked.
    for (const chunk of state.liveChunks) writeMeasured(pane, chunk);
    for (const sequence of state.liveSequences) options.updateSequence(pane, sequence);
    const stats = terminalReplayBufferStats(pane);
    clearState(pane, state, false);
    options.onUnlocked(pane);
    if (options.debugEnabled()) {
      console.debug("[terminal-replay]", {
        paneId: pane.id,
        bytes: stats?.totalBytes ?? 0,
        chunks: stats?.chunkCount ?? 0,
        performance: terminalPerformanceSnapshot(),
      });
    }
    return true;
  }

  function finishAfterTimeout(pane: TerminalPane, state: ReplayState): void {
    if (states.get(pane) !== state || pane.closing) return;
    if (!state.validated) {
      clearState(pane, state, false);
      options.onUnlocked(pane);
      return;
    }
    void finish(pane);
  }

  function overflow(pane: TerminalPane, state: ReplayState): void {
    if (states.get(pane) !== state) return;
    clearState(pane, state, true);
    options.onOverflow?.(pane);
  }

  function armProgressTimeout(pane: TerminalPane, state: ReplayState): void {
    if (state.completing) return;
    clearTimer(state.timer);
    state.timer = setTimer(() => finishAfterTimeout(pane, state), state.timeoutMs);
  }

  function queueFlush(pane: TerminalPane, state: ReplayState): void {
    if (state.flushFrame !== undefined || !state.validated || state.completing) return;
    state.flushFrame = requestFrame(() => {
      state.flushFrame = undefined;
      if (states.get(pane) !== state || !pane.replaying || state.completing) return;
      if (flushBatch(pane)) queueFlush(pane, state);
    });
  }

  function cancelFlush(state: ReplayState): void {
    if (state.flushFrame === undefined) return;
    cancelFrame(state.flushFrame);
    state.flushFrame = undefined;
  }

  function flushBatch(pane: TerminalPane): boolean {
    const batch = takeTerminalReplayBatch(pane, options.byteBudget);
    if (!batch) return false;
    writeMeasured(pane, batch);
    const stats = terminalReplayBufferStats(pane);
    if (stats) applyRenderedSequences(pane, stats);
    return (stats?.bufferedBytes ?? 0) > 0;
  }

  function writeMeasured(pane: TerminalPane, bytes: Uint8Array): void {
    const startedAt = now();
    options.writeBytes(pane, bytes);
    recordTerminalPerformance("replayWrite", now() - startedAt, bytes.byteLength);
  }

  function applyRenderedSequences(
    pane: TerminalPane,
    stats: { totalBytes: number; bufferedBytes: number },
  ): void {
    const renderedBytes = stats.totalBytes - stats.bufferedBytes;
    for (const sequence of takeRenderedReplaySequences(pane, renderedBytes)) {
      options.updateSequence(pane, sequence);
    }
  }

  return { begin, validate, clear, push, markSequence, finish };
}

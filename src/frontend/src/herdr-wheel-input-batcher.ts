import type { TerminalPane } from "./types";

const SGR_MOUSE_INPUT = /^\x1b\[<(\d+);(\d+);(\d+)M$/;
const SGR_MOUSE_MODIFIER_MASK = 4 | 8 | 16;
const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;
const SGR_WHEEL_LEFT = 66;
const SGR_WHEEL_RIGHT = 67;

type FrameRequest = (callback: FrameRequestCallback) => number;
type FrameCancel = (handle: number) => void;

type PaneBatchState = {
  frame: number;
  pending: string;
};

export type HerdrWheelInputBatcherOptions = {
  sendNow: (pane: TerminalPane, data: string) => boolean;
  requestFrame?: FrameRequest;
  cancelFrame?: FrameCancel;
};

export function createHerdrWheelInputBatcher(options: HerdrWheelInputBatcherOptions) {
  const requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
  const states = new Map<string, PaneBatchState>();

  function handle(pane: TerminalPane, data: string): boolean {
    if (pane.sessionBackend !== "herdr") return false;
    if (!isHerdrWheelInput(data)) {
      flush(pane);
      return false;
    }

    const state = states.get(pane.id);
    if (state) {
      state.pending += data;
      return true;
    }
    if (!options.sendNow(pane, data)) return false;

    const next: PaneBatchState = { frame: 0, pending: "" };
    const frame = requestFrame(() => {
      if (states.get(pane.id) !== next || next.frame !== frame) return;
      states.delete(pane.id);
      if (next.pending) options.sendNow(pane, next.pending);
    });
    next.frame = frame;
    states.set(pane.id, next);
    return true;
  }

  function flush(pane: TerminalPane): boolean {
    const state = states.get(pane.id);
    if (!state) return true;
    states.delete(pane.id);
    cancelFrame(state.frame);
    return !state.pending || options.sendNow(pane, state.pending);
  }

  function clear(pane: TerminalPane) {
    const state = states.get(pane.id);
    if (!state) return;
    states.delete(pane.id);
    state.pending = "";
    cancelFrame(state.frame);
  }

  return { handle, clear };
}

export function isHerdrWheelInput(data: string): boolean {
  const match = SGR_MOUSE_INPUT.exec(data);
  if (!match) return false;
  const button = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  if (
    !Number.isSafeInteger(button)
    || !Number.isSafeInteger(column)
    || !Number.isSafeInteger(row)
    || column < 1
    || row < 1
  ) {
    return false;
  }
  const baseButton = button & ~SGR_MOUSE_MODIFIER_MASK;
  return baseButton === SGR_WHEEL_UP
    || baseButton === SGR_WHEEL_DOWN
    || baseButton === SGR_WHEEL_LEFT
    || baseButton === SGR_WHEEL_RIGHT;
}

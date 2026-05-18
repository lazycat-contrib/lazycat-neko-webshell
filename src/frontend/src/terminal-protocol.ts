export const MAX_PENDING_INPUT_BYTES = 64 * 1024;

export type TerminalServerEvent =
  | { type: "ready" }
  | { type: "error"; message?: string; fatal?: boolean }
  | { type: "process-exit"; exit_code?: number; message?: string }
  | { type: "output-sequence"; sequence?: number }
  | { type: "replay-start"; session_id?: string; pane_id?: string; replay_after?: number }
  | { type: "replay-complete"; session_id?: string; pane_id?: string; last_sequence?: number };

export function parseTerminalServerMessage(text: string): TerminalServerEvent | undefined {
  try {
    const event = JSON.parse(text) as TerminalServerEvent;
    return typeof event.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

export function monotonicSequence(current: number, next: unknown): number {
  return typeof next === "number" && Number.isFinite(next)
    ? Math.max(current, Math.trunc(next))
    : current;
}

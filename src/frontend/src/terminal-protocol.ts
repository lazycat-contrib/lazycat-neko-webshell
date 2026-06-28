export const MAX_PENDING_INPUT_BYTES = 64 * 1024;

export type TerminalServerEvent =
  | { type: "ready"; session_id?: string; cols?: number; rows?: number }
  | { type: "error"; message?: string; fatal?: boolean }
  | { type: "process-exit"; exit_code?: number; message?: string }
  | { type: "session-stopped"; message?: string }
  | { type: "output-sequence"; sequence?: number }
  | {
    type: "control-state";
    session_id?: string;
    connection_id?: string;
    controller_id?: string;
    controller?: boolean;
    connection_count?: number;
    request_id?: string;
    control_action?: "take-control" | "release-control";
  }
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

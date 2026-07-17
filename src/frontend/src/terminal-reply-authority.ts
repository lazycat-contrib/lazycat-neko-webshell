export type TerminalReplyAuthority = "client" | "server";

export function normalizeTerminalReplyAuthority(value: unknown): TerminalReplyAuthority {
  return value === "server" ? "server" : "client";
}

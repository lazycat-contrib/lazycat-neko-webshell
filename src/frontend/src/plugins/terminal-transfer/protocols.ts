import type { TerminalTransferProtocolSupport } from "../../terminal-transfer/types";

export const TERMINAL_TRANSFER_PROTOCOLS_METADATA = "protocols";

export function defaultTerminalTransferProtocols(): TerminalTransferProtocolSupport {
  return {
    lrzsz: true,
    trzsz: true,
  };
}

export function terminalTransferProtocolsFromMetadata(
  metadata: Record<string, string> | undefined,
): TerminalTransferProtocolSupport {
  const raw = metadata?.[TERMINAL_TRANSFER_PROTOCOLS_METADATA]?.trim();
  if (!raw) return defaultTerminalTransferProtocols();
  const values = new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
  const protocols = {
    lrzsz: values.has("lrzsz") || values.has("zmodem"),
    trzsz: values.has("trzsz"),
  };
  return normalizeTerminalTransferProtocols(protocols);
}

export function normalizeTerminalTransferProtocols(
  protocols: Partial<TerminalTransferProtocolSupport>,
): TerminalTransferProtocolSupport {
  const normalized = {
    lrzsz: Boolean(protocols.lrzsz),
    trzsz: Boolean(protocols.trzsz),
  };
  if (!normalized.lrzsz && !normalized.trzsz) {
    normalized.lrzsz = true;
  }
  return normalized;
}

export function serializeTerminalTransferProtocols(protocols: TerminalTransferProtocolSupport): string {
  const normalized = normalizeTerminalTransferProtocols(protocols);
  return [
    normalized.lrzsz ? "lrzsz" : "",
    normalized.trzsz ? "trzsz" : "",
  ].filter(Boolean).join(",");
}

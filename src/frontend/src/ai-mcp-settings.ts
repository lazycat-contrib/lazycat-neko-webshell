import type { AiMcpServerSettings } from "./types";

export type AiMcpTransport = AiMcpServerSettings["transport"];

const DEFAULT_TRANSPORT: AiMcpTransport = "streamable-http";

export function parseAiMcpServers(source: string): AiMcpServerSettings[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  try {
    const value = JSON.parse(trimmed) as unknown;
    const servers = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.servers)
        ? value.servers
        : [];
    return servers
      .map(normalizeAiMcpServer)
      .filter((server): server is AiMcpServerSettings => Boolean(server));
  } catch {
    return [];
  }
}

export function serializeAiMcpServers(servers: AiMcpServerSettings[]): string {
  const normalized = servers
    .map(normalizeAiMcpServer)
    .filter((server): server is AiMcpServerSettings => Boolean(server));
  return normalized.length ? JSON.stringify({ servers: normalized }, null, 2) : "";
}

export function emptyAiMcpServer(): AiMcpServerSettings {
  return {
    name: "",
    url: "",
    transport: DEFAULT_TRANSPORT,
    authorization: "",
    headers: {},
  };
}

export function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export function headersFromText(source: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

function normalizeAiMcpServer(value: unknown): AiMcpServerSettings | undefined {
  if (!isRecord(value)) return undefined;
  const url = stringField(value, "url").trim();
  if (!url) return undefined;
  return {
    name: stringField(value, "name").trim(),
    url,
    transport: normalizeTransport(stringField(value, "transport")),
    authorization: stringField(value, "authorization").trim(),
    headers: normalizeHeaders(value.headers),
  };
}

function normalizeTransport(value: string): AiMcpTransport {
  return value.trim().toLowerCase() === "sse" ? "sse" : DEFAULT_TRANSPORT;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const header = key.trim();
    const text = typeof rawValue === "string" ? rawValue.trim() : "";
    if (header && text) headers[header] = text;
  }
  return headers;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

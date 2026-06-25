import type { JsonRecord } from "./types";
import type { LightOsForwardInfo } from "./plugins/lightos-port-forward/types";
import type { PublicTunnelInfo } from "./plugins/public-tunnel/types";

export function parseLightOsForwards(payload: JsonRecord): LightOsForwardInfo[] {
  return recordArray(payload, "forwards").map((item) => ({
    id: stringValue(item, "id"),
    selector: stringValue(item, "selector"),
    localHost: stringValue(item, "localHost") || "127.0.0.1",
    localPort: numberValue(item, "localPort"),
    localUrl: stringValue(item, "localUrl"),
    remoteHost: stringValue(item, "remoteHost") || "127.0.0.1",
    remotePort: numberValue(item, "remotePort"),
    status: stringValue(item, "status") || "unknown",
    createdAtMs: numberValue(item, "createdAtMs"),
  })).filter((item) => item.id && item.localUrl);
}

export function parsePublicTunnels(payload: JsonRecord): PublicTunnelInfo[] {
  return recordArray(payload, "sessions").map((item) => ({
    id: stringValue(item, "id"),
    provider: stringValue(item, "provider"),
    publicUrl: stringValue(item, "publicUrl"),
    upstreamUrl: stringValue(item, "upstreamUrl"),
    status: stringValue(item, "status") || "unknown",
    createdAtMs: numberValue(item, "createdAtMs"),
  })).filter((item) => item.id && item.publicUrl);
}

export function recordArray(record: JsonRecord, key: string): JsonRecord[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

export function recordValue(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

export function stringValue(record: JsonRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function numberValue(record: JsonRecord | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" ? value : Number(value || 0);
}

export function boolValue(record: JsonRecord | undefined, key: string): boolean {
  const value = record?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return Boolean(value);
}

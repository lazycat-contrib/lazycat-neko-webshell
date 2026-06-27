import type { JsonRecord } from "./types";

type JsonMeta = Record<string, unknown>;

export function metaString(meta: JsonMeta | undefined, key: string): string {
  const value = meta?.[key];
  return typeof value === "string" ? value : "";
}

export function metaNumber(meta: JsonMeta | undefined, key: string): number {
  const value = meta?.[key];
  return typeof value === "number" ? value : Number.NaN;
}

export function metaBoolean(meta: JsonMeta | undefined, key: string): boolean {
  return meta?.[key] === true;
}

export function metaStringArray(meta: JsonMeta | undefined, key: string): string[] {
  const value = meta?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function stringField(record: JsonRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function recordField(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

export function boolField(record: JsonRecord | undefined, key: string): boolean {
  return record?.[key] === true;
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

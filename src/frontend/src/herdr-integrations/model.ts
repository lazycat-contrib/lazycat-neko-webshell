import type { HerdrSocketEnvelope, JsonRecord } from "../types.ts";

export type HerdrIntegrationState = "not_installed" | "current" | "outdated";

export type HerdrIntegrationInfo = {
  target: string;
  label: string;
  command: string;
  available: boolean;
  state: HerdrIntegrationState;
};

const MAX_INTEGRATIONS = 64;
const MAX_TEXT_LENGTH = 160;
const INTEGRATION_STATES = new Set<HerdrIntegrationState>([
  "not_installed",
  "current",
  "outdated",
]);

export function herdrIntegrationListSupported(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version?.trim() ?? "");
  if (!match) return false;
  const [major, minor] = match.slice(1, 3).map(Number);
  return major > 0 || minor >= 9;
}

export function herdrIntegrationList(
  envelope: HerdrSocketEnvelope,
): HerdrIntegrationInfo[] | undefined {
  const values = envelope.result?.integrations;
  if (!Array.isArray(values) || values.length > MAX_INTEGRATIONS) return undefined;
  const integrations = values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as JsonRecord;
    const target = boundedText(record.target);
    const label = boundedText(record.label);
    const command = boundedText(record.command);
    const state = boundedText(record.state) as HerdrIntegrationState;
    if (!target || !label || !command || typeof record.available !== "boolean" || !INTEGRATION_STATES.has(state)) {
      return [];
    }
    return [{ target, label, command, available: record.available, state }];
  });
  return values.length > 0 && integrations.length === 0 ? undefined : integrations;
}

function boundedText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= MAX_TEXT_LENGTH ? normalized : "";
}

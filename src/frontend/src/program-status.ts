import type { MessageKey } from "./i18n.ts";
import type { TerminalPane, TerminalTab, Tone } from "./types.ts";
import { aggregateHerdrActivity, type HerdrActivity } from "./herdr-activity.ts";
import { herdrAgentIconKey, type HerdrAgentIconKey } from "./herdr-agent-icons.ts";

export type ProgramStatusRecord = {
  id: string;
  state: Exclude<HerdrActivity, "unknown">;
  app?: string;
  kind?: "permission" | "question" | "auth";
  progress?: number;
  title?: string;
  msg?: string;
};
export type ProgramStatusPresentation = {
  paneId: string;
  state: HerdrActivity;
  icon?: HerdrAgentIconKey;
  label: string;
  tone: Tone;
};
type Translate = (key: MessageKey) => string;
const states = new Set(["idle", "working", "done", "blocked", "error"]);
const encoder = new TextEncoder();

/** Validate app-owned records; OSC parsing stays in the Rust adapter. */
export function normalizeProgramStatus(value: unknown): ProgramStatusRecord[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const records: ProgramStatusRecord[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || !states.has(item.state)
      || typeof item.id !== "string" || item.id.length > 128 || ids.has(item.id)
      || (item.id && (item.id.split("/").length > 8 || item.id.split("/").some((part: string) => !/^[A-Za-z0-9_.+-]{1,32}$/.test(part))))) return undefined;
    if (item.app !== undefined && (typeof item.app !== "string" || !/^[A-Za-z0-9_.+-]{1,32}$/.test(item.app))) return undefined;
    if (item.kind !== undefined && !["permission", "question", "auth"].includes(item.kind)) return undefined;
    if (item.progress !== undefined && (!Number.isInteger(item.progress) || item.progress < 0 || item.progress > 100)) return undefined;
    for (const [field, limit] of [["title", 192], ["msg", 2048]] as const) {
      const text = item[field];
      if (text !== undefined && (typeof text !== "string" || encoder.encode(text).length > limit || /[\x00-\x1f\x7f-\x9f]/.test(text))) return undefined;
    }
    ids.add(item.id);
    records.push({ id: item.id, state: item.state, app: item.app, title: item.title, msg: item.msg,
      kind: item.state === "blocked" ? item.kind : undefined,
      progress: ["working", "blocked"].includes(item.state) ? item.progress : undefined });
  }
  return records;
}

export function applyProgramStatus(pane: Pick<TerminalPane, "programStatus">, value: unknown): boolean {
  const next = normalizeProgramStatus(value);
  if (!next || JSON.stringify(next) === JSON.stringify(pane.programStatus ?? [])) return false;
  pane.programStatus = next.length ? next : undefined;
  return true;
}

export function programStatusForPane(pane: TerminalPane, tr: Translate): ProgramStatusPresentation | undefined {
  if (pane.exited || pane.closing || pane.connectionState !== "connected"
    || pane.sessionBackend === "herdr" || pane.programKind === "herdr") return undefined;
  const records = pane.programStatus ?? [];
  const state = aggregateHerdrActivity(records.map((record) => record.state));
  const record = records.find((record) => record.state === state);
  if (!record) return undefined;
  const label = [record.app, tr(`herdr.activity.${state}`), record.progress === undefined ? "" : `${record.progress}%`,
    record.kind ? tr(`programStatus.${record.kind}`) : "", record.title, record.msg?.slice(0, 240)].filter(Boolean).join(" · ");
  return { paneId: pane.id, state, label, icon: herdrAgentIconKey(record.app),
    tone: state === "error" || state === "blocked" ? "error" : state === "done" || state === "idle" ? "ok" : "neutral" };
}

export function programStatusForTab(tab: TerminalTab, tr: Translate): ProgramStatusPresentation | undefined {
  const statuses = tab.panes.map((pane) => programStatusForPane(pane, tr)).filter((item) => item !== undefined);
  const state = aggregateHerdrActivity(statuses.map((item) => item.state));
  return statuses.find((item) => item.state === state);
}

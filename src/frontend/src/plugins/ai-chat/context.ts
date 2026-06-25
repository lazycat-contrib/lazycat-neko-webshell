import { recentAIContextText } from "../../ai-context";
import { recordField, stringField } from "../../json-meta";
import type { HerdrSocketEnvelope, JsonRecord, TerminalPane } from "../../types";
import { errorMessage } from "../../utils";

export type HerdrAIContextDeps = {
  lines: number;
  ensureHerdrSocketReady: (pane: TerminalPane) => Promise<string>;
  currentHerdrPaneId: (selector: string) => Promise<string>;
  runHerdrSocketRequest: (
    method: string,
    params: JsonRecord,
    options: { selector?: string; id?: string; mirrorNotification?: boolean },
  ) => Promise<HerdrSocketEnvelope>;
};

export function recentAIContext(pane: TerminalPane | undefined, lines: number): string {
  if (!pane) return "";
  return recentAIContextText(pane.aiContextText, lines);
}

export async function appendHerdrAIContext(
  context: Record<string, unknown>,
  pane: TerminalPane,
  deps: HerdrAIContextDeps,
) {
  const fallbackOutput = recentAIContext(pane, deps.lines);
  try {
    const selector = await deps.ensureHerdrSocketReady(pane);
    const paneId = await deps.currentHerdrPaneId(selector);
    context.herdr_pane_id = paneId;
    const [processInfo, paneRead] = await Promise.allSettled([
      deps.runHerdrSocketRequest("pane.process_info", { pane_id: paneId }, {
        selector,
        id: "lazycat-webshell:ai-context:process-info",
        mirrorNotification: false,
      }),
      deps.runHerdrSocketRequest("pane.read", {
        pane_id: paneId,
        source: "recent",
        lines: deps.lines,
      }, {
        selector,
        id: "lazycat-webshell:ai-context:pane-read",
        mirrorNotification: false,
      }),
    ]);
    if (processInfo.status === "fulfilled") {
      applyHerdrProcessInfoToAIContext(context, processInfo.value.result);
    }
    const readText = paneRead.status === "fulfilled" ? herdrPaneReadText(paneRead.value.result, deps.lines) : "";
    context.recent_output = readText || fallbackOutput;
    if (paneRead.status === "rejected" || processInfo.status === "rejected") {
      context.context_warning = "Herdr sockapi context was partially unavailable; local terminal buffer may be used as fallback.";
    }
  } catch (error) {
    context.context_source = "terminal.buffer";
    context.context_warning = `Herdr sockapi context unavailable: ${errorMessage(error)}`;
    context.recent_output = fallbackOutput;
  }
}

function applyHerdrProcessInfoToAIContext(context: Record<string, unknown>, result: JsonRecord | undefined) {
  const process = recordField(result, "process")
    ?? recordField(result, "process_info")
    ?? recordField(result, "info")
    ?? result;
  const cwd = stringField(process, "cwd")
    || stringField(process, "current_working_directory")
    || stringField(process, "working_directory");
  const shell = stringField(process, "shell");
  const command = stringField(process, "command")
    || stringField(process, "cmd")
    || stringField(process, "name")
    || herdrStringArrayField(process, "argv").join(" ");
  if (cwd) context.cwd = cwd;
  if (shell) context.shell = shell;
  if (command) context.last_command = command;
  const safeInfo = safeHerdrProcessInfo(process);
  if (Object.keys(safeInfo).length) {
    context.process_info = safeInfo;
  }
}

function safeHerdrProcessInfo(process: JsonRecord | undefined): JsonRecord {
  const safe: JsonRecord = {};
  for (const key of ["pane_id", "pid", "ppid", "name", "command", "cmd", "cwd", "working_directory", "current_working_directory", "shell"]) {
    const value = process?.[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  const argv = herdrStringArrayField(process, "argv");
  if (argv.length) safe.argv = argv;
  return safe;
}

function herdrPaneReadText(result: JsonRecord | undefined, linesLimit: number): string {
  const direct = stringField(result, "text")
    || stringField(result, "content")
    || stringField(result, "output")
    || stringField(result, "data");
  if (direct) return recentAIContextText(direct, linesLimit);
  const pane = recordField(result, "pane");
  const nested = stringField(pane, "text")
    || stringField(pane, "content")
    || stringField(pane, "output")
    || stringField(pane, "data");
  if (nested) return recentAIContextText(nested, linesLimit);
  const lines = herdrStringArrayField(result, "lines")
    .concat(herdrStringArrayField(pane, "lines"));
  return recentAIContextText(lines.join("\n"), linesLimit);
}

function herdrStringArrayField(record: JsonRecord | undefined, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

import type { HerdrSocketEnvelope, JsonRecord } from "../types.ts";
import { sameHistoryTarget, type HistoryState, type HistoryTarget, type TextPoint, type TextRange } from "./types.ts";

const MAX_QUERY_BYTES = 4096;
const MAX_PREVIEW_CHARS = 8192;
const unsupportedCodes = new Set(["unknown_method", "method_not_found", "unsupported_method", "unsupported_endpoint_command"]);
const record = (value: unknown): JsonRecord | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function point(value: unknown): TextPoint | undefined {
  const item = record(value);
  return item && integer(item.row, 0xffff_ffff) && integer(item.col, 0xffff) ? { row: item.row, col: item.col } : undefined;
}
function range(value: unknown): TextRange | undefined {
  const item = record(value), start = point(item?.start), end = point(item?.end);
  return start && end && (start.row < end.row || (start.row === end.row && start.col <= end.col)) ? { start, end } : undefined;
}
class HistoryError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** Operates on an explicitly chosen inner pane, independently from server-global focus. */
export function createHerdrHistoryController(options: {
  target: () => HistoryTarget | undefined;
  request: (method: string, params: JsonRecord, target: HistoryTarget) => Promise<HerdrSocketEnvelope>;
  copy: (text: Promise<string>, isCurrent: () => boolean) => Promise<void>;
  changed: (state: HistoryState) => void;
}) {
  let target: HistoryTarget | undefined;
  let operation = 0;
  let revision: number | undefined;
  let cursor: TextPoint = { row: 0, col: 0 };
  let state: HistoryState = { panes: [], paneId: "", query: "", status: "choose", total: 0, preview: "" };
  const publish = () => options.changed({ ...state, panes: [...state.panes] });
  function resetMatch() { revision = undefined; cursor = { row: 0, col: 0 }; state.match = undefined; state.position = undefined; state.total = 0; state.preview = ""; }
  function current(version: number): boolean {
    return operation === version && sameHistoryTarget(target, options.target());
  }
  async function request(method: string, params: JsonRecord, version: number): Promise<JsonRecord> {
    if (!target || !current(version)) throw new HistoryError("target_changed");
    const result = await options.request(method, params, target);
    if (!current(version)) throw new HistoryError("target_changed");
    if (result.error) {
      const unsupported = result.error.code === "invalid_request" && /unknown variant|unknown method/i.test(result.error.message ?? "");
      throw new HistoryError(unsupported ? "unknown_method" : result.error.code ?? "request_failed");
    }
    if (!result.result) throw new HistoryError("invalid_response");
    return result.result;
  }
  function fail(error: unknown, version: number) {
    if (operation !== version) return;
    resetMatch();
    const code = error instanceof HistoryError ? error.code : "request_failed";
    state.status = !current(version) ? "targetChanged" : code === "stale_content" ? "stale"
      : unsupportedCodes.has(code) ? "unsupported" : "error";
    publish();
  }
  async function open() {
    target = options.target();
    const version = ++operation;
    state = { panes: [], paneId: "", query: "", status: target ? "loading" : "targetChanged", total: 0, preview: "" };
    resetMatch(); publish();
    if (!target) return;
    try {
      const result = await request("pane.list", {}, version);
      if (!Array.isArray(result.panes)) throw new HistoryError("invalid_response");
      state.panes = result.panes.flatMap(value => {
        const pane = record(value);
        if (typeof pane?.pane_id !== "string" || typeof pane.workspace_id !== "string" || typeof pane.tab_id !== "string") return [];
        const title = typeof pane.title === "string" ? pane.title.slice(0, 120) : "";
        return [{ id: pane.pane_id, label: [title, pane.workspace_id, pane.tab_id, pane.pane_id].filter(Boolean).join(" · ") }];
      });
      state.status = "choose"; publish();
    } catch (error) { fail(error, version); }
  }
  function selectPane(paneId: string) {
    operation++; resetMatch();
    state.paneId = state.panes.some(pane => pane.id === paneId) ? paneId : "";
    state.status = state.paneId ? "ready" : "choose"; publish();
  }
  function setQuery(query: string) {
    operation++; resetMatch(); state.query = query;
    state.status = state.paneId ? "ready" : "choose"; publish();
  }
  async function search(direction: "forward" | "backward", refresh = false) {
    if (!state.paneId || !state.query.trim() || state.status === "unsupported") return;
    const version = ++operation;
    if (new TextEncoder().encode(state.query).length > MAX_QUERY_BYTES) {
      resetMatch(); state.status = "queryTooLong"; publish(); return;
    }
    if (refresh) resetMatch();
    state.status = "searching"; publish();
    try {
      if (revision === undefined) {
        // pane.read.revision is always 0 in Herdr 0.9.0. This read-only motion
        // returns runtime.content_seq plus an absolute coordinate, without moving the TUI.
        const bootstrap = await request("pane.copy_motion", {
          pane_id: state.paneId, cursor: { row: 0, col: 0 }, motion: "first_non_blank",
        }, version);
        if (bootstrap.pane_id !== state.paneId || !integer(bootstrap.content_revision)
          || bootstrap.content_revision % 2 !== 0 || !point(bootstrap.cursor)) throw new HistoryError("stale_content");
        revision = bootstrap.content_revision;
        cursor = point(bootstrap.cursor)!;
      }
      const result = await request("pane.copy_search", {
        pane_id: state.paneId, query: state.query, direction, cursor,
        content_revision: revision, ...(state.match ? { previous: state.match } : {}),
      }, version);
      if (result.pane_id !== state.paneId || result.content_revision !== revision || !Array.isArray(result.matches)
        || result.matches.length > 1024 || !integer(result.total)) throw new HistoryError("invalid_response");
      const selected = integer(result.current) ? range(result.matches[result.current]) : undefined;
      if (result.total > 0 && (!selected || !integer(result.current_global) || result.current_global >= result.total)) throw new HistoryError("invalid_response");
      state.total = result.total;
      state.match = selected;
      state.position = selected ? (result.current_global as number) + 1 : undefined;
      state.preview = "";
      if (selected) {
        cursor = selected.start;
        const selection = await readSelection(version);
        state.preview = selection.slice(0, MAX_PREVIEW_CHARS);
      }
      state.status = selected ? "ready" : "empty"; publish();
    } catch (error) { fail(error, version); }
  }
  async function readSelection(version: number): Promise<string> {
    if (!state.match || revision === undefined) throw new HistoryError("stale_content");
    const result = await request("pane.selection.read", {
      pane_id: state.paneId, anchor: state.match.start, cursor: state.match.end, content_revision: revision,
    }, version);
    if (result.pane_id !== state.paneId || typeof result.text !== "string" || result.text.length > MAX_PREVIEW_CHARS) throw new HistoryError("invalid_response");
    return result.text;
  }
  async function copy() {
    if (!state.match || revision === undefined) return;
    const version = ++operation;
    state.status = "copying"; publish();
    let validated = false;
    try {
      const text = readSelection(version).then((value) => { validated = true; return value; });
      void text.catch(() => {});
      // Start the clipboard request synchronously while this click has user activation.
      await Promise.all([text, options.copy(text, () => current(version))]);
      if (!current(version)) throw new HistoryError("target_changed");
      state.status = "copied"; publish();
    } catch (error) {
      if (validated && current(version) && !(error instanceof HistoryError)) {
        // Keep the checked preview selectable and allow a retry if clipboard permission fails.
        state.status = "copyError"; publish();
      } else fail(error, version);
    }
  }
  return { open, selectPane, setQuery, search, copy, dismiss() { operation++; target = undefined; resetMatch(); } };
}

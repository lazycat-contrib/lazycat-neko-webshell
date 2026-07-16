import type { MessageKey } from "../../i18n.ts";
import { errorMessage } from "../../utils.ts";
import {
  approveTerminalMcpRequest,
  denyTerminalMcpRequest,
  fetchTerminalMcpControlState,
  revokeTerminalMcpGrant,
} from "./api.ts";
import { callerIdsFromText, normalizeTerminalMcpPolicy, serializeTerminalMcpPolicy } from "./policy.ts";
import type { TerminalMcpPluginSnapshot, TerminalMcpPolicy, TerminalMcpControlState } from "./types.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
type Tone = "neutral" | "ok" | "error";

export type TerminalMcpControllerOptions = {
  root: () => HTMLElement;
  plugin: () => TerminalMcpPluginSnapshot | undefined;
  settingsVisible: () => boolean;
  configure: (metadata: Record<string, string>) => Promise<boolean>;
  tr: Translate;
  onRender: () => void;
  onStatus: (message: string, tone?: Tone) => void;
};

const POLL_INTERVAL_MS = 3000;

export function createTerminalMcpController(options: TerminalMcpControllerOptions) {
  let controlState: TerminalMcpControlState = emptyControlState();
  let loading = false;
  let error = "";
  let loaded = false;
  let pollingTimer: number | undefined;
  let draftPolicy: TerminalMcpPolicy | undefined;
  const busyIds = new Set<string>();

  function viewState() {
    const plugin = options.plugin();
    return {
      enabled: Boolean(plugin?.enabled),
      policy: draftPolicy ?? normalizeTerminalMcpPolicy(plugin?.metadata),
      pendingRequests: controlState.pendingRequests,
      activeGrants: controlState.activeGrants,
      busyIds,
      loading,
      error,
    };
  }

  function sync() {
    const plugin = options.plugin();
    if (!plugin?.enabled) {
      stopPolling();
      clearControlState();
      return;
    }
    if (!options.settingsVisible()) {
      stopPolling();
      return;
    }
    if (pollingTimer === undefined) {
      pollingTimer = window.setInterval(() => {
        if (!options.plugin()?.enabled || !options.settingsVisible()) {
          stopPolling();
          return;
        }
        void refresh();
      }, POLL_INTERVAL_MS);
      queueMicrotask(() => void refresh());
    }
  }

  async function refresh(forceRender = false) {
    if (loading || !options.plugin()?.enabled) return;
    const wasLoaded = loaded;
    const previousError = error;
    const previousState = JSON.stringify(controlState);
    loading = true;
    error = "";
    if (!wasLoaded || forceRender) render();
    try {
      controlState = await fetchTerminalMcpControlState();
      loaded = true;
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      loading = false;
      if (!wasLoaded || forceRender || previousError !== error || previousState !== JSON.stringify(controlState)) {
        render();
      }
    }
  }

  function handleClick(target: Element | null): boolean {
    const save = target?.closest<HTMLButtonElement>("[data-terminal-mcp-policy-save]");
    if (save) {
      void savePolicy();
      return true;
    }
    const refreshButton = target?.closest<HTMLButtonElement>("[data-terminal-mcp-refresh]");
    if (refreshButton) {
      void refresh(true);
      return true;
    }
    const approve = target?.closest<HTMLButtonElement>("[data-terminal-mcp-request-approve]");
    if (approve) {
      void decideRequest(approve.dataset.terminalMcpRequestApprove ?? "", "approve");
      return true;
    }
    const deny = target?.closest<HTMLButtonElement>("[data-terminal-mcp-request-deny]");
    if (deny) {
      void decideRequest(deny.dataset.terminalMcpRequestDeny ?? "", "deny");
      return true;
    }
    const revoke = target?.closest<HTMLButtonElement>("[data-terminal-mcp-grant-revoke]");
    if (revoke) {
      void revokeGrant(revoke.dataset.terminalMcpGrantRevoke ?? "");
      return true;
    }
    return false;
  }

  function handleInput(target: Element | null): boolean {
    const field = target?.closest([
      "[data-terminal-mcp-policy-mode]",
      "[data-terminal-mcp-trusted-callers]",
      "[data-terminal-mcp-denied-callers]",
    ].join(","));
    if (!field) {
      return false;
    }
    draftPolicy = readPolicyDraft();
    if (field.matches("[data-terminal-mcp-policy-mode]")) render();
    return true;
  }

  async function savePolicy() {
    const policy = readPolicyDraft();
    draftPolicy = policy;
    const saved = await options.configure(serializeTerminalMcpPolicy(policy));
    if (saved) {
      draftPolicy = undefined;
      render();
    }
  }

  function readPolicyDraft(): TerminalMcpPolicy {
    const root = options.root();
    const mode = root.querySelector<HTMLSelectElement>("[data-terminal-mcp-policy-mode]")?.value;
    const trusted = root.querySelector<HTMLTextAreaElement>("[data-terminal-mcp-trusted-callers]")?.value ?? "";
    const denied = root.querySelector<HTMLTextAreaElement>("[data-terminal-mcp-denied-callers]")?.value ?? "";
    return {
      mode: mode === "trusted_callers" || mode === "same_user_automatic" || mode === "read_only"
        ? mode
        : "confirm",
      trustedCallers: callerIdsFromText(trusted),
      deniedCallers: callerIdsFromText(denied),
    };
  }

  async function decideRequest(requestId: string, decision: "approve" | "deny") {
    if (!requestId || busyIds.has(requestId)) return;
    busyIds.add(requestId);
    render();
    try {
      if (decision === "approve") {
        await approveTerminalMcpRequest(requestId);
      } else {
        await denyTerminalMcpRequest(requestId);
      }
      await refreshAfterMutation();
      options.onStatus(options.tr(
        decision === "approve" ? "status.terminalMcpApproved" : "status.terminalMcpDenied",
      ), "ok");
    } catch (caught) {
      reportActionError(caught);
    } finally {
      busyIds.delete(requestId);
      render();
    }
  }

  async function revokeGrant(grantId: string) {
    if (!grantId || busyIds.has(grantId)) return;
    busyIds.add(grantId);
    render();
    try {
      await revokeTerminalMcpGrant(grantId);
      await refreshAfterMutation();
      options.onStatus(options.tr("status.terminalMcpRevoked"), "ok");
    } catch (caught) {
      reportActionError(caught);
    } finally {
      busyIds.delete(grantId);
      render();
    }
  }

  async function refreshAfterMutation() {
    controlState = await fetchTerminalMcpControlState();
    error = "";
  }

  function reportActionError(caught: unknown) {
    error = errorMessage(caught);
    options.onStatus(options.tr("status.terminalMcpActionFailed", { message: error }), "error");
  }

  function clearControlState() {
    if (!controlState.pendingRequests.length && !controlState.activeGrants.length && !loading && !error && !loaded) {
      return;
    }
    controlState = emptyControlState();
    loaded = false;
    loading = false;
    error = "";
    busyIds.clear();
  }

  function stopPolling() {
    window.clearInterval(pollingTimer);
    pollingTimer = undefined;
  }

  function render() {
    const root = options.root();
    const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
      ? document.activeElement
      : undefined;
    const selector = active?.matches("[data-terminal-mcp-policy-mode]")
      ? "[data-terminal-mcp-policy-mode]"
      : active?.matches("[data-terminal-mcp-trusted-callers]")
        ? "[data-terminal-mcp-trusted-callers]"
        : active?.matches("[data-terminal-mcp-denied-callers]")
          ? "[data-terminal-mcp-denied-callers]"
          : "";
    const selection = active instanceof HTMLTextAreaElement
      ? { start: active.selectionStart, end: active.selectionEnd }
      : undefined;
    options.onRender();
    if (!selector) return;
    const next = options.root().querySelector<HTMLElement>(selector);
    next?.focus({ preventScroll: true });
    if (next instanceof HTMLTextAreaElement && selection) {
      next.setSelectionRange(selection.start, selection.end);
    }
  }

  return {
    handleClick,
    handleInput,
    refresh,
    sync,
    viewState,
  };
}

function emptyControlState(): TerminalMcpControlState {
  return { pendingRequests: [], activeGrants: [] };
}

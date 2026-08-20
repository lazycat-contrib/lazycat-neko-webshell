import type { MessageKey } from "./i18n.ts";
import type {
  HerdrAgentInfo,
  HerdrBridgeState,
  HerdrSocketEnvelope,
  HerdrWorkspaceInfo,
  JsonRecord,
} from "./types.ts";
import { herdrSocketErrorCode } from "./herdr-socket-api.ts";
import type { HerdrStateMutationMethod } from "./herdr-state-mutation.ts";
import { escapeAttr, escapeHtml } from "./utils.ts";

export type HerdrConsoleAction = "search" | "new-agent" | "rename-workspace" | "close-agent";

export type HerdrSearchResult = {
  id: string;
  kind: "agent" | "workspace";
  label: string;
  detail: string;
  workspaceId: string;
  paneId?: string;
  agentCount?: number;
  status?: string;
};

export type HerdrConsoleTarget = {
  selector: string;
  generation: number;
  paneId: string;
  sessionId: string;
};

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type HerdrConsoleControllerDeps = {
  tr: Translate;
  state: () => HerdrBridgeState | undefined;
  target: () => HerdrConsoleTarget | undefined;
  isCurrent: (target: HerdrConsoleTarget) => boolean;
  runReadRequest: (
    method: string,
    params: JsonRecord,
    target: HerdrConsoleTarget,
  ) => Promise<HerdrSocketEnvelope>;
  runMutationRequest: (
    method: HerdrStateMutationMethod,
    params: JsonRecord,
    target: HerdrConsoleTarget,
  ) => Promise<HerdrSocketEnvelope>;
  refresh: (target: HerdrConsoleTarget) => Promise<void>;
  focusWorkspace: (workspaceId: string, target: HerdrConsoleTarget) => Promise<void> | void;
  focusPane: (paneId: string, target: HerdrConsoleTarget) => Promise<void> | void;
  confirm: (options: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger?: boolean;
  }) => Promise<boolean>;
  onStatus: (message: string, tone: "ok" | "error" | "neutral") => void;
  updateIcons: () => void;
  returnFocus?: () => HTMLElement | undefined;
  root?: HTMLElement;
};

const FALLBACK_AGENT_KINDS = ["claude", "codex", "gemini", "opencode", "grok"];

const BYPASS_FLAGS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  copilot: ["--allow-all-tools"],
  cursor: ["--force"],
  gemini: ["--yolo"],
  grok: ["--always-approve"],
  opencode: ["--auto"],
};

const AGENT_START_RETRY_DELAY_MS = 100;
const AGENT_START_RETRY_DEADLINE_MS = 2_000;
const SHELL_PROCESS_NAMES = new Set([
  "sh", "bash", "dash", "zsh", "fish", "ksh", "mksh", "csh", "tcsh",
  "elvish", "xonsh", "nu", "pwsh", "powershell", "cmd",
]);

export function herdrSearchResults(
  state: Pick<HerdrBridgeState, "agents" | "workspaces"> | undefined,
  query: string,
  tr?: Translate,
): HerdrSearchResult[] {
  const workspaces = state?.workspaces ?? [];
  const workspaceLabels = new Map(workspaces.map((workspace) => [
    workspace.workspace_id,
    workspaceLabel(workspace, tr),
  ]));
  const workspaceAgentCounts = new Map<string, number>();
  for (const agent of state?.agents ?? []) {
    workspaceAgentCounts.set(agent.workspace_id, (workspaceAgentCounts.get(agent.workspace_id) ?? 0) + 1);
  }
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (values: string[]) => !normalized
    || values.some((value) => value.toLocaleLowerCase().includes(normalized));
  const agents = (state?.agents ?? [])
    .filter((agent) => matches([
      agentLabel(agent),
      agent.agent ?? "",
      agent.agent_status,
      workspaceLabels.get(agent.workspace_id) ?? "",
    ]))
    .slice()
    .sort(compareAgents)
    .map((agent): HerdrSearchResult => {
      const workspace = workspaceLabels.get(agent.workspace_id) ?? agent.workspace_id;
      const kind = agent.display_agent?.trim() || agent.agent?.trim() || tr?.("herdr.agentFallback") || "Agent";
      return {
        id: `agent:${agent.pane_id}`,
        kind: "agent",
        label: agentLabel(agent),
        detail: `${kind} · ${workspace}`,
        workspaceId: agent.workspace_id,
        paneId: agent.pane_id,
        status: agent.agent_status,
      };
    });
  const spaces = workspaces
    .filter((workspace) => matches([workspaceLabel(workspace, tr)]))
    .slice()
    .sort((left, right) => Number(right.focused) - Number(left.focused) || left.number - right.number)
    .map((workspace): HerdrSearchResult => ({
      id: `workspace:${workspace.workspace_id}`,
      kind: "workspace",
      label: workspaceLabel(workspace, tr),
      detail: "",
      workspaceId: workspace.workspace_id,
      agentCount: workspaceAgentCounts.get(workspace.workspace_id) ?? 0,
    }));
  return [...agents, ...spaces];
}

export function herdrAgentKinds(envelope: HerdrSocketEnvelope | undefined): string[] {
  const manifests = envelope?.result?.manifests;
  if (!Array.isArray(manifests)) return FALLBACK_AGENT_KINDS.slice();
  const kinds = manifests.flatMap((manifest) => {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
    const agent = (manifest as JsonRecord).agent;
    return typeof agent === "string" && agent.trim() ? [agent.trim()] : [];
  });
  const unique = Array.from(new Set(kinds)).sort((left, right) => left.localeCompare(right));
  return unique.length ? unique : FALLBACK_AGENT_KINDS.slice();
}

export function herdrBypassArgs(kind: string, enabled: boolean): string[] {
  return enabled ? [...(BYPASS_FLAGS[kind] ?? [])] : [];
}

export function herdrCreatedPaneId(envelope: HerdrSocketEnvelope): string {
  const rootPane = envelope.result?.root_pane;
  if (!rootPane || typeof rootPane !== "object" || Array.isArray(rootPane)) return "";
  const paneId = (rootPane as JsonRecord).pane_id;
  return typeof paneId === "string" ? paneId.trim() : "";
}

export async function startHerdrAgent(
  runRequest: (method: "agent.start", params: JsonRecord) => Promise<HerdrSocketEnvelope>,
  params: { name: string; kind: string; paneId: string; args: string[] },
  options: {
    readRequest?: (method: "pane.get" | "pane.process_info", params: JsonRecord) => Promise<HerdrSocketEnvelope>;
    delay?: (milliseconds: number) => Promise<void>;
    uniqueSuffix?: () => string;
    now?: () => number;
  } = {},
): Promise<void> {
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
  const uniqueSuffix = options.uniqueSuffix ?? randomAgentSuffix;
  const now = options.now ?? Date.now;
  const pinnedTerminalId = options.readRequest
    ? await readPaneTerminalId(options.readRequest, params.paneId).catch(() => "")
    : "";
  const retryDeadline = now() + AGENT_START_RETRY_DEADLINE_MS;
  let name = params.name;
  let renamed = false;
  while (true) {
    try {
      await runRequest("agent.start", {
        name,
        kind: params.kind,
        pane_id: params.paneId,
        args: params.args,
      });
      return;
    } catch (error) {
      const code = herdrSocketErrorCode(error);
      if (code === "agent_name_taken" && !renamed) {
        name = `${params.kind}-${uniqueSuffix()}`;
        renamed = true;
        continue;
      }
      if (
        code === "agent_pane_busy"
        && options.readRequest
        && pinnedTerminalId
        && now() < retryDeadline
        && await paneShellStillInitializing(options.readRequest, params.paneId, pinnedTerminalId)
      ) {
        await delay(AGENT_START_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
}

export function herdrProcessInfoShowsShellInitialization(processInfo: JsonRecord | undefined): boolean {
  const shellPid = numericField(processInfo, "shell_pid");
  if (!Number.isFinite(shellPid) || numericField(processInfo, "foreground_process_group_id") !== shellPid) {
    return false;
  }
  const foregroundProcesses = processInfo?.foreground_processes;
  if (!Array.isArray(foregroundProcesses)) return false;
  return foregroundProcesses.some((process) => {
    if (!process || typeof process !== "object" || Array.isArray(process)) return false;
    const record = process as JsonRecord;
    if (numericField(record, "pid") !== shellPid) return false;
    const argv = Array.isArray(record.argv) ? record.argv : [];
    return isShellProcessName(typeof record.name === "string" ? record.name : "")
      || isShellProcessName(typeof argv[0] === "string" ? argv[0] : "");
  });
}

export function createPinnedHerdrRequester<TMethod extends string>(
  target: HerdrConsoleTarget,
  isCurrent: (target: HerdrConsoleTarget) => boolean,
  request: (method: TMethod, params: JsonRecord, target: HerdrConsoleTarget) => Promise<HerdrSocketEnvelope>,
  staleError: () => Error,
) {
  return async (method: TMethod, params: JsonRecord = {}): Promise<HerdrSocketEnvelope> => {
    if (!isCurrent(target)) throw staleError();
    const envelope = await request(method, params, target);
    if (!isCurrent(target)) throw staleError();
    return envelope;
  };
}

export function createHerdrConsoleController(deps: HerdrConsoleControllerDeps) {
  let overlay: HTMLDivElement | undefined;
  let returnFocus: HTMLElement | undefined;
  let searchResults: HerdrSearchResult[] = [];
  let searchIndex = 0;
  let actionVersion = 0;
  let actionTarget: HerdrConsoleTarget | undefined;

  const close = () => {
    actionVersion += 1;
    actionTarget = undefined;
    removeOverlay(true);
  };

  const dismiss = () => {
    actionVersion += 1;
    actionTarget = undefined;
    removeOverlay(false);
    returnFocus = undefined;
  };

  const open = async (action: HerdrConsoleAction) => {
    const target = deps.target();
    if (!target || !deps.state()?.available || !deps.isCurrent(target)) return;
    actionVersion += 1;
    const version = actionVersion;
    actionTarget = target;
    removeOverlay(false);
    returnFocus = deps.returnFocus?.()
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    if (action === "search") {
      openSearch(target, version);
      return;
    }
    if (action === "new-agent") {
      await openNewAgent(target, version);
      return;
    }
    if (action === "rename-workspace") {
      openRenameWorkspace(target, version);
      return;
    }
    await closeFocusedAgent(target, version);
  };

  function removeOverlay(restoreFocus: boolean) {
    overlay?.remove();
    overlay = undefined;
    if (restoreFocus) returnFocus?.focus({ preventScroll: true });
    if (restoreFocus) returnFocus = undefined;
  }

  function isActionCurrent(target: HerdrConsoleTarget, version: number): boolean {
    return actionVersion === version
      && actionTarget?.selector === target.selector
      && actionTarget.generation === target.generation
      && deps.isCurrent(target);
  }

  function mount(content: string, target: HerdrConsoleTarget, version: number, initialFocus?: string) {
    if (!isActionCurrent(target, version)) return;
    removeOverlay(false);
    overlay = document.createElement("div");
    overlay.className = "herdr-console-overlay";
    overlay.innerHTML = content;
    (deps.root ?? document.body).append(overlay);
    overlay.addEventListener("click", handleOverlayClick);
    overlay.addEventListener("keydown", handleOverlayKeydown);
    deps.updateIcons();
    if (initialFocus) {
      const mountedOverlay = overlay;
      requestAnimationFrame(() => {
        if (overlay !== mountedOverlay || !isActionCurrent(target, version)) return;
        overlay.querySelector<HTMLElement>(initialFocus)?.focus({ preventScroll: true });
      });
    }
  }

  function openSearch(target: HerdrConsoleTarget, version: number) {
    mount(renderDialog({
      icon: "search",
      title: deps.tr("action.searchHerdr"),
      subtitle: deps.tr("status.searchHerdrHint"),
      body: `
        <label class="herdr-console-search-field">
          <i data-lucide="search" aria-hidden="true"></i>
          <span class="sr-only">${escapeHtml(deps.tr("action.searchHerdr"))}</span>
          <input type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="herdr-console-results" data-herdr-console-search autocomplete="off" placeholder="${escapeAttr(deps.tr("field.searchHerdr"))}">
        </label>
        <div class="herdr-console-results" id="herdr-console-results" data-herdr-console-results role="listbox" aria-label="${escapeAttr(deps.tr("action.searchHerdr"))}"></div>
      `,
      footer: `<span>${escapeHtml(deps.tr("status.searchHerdrKeys"))}</span>`,
      extraClass: "is-search",
      closeLabel: deps.tr("action.close"),
    }), target, version);
    const input = overlay?.querySelector<HTMLInputElement>("[data-herdr-console-search]");
    input?.addEventListener("input", () => {
      searchIndex = 0;
      renderSearchMatches(input.value);
    });
    renderSearchMatches("");
    requestAnimationFrame(() => {
      if (isActionCurrent(target, version)) input?.focus();
    });
  }

  function renderSearchMatches(query: string) {
    searchResults = herdrSearchResults(deps.state(), query, deps.tr);
    searchIndex = Math.min(searchIndex, Math.max(0, searchResults.length - 1));
    const list = overlay?.querySelector<HTMLElement>("[data-herdr-console-results]");
    if (!list) return;
    list.innerHTML = searchResults.length
      ? searchResults.map((result, index) => renderSearchResult(result, index, index === searchIndex, deps.tr)).join("")
      : `<p class="herdr-console-empty">${escapeHtml(deps.tr("status.noHerdrSearchResults"))}</p>`;
    const input = overlay?.querySelector<HTMLInputElement>("[data-herdr-console-search]");
    if (searchResults.length) input?.setAttribute("aria-activedescendant", `herdr-search-option-${searchIndex}`);
    else input?.removeAttribute("aria-activedescendant");
    activeSearchOption()?.scrollIntoView({ block: "nearest" });
    deps.updateIcons();
  }

  async function chooseSearchResult(index: number) {
    const result = searchResults[index];
    const target = actionTarget;
    const version = actionVersion;
    if (!result || !target || !isActionCurrent(target, version)) return;
    close();
    if (!deps.isCurrent(target)) return;
    if (result.paneId) await deps.focusPane(result.paneId, target);
    else await deps.focusWorkspace(result.workspaceId, target);
  }

  async function openNewAgent(target: HerdrConsoleTarget, version: number) {
    mount(renderLoadingDialog(
      deps.tr("action.newHerdrAgent"),
      deps.tr("status.loadingHerdrAgentKinds"),
      deps.tr("action.close"),
    ), target, version, "[data-herdr-console-close]");
    const readRequest = createPinnedHerdrRequester(
      target,
      deps.isCurrent,
      deps.runReadRequest,
      () => new Error(deps.tr("status.herdrTargetChanged")),
    );
    let kinds = FALLBACK_AGENT_KINDS.slice();
    try {
      kinds = herdrAgentKinds(await readRequest("server.agent_manifests", {}));
    } catch {
      // The fallback list keeps agent creation usable on older compatible servers.
    }
    if (!overlay || !isActionCurrent(target, version)) {
      if (!deps.isCurrent(target)) close();
      return;
    }
    const state = deps.state();
    const focusedWorkspace = focusedHerdrWorkspace(state);
    mount(renderDialog({
      icon: "sparkles",
      title: deps.tr("action.newHerdrAgent"),
      subtitle: deps.tr("status.newHerdrAgentHint"),
      body: `
        <form class="herdr-console-form" data-herdr-new-agent-form>
          <label>
            <span>${escapeHtml(deps.tr("field.herdrAgent"))}</span>
            <select name="kind">${kinds.map((kind) => `<option value="${escapeAttr(kind)}">${escapeHtml(kind)}</option>`).join("")}</select>
          </label>
          <label>
            <span>${escapeHtml(deps.tr("field.herdrSpace"))}</span>
            <select name="workspace_id">${(state?.workspaces ?? []).map((workspace) => `
              <option value="${escapeAttr(workspace.workspace_id)}" ${workspace.workspace_id === focusedWorkspace?.workspace_id ? "selected" : ""}>${escapeHtml(workspaceLabel(workspace, deps.tr))}</option>
            `).join("")}</select>
          </label>
          <label class="herdr-console-check" data-herdr-bypass-row>
            <input type="checkbox" name="bypass" checked>
            <span><strong>${escapeHtml(deps.tr("field.herdrBypassPermissions"))}</strong><small data-herdr-bypass-hint></small></span>
          </label>
          <p class="herdr-console-form-error" data-herdr-form-error role="alert"></p>
        </form>
      `,
      footer: `
        <button type="button" class="command-button" data-herdr-console-close>${escapeHtml(deps.tr("action.cancel"))}</button>
        <button type="submit" form="herdr-new-agent-form" class="command-button primary" data-herdr-new-agent-submit>${escapeHtml(deps.tr("action.startHerdrAgent"))}</button>
      `,
      formId: "herdr-new-agent-form",
      closeLabel: deps.tr("action.close"),
    }), target, version);
    const form = overlay?.querySelector<HTMLFormElement>("[data-herdr-new-agent-form]");
    if (!form) return;
    form.id = "herdr-new-agent-form";
    const kindSelect = form.elements.namedItem("kind") as HTMLSelectElement | null;
    kindSelect?.addEventListener("change", () => syncBypassRow(form));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitNewAgent(form, target, version);
    });
    syncBypassRow(form);
    requestAnimationFrame(() => {
      if (isActionCurrent(target, version)) kindSelect?.focus();
    });
  }

  function syncBypassRow(form: HTMLFormElement) {
    const kind = (form.elements.namedItem("kind") as HTMLSelectElement | null)?.value ?? "";
    const row = form.querySelector<HTMLElement>("[data-herdr-bypass-row]");
    const hint = form.querySelector<HTMLElement>("[data-herdr-bypass-hint]");
    const flags = BYPASS_FLAGS[kind];
    if (row) row.hidden = !flags;
    if (hint) hint.textContent = flags?.join(" ") ?? "";
  }

  async function submitNewAgent(
    form: HTMLFormElement,
    target: HerdrConsoleTarget,
    version: number,
  ) {
    if (!isActionCurrent(target, version)) return;
    const kind = (form.elements.namedItem("kind") as HTMLSelectElement | null)?.value.trim() ?? "";
    const workspaceId = (form.elements.namedItem("workspace_id") as HTMLSelectElement | null)?.value.trim() ?? "";
    const bypass = (form.elements.namedItem("bypass") as HTMLInputElement | null)?.checked ?? false;
    if (!kind || !workspaceId) return;
    setFormBusy(form, true);
    setFormError(form, "");
    let paneId = "";
    const mutationRequest = createPinnedHerdrRequester(
      target,
      deps.isCurrent,
      deps.runMutationRequest,
      () => new Error(deps.tr("status.herdrTargetChanged")),
    );
    const readRequest = createPinnedHerdrRequester(
      target,
      deps.isCurrent,
      deps.runReadRequest,
      () => new Error(deps.tr("status.herdrTargetChanged")),
    );
    try {
      const created = await mutationRequest("tab.create", {
        workspace_id: workspaceId,
        label: kind,
        focus: false,
      });
      paneId = herdrCreatedPaneId(created);
      if (!paneId) throw new Error(deps.tr("status.herdrAgentPaneMissing"));
      await startHerdrAgent(mutationRequest, {
        name: uniqueAgentName(deps.state()?.agents ?? [], kind),
        kind,
        paneId,
        args: herdrBypassArgs(kind, bypass),
      }, {
        readRequest,
      });
      await refreshPinned(target);
      if (!isActionCurrent(target, version)) return;
      close();
      if (deps.isCurrent(target)) await deps.focusPane(paneId, target);
      if (deps.isCurrent(target)) deps.onStatus(deps.tr("status.herdrAgentStarted", { agent: kind }), "ok");
    } catch (error) {
      if (paneId && deps.isCurrent(target)) {
        try {
          await mutationRequest("pane.close", { pane_id: paneId });
        } catch {
          // Preserve the start failure; a refresh reconciles any surviving pane.
        }
        if (deps.isCurrent(target)) await refreshPinned(target).catch(() => undefined);
      }
      if (!isActionCurrent(target, version)) {
        if (!deps.isCurrent(target)) close();
        return;
      }
      setFormError(form, error instanceof Error ? error.message : String(error));
      setFormBusy(form, false);
    }
  }

  function openRenameWorkspace(target: HerdrConsoleTarget, version: number) {
    const workspace = focusedHerdrWorkspace(deps.state());
    if (!workspace) return;
    mount(renderDialog({
      icon: "pencil",
      title: deps.tr("action.renameHerdrSpace"),
      subtitle: deps.tr("status.renameHerdrSpaceHint", { name: workspaceLabel(workspace, deps.tr) }),
      body: `
        <form class="herdr-console-form" data-herdr-rename-form>
          <label>
            <span>${escapeHtml(deps.tr("field.name"))}</span>
            <input name="label" value="${escapeAttr(workspaceLabel(workspace, deps.tr))}" autocomplete="off" maxlength="160">
          </label>
          <p class="herdr-console-form-error" data-herdr-form-error role="alert"></p>
        </form>
      `,
      footer: `
        <button type="button" class="command-button" data-herdr-console-close>${escapeHtml(deps.tr("action.cancel"))}</button>
        <button type="submit" form="herdr-rename-form" class="command-button primary">${escapeHtml(deps.tr("action.rename"))}</button>
      `,
      formId: "herdr-rename-form",
      closeLabel: deps.tr("action.close"),
    }), target, version);
    const form = overlay?.querySelector<HTMLFormElement>("[data-herdr-rename-form]");
    if (!form) return;
    form.id = "herdr-rename-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitRenameWorkspace(form, workspace, target, version);
    });
    const input = form.elements.namedItem("label") as HTMLInputElement | null;
    requestAnimationFrame(() => {
      if (!isActionCurrent(target, version)) return;
      input?.focus();
      input?.select();
    });
  }

  async function submitRenameWorkspace(
    form: HTMLFormElement,
    workspace: HerdrWorkspaceInfo,
    target: HerdrConsoleTarget,
    version: number,
  ) {
    if (!isActionCurrent(target, version)) return;
    const label = (form.elements.namedItem("label") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!label || label === workspaceLabel(workspace, deps.tr)) return;
    setFormBusy(form, true);
    setFormError(form, "");
    const mutationRequest = createPinnedHerdrRequester(
      target,
      deps.isCurrent,
      deps.runMutationRequest,
      () => new Error(deps.tr("status.herdrTargetChanged")),
    );
    try {
      await mutationRequest("workspace.rename", { workspace_id: workspace.workspace_id, label });
      await refreshPinned(target);
      if (!isActionCurrent(target, version)) return;
      close();
      deps.onStatus(deps.tr("status.herdrSpaceRenamed", { name: label }), "ok");
    } catch (error) {
      if (!isActionCurrent(target, version)) {
        if (!deps.isCurrent(target)) close();
        return;
      }
      setFormError(form, error instanceof Error ? error.message : String(error));
      setFormBusy(form, false);
    }
  }

  async function closeFocusedAgent(target: HerdrConsoleTarget, version: number) {
    const agent = focusedHerdrAgent(deps.state());
    if (!agent) return;
    const label = agentLabel(agent);
    const confirmed = await deps.confirm({
      title: deps.tr("action.closeHerdrAgent"),
      message: deps.tr("confirm.closeHerdrAgent", { name: label }),
      confirmLabel: deps.tr("action.closeHerdrAgent"),
      cancelLabel: deps.tr("action.cancel"),
      danger: true,
    });
    if (!confirmed || !isActionCurrent(target, version)) return;
    const mutationRequest = createPinnedHerdrRequester(
      target,
      deps.isCurrent,
      deps.runMutationRequest,
      () => new Error(deps.tr("status.herdrTargetChanged")),
    );
    try {
      await mutationRequest("pane.close", { pane_id: agent.pane_id });
      await refreshPinned(target);
      if (isActionCurrent(target, version)) {
        deps.onStatus(deps.tr("status.herdrAgentClosed", { agent: label }), "ok");
      }
    } catch (error) {
      if (isActionCurrent(target, version)) {
        deps.onStatus(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }

  async function refreshPinned(target: HerdrConsoleTarget) {
    if (!deps.isCurrent(target)) throw new Error(deps.tr("status.herdrTargetChanged"));
    await deps.refresh(target);
    if (!deps.isCurrent(target)) throw new Error(deps.tr("status.herdrTargetChanged"));
  }

  function handleOverlayClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target === overlay || target.closest("[data-herdr-console-close]")) {
      close();
      return;
    }
    const result = target.closest<HTMLButtonElement>("[data-herdr-search-index]");
    if (result) void chooseSearchResult(Number(result.dataset.herdrSearchIndex));
  }

  function handleOverlayKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const search = event.target instanceof HTMLInputElement && event.target.matches("[data-herdr-console-search]");
    if (search && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      if (!searchResults.length) return;
      event.preventDefault();
      searchIndex = (searchIndex + (event.key === "ArrowDown" ? 1 : -1) + searchResults.length) % searchResults.length;
      renderSearchMatches(event.target.value);
      return;
    }
    if (search && event.key === "Enter") {
      event.preventDefault();
      void chooseSearchResult(searchIndex);
      return;
    }
    if (event.key === "Tab") trapFocus(event);
  }

  function trapFocus(event: KeyboardEvent) {
    const controls = Array.from(overlay?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
    ) ?? []).filter((element) => !element.closest("[hidden]") && element.getAttribute("aria-hidden") !== "true");
    if (!controls.length) return;
    const current = controls.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? (current <= 0 ? controls.length - 1 : current - 1)
      : (current < 0 || current === controls.length - 1 ? 0 : current + 1);
    event.preventDefault();
    controls[next]?.focus();
  }

  function activeSearchOption(): HTMLElement | undefined {
    return overlay?.querySelector<HTMLElement>(`[data-herdr-search-index="${searchIndex}"]`) ?? undefined;
  }

  return { open, close, dismiss, destroy: dismiss };
}

function renderDialog(options: {
  icon: string;
  title: string;
  subtitle: string;
  body: string;
  footer: string;
  extraClass?: string;
  formId?: string;
  closeLabel: string;
}): string {
  return `
    <section class="herdr-console-dialog ${escapeAttr(options.extraClass ?? "")}" role="dialog" aria-modal="true" aria-labelledby="herdr-console-title" tabindex="-1">
      <header>
        <span class="herdr-console-dialog-icon" aria-hidden="true"><i data-lucide="${escapeAttr(options.icon)}"></i></span>
        <span><h2 id="herdr-console-title">${escapeHtml(options.title)}</h2><p>${escapeHtml(options.subtitle)}</p></span>
        <button type="button" class="icon-button" data-herdr-console-close aria-label="${escapeAttr(options.closeLabel)}"><i data-lucide="x"></i></button>
      </header>
      <div class="herdr-console-dialog-body">${options.body}</div>
      <footer>${options.footer}</footer>
    </section>
  `;
}

function renderLoadingDialog(title: string, message: string, closeLabel: string): string {
  return renderDialog({
    icon: "sparkles",
    title,
    subtitle: message,
    body: `<div class="herdr-console-loading"><span>${escapeHtml(message)}</span></div>`,
    footer: "",
    closeLabel,
  });
}

function renderSearchResult(
  result: HerdrSearchResult,
  index: number,
  active: boolean,
  tr: Translate,
): string {
  const icon = result.kind === "workspace" ? "folder" : "sparkles";
  const detail = result.kind === "workspace"
    ? tr(result.agentCount === 1 ? "status.herdrAgentCountOne" : "status.herdrAgentCount", { count: result.agentCount ?? 0 })
    : result.detail;
  return `
    <button id="herdr-search-option-${index}" type="button" role="option" aria-selected="${active}" data-herdr-search-index="${index}">
      <i data-lucide="${icon}" aria-hidden="true"></i>
      <span><strong>${escapeHtml(result.label)}</strong><small>${escapeHtml(detail)}</small></span>
      ${result.status ? `<span class="status-dot" data-status="${escapeAttr(result.status)}"></span>` : ""}
    </button>
  `;
}

function workspaceLabel(workspace: HerdrWorkspaceInfo, tr?: Translate): string {
  if (workspace.label.trim()) return workspace.label.trim();
  if (tr) {
    return workspace.number
      ? tr("herdr.workspaceFallback", { number: workspace.number })
      : tr("herdr.workspaceFallbackPlain");
  }
  return `Workspace ${workspace.number || ""}`.trim();
}

function agentLabel(agent: HerdrAgentInfo): string {
  return agent.title?.trim()
    || agent.display_agent?.trim()
    || agent.name?.trim()
    || agent.agent?.trim()
    || agent.pane_id;
}

function compareAgents(left: HerdrAgentInfo, right: HerdrAgentInfo): number {
  const priority = (status: string) => status === "blocked" ? 0 : status === "done" ? 1 : status === "working" ? 2 : 3;
  return priority(left.agent_status) - priority(right.agent_status)
    || right.state_change_seq - left.state_change_seq;
}

function focusedHerdrWorkspace(state: HerdrBridgeState | undefined): HerdrWorkspaceInfo | undefined {
  return state?.workspaces.find((workspace) => workspace.workspace_id === state.focused_workspace_id)
    ?? state?.workspaces.find((workspace) => workspace.focused)
    ?? state?.workspaces[0];
}

function focusedHerdrAgent(state: HerdrBridgeState | undefined): HerdrAgentInfo | undefined {
  return state?.agents.find((agent) => agent.pane_id === state.focused_pane_id)
    ?? state?.agents.find((agent) => agent.focused);
}

function uniqueAgentName(agents: HerdrAgentInfo[], kind: string): string {
  const names = new Set(agents.map((agent) => agent.name?.trim()).filter(Boolean));
  if (!names.has(kind)) return kind;
  return `${kind}-${randomAgentSuffix()}`;
}

function randomAgentSuffix(): string {
  return globalThis.crypto?.randomUUID?.().slice(0, 4)
    ?? Math.random().toString(36).slice(2, 6);
}

function setFormBusy(form: HTMLFormElement, busy: boolean) {
  form.setAttribute("aria-busy", String(busy));
  form.closest<HTMLElement>(".herdr-console-dialog")?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    "input, select, button",
  ).forEach((control) => {
    control.disabled = busy;
  });
}

function setFormError(form: HTMLFormElement, message: string) {
  const error = form.querySelector<HTMLElement>("[data-herdr-form-error]");
  if (error) error.textContent = message;
}

async function readPaneTerminalId(
  request: (method: "pane.get" | "pane.process_info", params: JsonRecord) => Promise<HerdrSocketEnvelope>,
  paneId: string,
): Promise<string> {
  const envelope = await request("pane.get", { pane_id: paneId });
  const pane = envelope.result?.pane;
  if (!pane || typeof pane !== "object" || Array.isArray(pane)) return "";
  const terminalId = (pane as JsonRecord).terminal_id;
  return typeof terminalId === "string" ? terminalId.trim() : "";
}

async function paneShellStillInitializing(
  request: (method: "pane.get" | "pane.process_info", params: JsonRecord) => Promise<HerdrSocketEnvelope>,
  paneId: string,
  pinnedTerminalId: string,
): Promise<boolean> {
  try {
    if (await readPaneTerminalId(request, paneId) !== pinnedTerminalId) return false;
    const envelope = await request("pane.process_info", { pane_id: paneId });
    const processInfo = envelope.result?.process_info;
    return herdrProcessInfoShowsShellInitialization(
      processInfo && typeof processInfo === "object" && !Array.isArray(processInfo)
        ? processInfo as JsonRecord
        : undefined,
    );
  } catch {
    return false;
  }
}

function numericField(record: JsonRecord | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" ? value : Number.NaN;
}

function isShellProcessName(value: string): boolean {
  let name = value.trim().split(/[\\/]/).at(-1) ?? value;
  while (name.startsWith("-")) name = name.slice(1);
  name = name.toLocaleLowerCase();
  if (name.endsWith(".exe")) name = name.slice(0, -4);
  return SHELL_PROCESS_NAMES.has(name);
}

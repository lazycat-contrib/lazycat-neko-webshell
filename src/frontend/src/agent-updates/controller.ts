import { inspectAgentUpdate, requestAgentUpdate, type AgentUpdateStatus } from "./api.ts";
import { renderAgentUpdateView, type AgentUpdateViewState } from "./view.ts";
import type { MessageKey } from "../i18n";

type Target = { selector: string; generation: number };
type Options = {
  target: () => Target | undefined;
  isCurrent: (target: Target) => boolean;
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
  render: (state: AgentUpdateViewState | undefined, notice: boolean) => void;
  inspect?: typeof inspectAgentUpdate;
  update?: typeof requestAgentUpdate;
  deferred?: (key: string, version?: number) => number | undefined;
};

export function createAgentUpdateController(options: Options) {
  const inspect = options.inspect ?? inspectAgentUpdate;
  const update = options.update ?? requestAgentUpdate;
  let state: AgentUpdateViewState | undefined;
  let epoch = 0;
  let activeTarget: Target | undefined;
  const hiddenVersions = new Map<string, number>();
  function render() {
    const status = state?.status;
    options.render(state, status?.kind === "optional"
      && (options.deferred?.(status.selector) ?? hiddenVersions.get(status.selector)) !== status.latestVersion);
  }
  function current(target: Target, requestEpoch: number) {
    return epoch === requestEpoch && options.isCurrent(target);
  }
  async function perform(target: Target, requestEpoch: number, status: AgentUpdateStatus, optional: boolean) {
    if (!current(target, requestEpoch)) return;
    state = { status, busy: true }; render();
    try {
      const next = await update(status, optional);
      if (!current(target, requestEpoch) || next.selector !== target.selector) return;
      if (!optional && next.kind === "required") throw new Error("compatibility_update_pending");
      state = { status: next, busy: false }; render();
    } catch (error) {
      if (!current(target, requestEpoch)) return;
      state = { status, busy: false, error: String(error) }; render();
    }
  }
  return {
    async refresh() {
      const target = options.target();
      if (target && activeTarget?.selector === target.selector && activeTarget.generation === target.generation && state?.busy && state.status) return;
      activeTarget = target;
      const requestEpoch = ++epoch;
      if (!target) { state = undefined; render(); return; }
      state = { busy: true }; render();
      try {
        const status = await inspect(target.selector);
        if (!current(target, requestEpoch) || status.selector !== target.selector) return;
        state = { status, busy: false }; render();
        if (status.kind === "required") await perform(target, requestEpoch, status, false);
      } catch (error) {
        if (!current(target, requestEpoch)) return;
        state = { busy: false, error: String(error) }; render();
      }
    },
    async prepare() {
      const target = options.target();
      const status = state?.status;
      if (!target || !options.isCurrent(target) || state?.busy || status?.kind !== "optional" || status.selector !== target.selector) return;
      await perform(target, ++epoch, status, true);
    },
    later() {
      const status = state?.status;
      if (!status || status.kind !== "optional") return;
      hiddenVersions.set(status.selector, status.latestVersion);
      options.deferred?.(status.selector, status.latestVersion);
      render();
    },
    repaint: render,
  };
}

export function bindAgentUpdateView(
  container: HTMLElement, notice: HTMLButtonElement, controller: ReturnType<typeof createAgentUpdateController>,
  openSettings: () => void,
) {
  notice.addEventListener("click", () => {
    openSettings();
    container.scrollIntoView({ block: "center", behavior: "instant" });
    container.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  });
  container.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-agent-update]") : null;
    if (button?.dataset.agentUpdate === "prepare") void controller.prepare();
    if (button?.dataset.agentUpdate === "later") controller.later();
    if (button?.dataset.agentUpdate === "check") void controller.refresh();
  });
}

export function syncAgentUpdateView(container: HTMLElement, notice: HTMLButtonElement, state: AgentUpdateViewState | undefined,
  showNotice: boolean, tr: Options["tr"]) {
  container.hidden = !state;
  container.setAttribute("aria-busy", String(Boolean(state?.busy)));
  const hadFocus = container.contains(document.activeElement);
  if (state) {
    container.innerHTML = renderAgentUpdateView(state, tr);
    if (hadFocus) container.querySelector<HTMLElement>("[data-agent-update-status]")?.focus({ preventScroll: true });
  }
  notice.hidden = !showNotice;
  notice.title = tr("agentUpdate.optionalHelp");
  notice.setAttribute("aria-label", tr("agentUpdate.available"));
}

export function agentUpdateDeferral(selector: string, version?: number): number | undefined {
  try {
    const key = `neko.agent-update-later:${selector}`;
    if (version !== undefined) sessionStorage.setItem(key, String(version));
    const saved = Number(sessionStorage.getItem(key));
    return Number.isSafeInteger(saved) && saved > 0 ? saved : undefined;
  } catch { return undefined; }
}

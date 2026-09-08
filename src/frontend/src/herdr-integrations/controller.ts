import type { HerdrBridgeState, HerdrSocketEnvelope } from "../types.ts";
import { normalizeSelector } from "../workspace-selection.ts";
import { herdrIntegrationList, herdrIntegrationListSupported, type HerdrIntegrationInfo } from "./model.ts";

export type HerdrIntegrationsTarget = {
  selector: string;
  generation: number;
};

export type HerdrIntegrationsScreen =
  | { state: "loading" }
  | { state: "ready"; integrations: HerdrIntegrationInfo[] }
  | { state: "error"; message: string };

export function herdrIntegrationsTarget(
  state: HerdrBridgeState | undefined,
  selectedSelector: string,
  generation: number,
): HerdrIntegrationsTarget | undefined {
  const selector = normalizeSelector(selectedSelector);
  return selector && state?.available && normalizeSelector(state.selector) === selector
    ? { selector, generation }
    : undefined;
}

type HerdrIntegrationsControllerDeps = {
  target: () => HerdrIntegrationsTarget | undefined;
  isCurrent: (target: HerdrIntegrationsTarget) => boolean;
  request: (target: HerdrIntegrationsTarget) => Promise<HerdrSocketEnvelope>;
  present: (screen: HerdrIntegrationsScreen) => void;
  closeView: (restoreFocus: boolean) => void;
  setMenuVisible: (visible: boolean) => void;
  invalidResponse: () => string;
};

export function createHerdrIntegrationsController(deps: HerdrIntegrationsControllerDeps) {
  let supported = false;
  let actionVersion = 0;
  let activeTarget: HerdrIntegrationsTarget | undefined;

  function sync(state: HerdrBridgeState | undefined) {
    const nextSupported = Boolean(state?.available)
      && herdrIntegrationListSupported(state?.herdr_version);
    supported = nextSupported;
    deps.setMenuVisible(nextSupported);
    if (!nextSupported) dismiss();
  }

  async function open() {
    const target = deps.target();
    if (!supported || !target || !deps.isCurrent(target)) return;
    activeTarget = target;
    const version = ++actionVersion;
    await load(target, version);
  }

  async function refresh() {
    const target = activeTarget;
    if (!target || !deps.isCurrent(target)) {
      dismiss();
      return;
    }
    await load(target, ++actionVersion);
  }

  async function load(target: HerdrIntegrationsTarget, version: number) {
    deps.present({ state: "loading" });
    try {
      const envelope = await deps.request(target);
      if (!isActionCurrent(target, version)) {
        closeOwnedStaleView(target, version);
        return;
      }
      const integrations = herdrIntegrationList(envelope);
      if (!integrations) throw new Error(deps.invalidResponse());
      deps.present({ state: "ready", integrations });
    } catch (error) {
      if (!isActionCurrent(target, version)) {
        closeOwnedStaleView(target, version);
        return;
      }
      deps.present({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function closeOwnedStaleView(target: HerdrIntegrationsTarget, version: number) {
    if (actionVersion !== version || activeTarget !== target) return;
    actionVersion += 1;
    activeTarget = undefined;
    deps.closeView(false);
  }

  function isActionCurrent(target: HerdrIntegrationsTarget, version: number): boolean {
    return actionVersion === version
      && activeTarget?.selector === target.selector
      && activeTarget.generation === target.generation
      && deps.isCurrent(target);
  }

  function close() {
    actionVersion += 1;
    activeTarget = undefined;
    deps.closeView(true);
  }

  function dismiss() {
    actionVersion += 1;
    activeTarget = undefined;
    deps.closeView(false);
  }

  return { sync, open, refresh, close, dismiss, destroy: dismiss };
}

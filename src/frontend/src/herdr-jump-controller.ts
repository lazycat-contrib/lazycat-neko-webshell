import type { MessageKey } from "./i18n.ts";
import { buildHerdrJumpModel, normalizeHerdrJumpDensity, type HerdrJumpDensity, type HerdrJumpDevice, type HerdrJumpModel } from "./herdr-jump-model.ts";
import type { HerdrJumpPlatform, HerdrJumpPlatformFactory } from "./herdr-jump-platform.ts";
import { renderHerdrCurrentTargets, renderHerdrJumpGroups, type HerdrJumpLabels } from "./herdr-jump-view.ts";
import type { HerdrBridgeState } from "./types.ts";

type HerdrJumpElements = {
  dock: HTMLElement;
  switcher: HTMLElement;
  trigger: HTMLButtonElement;
  menu: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  currentTargets: HTMLElement;
  moreButton: HTMLButtonElement;
  moreMenu: HTMLElement;
};

type HerdrJumpControllerDeps = {
  elements: HerdrJumpElements;
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
  createPlatform: HerdrJumpPlatformFactory;
  prepareMobileOverlay: () => void;
  updateIcons: () => void;
  refresh: () => Promise<void> | void;
  focusWorkspace: (workspaceId: string) => Promise<void> | void;
  focusTab: (tabId: string) => Promise<void> | void;
  focusPane: (paneId: string) => Promise<void> | void;
  createTab: () => Promise<void> | void;
  createWorkspace: () => Promise<void> | void;
  closeWorkspace: () => Promise<void> | void;
};

type FocusedJumpControl = {
  attribute: string;
  value: string;
  scope: "menu" | "current";
};

const DENSITY_KEYS: Record<HerdrJumpDevice, string> = {
  desktop: "lazycat-neko-webshell.herdr-jump-density.desktop",
  mobile: "lazycat-neko-webshell.herdr-jump-density.mobile",
};
export function createHerdrJumpController(deps: HerdrJumpControllerDeps) {
  const { elements } = deps;
  let state: HerdrBridgeState | undefined;
  let model: HerdrJumpModel = { groups: [] };
  let platform: HerdrJumpPlatform;

  const device = (): HerdrJumpDevice => platform.device();
  const density = (): HerdrJumpDensity => normalizeHerdrJumpDensity(readPreference(device()), device());
  const labels = (): HerdrJumpLabels => ({
    jumpTo: deps.tr("action.herdrJumpTo"),
    compact: deps.tr("option.compact"),
    normal: deps.tr("option.normal"),
    density: deps.tr("field.herdrDisplayDensity"),
    current: deps.tr("status.current"),
    empty: deps.tr("status.noHerdrPanes"),
    focusWorkspace: deps.tr("action.focusHerdrSpace"),
    focusTab: deps.tr("action.focusHerdrTab"),
    focusPane: deps.tr("action.focusHerdrPane"),
  });

  const render = (nextState: HerdrBridgeState | undefined) => {
    const focusedControl = focusedJumpControl();
    state = nextState;
    model = buildHerdrJumpModel(state, {
      workspace: (number) => deps.tr("herdr.workspaceFallback", { number }),
      workspaceDefault: deps.tr("herdr.workspaceFallbackPlain"),
      tab: (number) => deps.tr("herdr.tabFallback", { number }),
      tabDefault: deps.tr("herdr.tabFallbackPlain"),
      terminal: deps.tr("herdr.terminalFallback"),
    });
    const mode = density();
    const viewLabels = labels();
    elements.dock.dataset.herdrDensity = mode;
    elements.list.innerHTML = renderHerdrJumpGroups(model, mode, viewLabels);
    elements.currentTargets.innerHTML = renderHerdrCurrentTargets(model, mode, viewLabels);
    elements.menu.querySelectorAll<HTMLButtonElement>("[data-herdr-density]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.herdrDensity === mode));
    });
    elements.menu.setAttribute("aria-label", viewLabels.jumpTo);
    elements.status.textContent = state?.message ?? "";
    elements.trigger.setAttribute("aria-label", viewLabels.jumpTo);
    elements.trigger.title = viewLabels.jumpTo;
    syncTargetTooltips(mode);
    deps.updateIcons();
    restoreJumpControlFocus(focusedControl);
    if (!elements.menu.hidden) requestAnimationFrame(positionPopover);
  };

  const open = async (keyboard = false) => {
    if (!elements.menu.hidden) return;
    deps.prepareMobileOverlay();
    elements.menu.dataset.keyboardOpen = String(keyboard);
    elements.menu.hidden = false;
    elements.trigger.setAttribute("aria-expanded", "true");
    positionPopover();
    syncTargetTooltips(density());
    platform.onOpen();
    if (keyboard) {
      requestAnimationFrame(() => firstJumpControl()?.focus());
    }
    requestAnimationFrame(() => elements.menu.removeAttribute("data-keyboard-open"));
    await deps.refresh();
  };

  const close = (fromHistory = false) => {
    closeMore();
    platform.closeMobileMore();
    if (elements.menu.hidden) return;
    elements.menu.hidden = true;
    elements.menu.style.removeProperty("left");
    elements.menu.style.removeProperty("top");
    elements.menu.style.removeProperty("bottom");
    elements.menu.style.removeProperty("--herdr-popover-origin");
    elements.menu.style.removeProperty("transform");
    elements.trigger.setAttribute("aria-expanded", "false");
    platform.onClose(fromHistory);
    elements.trigger.focus({ preventScroll: true });
  };

  const toggle = (keyboard = false) => elements.menu.hidden ? void open(keyboard) : close();
  const toggleMore = () => {
    const opening = elements.moreMenu.hidden;
    elements.moreMenu.hidden = !opening;
    elements.moreButton.setAttribute("aria-expanded", String(opening));
  };
  const closeMore = () => {
    elements.moreMenu.hidden = true;
    elements.moreButton.setAttribute("aria-expanded", "false");
  };
  platform = deps.createPlatform((fromHistory) => close(fromHistory));

  const handleTriggerClick = (event: MouseEvent) => {
    event.stopPropagation();
    toggle(false);
  };
  const handleTriggerKeydown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void open(true);
  };
  const handleMoreButtonClick = (event: MouseEvent) => {
    event.stopPropagation();
    toggleMore();
  };
  const handleMoreButtonKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !elements.moreMenu.hidden) {
      event.preventDefault();
      closeMore();
      return;
    }
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (elements.moreMenu.hidden) toggleMore();
    elements.moreMenu.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({ preventScroll: true });
  };
  const handleMoreMenuKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeMore();
    elements.moreButton.focus({ preventScroll: true });
  };
  const handleDockClickEvent = (event: MouseEvent) => void handleDockClick(event);

  elements.trigger.addEventListener("click", handleTriggerClick);
  elements.trigger.addEventListener("keydown", handleTriggerKeydown);
  elements.moreButton.addEventListener("click", handleMoreButtonClick);
  elements.moreButton.addEventListener("keydown", handleMoreButtonKeydown);
  elements.dock.addEventListener("click", handleDockClickEvent);
  elements.menu.addEventListener("keydown", handleMenuKeydown);
  elements.moreMenu.addEventListener("keydown", handleMoreMenuKeydown);
  document.addEventListener("click", handleDocumentClick);
  window.addEventListener("resize", positionPopover);
  platform.onDeviceChange(handleDeviceChange);

  async function handleDockClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-herdr-jump-dismiss]")) {
      close();
      return;
    }
    const densityButton = target.closest<HTMLButtonElement>("[data-herdr-density]");
    if (densityButton) {
      const next = normalizeHerdrJumpDensity(densityButton.dataset.herdrDensity, device());
      writePreference(device(), next);
      render(state);
      return;
    }
    const paneButton = target.closest<HTMLButtonElement>("[data-herdr-jump-pane]");
    if (paneButton) {
      const paneId = paneButton.dataset.herdrJumpPane ?? "";
      close();
      await deps.focusPane(paneId);
      return;
    }
    const tabButton = target.closest<HTMLButtonElement>("[data-herdr-jump-tab]");
    if (tabButton) {
      const tabId = tabButton.dataset.herdrJumpTab ?? "";
      close();
      await deps.focusTab(tabId);
      return;
    }
    const workspaceButton = target.closest<HTMLButtonElement>("[data-herdr-jump-workspace]");
    if (workspaceButton) {
      const workspaceId = workspaceButton.dataset.herdrJumpWorkspace ?? "";
      close();
      await deps.focusWorkspace(workspaceId);
      return;
    }
    const mobileMore = target.closest<HTMLButtonElement>("[data-herdr-mobile-more]");
    if (mobileMore) {
      platform.toggleMobileMore();
      return;
    }
    const action = target.closest<HTMLButtonElement>("[data-herdr-jump-action]")?.dataset.herdrJumpAction;
    if (!action) return;
    closeMore();
    platform.closeMobileMore();
    if (action !== "refresh") close();
    if (action === "create-tab") await deps.createTab();
    if (action === "create-workspace") await deps.createWorkspace();
    if (action === "refresh") await deps.refresh();
    if (action === "close-workspace") await deps.closeWorkspace();
  }

  function handleMenuKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const controls = jumpControls();
    if (!controls.length) return;
    event.preventDefault();
    const current = controls.findIndex((control) => control === document.activeElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? controls.length - 1
        : (current + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length;
    controls[next]?.focus();
  }

  function handleDocumentClick(event: MouseEvent) {
    if (!(event.target instanceof Node)) return;
    if (!elements.switcher.contains(event.target)) close();
    if (!elements.moreMenu.contains(event.target) && event.target !== elements.moreButton) closeMore();
  }

  function handleDeviceChange() {
    if (!elements.menu.hidden) close();
    render(state);
  }

  function positionPopover() {
    if (elements.menu.hidden || platform.isMobile()) return;
    const trigger = elements.trigger.getBoundingClientRect();
    const menu = elements.menu.getBoundingClientRect();
    const margin = 8;
    const below = window.innerHeight - trigger.bottom;
    const above = trigger.top;
    const placeAbove = below < menu.height + margin && above > below;
    const left = Math.min(Math.max(margin, trigger.left), Math.max(margin, window.innerWidth - menu.width - margin));
    elements.menu.style.left = `${left}px`;
    elements.menu.style.top = placeAbove ? "auto" : `${trigger.bottom + margin}px`;
    elements.menu.style.bottom = placeAbove ? `${window.innerHeight - trigger.top + margin}px` : "auto";
    const originX = Math.min(Math.max(trigger.left + trigger.width / 2 - left, 24), Math.max(24, menu.width - 24));
    elements.menu.style.setProperty("--herdr-popover-origin", `${originX}px ${placeAbove ? "100%" : "0%"}`);
  }

  function syncTargetTooltips(mode: HerdrJumpDensity) {
    requestAnimationFrame(() => {
      elements.dock.querySelectorAll<HTMLButtonElement>(".herdr-target-chip").forEach((button) => {
        if (mode === "compact") return;
        const label = button.querySelector<HTMLElement>(".herdr-target-name");
        if (label && label.scrollWidth <= label.clientWidth) button.removeAttribute("title");
      });
    });
  }

  function jumpControls(): HTMLButtonElement[] {
    return Array.from(elements.menu.querySelectorAll<HTMLButtonElement>("[data-herdr-jump-workspace], [data-herdr-jump-tab], [data-herdr-jump-pane]"));
  }
  function firstJumpControl(): HTMLButtonElement | undefined {
    return jumpControls()[0] ?? elements.menu.querySelector<HTMLButtonElement>("[data-herdr-density]") ?? undefined;
  }
  function focusedJumpControl(): FocusedJumpControl | undefined {
    if (!(document.activeElement instanceof HTMLButtonElement)) return undefined;
    const scope = elements.menu.contains(document.activeElement)
      ? "menu"
      : elements.currentTargets.contains(document.activeElement)
        ? "current"
        : undefined;
    if (!scope) return undefined;
    for (const attribute of ["data-herdr-jump-pane", "data-herdr-jump-tab", "data-herdr-jump-workspace"]) {
      const value = document.activeElement.getAttribute(attribute);
      if (value) return { attribute, value, scope };
    }
    return undefined;
  }
  function restoreJumpControlFocus(identity: FocusedJumpControl | undefined) {
    if (!identity) return;
    const escaped = CSS.escape(identity.value);
    const root = identity.scope === "menu" ? elements.menu : elements.currentTargets;
    const control = root.querySelector<HTMLButtonElement>(`[${identity.attribute}="${escaped}"]`)
      ?? (identity.scope === "menu"
        ? firstJumpControl()
        : elements.currentTargets.querySelector<HTMLButtonElement>("[data-herdr-jump-pane], [data-herdr-jump-tab]")
          ?? elements.trigger);
    control?.focus({ preventScroll: true });
  }

  return {
    render,
    open,
    close,
    destroy() {
      elements.trigger.removeEventListener("click", handleTriggerClick);
      elements.trigger.removeEventListener("keydown", handleTriggerKeydown);
      elements.moreButton.removeEventListener("click", handleMoreButtonClick);
      elements.moreButton.removeEventListener("keydown", handleMoreButtonKeydown);
      elements.dock.removeEventListener("click", handleDockClickEvent);
      elements.menu.removeEventListener("keydown", handleMenuKeydown);
      elements.moreMenu.removeEventListener("keydown", handleMoreMenuKeydown);
      document.removeEventListener("click", handleDocumentClick);
      window.removeEventListener("resize", positionPopover);
      platform.destroy();
    },
  };
}

function readPreference(device: HerdrJumpDevice): string | null {
  try {
    return localStorage.getItem(DENSITY_KEYS[device]);
  } catch {
    return null;
  }
}

function writePreference(device: HerdrJumpDevice, density: HerdrJumpDensity) {
  try {
    localStorage.setItem(DENSITY_KEYS[device], density);
  } catch {
    // The device-specific default remains usable when storage is unavailable.
  }
}

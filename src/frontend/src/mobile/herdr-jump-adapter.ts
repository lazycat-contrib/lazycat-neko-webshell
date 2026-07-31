import type { HerdrJumpPlatform } from "../herdr-jump-platform.ts";
import { bindHerdrJumpSheetGesture } from "./herdr-jump-sheet.ts";

type HerdrJumpMobileAdapterDeps = {
  menu: HTMLElement;
  switcher: HTMLElement;
  onRequestClose: (fromHistory: boolean) => void;
};

const MOBILE_QUERY = "(max-width: 760px), (pointer: coarse), (any-pointer: coarse)";
const HISTORY_KEY = "lazycatHerdrJump";

export function createHerdrJumpMobileAdapter(deps: HerdrJumpMobileAdapterDeps): HerdrJumpPlatform {
  const mobileQuery = window.matchMedia(MOBILE_QUERY);
  let historyEntryActive = false;
  let programmaticBackPending = false;
  let deviceChangeHandler: (() => void) | undefined;

  const isMobile = () => mobileQuery.matches;
  const scrim = () => deps.switcher.querySelector<HTMLElement>(".herdr-jump-scrim");

  const handlePopState = () => {
    if (programmaticBackPending) {
      programmaticBackPending = false;
      if (historyEntryActive) pushHistoryEntry();
      return;
    }
    if (!historyEntryActive) return;
    historyEntryActive = false;
    deps.onRequestClose(true);
  };
  const handleDeviceChange = () => deviceChangeHandler?.();
  const unbindGesture = bindHerdrJumpSheetGesture({
    sheet: deps.menu,
    isMobile,
    close: () => deps.onRequestClose(false),
  });

  window.addEventListener("popstate", handlePopState);
  mobileQuery.addEventListener("change", handleDeviceChange);

  function pushHistoryEntry(): boolean {
    try {
      window.history.pushState({ ...window.history.state, [HISTORY_KEY]: true }, "");
      return true;
    } catch {
      return false;
    }
  }

  return {
    device: () => isMobile() ? "mobile" : "desktop",
    isMobile,
    onOpen() {
      scrim()?.toggleAttribute("hidden", !isMobile());
      if (!isMobile() || historyEntryActive) return;
      historyEntryActive = pushHistoryEntry();
    },
    onClose(fromHistory) {
      scrim()?.setAttribute("hidden", "");
      if (!historyEntryActive) return;
      historyEntryActive = false;
      if (!fromHistory) {
        try {
          programmaticBackPending = true;
          window.history.back();
        } catch {
          programmaticBackPending = false;
          // The visual sheet is already closed, even if browser history is unavailable.
        }
      }
    },
    onDeviceChange(handler) {
      deviceChangeHandler = handler;
    },
    destroy() {
      unbindGesture();
      window.removeEventListener("popstate", handlePopState);
      mobileQuery.removeEventListener("change", handleDeviceChange);
      deviceChangeHandler = undefined;
    },
  };
}

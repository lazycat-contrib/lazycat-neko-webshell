import type { TerminalPane } from "../types.ts";
import {
  createMobileTerminalGestureController,
  type MobileTerminalGesture,
} from "./terminal-gestures.ts";

export type MobileTerminalInteractionControllerOptions = {
  activePane: () => TerminalPane | undefined;
  activateAdjacentTab: (direction: 1 | -1) => void;
  dismissKeyboardAfterGesture: (pane: TerminalPane) => void;
  findPaneById: (paneId: string) => TerminalPane | undefined;
  restoreKeyboard: () => void;
  showKeyboard: (pane: TerminalPane) => void;
};

type PointerCoordinates = Event & {
  clientX?: number;
  clientY?: number;
};

export function createMobileTerminalInteractionController(
  options: MobileTerminalInteractionControllerOptions,
) {
  const gestures = createMobileTerminalGestureController({
    activateAdjacentTab: options.activateAdjacentTab,
  });

  const handleGestureEnd = (
    paneId: string,
    event: Event,
    gesture: MobileTerminalGesture,
    cancelled: boolean,
  ) => {
    const current = options.findPaneById(paneId);
    if (!current) return;
    if (!cancelled && gestures.runSwipe(gesture)) {
      gestures.clearTap();
      event.preventDefault();
      options.dismissKeyboardAfterGesture(options.activePane() ?? current);
      return;
    }
    if (cancelled || !gestures.isTapGesture(gesture)) {
      gestures.clearTap();
      options.dismissKeyboardAfterGesture(current);
      return;
    }
    const pointer = event as PointerCoordinates;
    if (gestures.isDoubleTap(current.id, {
      clientX: pointer.clientX ?? 0,
      clientY: pointer.clientY ?? 0,
    })) {
      event.preventDefault();
      options.showKeyboard(current);
      return;
    }
    options.restoreKeyboard();
  };

  return { handleGestureEnd };
}

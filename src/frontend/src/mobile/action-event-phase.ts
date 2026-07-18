export function mobileActionEventPhase(action: string): "pointerdown" | "click" {
  return action === "pane-menu" ? "click" : "pointerdown";
}

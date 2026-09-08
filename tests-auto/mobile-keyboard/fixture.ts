import { createMobileKeyboardController } from "../../src/frontend/src/mobile/keyboard-controller";
const root = document.querySelector<HTMLElement>("#keyboard")!;
const events: Array<{ kind: string; value: string; active: boolean; phase: string; releaseTask: boolean }> = [];
let phase = "";
let releaseTask = false;
window.addEventListener("pointerup", () => { releaseTask = true; setTimeout(() => { releaseTask = false; }, 0); }, true);
for (const type of ["pointerdown", "pointerup", "click"]) window.addEventListener(type, () => { phase = type; }, true);
function record(kind: string, value: string) {
  events.push({ kind, value, active: navigator.userActivation.isActive, phase, releaseTask });
  document.querySelector("#state")!.textContent = JSON.stringify(events, null, 2);
}
const controller = createMobileKeyboardController({ root,
  preserveSystemKeyboardState: () => () => {},
  onKeyInput: value => record("key", value), onPasteShortcut: async () => record("paste", ""),
  onAction: async value => record("action", value), onPhrase: async value => record("phrase", value),
});
controller.bind();
Object.assign(window, { keyboardProbe: {
  events: () => [...events],
  clear: () => { events.length = 0; document.querySelector("#state")!.textContent = "No input"; },
  point: (selector: string) => {
    const button = root.querySelector<HTMLElement>(selector)!;
    button.scrollIntoView({ block: "nearest", inline: "center" });
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  },
  scrollDuringNextHold: () => root.addEventListener("pointerdown", () => {
    setTimeout(() => { root.querySelector<HTMLElement>(".keys")!.scrollLeft += 35; }, 50);
  }, { once: true }),
  dispose: () => controller.dispose?.(),
} });

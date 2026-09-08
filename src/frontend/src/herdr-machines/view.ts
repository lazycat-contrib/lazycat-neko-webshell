import type { ResttyFontInput } from "restty";
import type { MessageKey } from "../i18n.ts";
import { fetchSshConfigHosts } from "../ssh-backend/api.ts";
import { requestMachines } from "./api.ts";
import { createMachineController } from "./controller.ts";
import type { MachineState, MachineTarget } from "./model.ts";
import { renderMachineDialog } from "./view-render.ts";
import { startMachineTerminal } from "./terminal.ts";
import "./view.css";

export function createHerdrMachines(options: {
  target: () => MachineTarget | undefined;
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
  prepare: () => void;
  updateIcons: () => void;
  terminalOptions: () => { fonts: ResttyFontInput[]; fontSize: number };
}) {
  let dialog: HTMLDialogElement | undefined;
  let previousScreen: MachineState["screen"] | undefined;
  let returnFocus: HTMLElement | undefined;
  let focusKey = "";
  let setup: ReturnType<typeof startMachineTerminal> | undefined;
  const controller = createMachineController({
    target: options.target, tr: options.tr,
    request: (target, action) => requestMachines(target.selector, action),
    hosts: (target) => fetchSshConfigHosts(target.selector),
    changed: present,
    close,
    setup: (target, action, done) => {
      const mount = dialog?.querySelector<HTMLElement>("[data-machine-terminal]");
      if (!mount) throw new Error(options.tr("machines.setupFailed"));
      setup = startMachineTerminal({ mount, target, action, done, ...options.terminalOptions() });
      return () => { setup?.stop(); setup = undefined; };
    },
  });
  function present(state: MachineState) {
    if (!dialog) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      options.prepare();
      dialog = document.createElement("dialog");
      dialog.className = "herdr-console-dialog herdr-machines-dialog";
      dialog.setAttribute("aria-labelledby", "herdr-machines-title");
      dialog.tabIndex = -1;
      dialog.addEventListener("cancel", event => { event.preventDefault(); controller.dismiss(); });
      dialog.addEventListener("keydown", event => {
        const inTerminal = event.target instanceof Element && event.target.closest("[data-machine-terminal]");
        if (inTerminal && event.shiftKey && event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          dialog?.querySelector<HTMLButtonElement>('[data-machine-action="close"]')?.focus();
        } else if (!inTerminal) event.stopPropagation();
      });
      dialog.addEventListener("click", click);
      dialog.addEventListener("input", input);
      dialog.addEventListener("change", change);
      dialog.addEventListener("submit", event => { event.preventDefault(); controller.submit(); });
      document.body.append(dialog);
    }
    const focused = document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)
      ? document.activeElement : undefined;
    if (state.screen !== previousScreen) focusKey = "";
    else if (focused?.matches("input, select, button")) focusKey = controlKey(focused);
    const selection = focused instanceof HTMLInputElement && ["text", "search"].includes(focused.type)
      ? [focused.selectionStart, focused.selectionEnd] : undefined;
    if (state.screen === "setup" && previousScreen === "setup") {
      const status = dialog.querySelector<HTMLElement>("[data-machine-message]")!;
      status.textContent = state.message; status.dataset.error = String(state.error);
      dialog.querySelector<HTMLElement>(".machine-body")?.setAttribute("aria-busy", String(state.busy));
      const back = dialog.querySelector<HTMLButtonElement>('[data-machine-action="back"]')!;
      back.textContent = options.tr(state.setupFinished ? "machines.back" : "machines.cancelSetup");
    } else {
      dialog.innerHTML = renderMachineDialog(state, options.tr);
      options.updateIcons();
    }
    if (!dialog.open) dialog.showModal();
    if (focusKey && state.screen === previousScreen) {
      const next = Array.from(dialog.querySelectorAll<HTMLElement>("input, select, button")).find(control => controlKey(control) === focusKey);
      if (next && !next.matches(":disabled") && !next.closest("[hidden]")) {
        next.focus({ preventScroll: true });
        if (selection && next instanceof HTMLInputElement) next.setSelectionRange(selection[0], selection[1]);
      } else dialog.focus({ preventScroll: true });
    } else if (state.screen !== previousScreen && state.screen !== "setup") {
      const first = state.screen === "rename" ? dialog.querySelector<HTMLInputElement>('input[name="label"]')
        : previousScreen === "setup" && state.screen === "add" ? dialog.querySelector<HTMLElement>('[form="machine-form"]')
        : dialog.querySelector<HTMLElement>("button, input, select");
      first?.focus({ preventScroll: true });
      if (state.screen === "rename" && first instanceof HTMLInputElement) first.select();
    }
    previousScreen = state.screen;
  }
  function controlKey(control: HTMLElement): string {
    return [control.tagName, control.getAttribute("name"), control.dataset.machineAction, control.dataset.machineSource,
      control.closest<HTMLElement>("[data-machine-id]")?.dataset.machineId].join("|");
  }
  function close() {
    setup?.stop(); setup = undefined;
    dialog?.close(); dialog?.remove(); dialog = undefined; previousScreen = undefined;
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    returnFocus = undefined;
  }
  function click(event: MouseEvent) {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-machine-action], [data-machine-source]") : null;
    if (!button || button.disabled) return;
    const source = button.dataset.machineSource;
    if (source === "config" || source === "manual") { controller.source(source); return; }
    const action = button.dataset.machineAction;
    const id = button.closest<HTMLElement>("[data-machine-id]")?.dataset.machineId ?? "";
    if (action === "close") controller.dismiss();
    if (action === "refresh") void controller.refresh();
    if (action === "add") void controller.add();
    if (action === "back") controller.back();
    if (action === "rename" || action === "remove") controller.edit(id, action === "remove");
    if (action === "toggle") controller.toggle(id);
    if (action === "test") controller.test();
    if (action === "keyboard") setup?.focus();
  }
  function input(event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const { name, value } = event.target;
    if (name === "machine-query") controller.setQuery(value);
    if (name === "target" || name === "label" || name === "session") {
      const form = controller.setForm(name, value);
      if (name === "target" && form) {
        const label = dialog?.querySelector<HTMLInputElement>('input[name="label"]');
        if (label) label.value = form.label;
      }
      const status = dialog?.querySelector<HTMLElement>("[data-machine-message]");
      if (status) status.textContent = "";
    }
  }
  function change(event: Event) {
    if (!(event.target instanceof HTMLSelectElement) || event.target.name !== "machine-host" || !dialog) return;
    const target = event.target.value;
    controller.setForm("target", target);
    const status = dialog.querySelector<HTMLElement>("[data-machine-message]");
    if (status) status.textContent = "";
    const manual = dialog.querySelector<HTMLElement>("[data-machine-manual]")!;
    manual.hidden = Boolean(target);
    const targetInput = dialog.querySelector<HTMLInputElement>('input[name="target"]')!;
    const labelInput = dialog.querySelector<HTMLInputElement>('input[name="label"]')!;
    if (labelInput.value === targetInput.value || !labelInput.value) labelInput.value = target;
    targetInput.value = target;
    if (!target) targetInput.focus();
  }
  return { open: controller.open, dismiss: controller.dismiss, sync: controller.sync,
    ownsEvent: (event: Event) => Boolean(dialog && event.target instanceof Node && dialog.contains(event.target)),
  };
}

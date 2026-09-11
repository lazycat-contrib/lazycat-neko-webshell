import type { Client } from "@connectrpc/connect";
import type { CapabilityService } from "../../gen/lazycat/webshell/v1/capability_pb";
import { legacyCopyText, writeSystemClipboardText } from "../../browser-clipboard";
import type { TerminalPane, Tone } from "../../types";
import { invokeFileTransferWithConnect } from "./connect-upload";
import { createSecretFileView, secretElement as element, type SecretTranslate } from "./secret-file-view";
import {
  secretFilePathIsValid, secretFilePayload, secretFileShortcutMatches, secretFileTargetIsCurrent,
  type SecretFileResult, type SecretFileShortcut, type SecretFileTarget,
} from "./secret-file-state.ts";

type Deps = {
  client: Client<typeof CapabilityService>;
  activePane: () => TerminalPane | undefined;
  generation: () => number;
  enabled: () => boolean;
  canWrite: (pane: TerminalPane) => boolean;
  prepare: () => void;
  paste: (pane: TerminalPane, text: string) => Promise<boolean> | boolean;
  focus: (pane: TerminalPane) => void;
  shortcut: () => SecretFileShortcut;
  setShortcut: (shortcut: SecretFileShortcut) => void;
  tr: SecretTranslate;
  status: (message: string, tone?: Tone) => void;
};

export function createSecretFileController(deps: Deps) {
  let view: ReturnType<typeof createSecretFileView> | undefined;
  let target: SecretFileTarget | undefined;
  let current: SecretFileResult | undefined;
  let busy = false;
  let reading = false;
  let epoch = 0;
  let restoreFocus: HTMLElement | undefined;
  const files = new Map<string, SecretFileResult[]>();
  const key = (target: SecretFileTarget) => JSON.stringify([target.selector, target.sessionId]);
  const isCurrent = (target: SecretFileTarget) => secretFileTargetIsCurrent(target, deps.activePane(), deps.generation());
  const writable = (target: SecretFileTarget) => isCurrent(target) && deps.enabled()
    && target.pane.connectionState === "connected" && !target.pane.replaying && deps.canWrite(target.pane);
  const message = (key: Parameters<SecretTranslate>[0]) => { if (view) view.status.textContent = deps.tr(key); };

  function close() {
    epoch++;
    if (reading) { reading = false; busy = false; }
    // A pending create continues for its captured target and retains only its returned path.
    view?.dialog.close();
    const input = view?.content.querySelector("textarea");
    if (input) input.value = "";
    restoreFocus?.focus({ preventScroll: true });
  }

  function rows(...buttons: HTMLButtonElement[]) {
    const row = element("div", "", "secret-file-actions");
    row.append(...buttons);
    return row;
  }

  function showResult() {
    if (!view || !current) return;
    const result = current;
    view.content.replaceChildren();
    const history = files.get(key(result.target)) ?? [];
    if (history.length > 1) {
      const select = element("select");
      select.setAttribute("aria-label", deps.tr("secret.files"));
      for (const file of history) {
        const option = element("option", file.path.split("/").at(-1));
        option.value = file.path;
        select.append(option);
      }
      select.value = result.path;
      select.onchange = () => { current = history.find(file => file.path === select.value); showResult(); };
      view.content.append(select);
    }
    const path = element("code", result.path, "secret-file-path");
    path.tabIndex = 0;
    view.content.append(path, element("p", deps.tr("secret.permissions"), "secret-file-help"));
    const insert = view.button("secret.insert", () => void insertPath(result), true);
    insert.disabled = !writable(result.target);
    if (insert.disabled) view.content.append(element("p", deps.tr("secret.targetChanged"), "secret-file-help"));
    const copy = view.button("secret.copy", () => {
      copy.disabled = true;
      void writeSystemClipboardText(result.path, {
        isCurrent: () => current === result && Boolean(view?.dialog.open),
        fallbackCopy: text => Boolean(view?.dialog.open) && legacyCopyText(text, document, view!.dialog),
      }).then(() => {
        if (current === result && view?.dialog.open) message("secret.copied");
      }).catch(() => {
        if (current === result && view?.dialog.open) message("secret.copyFailed");
      }).finally(() => { copy.disabled = false; });
    });
    view.content.append(rows(insert, copy), element("p", deps.tr("secret.cleanupHint"), "secret-file-help"), element("p", deps.tr("secret.aiHint"), "secret-file-help"));
    const remove = view.button("secret.delete", () => void deleteFile(result));
    const another = view.button("secret.another", () => void readClipboard());
    view.content.append(rows(another, remove));
  }

  async function insertPath(result: SecretFileResult) {
    if (busy || !writable(result.target)) { message("secret.targetChanged"); return; }
    busy = true;
    try {
      // Generated paths use a restricted shell-safe alphabet. No newline or secret body.
      if (!await deps.paste(result.target.pane, result.path)) { message("secret.insertFailed"); return; }
      if (current === result && view?.dialog.open) {
        close();
        if (isCurrent(result.target)) deps.focus(result.target.pane);
        deps.status(deps.tr("secret.inserted"), "ok");
      }
    } catch { message("secret.insertFailed"); }
    finally { busy = false; }
  }

  async function deleteFile(result: SecretFileResult) {
    if (busy) return;
    busy = true;
    message("secret.deleting");
    const version = epoch;
    try {
      await invokeFileTransferWithConnect(deps.client, result.target.sessionId, "secret_delete", { selector: result.target.selector, path: result.path });
      const remaining = (files.get(key(result.target)) ?? []).filter(file => file !== result);
      files.set(key(result.target), remaining);
      if (version !== epoch || !view?.dialog.open) return;
      current = remaining.at(-1);
      if (current) showResult();
      else view.content.replaceChildren(element("p", deps.tr("secret.deleted")), rows(view.button("secret.another", () => void readClipboard(), true)));
      message("secret.deleted");
    } catch { if (version === epoch) message("secret.deleteFailed"); }
    finally { busy = false; }
  }

  function manualInput() {
    if (!view) return;
    view.content.replaceChildren();
    const label = element("label", deps.tr("secret.manual"));
    const input = element("textarea", "", "secret-file-input");
    input.id = "secret-file-input";
    label.htmlFor = input.id;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-describedby", "secret-file-manual-hint");
    const hint = element("p", deps.tr("secret.manualHint"), "secret-file-help");
    hint.id = "secret-file-manual-hint";
    view.content.append(label, input, hint, rows(view.button("secret.generate", () => {
      const payload = secretFilePayload(input.value);
      if (!payload) { message("secret.invalidText"); return; }
      input.value = "";
      void createFile(payload);
    }, true)));
    // Explicit user focus only: opening the fallback must not summon a phone keyboard.
  }

  async function readClipboard() {
    if (busy || !target || !view) return;
    if (!writable(target)) { message("secret.targetChanged"); return; }
    busy = true;
    const version = epoch;
    reading = true;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    // Start within the click/keyboard gesture, before rendering or awaiting anything.
    let promise: Promise<string>;
    try { promise = navigator.clipboard?.readText() ?? Promise.reject(new Error("unavailable")); }
    catch { promise = Promise.reject(new Error("unavailable")); }
    message("secret.reading");
    try {
      const value = await Promise.race([
        promise,
        new Promise<never>((_, reject) => { readTimer = setTimeout(() => reject(new Error("clipboard timeout")), 3000); }),
      ]);
      const payload = secretFilePayload(value);
      if (version !== epoch || !view.dialog.open) return;
      busy = false;
      reading = false;
      if (!payload) { manualInput(); message("secret.invalidText"); return; }
      await createFile(payload);
    } catch {
      if (version === epoch && view.dialog.open) { manualInput(); message("secret.permission"); }
    } finally {
      clearTimeout(readTimer);
      if (version === epoch) { reading = false; busy = false; }
    }
  }

  async function createFile(payload: Uint8Array<ArrayBuffer>) {
    if (busy || !target || !view || !writable(target)) { payload.fill(0); message("secret.targetChanged"); return; }
    const captured = target;
    const version = epoch;
    busy = true;
    current = undefined;
    view.content.replaceChildren(element("p", deps.tr("secret.saving")));
    message("secret.bodyPrivate");
    try {
      const response = await invokeFileTransferWithConnect(deps.client, captured.sessionId, "secret_create", { selector: captured.selector }, payload, "text/plain;charset=utf-8");
      if (response.status !== "complete" || !secretFilePathIsValid(response.meta.path)) throw new Error("invalid response");
      const result = { path: response.meta.path, target: captured };
      files.set(key(captured), [...(files.get(key(captured)) ?? []), result]);
      if (version !== epoch || !view.dialog.open) { deps.status(deps.tr("secret.savedClosed"), "ok"); return; }
      current = result;
      showResult();
      message("secret.created");
    } catch {
      if (version === epoch && view.dialog.open) {
        view.content.replaceChildren(rows(view.button("secret.retry", () => void readClipboard(), true), view.button("secret.manual", manualInput)));
        message("secret.failed");
      }
    } finally { payload.fill(0); busy = false; }
  }

  function open(pane = deps.activePane(), instant = false) {
    if (busy) { deps.status(deps.tr("secret.saving")); return; }
    if (!deps.enabled() || !pane?.sessionId || pane.closing || pane.exited) { deps.status(deps.tr("secret.unavailable"), "error"); return; }
    if (view?.dialog.open) return;
    target = { pane, sessionId: pane.sessionId, selector: pane.selector, generation: deps.generation() };
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    deps.prepare();
    // Recreate to pick up locale changes and discard any residual textarea contents.
    view?.destroy();
    view = createSecretFileView(deps.tr, close, deps.setShortcut);
    view.select.value = deps.shortcut();
    view.dialog.dataset.instant = String(instant);
    view.target.textContent = deps.tr("secret.target", { target: pane.selector });
    view.dialog.showModal();
    view.syncViewport();
    // Reopening explicitly reauthorizes this unchanged selector/session for the
    // current pane generation. In-flight operations keep their original target.
    const history = files.get(key(target));
    if (history) for (const result of history) result.target = { ...target };
    current = history?.at(-1);
    if (current) showResult();
    else void readClipboard();
  }

  function handleShortcut(event: KeyboardEvent, pane: TerminalPane | undefined): boolean {
    if (!pane || event.defaultPrevented) return false;
    // Firefox may report AltGraph for an ordinary Ctrl+Alt chord. Only reject
    // it when that chord is producing a different printable character.
    if (event.getModifierState?.("AltGraph") && event.key.toLowerCase() !== event.code.slice(3).toLowerCase()) return false;
    if (!secretFileShortcutMatches(event, deps.shortcut(), /Mac|iPhone|iPad|iPod/i.test(navigator.platform))) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    open(pane, true);
    return true;
  }

  return { open, handleShortcut, ownsEvent: (event: Event) => event.target instanceof Node && Boolean(view?.dialog.contains(event.target)) };
}

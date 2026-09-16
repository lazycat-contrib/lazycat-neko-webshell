import type { MessageKey } from "../../i18n.ts";
import type { MobileInputTarget } from "../input-target.ts";
import { MobileComposerModel } from "./model.ts";
import { createMobileComposerView } from "./view.ts";

type Options = {
  target: () => MobileInputTarget | undefined;
  isCurrent: (target: MobileInputTarget) => boolean;
  send: (target: MobileInputTarget, text: string, enter: boolean) => Promise<boolean>;
  prepare: () => void;
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
};

export function createMobileComposer(options: Options) {
  const model = new MobileComposerModel();
  let view: ReturnType<typeof createMobileComposerView> | undefined;
  let captured: MobileInputTarget | undefined;
  let restoreFocus: HTMLElement | undefined;
  let busy = false;
  let disposed = false;

  function ensureView() {
    if (view) return view;
    view = createMobileComposerView(options.tr, {
      close,
      discard,
      submit: (enter) => void submit(enter),
      input: updateDraft,
    });
    return view;
  }

  function message(key?: MessageKey) {
    if (view) view.status.textContent = key ? options.tr(key) : "";
  }

  function failureMessage(error?: unknown) {
    if (!view) return;
    view.status.textContent = error instanceof Error && error.message
      ? error.message
      : options.tr("mobileComposer.failed");
  }

  function open() {
    if (disposed) return;
    const next = options.target();
    if (view?.dialog.open) close(false);
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    options.prepare();
    const currentView = ensureView();
    captured = next;
    busy = false;
    currentView.setBusy(false);
    currentView.setAvailable(Boolean(next));
    currentView.target.textContent = next?.label ?? "";
    currentView.textarea.value = next ? model.open(next.key) : "";
    message(next ? undefined : "mobileComposer.unavailable");
    currentView.dialog.showModal();
    currentView.syncViewport();
    if (next) currentView.textarea.focus({ preventScroll: true });
    else currentView.close.focus({ preventScroll: true });
  }

  function close(restore = true) {
    if (!view?.dialog.open) return;
    model.close();
    captured = undefined;
    busy = false;
    view.dialog.close();
    if (restore && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    restoreFocus = undefined;
  }

  function updateDraft() {
    if (!view || !captured || busy) return;
    const previous = model.draft(captured.key);
    const selection = view.textarea.selectionStart;
    const update = model.update(view.textarea.value);
    if (update.ok) {
      message();
      return;
    }
    view.textarea.value = previous;
    const cursor = Math.min(selection ?? previous.length, previous.length);
    view.textarea.setSelectionRange(cursor, cursor);
    message("mobileComposer.tooLarge");
  }

  function discard() {
    if (!view || busy) return;
    model.discard();
    view.textarea.value = "";
    close();
  }

  async function submit(enter: boolean) {
    if (!view || busy || !captured) {
      if (view && !captured) message("mobileComposer.unavailable");
      return;
    }
    const submission = model.beginSubmission();
    if (!submission) {
      message("mobileComposer.empty");
      view.textarea.focus({ preventScroll: true });
      return;
    }
    if (!options.isCurrent(captured)) {
      message("mobileComposer.unavailable");
      return;
    }

    const target = captured;
    busy = true;
    view.setBusy(true);
    message("mobileComposer.sending");
    let succeeded = false;
    let failure: unknown;
    try {
      succeeded = await options.send(target, submission.text, enter);
    } catch (error) {
      failure = error;
      succeeded = false;
    }
    const completion = model.completeSubmission(submission, succeeded);
    if (!completion.ownsView || captured !== target || !view.dialog.open) return;
    busy = false;
    view.setBusy(false);
    if (succeeded) close();
    else {
      failureMessage(failure);
      view.textarea.focus({ preventScroll: true });
    }
  }

  function sync() {
    if (!view?.dialog.open || !captured) return;
    if (!options.isCurrent(captured)) close();
  }

  function ownsEvent(event: Event): boolean {
    return Boolean(view?.dialog.open && event.target instanceof Node && view.dialog.contains(event.target));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    close(false);
    view?.destroy();
    view = undefined;
  }

  return {
    open,
    close: () => close(),
    sync,
    isOpen: () => Boolean(view?.dialog.open),
    ownsEvent,
    dispose,
  };
}

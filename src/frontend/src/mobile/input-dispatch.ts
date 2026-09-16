import type { TerminalPane } from "../types.ts";
import type { MobileInputTarget } from "./input-target.ts";

/** Track only terminal mode state and a short incomplete escape sequence. */
export function createMobileInputDispatch(options: {
  isCurrent: (target: MobileInputTarget) => boolean;
  canWrite: (pane: TerminalPane) => boolean;
  sendBytes: (pane: TerminalPane, text: string) => boolean;
  ensureHerdr: (pane: TerminalPane) => Promise<string>;
  currentHerdrPane: (selector: string) => Promise<string>;
  sendHerdrInput: (selector: string, paneId: string, text: string, enter: boolean) => Promise<void>;
  multilineError: () => string;
}) {
  const modes = new WeakMap<TerminalPane, { bracketed: boolean; tail: string; sessionId?: string; socket?: WebSocket }>();
  const writable = (target: MobileInputTarget) => options.isCurrent(target)
    && target.pane.connectionState === "connected" && !target.pane.replaying
    && !target.pane.workspaceRefreshPending && options.canWrite(target.pane);

  function observe(pane: TerminalPane, text: string) {
    const previous = modes.get(pane);
    const state = previous?.sessionId === pane.sessionId && previous?.socket === pane.socket
      ? previous ?? { bracketed: false, tail: "", sessionId: pane.sessionId, socket: pane.socket }
      : { bracketed: false, tail: "", sessionId: pane.sessionId, socket: pane.socket };
    const output = state.tail + text;
    const pattern = /\x1b\[\?([\d;]+)([hl])|\x1bc/g;
    for (const match of output.matchAll(pattern)) {
      if (match[0] === "\x1bc") state.bracketed = false;
      else if (match[1].split(";").includes("2004")) state.bracketed = match[2] === "h";
    }
    const lastEscape = output.lastIndexOf("\x1b");
    const tail = lastEscape >= 0 ? output.slice(lastEscape) : "";
    state.tail = tail.length < 32 && /^\x1b(?:\[(?:\?[\d;]*)?)?$/.test(tail) ? tail : "";
    modes.set(pane, state);
  }

  async function send(target: MobileInputTarget, text: string, enter: boolean): Promise<boolean> {
    if (!text || !writable(target)) return false;
    if (target.herdrPaneId) {
      // The outer Herdr terminal's mode does not establish the inner pane's
      // paste mode. The allowlisted API exposes no verified inner-mode flag.
      if (!enter && /[\r\n]/.test(text)) throw new Error(options.multilineError());
      const selector = await options.ensureHerdr(target.pane);
      if (!writable(target) || selector !== target.selector) return false;
      const remotePane = await options.currentHerdrPane(selector);
      if (!writable(target) || remotePane !== target.herdrPaneId) return false;
      await options.sendHerdrInput(selector, target.herdrPaneId, text.replace(/\x1b/g, ""), enter);
      return true;
    }
    // Prevent pasted escape controls from terminating a bracketed-paste envelope.
    const cleaned = text.replace(/\x1b/g, "");
    const mode = modes.get(target.pane);
    const bracketed = Boolean(mode?.bracketed && mode.sessionId === target.sessionId && mode.socket === target.pane.socket);
    if (!enter && /[\r\n]/.test(cleaned) && !bracketed) throw new Error(options.multilineError());
    const payload = bracketed ? `\x1b[200~${cleaned}\x1b[201~` : cleaned;
    return options.sendBytes(target.pane, enter ? `${payload}\r` : payload);
  }

  return { send, observe, writable };
}

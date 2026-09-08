import type { PtyCallbacks, PtyTransport, ResttyFontInput, ResttyRuntimeEvent } from "restty";
import { createPaneTerminal } from "../terminal-options.ts";
import { machineUrl } from "./api.ts";
import type { MachineSetup, MachineTarget } from "./model.ts";

export function startMachineTerminal(options: {
  mount: HTMLElement; target: MachineTarget; action: MachineSetup;
  fonts: ResttyFontInput[]; fontSize: number;
  done: (code: number, message?: string) => void;
}) {
  let stopped = false, completed = false;
  let socket: WebSocket | undefined;
  let callbacks: PtyCallbacks | undefined;
  const decoder = new TextDecoder();
  const send = (value: unknown): boolean => {
    if (stopped || completed || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(value)); return true;
  };
  const finish = (code: number, message?: string) => {
    if (stopped || completed) return;
    completed = true; socket?.close(); callbacks?.onExit?.(code);
    options.done(code, message);
  };
  const transport: PtyTransport = {
    connect: connection => {
      if (stopped || completed || socket) return;
      callbacks = connection.callbacks;
      socket = new WebSocket(machineUrl(options.target.selector, true));
      socket.addEventListener("open", () => {
        if (stopped) { socket?.close(); return; }
        socket!.send(JSON.stringify(options.action));
        callbacks?.onConnect?.();
        send({ type: "resize", cols: connection.cols || 80, rows: connection.rows || 24 });
        terminal.focus();
      });
      socket.addEventListener("message", event => {
        if (stopped || completed) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 16 * 1024) throw new Error("Invalid setup response");
          const message = JSON.parse(event.data);
          if (message.type === "output" && typeof message.data === "string") {
            callbacks?.onData?.(decoder.decode(Uint8Array.from(atob(message.data), char => char.charCodeAt(0)), { stream: true }));
          } else if (message.type === "exit" && Number.isInteger(message.code)) {
            const tail = decoder.decode(); if (tail) callbacks?.onData?.(tail);
            finish(message.code, typeof message.message === "string" ? message.message : undefined);
          } else throw new Error("Invalid setup message");
        } catch (error) { finish(1, error instanceof Error ? error.message : String(error)); }
      });
      socket.addEventListener("error", () => finish(1));
      socket.addEventListener("close", () => finish(1));
    },
    disconnect: () => socket?.close(),
    sendInput: data => send({ type: "input", data }),
    resize: (cols, rows) => send({ type: "resize", cols, rows }),
    isConnected: () => !stopped && !completed && socket?.readyState === WebSocket.OPEN,
  };
  const terminal = createPaneTerminal({
    cols: 80, rows: 24, fonts: options.fonts, fontSize: options.fontSize,
    fontLigatures: false, fontHinting: true, fontHintTarget: "normal", scrollbackLimit: 2000,
    touchSelectionMode: "long-press", transport,
    // Prevent local echo before/after SSH; password echo is controlled by its PTY.
    beforeInput: ({ text }) => transport.isConnected() ? text : "",
    contextMenuItems: () => [], searchClearButtonText: "", searchPlaceholder: "",
    onDomReady: () => {}, onGridSize: (cols, rows) => transport.resize(cols, rows),
  });
  terminal.open(options.mount);
  const pane = terminal.restty?.getPanes()[0];
  if (!pane) { terminal.dispose(); throw new Error("Could not create setup terminal"); }
  const connect = () => { if (!stopped && !completed) { pane.runtime.interaction.updateSize(true); pane.runtime.io.connectPty(""); } };
  const unsubscribe = pane.runtime.events.subscribe((event: ResttyRuntimeEvent) => {
    if (event.type === "state" && event.state === "ready") connect();
    if (event.type === "state" && event.state === "failed") finish(1);
  });
  if (pane.runtime.lifecycle.state() === "ready") connect();
  const timeout = window.setTimeout(() => { if (!socket) finish(1, "Terminal initialization timed out"); }, 15000);
  return {
    focus: () => terminal.focus(),
    stop: () => { stopped = true; clearTimeout(timeout); unsubscribe(); socket?.close(); terminal.dispose(); },
  };
}

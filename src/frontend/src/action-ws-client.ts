export type ActionMessageType = "ai" | "transfer" | "ping";
export type ActionResponseType = "stream" | "done" | "error" | "transfer_progress";

export type ActionResponseMeta = Record<string, unknown>;

export type ActionDone = {
  id: string;
  meta?: ActionResponseMeta;
};

type ActionCallbacks = {
  onStream?: (chunk: string) => void;
  onProgress?: (meta: ActionResponseMeta) => void;
};

type PendingAction = ActionCallbacks & {
  resolve: (done: ActionDone) => void;
  reject: (error: Error) => void;
};

type ActionResponse = {
  id: string;
  type: ActionResponseType;
  content?: string;
  meta?: ActionResponseMeta;
};

const UPLOAD_CHUNK_BYTES = 64 * 1024;

export class TerminalActionWSClient {
  private ws?: WebSocket;
  private openPromise?: Promise<void>;
  private readonly pending = new Map<string, PendingAction>();

  constructor(private readonly endpoint = "./ws/action") {}

  async send(
    type: ActionMessageType,
    action: string,
    payload: Record<string, unknown> = {},
    callbacks: ActionCallbacks = {},
  ): Promise<ActionDone> {
    const id = newActionId();
    await this.ensureOpen();
    const done = this.register(id, callbacks);
    this.sendMessage({ id, type, action, payload });
    return done;
  }

  async uploadFile(
    file: File,
    sessionId: string,
    remotePath: string,
    callbacks: ActionCallbacks = {},
  ): Promise<ActionDone> {
    const id = newActionId();
    await this.ensureOpen();
    const done = this.register(id, callbacks);
    this.sendMessage({
      id,
      type: "transfer",
      action: "upload_start",
      payload: {
        name: file.name,
        size: file.size,
        sessionId,
        remotePath,
      },
    });

    if (file.size === 0) {
      this.sendMessage({
        id,
        type: "transfer",
        action: "upload_chunk",
        payload: {
          data: "",
          offset: 0,
          final: true,
        },
      });
      return done;
    }

    let offset = 0;
    while (offset < file.size) {
      const nextOffset = Math.min(offset + UPLOAD_CHUNK_BYTES, file.size);
      const bytes = new Uint8Array(await file.slice(offset, nextOffset).arrayBuffer());
      this.sendMessage({
        id,
        type: "transfer",
        action: "upload_chunk",
        payload: {
          data: bytesToBase64(bytes),
          offset,
          final: nextOffset >= file.size,
        },
      });
      offset = nextOffset;
    }
    return done;
  }

  close() {
    this.ws?.close();
    this.ws = undefined;
    this.openPromise = undefined;
  }

  private register(id: string, callbacks: ActionCallbacks): Promise<ActionDone> {
    return new Promise<ActionDone>((resolve, reject) => {
      this.pending.set(id, { ...callbacks, resolve, reject });
    });
  }

  private async ensureOpen(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise<void>((resolve, reject) => {
      const url = new URL(this.endpoint, window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.openPromise = undefined;
        resolve();
      }, { once: true });
      ws.addEventListener("message", (event) => this.handleMessage(event));
      ws.addEventListener("error", () => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("action websocket failed to open"));
        }
      }, { once: true });
      ws.addEventListener("close", () => {
        if (this.ws === ws) {
          this.ws = undefined;
          this.openPromise = undefined;
        }
        this.rejectPending(new Error("action websocket closed"));
      });
    });

    return this.openPromise;
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    let response: ActionResponse;
    try {
      response = JSON.parse(event.data) as ActionResponse;
    } catch {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;

    if (response.type === "stream") {
      pending.onStream?.(response.content ?? "");
      return;
    }
    if (response.type === "transfer_progress") {
      pending.onProgress?.(response.meta ?? {});
      return;
    }
    this.pending.delete(response.id);
    if (response.type === "error") {
      pending.reject(new Error(response.content || "action failed"));
      return;
    }
    pending.resolve({ id: response.id, meta: response.meta });
  }

  private sendMessage(message: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("action websocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function newActionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

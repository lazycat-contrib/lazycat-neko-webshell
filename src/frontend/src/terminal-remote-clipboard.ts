const OSC_52_PREFIX = "\u001b]52;";
const OSC_BEL = "\u0007";
const OSC_ST = "\u001b\\";
const DEFAULT_MAX_CLIPBOARD_BYTES = 1_000_000;
const DEFAULT_CLIPBOARD_WRITE_TIMEOUT_MS = 5_000;

type ClipboardWriteRequest = {
  generation: number;
  text: string;
  isCurrent: () => boolean;
  onReconciliationError?: (error: unknown, text: string) => void;
  internal: boolean;
  resolve: (written: boolean) => void;
  reject: (error: unknown) => void;
};

type ClipboardWriteOutcome =
  | { kind: "written" }
  | { kind: "failed"; error: unknown }
  | { kind: "timed-out" };

export type TerminalRemoteClipboardBridge = {
  beforeRenderOutput: (text: string) => string;
  reset: () => void;
  settled: () => Promise<void>;
};

export function createSerializedTerminalRemoteClipboardWriter(
  writeText: (text: string, isCurrent: () => boolean) => Promise<void>,
  options: { operationTimeoutMs?: number } = {},
): (
  text: string,
  isCurrent?: () => boolean,
  onReconciliationError?: (error: unknown, text: string) => void,
) => Promise<boolean> {
  const operationTimeoutMs = Math.max(
    1,
    options.operationTimeoutMs ?? DEFAULT_CLIPBOARD_WRITE_TIMEOUT_MS,
  );
  let generation = 0;
  let latestRequest: ClipboardWriteRequest | undefined;
  let activeRequest: ClipboardWriteRequest | undefined;
  let pendingRequest: ClipboardWriteRequest | undefined;
  let reconciliationRequested = false;
  let reconciliationTask: Promise<void> | undefined;

  function scheduleLatestReconciliation() {
    reconciliationRequested = true;
    if (reconciliationTask) return;
    reconciliationTask = Promise.resolve()
      .then(reconcileLatestWrite)
      .finally(() => {
        reconciliationTask = undefined;
        if (reconciliationRequested) scheduleLatestReconciliation();
      });
  }

  async function reconcileLatestWrite() {
    while (reconciliationRequested) {
      reconciliationRequested = false;
      const request = latestRequest;
      if (!request?.isCurrent()) continue;
      if (
        activeRequest?.generation === request.generation
        || pendingRequest?.generation === request.generation
      ) continue;
      await enqueueWrite({
        generation: request.generation,
        text: request.text,
        isCurrent: request.isCurrent,
        onReconciliationError: request.onReconciliationError,
        internal: true,
      });
    }
  }

  function performWrite(
    request: ClipboardWriteRequest,
    finish: (outcome: ClipboardWriteOutcome) => void,
  ) {
    const mayWrite = () => request.isCurrent() && (
      latestRequest?.generation === request.generation
      || !latestRequest?.isCurrent()
    );
    const operation = Promise.resolve().then(() => writeText(request.text, mayWrite));
    operation.then(() => {
      if (
        latestRequest?.generation !== request.generation
        && latestRequest?.isCurrent()
      ) {
        scheduleLatestReconciliation();
      }
    }, () => {});

    const timeout = setTimeout(
      () => finish({ kind: "timed-out" }),
      operationTimeoutMs,
    );
    operation.then(
      () => {
        clearTimeout(timeout);
        finish({ kind: "written" });
      },
      (error) => {
        clearTimeout(timeout);
        finish({ kind: "failed", error });
      },
    );
  }

  function startWrite(request: ClipboardWriteRequest) {
    activeRequest = request;
    let finished = false;
    performWrite(request, (outcome) => {
      if (finished) return;
      finished = true;
      finishWrite(request, outcome);
    });
  }

  function finishWrite(request: ClipboardWriteRequest, outcome: ClipboardWriteOutcome) {
    if (activeRequest !== request) return;
    activeRequest = undefined;

    let next = pendingRequest;
    pendingRequest = undefined;
    if (next && !next.isCurrent()) {
      next.resolve(false);
      if (latestRequest === next) {
        latestRequest = request.isCurrent() ? request : undefined;
      }
      next = undefined;
    }

    const superseded = Boolean(next);
    const stillLatest = latestRequest?.generation === request.generation
      && request.isCurrent();
    if (request.internal) {
      const written = outcome.kind === "written" && !superseded && stillLatest;
      request.resolve(written);
      if (!superseded && stillLatest && outcome.kind !== "written") {
        const error = outcome.kind === "failed"
          ? outcome.error
          : new Error("system clipboard reconciliation timed out");
        request.onReconciliationError?.(error, request.text);
      }
    } else if (superseded || !request.isCurrent()) {
      request.resolve(false);
    } else {
      latestRequest = request;
      if (outcome.kind === "written") {
        request.resolve(true);
      } else if (outcome.kind === "failed") {
        request.reject(outcome.error);
      } else {
        request.reject(new Error("system clipboard write timed out"));
      }
    }

    if (next) {
      startWrite(next);
    } else if (latestRequest && !latestRequest.isCurrent()) {
      latestRequest = undefined;
    }
  }

  function enqueueWrite(requestOptions: Omit<
    ClipboardWriteRequest,
    "resolve" | "reject"
  >): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const request: ClipboardWriteRequest = { ...requestOptions, resolve, reject };
      if (!request.internal) latestRequest = request;
      if (!activeRequest) {
        startWrite(request);
        return;
      }
      pendingRequest?.resolve(false);
      pendingRequest = request;
    });
  }

  return (text, isCurrent = () => true, onReconciliationError) => {
    if (!isCurrent()) return Promise.resolve(false);
    return enqueueWrite({
      generation: ++generation,
      text,
      isCurrent,
      onReconciliationError,
      internal: false,
    });
  };
}

export function createTerminalRemoteClipboardSourceWriter(
  writeText: (
    text: string,
    isCurrent?: () => boolean,
    onReconciliationError?: (error: unknown, text: string) => void,
  ) => Promise<boolean>,
  enabled: () => boolean,
): {
  writeText: (
    text: string,
    onReconciliationError?: (error: unknown, text: string) => void,
  ) => Promise<boolean>;
  prepareWrite: (
    text: string,
    onReconciliationError?: (error: unknown, text: string) => void,
  ) => () => Promise<boolean>;
  invalidate: () => void;
} {
  let generation = 0;
  function prepareWrite(
    text: string,
    onReconciliationError?: (error: unknown, text: string) => void,
  ) {
    const requestGeneration = generation;
    const isCurrent = () => requestGeneration === generation && enabled();
    return async () => {
      try {
        const written = await writeText(text, isCurrent, (error, failedText) => {
          if (isCurrent()) onReconciliationError?.(error, failedText);
        });
        return written && isCurrent();
      } catch (error) {
        if (!isCurrent()) return false;
        throw error;
      }
    };
  }
  return {
    writeText(text, onReconciliationError) {
      return prepareWrite(text, onReconciliationError)();
    },
    prepareWrite,
    invalidate() {
      generation += 1;
    },
  };
}

export function createTerminalRemoteClipboardBridge(options: {
  enabled: () => boolean;
  writeText: (text: string) => Promise<void | boolean>;
  prepareWrite?: (
    text: string,
    onReconciliationError?: (error: unknown, text: string) => void,
  ) => () => Promise<void | boolean>;
  onWriteStart?: (text: string) => void;
  onCopied?: (text: string) => void;
  onWriteError?: (error: unknown, text: string) => void;
  onError: (error: unknown) => void;
  maxClipboardBytes?: number;
}): TerminalRemoteClipboardBridge {
  const maxClipboardBytes = Math.max(1, options.maxClipboardBytes ?? DEFAULT_MAX_CLIPBOARD_BYTES);
  const maxSequenceLength = Math.ceil(maxClipboardBytes * 4 / 3) + 32;
  let pending = "";
  let suppressedPrefixLength = 0;
  let discardingSequence = false;
  let writeQueue = Promise.resolve();
  let queuedWrite: { text: string; write: () => Promise<void | boolean> } | undefined;
  let drainingWrites = false;

  function beforeRenderOutput(text: string): string {
    const retainParserState = options.enabled();
    let input = text;
    if (retainParserState) {
      input = pending + input;
    } else if (pending) {
      discardingSequence = true;
    }
    pending = "";
    if (suppressedPrefixLength > 0) {
      const candidate = OSC_52_PREFIX.slice(0, suppressedPrefixLength) + input;
      suppressedPrefixLength = 0;
      if (OSC_52_PREFIX.startsWith(candidate)) {
        suppressedPrefixLength = candidate.length;
        return "";
      }
      if (candidate.startsWith(OSC_52_PREFIX)) {
        discardingSequence = true;
        input = candidate;
      }
    }
    let output = "";

    if (discardingSequence) {
      const terminator = findOscTerminator(input, 0);
      if (!terminator) return "";
      discardingSequence = false;
      input = input.slice(terminator.index + terminator.length);
    }

    while (input) {
      const start = input.indexOf(OSC_52_PREFIX);
      if (start < 0) {
        const partialLength = partialPrefixLength(input);
        output += input.slice(0, input.length - partialLength);
        if (retainParserState) {
          pending = input.slice(input.length - partialLength);
        } else {
          suppressedPrefixLength = partialLength;
        }
        break;
      }

      output += input.slice(0, start);
      const terminator = findOscTerminator(input, start + OSC_52_PREFIX.length);
      if (!terminator) {
        const incomplete = input.slice(start);
        if (incomplete.length > maxSequenceLength) {
          discardingSequence = true;
          options.onError(new Error("remote clipboard payload is too large"));
        } else if (retainParserState) {
          pending = incomplete;
        } else {
          discardingSequence = true;
        }
        break;
      }

      const body = input.slice(start + OSC_52_PREFIX.length, terminator.index);
      handleOsc52Body(body);
      input = input.slice(terminator.index + terminator.length);
    }

    return output;
  }

  function handleOsc52Body(body: string) {
    const separator = body.indexOf(";");
    if (separator < 0) return;
    const payload = body.slice(separator + 1);
    if (!payload || payload === "?" || !options.enabled()) return;

    let text: string;
    try {
      const bytes = decodeBase64(payload, maxClipboardBytes);
      text = new TextDecoder().decode(bytes);
    } catch (error) {
      options.onError(error);
      return;
    }
    if (!text) return;

    queueClipboardWrite(text);
  }

  function queueClipboardWrite(text: string) {
    const reportError = (error: unknown) => reportWriteError(error, text);
    queuedWrite = {
      text,
      write: options.prepareWrite?.(text, reportError) ?? (() => options.writeText(text)),
    };
    if (drainingWrites) return;
    drainingWrites = true;
    writeQueue = Promise.resolve().then(drainClipboardWrites);
  }

  async function drainClipboardWrites() {
    try {
      while (queuedWrite !== undefined) {
        const { text, write } = queuedWrite;
        queuedWrite = undefined;
        if (!options.enabled()) continue;
        try {
          options.onWriteStart?.(text);
          const written = await write();
          if (written === false) continue;
          options.onCopied?.(text);
        } catch (error) {
          reportWriteError(error, text);
        }
      }
    } finally {
      drainingWrites = false;
    }
  }

  function reportWriteError(error: unknown, text: string) {
    if (options.onWriteError) {
      options.onWriteError(error, text);
    } else {
      options.onError(error);
    }
  }

  function reset() {
    pending = "";
    suppressedPrefixLength = 0;
    discardingSequence = false;
    queuedWrite = undefined;
  }

  return {
    beforeRenderOutput,
    reset,
    settled: () => writeQueue,
  };
}

function findOscTerminator(
  text: string,
  from: number,
): { index: number; length: number } | undefined {
  const bell = text.indexOf(OSC_BEL, from);
  const stringTerminator = text.indexOf(OSC_ST, from);
  if (bell < 0 && stringTerminator < 0) return undefined;
  if (bell >= 0 && (stringTerminator < 0 || bell < stringTerminator)) {
    return { index: bell, length: OSC_BEL.length };
  }
  return { index: stringTerminator, length: OSC_ST.length };
}

function partialPrefixLength(text: string): number {
  const maxLength = Math.min(text.length, OSC_52_PREFIX.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (OSC_52_PREFIX.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw new Error("remote clipboard payload is too large");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("remote clipboard payload is invalid");
  }
  const decoded = atob(value);
  if (decoded.length > maxBytes) {
    throw new Error("remote clipboard payload is too large");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

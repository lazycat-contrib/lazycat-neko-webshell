const OSC_52_PREFIX = "\u001b]52;";
const OSC_BEL = "\u0007";
const OSC_ST = "\u001b\\";
const DEFAULT_MAX_CLIPBOARD_BYTES = 1_000_000;

export type TerminalRemoteClipboardBridge = {
  beforeRenderOutput: (text: string) => string;
  settled: () => Promise<void>;
};

export function createTerminalRemoteClipboardBridge(options: {
  enabled: () => boolean;
  writeText: (text: string) => Promise<void>;
  onCopied?: () => void;
  onError: (error: unknown) => void;
  maxClipboardBytes?: number;
}): TerminalRemoteClipboardBridge {
  const maxClipboardBytes = Math.max(1, options.maxClipboardBytes ?? DEFAULT_MAX_CLIPBOARD_BYTES);
  const maxSequenceLength = Math.ceil(maxClipboardBytes * 4 / 3) + 32;
  let pending = "";
  let discardingOversizedSequence = false;
  let writeQueue = Promise.resolve();
  let queuedText: string | undefined;
  let drainingWrites = false;

  function beforeRenderOutput(text: string): string {
    let input = pending + text;
    pending = "";
    let output = "";

    if (discardingOversizedSequence) {
      const terminator = findOscTerminator(input, 0);
      if (!terminator) return "";
      discardingOversizedSequence = false;
      input = input.slice(terminator.index + terminator.length);
    }

    while (input) {
      const start = input.indexOf(OSC_52_PREFIX);
      if (start < 0) {
        const partialLength = partialPrefixLength(input);
        output += input.slice(0, input.length - partialLength);
        pending = input.slice(input.length - partialLength);
        break;
      }

      output += input.slice(0, start);
      const terminator = findOscTerminator(input, start + OSC_52_PREFIX.length);
      if (!terminator) {
        const incomplete = input.slice(start);
        if (incomplete.length > maxSequenceLength) {
          discardingOversizedSequence = true;
          options.onError(new Error("remote clipboard payload is too large"));
        } else {
          pending = incomplete;
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
    queuedText = text;
    if (drainingWrites) return;
    drainingWrites = true;
    writeQueue = Promise.resolve().then(drainClipboardWrites);
  }

  async function drainClipboardWrites() {
    try {
      while (queuedText !== undefined) {
        const text = queuedText;
        queuedText = undefined;
        if (!options.enabled()) continue;
        try {
          await options.writeText(text);
          options.onCopied?.();
        } catch (error) {
          options.onError(error);
        }
      }
    } finally {
      drainingWrites = false;
    }
  }

  return {
    beforeRenderOutput,
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

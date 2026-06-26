export type TerminalTitleObservation = {
  buffer: string;
  title?: string;
  found: boolean;
};

const MAX_TERMINAL_TITLE_BUFFER = 4096;
const OSC_TITLE_PATTERN = /\x1b\](?:0|2);([\s\S]*?)(?:\x07|\x1b\\)/g;
const TITLE_PREFIXES = ["\x1b]0;", "\x1b]2;"];
const PARTIAL_PREFIXES = ["\x1b", "\x1b]", "\x1b]0", "\x1b]2"];

export function observeTerminalTitleChunk(buffer: string, text: string): TerminalTitleObservation {
  const combined = `${buffer}${text}`;
  let title: string | undefined;
  let consumedUntil = 0;
  let match: RegExpExecArray | null;
  OSC_TITLE_PATTERN.lastIndex = 0;
  while ((match = OSC_TITLE_PATTERN.exec(combined)) !== null) {
    title = sanitizeTerminalTitle(match[1] ?? "");
    consumedUntil = OSC_TITLE_PATTERN.lastIndex;
  }

  const tailSource = consumedUntil > 0 ? combined.slice(consumedUntil) : combined;
  return {
    buffer: terminalTitleTail(tailSource),
    title,
    found: consumedUntil > 0,
  };
}

function sanitizeTerminalTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

function terminalTitleTail(text: string): string {
  const titleStart = Math.max(...TITLE_PREFIXES.map((prefix) => text.lastIndexOf(prefix)));
  if (titleStart >= 0) {
    return text.slice(titleStart).slice(-MAX_TERMINAL_TITLE_BUFFER);
  }
  for (const partial of PARTIAL_PREFIXES) {
    if (text.endsWith(partial)) return partial;
  }
  return "";
}

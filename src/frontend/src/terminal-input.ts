const KEYDOWN_BEFOREINPUT_DEDUPE_MS = 25;

type Clock = () => number;

export class TerminalInputDeduper {
  private lastText = "";
  private lastAt = 0;

  constructor(private readonly clock: Clock = defaultClock) {}

  accept(text: string): boolean {
    if (!shouldDedupe(text)) {
      this.remember(text);
      return true;
    }

    const now = this.clock();
    if (text === this.lastText && now - this.lastAt <= KEYDOWN_BEFOREINPUT_DEDUPE_MS) {
      this.lastAt = now;
      return false;
    }

    this.lastText = text;
    this.lastAt = now;
    return true;
  }

  reset() {
    this.lastText = "";
    this.lastAt = 0;
  }

  private remember(text: string) {
    this.lastText = text;
    this.lastAt = this.clock();
  }
}

function shouldDedupe(text: string): boolean {
  if (text.length !== 1) return false;
  const code = text.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

function defaultClock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

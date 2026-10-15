import { escapeAttr, escapeHtml } from "../utils.ts";

export type MobileVirtualKeyboardPage = "typing" | "function";

type VirtualKeyBase = {
  label: string;
  name: string;
  repeat?: boolean;
  size?: "wide" | "space";
};

type VirtualKey = VirtualKeyBase & (
  | { shortcut: string; chord?: never }
  | { chord: "shift-tab"; shortcut?: never }
);

const printable = (value: string, name = value): VirtualKey => ({
  label: value.toUpperCase(),
  name,
  shortcut: value,
});

const shortcut = (value: string, label: string, name = label, repeat = false): VirtualKey => ({
  label,
  name,
  shortcut: value,
  repeat,
});

const SYMBOL_KEYS = [
  ["`", "Backtick"], ["-", "Hyphen"], ["=", "Equals"], ["\\", "Backslash"],
  [";", "Semicolon"], ["'", "Apostrophe"], [",", "Comma"], [".", "Period"], ["/", "Slash"],
] as const;

const TYPING_ROWS: readonly (readonly VirtualKey[])[] = [
  [shortcut("escape", "Esc", "Escape"), ...SYMBOL_KEYS.map(([value, name]) => printable(value, name))],
  [..."1234567890"].map((value) => printable(value)),
  [..."qwertyuiop"].map((value) => printable(value, value.toUpperCase())),
  [..."asdfghjkl"].map((value) => printable(value, value.toUpperCase())),
  [shortcut("shift", "⇧", "Shift"), ...[..."zxcvbnm"].map((value) => printable(value, value.toUpperCase())), shortcut("backspace", "⌫", "Backspace", true)],
  [
    shortcut("ctrl", "Ctrl"), shortcut("alt", "Alt"), shortcut("tab", "Tab"),
    { ...printable(" ", "Space"), label: "Space", size: "space" },
    shortcut("enter", "↵", "Enter", true),
    shortcut("left", "←", "Left arrow", true), shortcut("up", "↑", "Up arrow", true),
    shortcut("down", "↓", "Down arrow", true), shortcut("right", "→", "Right arrow", true),
  ],
];

const FUNCTION_ROWS: readonly (readonly VirtualKey[])[] = [
  ["f1", "f2", "f3"].map((value) => shortcut(value, value.toUpperCase()))
    .concat([shortcut("insert", "Ins", "Insert"), shortcut("home", "Home", "Home", true), shortcut("pageUp", "PgUp", "Page up", true)]),
  ["f4", "f5", "f6"].map((value) => shortcut(value, value.toUpperCase()))
    .concat([shortcut("delete", "Del", "Delete", true), shortcut("end", "End", "End", true), shortcut("pageDown", "PgDn", "Page down", true)]),
  ["f7", "f8", "f9"].map((value) => shortcut(value, value.toUpperCase()))
    .concat([shortcut("escape", "Esc", "Escape"), shortcut("tab", "Tab"), shortcut("backspace", "⌫", "Backspace", true)]),
  ["f10", "f11", "f12"].map((value) => shortcut(value, value.toUpperCase()))
    .concat([shortcut("left", "←", "Left arrow", true), shortcut("up", "↑", "Up arrow", true), shortcut("right", "→", "Right arrow", true)]),
  [
    { chord: "shift-tab", label: "Shift+Tab", name: "Shift tab", size: "wide" },
    shortcut("down", "↓", "Down arrow", true), shortcut("enter", "Enter", "Enter", true),
  ],
];

function renderKey(key: VirtualKey): string {
  const route = key.chord
    ? `data-mobile-chord="${escapeAttr(key.chord)}"`
    : `data-mobile-shortcut="${escapeAttr(key.shortcut)}"`;
  const modifier = key.shortcut === "ctrl" || key.shortcut === "alt" || key.shortcut === "shift"
    ? ` data-mobile-modifier="${key.shortcut}" aria-pressed="false"`
    : "";
  return `<button type="button" class="mobile-virtual-key" ${route} aria-label="${escapeAttr(key.name)}"${modifier}${key.repeat ? ' data-mobile-repeat="true"' : ""}${key.size ? ` data-mobile-virtual-size="${key.size}"` : ""}>${escapeHtml(key.label)}</button>`;
}

export function renderMobileVirtualKeyboardPanel(page: MobileVirtualKeyboardPage): string {
  const rows = page === "typing" ? TYPING_ROWS : FUNCTION_ROWS;
  const name = page === "typing" ? "Typing keyboard" : "Function and navigation keys";
  return `<div class="mobile-virtual-keyboard-panel" data-mobile-panel="${page}" role="group" aria-label="${name}"${page === "function" ? " hidden" : ""}>${rows.map((row, index) => (
    `<div class="mobile-virtual-keyboard-row" data-mobile-virtual-row="${index + 1}">${row.map(renderKey).join("")}</div>`
  )).join("")}</div>`;
}

export function renderMobileVirtualKeyboardPanels(): string {
  return renderMobileVirtualKeyboardPanel("typing") + renderMobileVirtualKeyboardPanel("function");
}

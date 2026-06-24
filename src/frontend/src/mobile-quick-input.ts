import type { MessageKey } from "./i18n";
import type { JsonRecord, MobileQuickPhrase } from "./types";
import { recordField, stringField } from "./json-meta";
import { escapeAttr, escapeHtml } from "./utils";

export type MobileSymbolAgent =
  | "default"
  | "agy"
  | "amp"
  | "claude"
  | "cline"
  | "codex"
  | "copilot"
  | "cursor"
  | "devin"
  | "droid"
  | "gemini"
  | "grok"
  | "hermes"
  | "kilo"
  | "kimi"
  | "kiro"
  | "opencode"
  | "pi"
  | "qodercli";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export const MAX_MOBILE_QUICK_PHRASES = 24;
export const MAX_MOBILE_QUICK_PHRASE_LABEL = 32;
export const MAX_MOBILE_QUICK_PHRASE_TEXT = 256;

const SYMBOL_LABELS: Record<string, string> = {
  "|": "Pipe",
  "\\": "Backslash",
  "~": "Tilde",
  "`": "Backtick",
  "[": "Left bracket",
  "]": "Right bracket",
  "{": "Left brace",
  "}": "Right brace",
  "(": "Left parenthesis",
  ")": "Right parenthesis",
  "&": "Ampersand",
  ";": "Semicolon",
  ":": "Colon",
  "$": "Dollar",
  "/": "Slash",
  "-": "Hyphen",
  "*": "Asterisk",
  "?": "Question mark",
};

const SYMBOLS = ["$", "/", "-", "~", "|", "\\", "`", "[", "]", "{", "}", "(", ")", "&", ";", ":", "*", "?"] as const;
const DEFAULT_PRIORITY = ["$", "/", "-", "~", "|", "\\", "`", "[", "]", "{", "}", "(", ")", "&", ";", ":", "*", "?"];
const SLASH_COMMAND_PRIORITY = ["/", "$", "-", "~", "\\", "|", "`", "[", "]", "{", "}", "(", ")", "?", "&", ";", ":", "*"];
const CODEX_PRIORITY = ["$", "/", "-", "~", "`", "|", "\\", "[", "]", "{", "}", "(", ")", "&", ";", ":", "*", "?"];
const PATH_FIRST_PRIORITY = ["/", "-", "~", "$", "|", "\\", "`", "[", "]", "{", "}", "(", ")", "?", "&", ";", ":", "*"];

const AGENT_PRIORITY: Partial<Record<MobileSymbolAgent, string[]>> = {
  agy: SLASH_COMMAND_PRIORITY,
  amp: SLASH_COMMAND_PRIORITY,
  claude: SLASH_COMMAND_PRIORITY,
  cline: SLASH_COMMAND_PRIORITY,
  codex: CODEX_PRIORITY,
  copilot: SLASH_COMMAND_PRIORITY,
  cursor: SLASH_COMMAND_PRIORITY,
  devin: DEFAULT_PRIORITY,
  droid: PATH_FIRST_PRIORITY,
  gemini: SLASH_COMMAND_PRIORITY,
  grok: SLASH_COMMAND_PRIORITY,
  hermes: SLASH_COMMAND_PRIORITY,
  kilo: SLASH_COMMAND_PRIORITY,
  kimi: SLASH_COMMAND_PRIORITY,
  kiro: SLASH_COMMAND_PRIORITY,
  opencode: SLASH_COMMAND_PRIORITY,
  pi: SLASH_COMMAND_PRIORITY,
  qodercli: SLASH_COMMAND_PRIORITY,
};

const AGENT_ALIASES: Record<string, MobileSymbolAgent> = {
  agy: "agy",
  antigravity: "agy",
  amp: "amp",
  claude: "claude",
  "claude-code": "claude",
  cline: "cline",
  codex: "codex",
  copilot: "copilot",
  "github-copilot": "copilot",
  cursor: "cursor",
  devin: "devin",
  droid: "droid",
  gemini: "gemini",
  grok: "grok",
  hermes: "hermes",
  kilo: "kilo",
  kimi: "kimi",
  kiro: "kiro",
  opencode: "opencode",
  pi: "pi",
  qoder: "qodercli",
  qodercli: "qodercli",
};

export function mobileSymbolAgentFromText(value: string): MobileSymbolAgent {
  const normalized = value.toLowerCase().trim();
  if (!normalized) return "default";
  const tokens = normalized.split(/[^a-z0-9-]+/).filter(Boolean);
  for (const token of [normalized, ...tokens]) {
    const agent = AGENT_ALIASES[token];
    if (agent) return agent;
  }
  return "default";
}

export function mobileSymbolAgentFromHerdrPane(result: JsonRecord | undefined): MobileSymbolAgent {
  const pane = recordField(result, "pane") ?? result;
  const session = recordField(pane, "agent_session");
  const candidates = [
    stringField(pane, "agent"),
    stringField(session, "agent"),
    stringField(session, "source"),
    stringField(pane, "display_agent"),
    stringField(pane, "title"),
    stringField(pane, "label"),
  ];
  for (const candidate of candidates) {
    const agent = mobileSymbolAgentFromText(candidate);
    if (agent !== "default") return agent;
  }
  return "default";
}

export function renderMobileSymbolKeyboardPanel(agent: MobileSymbolAgent): string {
  return orderedSymbols(agent).map((symbol) => {
    const label = SYMBOL_LABELS[symbol] ?? symbol;
    return `<button type="button" data-mobile-shortcut="${escapeAttr(symbol)}" aria-label="${escapeAttr(label)}">${escapeHtml(symbol)}</button>`;
  }).join("");
}

export function renderMobileQuickPhrasePageButton(phrases: MobileQuickPhrase[], tr: Translate): string {
  return phrases.length
    ? `<button type="button" data-mobile-page="phrases" aria-pressed="false" aria-label="${escapeAttr(tr("tab.quickPhrases"))}" title="${escapeAttr(tr("tab.quickPhrases"))}"><i data-lucide="message-square-text"></i></button>`
    : "";
}

export function renderMobileQuickPhraseKeyboardPanel(phrases: MobileQuickPhrase[]): string {
  return sortedMobileQuickPhrases(phrases).map((phrase) => (
    `<button type="button" data-mobile-phrase="${escapeAttr(phrase.id)}" title="${escapeAttr(phrase.text)}">${escapeHtml(phrase.label || phrase.text)}</button>`
  )).join("");
}

export function renderMobileQuickPhraseList(phrases: MobileQuickPhrase[], tr: Translate): string {
  const sorted = sortedMobileQuickPhrases(phrases);
  if (!sorted.length) {
    return `<p class="empty">${escapeHtml(tr("status.noQuickPhrases"))}</p>`;
  }
  return sorted.map((phrase) => `
    <div class="quick-phrase-row" data-quick-phrase-row="${escapeAttr(phrase.id)}">
      <button type="button" class="quick-phrase-preview" data-quick-phrase-edit="${escapeAttr(phrase.id)}">
        <span>${escapeHtml(phrase.label || phrase.text)}</span>
        <small>${escapeHtml(phrase.text)}</small>
      </button>
      <button type="button" class="icon-button" data-quick-phrase-remove="${escapeAttr(phrase.id)}" aria-label="${escapeAttr(tr("action.quickPhraseRemove"))}" title="${escapeAttr(tr("action.quickPhraseRemove"))}">
        <i data-lucide="trash-2"></i>
      </button>
    </div>
  `).join("");
}

export function sortedMobileQuickPhrases(phrases: MobileQuickPhrase[]): MobileQuickPhrase[] {
  return [...phrases].sort((left, right) => {
    const uses = right.useCount - left.useCount;
    if (uses !== 0) return uses;
    return right.lastUsedAt - left.lastUsedAt;
  });
}

export function normalizeMobileQuickPhrases(value: unknown): MobileQuickPhrase[] {
  if (!Array.isArray(value)) return [];
  const phrases: MobileQuickPhrase[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<MobileQuickPhrase>;
    const text = normalizePhraseText(raw.text);
    if (!text) continue;
    const label = normalizePhraseLabel(raw.label) || text.slice(0, MAX_MOBILE_QUICK_PHRASE_LABEL);
    const id = normalizePhraseId(raw.id, ids, phrases.length);
    phrases.push({
      id,
      label,
      text,
      useCount: normalizeCount(raw.useCount),
      lastUsedAt: normalizeTimestamp(raw.lastUsedAt),
    });
    ids.add(id);
    if (phrases.length >= MAX_MOBILE_QUICK_PHRASES) break;
  }
  return phrases;
}

export function makeMobileQuickPhrase(input: { id?: string; label: string; text: string }, existing: MobileQuickPhrase[] = []): MobileQuickPhrase {
  const ids = new Set(existing.map((phrase) => phrase.id).filter((id) => id !== input.id));
  return {
    id: normalizePhraseId(input.id, ids, existing.length),
    label: normalizePhraseLabel(input.label) || normalizePhraseText(input.text).slice(0, MAX_MOBILE_QUICK_PHRASE_LABEL),
    text: normalizePhraseText(input.text),
    useCount: 0,
    lastUsedAt: 0,
  };
}

export function markMobileQuickPhraseUsed(phrases: MobileQuickPhrase[], id: string, now = Date.now()): MobileQuickPhrase[] {
  return phrases.map((phrase) => phrase.id === id
    ? {
        ...phrase,
        useCount: Math.min(Number.MAX_SAFE_INTEGER, phrase.useCount + 1),
        lastUsedAt: now,
      }
    : phrase);
}

function orderedSymbols(agent: MobileSymbolAgent): string[] {
  const priority = AGENT_PRIORITY[agent] ?? DEFAULT_PRIORITY;
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const symbol of [...priority, ...SYMBOLS]) {
    if (!SYMBOL_LABELS[symbol] || seen.has(symbol)) continue;
    seen.add(symbol);
    ordered.push(symbol);
  }
  return ordered;
}

function normalizePhraseText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, MAX_MOBILE_QUICK_PHRASE_TEXT);
}

function normalizePhraseLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_MOBILE_QUICK_PHRASE_LABEL);
}

function normalizePhraseId(value: unknown, used: Set<string>, index: number): string {
  const candidate = typeof value === "string" ? value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) : "";
  if (candidate && !used.has(candidate)) return candidate;
  let id = `phrase-${index + 1}`;
  let suffix = 2;
  while (used.has(id)) {
    id = `phrase-${index + suffix}`;
    suffix += 1;
  }
  return id;
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

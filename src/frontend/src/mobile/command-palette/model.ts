import type { MobileQuickPhrase } from "../../types.ts";
import type { MobileKeyboardKey } from "../keyboard-layout-types.ts";

export type MobilePaletteTab = "recent" | "all" | "keys";

export type MobilePaletteChoice =
  | { readonly kind: "phrase"; readonly id: string; readonly phrase: Readonly<MobileQuickPhrase> }
  | { readonly kind: "key"; readonly id: string; readonly key: Readonly<MobileKeyboardKey> };

export class MobilePaletteOperationLock {
  #active: object | undefined;

  get busy(): boolean {
    return Boolean(this.#active);
  }

  begin(): object | undefined {
    if (this.#active) return undefined;
    const token = {};
    this.#active = token;
    return token;
  }

  complete(token: object): boolean {
    if (this.#active !== token) return false;
    this.#active = undefined;
    return true;
  }
}

export function operationOwnsView<T>(
  operationGeneration: number,
  currentGeneration: number,
  operationTarget: T,
  capturedTarget: T | undefined,
): boolean {
  return operationGeneration === currentGeneration && operationTarget === capturedTarget;
}

function searchable(value: string): string {
  return value.toLocaleLowerCase();
}

function includesQuery(values: string[], query: string): boolean {
  const normalized = searchable(query.trim());
  return !normalized || values.some((value) => searchable(value).includes(normalized));
}

export function phraseChoices(
  phrases: readonly MobileQuickPhrase[],
  tab: Exclude<MobilePaletteTab, "keys">,
  query: string,
): MobilePaletteChoice[] {
  return phrases
    .map((phrase, sourceIndex) => ({ phrase: { ...phrase }, sourceIndex }))
    .filter(({ phrase }) => tab !== "recent" || phrase.lastUsedAt > 0)
    .filter(({ phrase }) => includesQuery([phrase.label, phrase.text, phrase.group], query))
    .sort((left, right) => tab === "recent"
      ? right.phrase.lastUsedAt - left.phrase.lastUsedAt
        || left.phrase.order - right.phrase.order
        || left.sourceIndex - right.sourceIndex
      : left.phrase.order - right.phrase.order || left.sourceIndex - right.sourceIndex)
    .map(({ phrase }) => ({ kind: "phrase", id: `phrase:${phrase.id}`, phrase }));
}

export function isSafePaletteKey(key: MobileKeyboardKey): boolean {
  if (key.hidden) return false;
  if (key.kind === "shortcut" || key.kind === "chord") return true;
  return key.kind === "text" && key.custom;
}

export function keyChoices(keys: readonly MobileKeyboardKey[], query: string): MobilePaletteChoice[] {
  return keys
    .filter(isSafePaletteKey)
    .filter((key) => includesQuery([key.label, key.value], query))
    .map((key) => ({ kind: "key", id: `key:${key.id}`, key: { ...key } }));
}

export function choicesForTab(
  phrases: readonly MobileQuickPhrase[],
  keys: readonly MobileKeyboardKey[],
  tab: MobilePaletteTab,
  query: string,
): MobilePaletteChoice[] {
  return tab === "keys" ? keyChoices(keys, query) : phraseChoices(phrases, tab, query);
}

export function resolveActivationTarget<T>(
  captured: T | undefined,
  isCurrent: (target: T) => boolean,
): T | undefined {
  return captured && isCurrent(captured) ? captured : undefined;
}

export function samePhrase(left: Readonly<MobileQuickPhrase>, right: Readonly<MobileQuickPhrase>): boolean {
  return left.id === right.id
    && left.label === right.label
    && left.text === right.text
    && left.useCount === right.useCount
    && left.lastUsedAt === right.lastUsedAt
    && left.group === right.group
    && left.order === right.order
    && left.sendEnter === right.sendEnter;
}

export function sameKey(left: Readonly<MobileKeyboardKey>, right: Readonly<MobileKeyboardKey>): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.value === right.value
    && left.label === right.label
    && left.ariaLabel === right.ariaLabel
    && left.icon === right.icon
    && left.width === right.width
    && left.hidden === right.hidden
    && left.repeat === right.repeat
    && left.autoEnter === right.autoEnter
    && left.custom === right.custom;
}

export function resolveCurrentChoice(
  choice: MobilePaletteChoice,
  phrases: readonly MobileQuickPhrase[],
  keys: readonly MobileKeyboardKey[],
): MobilePaletteChoice | undefined {
  if (choice.kind === "phrase") {
    const phrase = phrases.find((item) => item.id === choice.phrase.id && samePhrase(item, choice.phrase));
    return phrase ? { kind: "phrase", id: choice.id, phrase } : undefined;
  }
  const key = keys.find((item) => isSafePaletteKey(item) && item.id === choice.key.id && sameKey(item, choice.key));
  return key ? { kind: "key", id: choice.id, key } : undefined;
}

import type { LocaleSetting } from "./types";

import { enMessages, type MessageKey } from "./i18n/messages-en";
import { zhCNMessages } from "./i18n/messages-zh-cn";

type Language = "en" | "zh-CN";

export type { MessageKey } from "./i18n/messages-en";

const messages = {
  en: enMessages,
  "zh-CN": zhCNMessages,
} satisfies Record<Language, Record<MessageKey, string>>;

export function resolveLanguage(locale: LocaleSetting): Language {
  if (locale === "en" || locale === "zh-CN") return locale;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function translate(locale: LocaleSetting, key: MessageKey, values: Record<string, string | number> = {}): string {
  const template = messages[resolveLanguage(locale)][key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}

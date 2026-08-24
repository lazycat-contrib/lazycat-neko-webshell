export type MobileKeyboardPresetId = "default" | "operations" | "editor" | "custom";
export type MobileKeyboardPageId = "main" | "ops" | "nav" | "fn" | "sym";
export type MobileKeyboardKeyKind = "shortcut" | "chord" | "action" | "text";
export type MobileKeyboardKeyWidth = "sm" | "md" | "lg";

export type MobileKeyboardKey = {
  id: string;
  kind: MobileKeyboardKeyKind;
  value: string;
  label: string;
  ariaLabel: string;
  icon?: string;
  width: MobileKeyboardKeyWidth;
  hidden: boolean;
  repeat: boolean;
  autoEnter: boolean;
  custom: boolean;
};

export type MobileKeyboardPage = {
  id: MobileKeyboardPageId;
  keys: MobileKeyboardKey[];
};

export type MobileKeyboardLayout = {
  pages: MobileKeyboardPage[];
};

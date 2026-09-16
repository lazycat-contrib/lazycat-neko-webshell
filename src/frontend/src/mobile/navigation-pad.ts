import type { MobileKeyboardKey } from "./keyboard-layout-types.ts";

/** Keep the existing navigation keys, without copying keys from the main rail. */
export function navigationPadKeys(keys: MobileKeyboardKey[]): MobileKeyboardKey[] {
  return keys.filter(key => !key.hidden);
}

import assert from "node:assert/strict";
import test from "node:test";
import { createMobileRemoteDesktopPreference, MOBILE_REMOTE_DESKTOP_STORAGE_KEY } from "./remote-desktop-preference.ts";

test("the LightOS mobile desktop preference defaults off and survives a new page", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const preference = createMobileRemoteDesktopPreference(storage);
  assert.equal(preference.isEnabled(), false);
  preference.setEnabled(true);
  assert.equal(values.get("lightos-mobile-remote-desktop-enabled"), "true");
  const nextPage = createMobileRemoteDesktopPreference(storage);
  assert.equal(nextPage.isEnabled(), true);
  nextPage.setEnabled(false);
  assert.equal(createMobileRemoteDesktopPreference(storage).isEnabled(), false);
  assert.equal(MOBILE_REMOTE_DESKTOP_STORAGE_KEY, "lightos-mobile-remote-desktop-enabled");
});

test("blocked storage preserves the selection on this page without throwing", () => {
  const blocked = () => { throw Error("storage unavailable"); };
  const preference = createMobileRemoteDesktopPreference({ getItem: blocked, setItem: blocked });
  assert.equal(preference.isEnabled(), false);
  preference.setEnabled(true);
  assert.equal(preference.isEnabled(), true);
  preference.setEnabled(false);
  assert.equal(preference.isEnabled(), false);
});

test("unrecognized saved values cannot accidentally enable mobile remote desktop", () => {
  for (const saved of [null, "false", "1", "enabled", "{\"enabled\":true}"]) {
    assert.equal(createMobileRemoteDesktopPreference({ getItem: () => saved, setItem() {} }).isEnabled(), false);
  }
});

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { buildLightOSHomeUrl, referrerHomeUrl, resolveLightOSHomeUrl } from "./lightos-navigation.ts";

const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
beforeEach(() => {
  globalThis.window = { location: new URL("https://neko.example/?name=instance%40owner") };
  globalThis.document = { referrer: "" };
});
after(() => Object.assign(globalThis, previous));

test("LightOS home receives the explicit mobile preference without losing its base path", () => {
  const base = "https://lightos.example/admin/?keep=value&mobile_remote_desktop=0#instances";
  const enabled = new URL(buildLightOSHomeUrl(base, true));
  assert.equal(enabled.pathname, "/admin/");
  assert.equal(enabled.searchParams.get("view"), "home");
  assert.equal(enabled.searchParams.get("mobile_remote_desktop"), "1");
  assert.equal(enabled.searchParams.get("keep"), "value");
  assert.equal(enabled.hash, "#instances");
  assert.equal(new URL(buildLightOSHomeUrl(enabled.href, false)).searchParams.get("mobile_remote_desktop"), "0");
  assert.equal(new URL(buildLightOSHomeUrl(base)).searchParams.get("mobile_remote_desktop"), "0");
});

test("the admin-info response and referrer fallback carry the same preference", async () => {
  globalThis.fetch = async () => Response.json({ base_url: "https://lightos.example/" });
  assert.equal(new URL(await resolveLightOSHomeUrl(true)).searchParams.get("mobile_remote_desktop"), "1");
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  globalThis.document.referrer = "https://lightos.example/private?name=other&token=private#instance";
  const fallback = new URL(await resolveLightOSHomeUrl(true));
  assert.equal(fallback.pathname, "/");
  assert.equal(fallback.searchParams.get("mobile_remote_desktop"), "1");
  assert.equal(fallback.searchParams.get("view"), "home");
  assert.equal(fallback.searchParams.has("token"), false);
  assert.equal(fallback.hash, "");
  assert.equal(new URL(referrerHomeUrl(false)).searchParams.get("mobile_remote_desktop"), "0");
});

test("return navigation rejects non-web protocols and same-origin referrers", () => {
  assert.throws(() => buildLightOSHomeUrl("javascript:alert(1)", true), /protocol/);
  globalThis.document.referrer = "https://neko.example/";
  assert.equal(referrerHomeUrl(true), "");
  globalThis.document.referrer = "data:text/html,unsafe";
  assert.equal(referrerHomeUrl(true), "");
});

import assert from "node:assert/strict";
import test from "node:test";

import { renderTerminalMcpSettingsView } from "./settings-view.ts";

const tr = (key) => key;

test("escapes pending approval details and exposes decision controls", () => {
  const html = renderTerminalMcpSettingsView({
    enabled: true,
    disabled: false,
    loading: false,
    error: "",
    busyIds: new Set(),
    policy: {
      mode: "confirm",
      trustedCallers: [],
      deniedCallers: [],
    },
    pendingRequests: [{
      id: "request-1",
      userId: "lazycat",
      callerAppId: "cloud.lazycat.app.agent",
      callerName: "Agent <script>alert(1)</script>",
      target: {
        sessionId: "session-1",
        backend: "herdr",
        label: "Codex <main>",
      },
      capability: "interact",
      reason: "Need <script>control</script>",
      decision: "pending",
      createdAtMs: 1,
    }],
    activeGrants: [],
    tr,
  });

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;control&lt;\/script&gt;/);
  assert.match(html, /cloud\.lazycat\.app\.agent/);
  assert.match(html, /herdr/);
  assert.match(html, /session-1/);
  assert.match(html, /data-terminal-mcp-request-approve="request-1"/);
  assert.match(html, /data-terminal-mcp-request-deny="request-1"/);
});

test("renders active grants, revoke controls, and automatic-control warning", () => {
  const html = renderTerminalMcpSettingsView({
    enabled: true,
    disabled: false,
    loading: false,
    error: "",
    busyIds: new Set(),
    policy: {
      mode: "same_user_automatic",
      trustedCallers: [],
      deniedCallers: [],
    },
    pendingRequests: [],
    activeGrants: [{
      id: "grant-1",
      userId: "lazycat",
      callerAppId: "cloud.lazycat.app.agent",
      callerName: "Agent",
      target: {
        sessionId: "session-1",
        backend: "ssh",
        label: "Production",
      },
      capabilities: ["interact", "terminate"],
      createdAtMs: 1,
    }],
    tr,
  });

  assert.match(html, /terminalMcp\.automaticWarning/);
  assert.match(html, /data-terminal-mcp-grant-revoke="grant-1"/);
  assert.match(html, /interact/);
  assert.match(html, /terminate/);
});

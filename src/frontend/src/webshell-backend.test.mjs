import assert from "node:assert/strict";
import test from "node:test";

import { webshellTerminalSocketUrl } from "./webshell-backend.ts";

test("terminal socket advertises the client's reply authority capability", () => {
  globalThis.window = {
    location: new URL("https://webshell.example/app/"),
  };

  const url = webshellTerminalSocketUrl({
    selector: "demo@owner",
    sessionId: "session-1",
    paneId: "pane-1",
    sessionBackend: "webshell",
    cols: 120,
    rows: 32,
    restart: false,
    after: 0,
    outputLimit: 4096,
    terminalReplyAuthority: "server",
  });

  assert.equal(url.searchParams.get("terminal_reply_authority"), "server");
});

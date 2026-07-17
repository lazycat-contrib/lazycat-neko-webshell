import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTerminalReplyAuthority } from "./terminal-reply-authority.ts";

test("accepts only explicit server terminal reply authority", () => {
  assert.equal(normalizeTerminalReplyAuthority("server"), "server");
  assert.equal(normalizeTerminalReplyAuthority("client"), "client");
  assert.equal(normalizeTerminalReplyAuthority(undefined), "client");
  assert.equal(normalizeTerminalReplyAuthority("future-authority"), "client");
});

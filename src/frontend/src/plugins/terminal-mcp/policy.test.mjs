import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTerminalMcpPolicy,
  serializeTerminalMcpPolicy,
  terminalMcpPolicyAccess,
} from "./policy.ts";

test("normalizes all terminal MCP policy modes", () => {
  for (const mode of ["confirm", "trusted_callers", "same_user_automatic", "read_only"]) {
    assert.equal(normalizeTerminalMcpPolicy({ defaultPolicy: mode }).mode, mode);
  }
  assert.equal(normalizeTerminalMcpPolicy({ defaultPolicy: "unknown" }).mode, "confirm");
});

test("normalizes caller lists and applies deny precedence", () => {
  const policy = normalizeTerminalMcpPolicy({
    defaultPolicy: "trusted_callers",
    trustedCallers: JSON.stringify([" agent.b ", "agent.a", "agent.b", "denied.agent", 12]),
    deniedCallers: JSON.stringify([" denied.agent ", "blocked.agent", "blocked.agent"]),
  });

  assert.deepEqual(policy.trustedCallers, ["agent.a", "agent.b"]);
  assert.deepEqual(policy.deniedCallers, ["blocked.agent", "denied.agent"]);
  assert.equal(terminalMcpPolicyAccess(policy, "agent.a"), "automatic");
  assert.equal(terminalMcpPolicyAccess(policy, "denied.agent"), "denied");
  assert.equal(terminalMcpPolicyAccess(policy, "unknown.agent"), "confirm");
});

test("malformed caller metadata falls back to empty arrays", () => {
  const policy = normalizeTerminalMcpPolicy({
    trustedCallers: "not-json",
    deniedCallers: JSON.stringify({ caller: "agent" }),
  });
  assert.deepEqual(policy.trustedCallers, []);
  assert.deepEqual(policy.deniedCallers, []);
});

test("policy metadata round trips in stable sorted form", () => {
  const metadata = serializeTerminalMcpPolicy({
    mode: "trusted_callers",
    trustedCallers: [" agent.z ", "agent.a", "agent.a"],
    deniedCallers: ["agent.z"],
  });

  assert.deepEqual(metadata, {
    defaultPolicy: "trusted_callers",
    trustedCallers: JSON.stringify(["agent.a"]),
    deniedCallers: JSON.stringify(["agent.z"]),
  });
  assert.deepEqual(normalizeTerminalMcpPolicy(metadata), {
    mode: "trusted_callers",
    trustedCallers: ["agent.a"],
    deniedCallers: ["agent.z"],
  });
});

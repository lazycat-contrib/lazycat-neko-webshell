import assert from "node:assert/strict";
import test from "node:test";

import { createAIChatController } from "./controller.ts";

const messages = {
  "plugin.aiChat.block": "Chat",
  "status.aiHerdrAgentPrompting": "Sending to Herdr Agent...",
  "status.aiHerdrAgentPrompted": "Herdr Agent {agent} reached {status}",
  "validation.aiPrompt": "Enter a prompt",
  "validation.aiHerdrAgentUnavailable": "No interactive Herdr Agent",
  "validation.aiHerdrAgentInvalidResponse": "Invalid Herdr Agent response",
};
const tr = (key, values = {}) => (messages[key] ?? key).replace(
  /\{(\w+)\}/g,
  (_, name) => String(values[name] ?? ""),
);

function fixture({
  withAgent = true,
  interactiveReady = true,
  promptResult = {
    type: "agent_prompted",
    agent: {
      terminal_id: "term-1",
      name: "reviewer",
      agent_status: "done",
      workspace_id: "w1",
      tab_id: "w1:t1",
      pane_id: "w1:p1",
      focused: true,
      revision: 3,
      launch_pending: false,
      interactive_ready: true,
      state_change_seq: 10,
      tokens: {},
    },
  },
} = {}) {
  const input = { value: "Review this diff", style: { height: "" }, scrollHeight: 42 };
  const statuses = [];
  const calls = [];
  const target = {
    key: "target-1",
    label: "repo · main",
    ...(withAgent ? {
      herdrAgent: {
        target: "w1:p1",
        label: "Codex review",
        status: "working",
        interactiveReady,
      },
    } : {}),
  };
  let id = 0;
  const controller = createAIChatController({
    isEnabled: () => true,
    accessConfigured: () => false,
    configuredModel: () => "",
    activeProfileId: () => "default",
    setConfiguredModel: () => {},
    saveSettings: () => {},
    flushSettings: async () => {},
    terminalContext: async () => ({}),
    recentTerminalContext: () => "",
    activeTerminalTarget: () => target,
    inputElement: () => input,
    actionClient: { send: async () => { throw new Error("AI transport should not be used"); } },
    requestHerdrAgentPrompt: async (params) => {
      calls.push(params);
      return promptResult;
    },
    tr,
    createId: () => `id-${++id}`,
    onStatus: (message, tone) => statuses.push({ message, tone }),
    onRender: () => {},
    voiceReplyEnabled: () => false,
    voiceReplyStateForMessage: () => ({ status: "idle" }),
    onAssistantMessageDone: () => {},
  });
  return { controller, input, calls, statuses, target };
}

test("submits the composer to the active Herdr Agent without AI credentials", async () => {
  const target = fixture();
  assert.equal(target.controller.canPromptHerdrAgent(), true);

  await target.controller.promptHerdrAgent();

  assert.deepEqual(target.calls, [{
    target: "w1:p1",
    text: "Review this diff",
    wait: {
      until: ["done", "blocked"],
      timeout_ms: 120_000,
    },
  }]);
  assert.equal(target.input.value, "");
  assert.deepEqual(target.controller.activeSession().messages, [
    { role: "user", content: "Review this diff" },
    { role: "system", content: "Herdr Agent Codex review reached done", tone: "ok" },
  ]);
  assert.deepEqual(target.statuses.at(-1), {
    message: "Herdr Agent Codex review reached done",
    tone: "ok",
  });
  assert.equal(target.controller.isStreaming(), false);
});

test("hides the prompt action when no interactive Herdr Agent is active", () => {
  const target = fixture({ withAgent: false });
  assert.equal(target.controller.canPromptHerdrAgent(), false);
});

test("detects Herdr Agent availability changes on the same terminal target", () => {
  const fixtureTarget = fixture({ interactiveReady: false });
  assert.equal(fixtureTarget.controller.syncSessionForActiveTarget(), true);
  assert.equal(fixtureTarget.controller.syncSessionForActiveTarget(), false);

  fixtureTarget.target.herdrAgent.interactiveReady = true;
  assert.equal(fixtureTarget.controller.syncSessionForActiveTarget(), true);

  delete fixtureTarget.target.herdrAgent;
  assert.equal(fixtureTarget.controller.syncSessionForActiveTarget(), true);
});

test("localizes an invalid Herdr Agent prompt response", async () => {
  const target = fixture({ promptResult: { type: "agent_prompted" } });

  await target.controller.promptHerdrAgent();

  assert.deepEqual(target.controller.activeSession().messages.at(-1), {
    role: "system",
    content: "Invalid Herdr Agent response",
    tone: "error",
  });
  assert.deepEqual(target.statuses.at(-1), {
    message: "Invalid Herdr Agent response",
    tone: "error",
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  HERDR_AGENT_PROMPT_TIMEOUT_MS,
  herdrAgentPromptParams,
  herdrAgentPromptResult,
  herdrAgentPromptTone,
  submitHerdrAgentPrompt,
} from "./herdr-agent-prompt.ts";

test("builds one atomic Herdr prompt-and-wait request", () => {
  assert.equal(HERDR_AGENT_PROMPT_TIMEOUT_MS, 120_000);
  assert.deepEqual(herdrAgentPromptParams("w1:p1", "Review this diff"), {
    target: "w1:p1",
    text: "Review this diff",
    wait: {
      until: ["done", "blocked"],
      timeout_ms: 120_000,
    },
  });
});

test("parses the final Agent and maps its status tone", () => {
  const agent = herdrAgentPromptResult({
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
      interactive_ready: true,
      state_change_seq: 10,
    },
  });
  assert.equal(agent.pane_id, "w1:p1");
  assert.equal(agent.agent_status, "done");
  assert.equal(herdrAgentPromptTone("done"), "ok");
  assert.equal(herdrAgentPromptTone("blocked"), "error");
  assert.equal(herdrAgentPromptTone("working"), "neutral");
});

test("submits and parses the atomic prompt through the plugin boundary", async () => {
  const calls = [];
  const agent = await submitHerdrAgentPrompt(async (params) => {
    calls.push(params);
    return {
      type: "agent_prompted",
      agent: {
        terminal_id: "term-1",
        agent_status: "blocked",
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p1",
        focused: true,
        revision: 4,
      },
    };
  }, "w1:p1", "Review this diff");

  assert.deepEqual(calls, [herdrAgentPromptParams("w1:p1", "Review this diff")]);
  assert.equal(agent.agent_status, "blocked");
});

import assert from "node:assert/strict";
import test from "node:test";

import { renderHerdrAgentPromptButton } from "./herdr-agent-prompt-view.ts";

const tr = () => "Send to Herdr Agent";

test("renders the separate Herdr Agent action only when available", () => {
  assert.equal(renderHerdrAgentPromptButton({ available: false, busy: false, tr }), "");
  const html = renderHerdrAgentPromptButton({ available: true, busy: false, tr });
  assert.match(html, /data-ai-action="send-herdr-agent"/);
  assert.match(html, />Send to Herdr Agent</);
  assert.doesNotMatch(html, /disabled/);

  const busy = renderHerdrAgentPromptButton({ available: true, busy: true, tr });
  assert.match(busy, /disabled/);
});

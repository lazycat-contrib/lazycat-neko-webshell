import assert from "node:assert/strict";
import test from "node:test";

import { herdrEventMessage } from "./herdr-event-presentation.ts";

const templates = {
  "status.herdrAgentDetected": "Herdr {agent}: detected",
  "status.herdrAgentReleased": "Herdr {agent}: released",
  "status.herdrAgentReleasedWithStatus": "Herdr {agent}: released ({status})",
  "status.herdrEvent": "Herdr {event}: {subject}",
  "status.herdrEventAgent": "Herdr {agent}: {status}",
};

const tr = (key, values = {}) => templates[key].replace(
  /\{(\w+)\}/g,
  (_, name) => String(values[name] ?? ""),
);

test("describes Herdr agent detection and release events", () => {
  assert.equal(
    herdrEventMessage("pane.agent_detected", { agent: "codex" }, tr),
    "Herdr codex: detected",
  );
  assert.equal(
    herdrEventMessage("pane.agent_detected", { agent: "codex", released: true }, tr),
    "Herdr codex: released",
  );
  assert.equal(
    herdrEventMessage(
      "pane.agent_detected",
      { agent: "codex", released: true, final_status: "done" },
      tr,
    ),
    "Herdr codex: released (done)",
  );
});

test("keeps Herdr status and resource event messages stable", () => {
  assert.equal(
    herdrEventMessage(
      "pane.agent_status_changed",
      { display_agent: "Codex auth", agent_status: "blocked" },
      tr,
    ),
    "Herdr Codex auth: blocked",
  );
  assert.equal(
    herdrEventMessage("tab.renamed", { tab_id: "w1:t1" }, tr),
    "Herdr tab.renamed: w1:t1",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  HERDR_SOCKET_PROTOCOL,
  HERDR_SOCKET_SCHEMA_VERSION,
  HERDR_SOCKET_SOURCE_REVISION,
  HERDR_SOCKET_SOURCE_VERSION,
  herdrEventSubscriptions,
  herdrPaneIdFromEvent,
  herdrPaneInfo,
  herdrScrollInfoFromEvent,
  isHerdrSocketMethod,
  isHerdrSocketSubscription,
} from "./herdr-socket-api.ts";

test("tracks the current Herdr 0.7.4 socket schema", () => {
  assert.equal(HERDR_SOCKET_PROTOCOL, 16);
  assert.equal(HERDR_SOCKET_SCHEMA_VERSION, 1);
  assert.equal(HERDR_SOCKET_SOURCE_VERSION, "0.7.4");
  assert.equal(HERDR_SOCKET_SOURCE_REVISION, "a22454f27ce096585e19d1787dba43f56d1505cf");
  assert.equal(isHerdrSocketMethod("workspace.report_metadata"), true);
  assert.equal(isHerdrSocketMethod("pane.graphics.set"), true);
  assert.equal(isHerdrSocketMethod("popup.close"), true);
  assert.equal(isHerdrSocketMethod("pane.graphics.stream"), false);
  assert.equal(isHerdrSocketSubscription("workspace.metadata_updated"), true);
  assert.equal(isHerdrSocketSubscription("pane.updated"), true);
  assert.equal(isHerdrSocketSubscription("pane.scroll_changed"), true);
});

test("uses the synced event contract without enabling scroll polling", () => {
  const subscriptions = herdrEventSubscriptions(["w1:p1", "w1:p1", "w1:p2"]);
  assert.deepEqual(
    subscriptions.filter((item) => item.type === "pane.agent_status_changed"),
    [
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    ],
  );
  assert.deepEqual(subscriptions.filter((item) => item.type === "pane.scroll_changed"), []);
});

test("parses PaneInfo and pane.scroll_changed metrics", () => {
  assert.deepEqual(herdrPaneInfo({
    pane: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      scroll: {
        offset_from_bottom: 12,
        max_offset_from_bottom: 240,
        viewport_rows: 30,
      },
    },
  }), {
    paneId: "w1:p1",
    workspaceId: "w1",
    scroll: {
      offsetFromBottom: 12,
      maxOffsetFromBottom: 240,
      viewportRows: 30,
    },
  });
  const event = {
    pane_id: "w1:p1",
    workspace_id: "w1",
    scroll: {
      offset_from_bottom: 0,
      max_offset_from_bottom: 240,
      viewport_rows: 30,
    },
  };
  assert.equal(herdrPaneIdFromEvent(event), "w1:p1");
  assert.deepEqual(herdrScrollInfoFromEvent(event), {
    offsetFromBottom: 0,
    maxOffsetFromBottom: 240,
    viewportRows: 30,
  });
});

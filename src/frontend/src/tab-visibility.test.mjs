import assert from "node:assert/strict";
import test from "node:test";

import { visibleInstanceTabs } from "./tab-visibility.ts";

test("instance tab display keeps other instances available only in combined mode", () => {
  const tabs = [
    { id: "a1", selector: "alpha@owner" },
    { id: "b1", selector: "beta@owner" },
    { id: "a2", selector: "alpha@owner" },
  ];
  assert.deepEqual(visibleInstanceTabs(tabs, "alpha@owner", "combined"), tabs);
  assert.deepEqual(
    visibleInstanceTabs(tabs, "alpha@owner", "by-instance").map((tab) => tab.id),
    ["a1", "a2"],
  );
  assert.deepEqual(visibleInstanceTabs(tabs, "gamma@owner", "by-instance"), []);
});

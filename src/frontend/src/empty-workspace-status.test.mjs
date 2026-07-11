import assert from "node:assert/strict";
import test from "node:test";

import { statusForEmptyWorkspace } from "./empty-workspace-status.ts";

test("keeps an actionable error visible when the workspace has no pane", () => {
  assert.deepEqual(
    statusForEmptyWorkspace(
      { message: "连接失败：selector is not visible", tone: "error" },
      "空闲",
    ),
    { message: "连接失败：selector is not visible", tone: "error" },
  );
});

test("uses idle after a non-error status when the workspace has no pane", () => {
  assert.deepEqual(
    statusForEmptyWorkspace({ message: "实例已加载", tone: "ok" }, "空闲"),
    { message: "空闲", tone: "neutral" },
  );
});

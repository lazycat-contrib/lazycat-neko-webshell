import assert from "node:assert/strict";
import test from "node:test";
import { remoteTabTitle } from "./tab-labels.ts";

test("describes remote Herdr without exposing visible tab text", () => {
  assert.equal(
    remoteTabTitle(
      { label: "client:alice-pc" },
      { title: "shell", programKind: "herdr" },
      "Alice PC",
    ),
    "Alice PC — Herdr",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { herdrEventChangesDock, herdrEventShowsStatus } from "./herdr-backend.ts";

test("treats Herdr metadata snapshots as silent dock changes", () => {
  assert.equal(herdrEventChangesDock("workspace.metadata_updated"), true);
  assert.equal(herdrEventChangesDock("pane.updated"), true);
  assert.equal(herdrEventShowsStatus("workspace.metadata_updated"), false);
  assert.equal(herdrEventShowsStatus("pane.updated"), false);
});

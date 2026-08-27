import assert from "node:assert/strict";
import test from "node:test";

import { createProviderRevisionController } from "./provider-revision-controller.ts";

test("accepts the initial revision and ignores unchanged checks", async () => {
  const changed = [];
  const controller = createProviderRevisionController({
    fetchRevision: async () => "build-a",
    onChanged: (next, previous) => changed.push({ next, previous }),
  });
  controller.setInitialRevision("build-a");

  assert.equal(await controller.check(), false);
  assert.equal(controller.isStale(), false);
  assert.deepEqual(changed, []);
});

test("marks a changed provider stale once and keeps the old revision for diagnostics", async () => {
  const changed = [];
  const controller = createProviderRevisionController({
    fetchRevision: async () => "build-b",
    onChanged: (next, previous) => changed.push({ next, previous }),
  });
  controller.setInitialRevision("build-a");

  assert.equal(await controller.check(), true);
  assert.equal(await controller.check(), false);
  assert.equal(controller.isStale(), true);
  assert.equal(controller.expectedRevision(), "build-a");
  assert.deepEqual(changed, [{ next: "build-b", previous: "build-a" }]);
});

test("discards a late check from a previous initial revision", async () => {
  const pending = [];
  const changed = [];
  const controller = createProviderRevisionController({
    fetchRevision: () => new Promise((resolve) => pending.push(resolve)),
    onChanged: (next, previous) => changed.push({ next, previous }),
  });
  controller.setInitialRevision("build-a");
  const first = controller.check();
  controller.setInitialRevision("build-b");
  pending[0]("build-c");

  assert.equal(await first, false);
  assert.equal(controller.isStale(), false);
  assert.deepEqual(changed, []);
});

test("learns the first revision after an unavailable startup response", async () => {
  const controller = createProviderRevisionController({
    fetchRevision: async () => "build-a",
    onChanged: () => assert.fail("the first available revision is the baseline"),
  });
  controller.setInitialRevision("");

  assert.equal(await controller.check(), false);
  assert.equal(controller.expectedRevision(), "build-a");
  assert.equal(controller.isStale(), false);
});

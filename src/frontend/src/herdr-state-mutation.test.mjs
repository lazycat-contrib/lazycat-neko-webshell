import assert from "node:assert/strict";
import test from "node:test";

import {
  createHerdrStateMutationRunner,
  herdrStateMutationChangesVisibleTerminal,
} from "./herdr-state-mutation.ts";

function mutationRunner(overrides = {}) {
  const requests = [];
  const invalidations = [];
  const reconciliations = [];
  const run = createHerdrStateMutationRunner({
    selectedSelector: () => "alpha@owner",
    selectedGeneration: () => 7,
    request: async (method, params, options) => {
      requests.push({ method, params, options });
      return { result: { ok: true } };
    },
    isCurrent: (selector, generation) => selector === "alpha@owner" && generation === 7,
    canMutate: () => true,
    blockedError: () => new Error("observer"),
    invalidate: () => invalidations.push("invalidate"),
    reconcile: (method, selector) => reconciliations.push([method, selector]),
    ...overrides,
  });
  return { run, requests, invalidations, reconciliations };
}

test("invalidates pending state only after a current Herdr mutation succeeds", async () => {
  const { run, requests, invalidations } = mutationRunner();

  await run("pane.focus", { pane_id: "p2" }, { id: "focus" });

  assert.deepEqual(requests, [{
    method: "pane.focus",
    params: { pane_id: "p2" },
    options: { id: "focus", selector: "alpha@owner" },
  }]);
  assert.deepEqual(invalidations, ["invalidate"]);
});

test("does not invalidate the selected state when a completed mutation became stale", async () => {
  const { run, invalidations } = mutationRunner({ isCurrent: () => false });

  await run("pane.close", { pane_id: "p1" });

  assert.deepEqual(invalidations, []);
});

test("blocks observers before sending a Herdr state mutation", async () => {
  const { run, requests, invalidations } = mutationRunner({ canMutate: () => false });

  await assert.rejects(run("pane.split", { target_pane_id: "p1" }), /observer/);
  assert.deepEqual(requests, []);
  assert.deepEqual(invalidations, []);
});

test("reconciles current state when a Herdr mutation has an ambiguous failure", async () => {
  const { run, invalidations, reconciliations } = mutationRunner({
    request: async () => {
      throw new Error("focus failed");
    },
  });

  await assert.rejects(run("pane.focus", { pane_id: "p2" }), /focus failed/);
  assert.deepEqual(invalidations, ["invalidate"]);
  assert.deepEqual(reconciliations, [["pane.focus", "alpha@owner"]]);
});

test("replays only mutations that can change the visible terminal", () => {
  assert.equal(herdrStateMutationChangesVisibleTerminal("pane.focus"), true);
  assert.equal(herdrStateMutationChangesVisibleTerminal("pane.split"), true);
  assert.equal(herdrStateMutationChangesVisibleTerminal("workspace.rename"), false);
});

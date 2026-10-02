import assert from "node:assert/strict";
import test from "node:test";
import { createAgentUpdateController } from "./controller.ts";

const status = (kind = "optional", selector = "target@owner") => ({ selector, kind, currentVersion: 16,
  latestVersion: 17, minimumVersion: 11, protocol: "lazycat-neko-webshell-agent-v4", payloadManifest: "sha256:running" });
const promise = () => { let resolve; const pending = new Promise((done) => resolve = done); return { pending, resolve }; };
function setup(overrides = {}) {
  let target = { selector: "target@owner", generation: 1 };
  const rendered = []; const updates = [];
  const controller = createAgentUpdateController({ target: () => target,
    isCurrent: (value) => value.selector === target?.selector && value.generation === target?.generation,
    tr: (key) => key, render: (state, notice) => rendered.push({ state, notice }),
    inspect: async (selector) => status("optional", selector),
    update: async (value, optional) => { updates.push({ value, optional }); return status(optional ? "pending_restart" : "ready", value.selector); },
    ...overrides });
  return { controller, rendered, updates, select: (value) => { target = value; } };
}

test("compatible updates wait for explicit preparation and later only suppresses the notice", async () => {
  const { controller, rendered, updates } = setup();
  await controller.refresh(); assert.equal(updates.length, 0); assert.equal(rendered.at(-1).notice, true);
  controller.later(); assert.equal(rendered.at(-1).notice, false); assert.equal(rendered.at(-1).state.status.kind, "optional");
  await controller.prepare(); assert.equal(updates[0].optional, true); assert.equal(rendered.at(-1).state.status.kind, "pending_restart");
});

test("required compatibility updates run automatically without a choice", async () => {
  const { controller, updates, rendered } = setup({ inspect: async () => status("required") });
  await controller.refresh(); assert.equal(updates.length, 1); assert.equal(updates[0].optional, false);
  assert.equal(rendered.at(-1).state.status.kind, "ready");
});

test("newer protocols and prepared payloads do not trigger an update", async () => {
  for (const kind of ["provider_older", "pending_restart", "ready"]) {
    const { controller, updates } = setup({ inspect: async () => status(kind) });
    await controller.refresh(); await controller.prepare(); assert.equal(updates.length, 0);
  }
});

test("late checks and update replies cannot affect another selector generation", async () => {
  const delayed = promise();
  const { controller, rendered, select } = setup({ inspect: () => delayed.pending });
  const check = controller.refresh(); select(undefined); await controller.refresh();
  delayed.resolve(status()); await check; assert.equal(rendered.at(-1).state, undefined);
  const delayedUpdate = promise();
  const second = setup({ update: () => delayedUpdate.pending });
  await second.controller.refresh(); const preparing = second.controller.prepare();
  second.select(undefined); await second.controller.refresh(); delayedUpdate.resolve(status("pending_restart")); await preparing;
  assert.equal(second.rendered.at(-1).state, undefined);
});

test("refresh does not race an ongoing update on the same target", async () => {
  const delayed = promise(); let checks = 0;
  const { controller, rendered } = setup({ inspect: async () => { checks += 1; return status(); }, update: () => delayed.pending });
  await controller.refresh(); const preparing = controller.prepare(); await controller.refresh();
  assert.equal(checks, 1); assert.equal(rendered.at(-1).state.busy, true);
  delayed.resolve(status("pending_restart")); await preparing; assert.equal(rendered.at(-1).state.busy, false);
});

test("errors keep a retry path and ineligible targets stay hidden", async () => {
  let fail = true;
  const { controller, rendered, select } = setup({ inspect: async () => { if (fail) throw new Error("offline"); return status(); } });
  await controller.refresh(); assert.ok(rendered.at(-1).state.error); fail = false; await controller.refresh();
  assert.equal(rendered.at(-1).state.status.kind, "optional"); select(undefined); await controller.refresh();
  assert.equal(rendered.at(-1).state, undefined);
});


test("target readiness can supersede an inspection started before the agent was reachable", async () => {
  const delayed = promise(); let checks = 0;
  const { controller, rendered, updates } = setup({ inspect: () => ++checks === 1 ? delayed.pending : Promise.resolve(status()) });
  const early = controller.refresh();
  await controller.refresh();
  delayed.resolve(status("required")); await early;
  assert.equal(rendered.at(-1).state.status.kind, "optional");
  assert.equal(rendered.at(-1).notice, true);
  assert.equal(updates.length, 0);
});


test("background checks preserve a known optional update entry", async () => {
  const delayed = promise(); let checks = 0;
  const { controller, rendered } = setup({ inspect: () => ++checks === 1 ? Promise.resolve(status()) : delayed.pending });
  await controller.refresh();
  const checking = controller.refresh();
  assert.equal(rendered.at(-1).notice, true);
  assert.equal(rendered.at(-1).state.busy, true);
  delayed.resolve(status()); await checking;
  assert.equal(rendered.at(-1).notice, true);
});

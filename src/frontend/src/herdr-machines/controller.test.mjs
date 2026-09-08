import test from "node:test";
import assert from "node:assert/strict";
import { createMachineController } from "./controller.ts";
import { parseMachineCatalog, validMachineForm, visibleMachines } from "./model.ts";
import { renderMachineDialog } from "./view-render.ts";
const machine = { id: "a".repeat(32), label: "Build", target: "build-alias", session: "default", enabled: true, selected: false };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  let target = { selector: "dev@owner", generation: 1 };
  let state, stopped = 0, closed = 0, callback;
  const requests = [], setups = [];
  const controller = createMachineController({
    target: () => target,
    request: async (target, action) => { requests.push(action); return { supported: true, machines: [{ ...machine }] }; },
    hosts: async () => [{ alias: "build-alias" }, { alias: "prod" }, { alias: "*" }],
    changed: next => { state = next; }, close: () => { closed++; },
    setup: (target, action, done) => { setups.push({ target, action }); callback = done; return () => { stopped++; }; },
    tr: key => key,
    ...overrides,
  });
  return { controller, requests, setups, state: () => state, done: (...args) => callback(...args), stopped: () => stopped, closed: () => closed, switchTarget() { target = { ...target, generation: target.generation + 1 }; } };
}

test("machine labels are primary and searchable without inventing online status", () => {
  assert.equal(visibleMachines([machine], "BUILD").length, 1);
  assert.equal(visibleMachines([machine], "alias").length, 1);
  assert.equal(visibleMachines([machine], "default").length, 1);
  assert.throws(() => parseMachineCatalog({ supported: true, machines: [machine, machine] }));
  assert.equal(validMachineForm({ label: "机器", target: "ssh://user@host:2222", session: "agents.v2" }), true);
  assert.equal(validMachineForm({ label: "机".repeat(43), target: "host", session: "default" }), false);
  assert.equal(validMachineForm({ label: "Build", target: "-oProxyCommand=x", session: "default" }), false);
});

test("add reads config aliases, auto-fills label and retains customized names", async () => {
  const f = fixture(); await f.controller.open(); await f.controller.add();
  assert.deepEqual(f.state().hosts, [{ alias: "build-alias" }, { alias: "prod" }]);
  assert.equal(f.state().form.label, "build-alias");
  f.controller.setForm("target", "prod");
  f.controller.setForm("label", "Production");
  f.controller.setForm("target", "prod-next");
  f.controller.submit();
  assert.deepEqual(f.setups[0].action, { action: "add", target: "prod-next", label: "Production", session: "default" });
});

test("connection test never adds a machine and returns to the preserved form", async () => {
  const f = fixture(); await f.controller.open(); await f.controller.add();
  f.controller.setForm("label", "Build server"); f.controller.setForm("session", "agents");
  f.controller.test(); f.controller.test();
  assert.deepEqual(f.setups.map(item => item.action), [{ action: "test", target: "build-alias" }]);
  f.done(0);
  assert.equal(f.state().screen, "add");
  assert.deepEqual(f.state().form, { target: "build-alias", label: "Build server", session: "agents" });
  assert.equal(f.state().message, "machines.testPassed");
  assert.equal(f.requests.length, 1);
  assert.equal(f.stopped(), 1);
  f.controller.submit();
  assert.equal(f.setups[1].action.action, "add");
});

test("failed test retains output and form; changing target cancels setup and ignores late success", async () => {
  const f = fixture(); await f.controller.open(); await f.controller.add();
  f.controller.test(); f.done(1, "Permission denied");
  assert.equal(f.state().screen, "setup"); assert.equal(f.state().message, "Permission denied");
  f.controller.back(); assert.equal(f.state().screen, "add");
  f.controller.test(); f.switchTarget(); f.controller.sync(); f.done(0);
  assert.equal(f.stopped(), 2); assert.equal(f.requests.length, 1);
});

test("stale catalog responses cannot replace a reopened manager", async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ request: () => ++calls === 1 ? pending.promise : Promise.resolve({ supported: true, machines: [] }) });
  const first = f.controller.open(); f.controller.dismiss(); await f.controller.open();
  pending.resolve({ supported: true, machines: [machine] }); await first;
  assert.deepEqual(f.state().machines, []); assert.equal(f.state().busy, false);
});

test("removal is explicitly submitted, revalidated and serialized", async () => {
  const pending = deferred(); const mutations = [];
  const f = fixture({ request: async (_target, action) => { if (action) { mutations.push(action); return pending.promise; } return { supported: true, machines: [{ ...machine }] }; } });
  await f.controller.open(); f.controller.edit(machine.id, true);
  assert.equal(mutations.length, 0);
  f.controller.submit(); await flush(); f.controller.submit(); f.controller.toggle(machine.id);
  assert.deepEqual(mutations, [{ action: "remove", id: machine.id, expected: machine }]);
  pending.resolve({ supported: true, machines: [] }); await flush();
  assert.equal(f.state().screen, "list"); assert.deepEqual(f.state().machines, []);
});

test("changed machine identities are not removed after confirmation", async () => {
  let calls = 0; const writes = [];
  const f = fixture({ request: async (_target, action) => { if (action) writes.push(action); return { supported: true, machines: [{ ...machine, label: ++calls === 1 ? machine.label : "Renamed elsewhere" }] }; } });
  await f.controller.open(); f.controller.edit(machine.id, true); f.controller.submit(); await flush();
  assert.deepEqual(writes, []); assert.equal(f.state().message, "machines.changed");
});

test("machine markup escapes untrusted labels and targets and offers an optional test", async () => {
  const f = fixture({ request: async () => ({ supported: true, machines: [{ ...machine, label: '<img src=x onerror="evil()">', target: '<script>evil()</script>' }] }) });
  await f.controller.open();
  const html = renderMachineDialog(f.state(), key => key);
  assert(!html.includes('<img src=x')); assert(!html.includes('<script>')); assert(!html.includes("online"));
  assert(html.includes("&lt;img"));
  await f.controller.add();
  assert(renderMachineDialog(f.state(), key => key).includes('data-machine-action="test"'));
});

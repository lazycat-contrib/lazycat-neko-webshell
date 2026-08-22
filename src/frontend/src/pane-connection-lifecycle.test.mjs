import assert from "node:assert/strict";
import test from "node:test";
import { createPaneConnectionLifecycle } from "./pane-connection-lifecycle.ts";

function pane() {
  return {
    reconnectDelay: 1000,
    connectionState: "idle",
    hasConnected: true,
    sessionStatus: "running",
    sessionBackend: "webshell",
  };
}

function setup(online) {
  const statuses = [];
  const timers = [];
  let connects = 0;
  const lifecycle = createPaneConnectionLifecycle({
    canConnect: () => true,
    autoRestartEnabled: () => false,
    isHerdr: () => false,
    isOnline: () => online,
    connect: () => { connects += 1; },
    setStatus: (_pane, message, tone) => statuses.push([message, tone]),
    tr: (key, values) => values ? `${key}:${values.seconds}` : key,
    random: () => 0,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { lifecycle, statuses, timers, connects: () => connects };
}

test("keeps bounded reconnect attempts active when navigator reports offline", () => {
  const target = pane();
  const subject = setup(false);
  subject.lifecycle.scheduleReconnect(target);
  assert.equal(target.connectionState, "offline");
  assert.equal(subject.timers[0].delay, 5000);
  subject.timers[0].callback();
  assert.equal(subject.connects(), 1);
});

test("projects connection lifecycle states and clears retry state on success", () => {
  const target = pane();
  const subject = setup(true);
  subject.lifecycle.beginConnection(target);
  assert.equal(target.connectionState, "reconnecting");
  subject.lifecycle.markReplaying(target);
  assert.equal(target.connectionState, "replaying");
  subject.lifecycle.markConnected(target);
  assert.equal(target.connectionState, "connected");
  assert.deepEqual(subject.statuses.at(-1), ["status.shellReady", "ok"]);
});

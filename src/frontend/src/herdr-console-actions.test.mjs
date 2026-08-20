import assert from "node:assert/strict";
import test from "node:test";

import {
  createPinnedHerdrRequester,
  herdrAgentKinds,
  herdrBypassArgs,
  herdrCreatedPaneId,
  herdrProcessInfoShowsShellInitialization,
  herdrSearchResults,
  startHerdrAgent,
} from "./herdr-console-actions.ts";
import { HerdrSocketRequestError } from "./herdr-socket-api.ts";

const state = {
  workspaces: [
    {
      workspace_id: "w1",
      number: 1,
      label: "Payments",
      focused: true,
      active_tab_id: "t1",
      tab_count: 1,
      pane_count: 2,
      tokens: {},
    },
    {
      workspace_id: "w2",
      number: 2,
      label: "Docs",
      focused: false,
      active_tab_id: "t2",
      tab_count: 1,
      pane_count: 1,
      tokens: {},
    },
  ],
  agents: [
    {
      terminal_id: "term-1",
      name: "claude",
      agent: "claude",
      display_agent: "Claude",
      agent_status: "working",
      workspace_id: "w1",
      tab_id: "t1",
      pane_id: "p1",
      focused: true,
      revision: 1,
      launch_pending: false,
      interactive_ready: true,
      state_change_seq: 10,
      title: "Fix checkout",
      tokens: {},
    },
    {
      terminal_id: "term-2",
      name: "codex",
      agent: "codex",
      display_agent: "Codex",
      agent_status: "blocked",
      workspace_id: "w2",
      tab_id: "t2",
      pane_id: "p2",
      focused: false,
      revision: 1,
      launch_pending: false,
      interactive_ready: true,
      state_change_seq: 12,
      title: "Write guide",
      tokens: {},
    },
  ],
};

test("searches HerdrM-style Agent and space navigation on the current target", () => {
  const docs = herdrSearchResults(state, "docs");
  assert.deepEqual(docs.map((result) => result.id), ["agent:p2", "workspace:w2"]);
  assert.equal(docs[0].label, "Write guide");
  assert.equal(docs[0].status, "blocked");
  assert.equal(docs[1].agentCount, 1);

  const claude = herdrSearchResults(state, "claude");
  assert.deepEqual(claude.map((result) => result.id), ["agent:p1"]);
});

test("orders blocked Agents before working Agents in the empty command palette", () => {
  const withDone = {
    ...state,
    agents: [
      ...state.agents,
      { ...state.agents[0], pane_id: "p3", terminal_id: "term-3", agent_status: "done" },
    ],
  };
  const results = herdrSearchResults(withDone, "");
  assert.deepEqual(results.slice(0, 3).map((result) => result.id), ["agent:p2", "agent:p3", "agent:p1"]);
});

test("normalizes manifest Agent kinds and keeps a compatible fallback", () => {
  assert.deepEqual(herdrAgentKinds({
    result: {
      manifests: [{ agent: "codex" }, { agent: " claude " }, { agent: "codex" }],
    },
  }), ["claude", "codex"]);
  assert.ok(herdrAgentKinds(undefined).includes("claude"));
});

test("maps verified bypass flags and parses the new pane id", () => {
  assert.deepEqual(herdrBypassArgs("claude", true), ["--dangerously-skip-permissions"]);
  assert.deepEqual(herdrBypassArgs("unknown", true), []);
  assert.deepEqual(herdrBypassArgs("claude", false), []);
  assert.equal(herdrCreatedPaneId({ result: { root_pane: { pane_id: "p-new" } } }), "p-new");
  assert.equal(herdrCreatedPaneId({ result: {} }), "");
});

test("retries a newly created pane while its shell is initializing", async () => {
  const calls = [];
  const delays = [];
  await startHerdrAgent(async (method, params) => {
    calls.push([method, params]);
    if (calls.length < 3) {
      throw new HerdrSocketRequestError({ code: "agent_pane_busy", message: "pane is still busy" });
    }
    return { result: {} };
  }, {
    name: "claude",
    kind: "claude",
    paneId: "p-new",
    args: ["--dangerously-skip-permissions"],
  }, {
    readRequest: async (method) => method === "pane.get"
      ? { result: { pane: { terminal_id: "term-new" } } }
      : {
          result: {
            process_info: {
              shell_pid: 42,
              foreground_process_group_id: 42,
              foreground_processes: [{ pid: 42, name: "-zsh", argv: ["/bin/zsh"] }],
            },
          },
        },
    delay: async (milliseconds) => { delays.push(milliseconds); },
    now: () => 0,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [100, 100]);
  assert.equal(calls[2][1].pane_id, "p-new");
});

test("does not retry a busy pane after its pinned terminal is replaced", async () => {
  let paneReads = 0;
  let starts = 0;
  await assert.rejects(startHerdrAgent(async () => {
    starts += 1;
    throw new HerdrSocketRequestError({ code: "agent_pane_busy" });
  }, {
    name: "claude",
    kind: "claude",
    paneId: "p-new",
    args: [],
  }, {
    readRequest: async (method) => {
      if (method === "pane.get") {
        paneReads += 1;
        return { result: { pane: { terminal_id: paneReads === 1 ? "term-a" : "term-b" } } };
      }
      return { result: {} };
    },
    now: () => 0,
  }), (error) => error.code === "agent_pane_busy");

  assert.equal(starts, 1);
});

test("detects only an initializing foreground shell", () => {
  assert.equal(herdrProcessInfoShowsShellInitialization({
    shell_pid: 42,
    foreground_process_group_id: 42,
    foreground_processes: [{ pid: 42, name: "-zsh", argv: ["/bin/zsh"] }],
  }), true);
  assert.equal(herdrProcessInfoShowsShellInitialization({
    shell_pid: 42,
    foreground_process_group_id: 99,
    foreground_processes: [{ pid: 99, name: "vim" }],
  }), false);
  assert.equal(herdrProcessInfoShowsShellInitialization({
    shell_pid: 42,
    foreground_process_group_id: 42,
    foreground_processes: [{ pid: 42, name: "opencode" }],
  }), false);
});

test("stops a pinned multi-step request when the selected target changes", async () => {
  const target = { selector: "alpha@owner", generation: 7 };
  let current = true;
  const requests = [];
  const request = createPinnedHerdrRequester(
    target,
    () => current,
    async (method, params, requestTarget) => {
      requests.push({ method, params, target: requestTarget });
      current = false;
      return { result: { root_pane: { pane_id: "p-new" } } };
    },
    () => new Error("target changed"),
  );

  await assert.rejects(request("tab.create", { workspace_id: "w1" }), /target changed/);
  await assert.rejects(request("agent.start", { pane_id: "p-new" }), /target changed/);
  assert.deepEqual(requests.map((entry) => entry.method), ["tab.create"]);
  assert.deepEqual(requests[0].target, target);
});

test("retries an Agent name collision once with a unique suffix", async () => {
  const names = [];
  await startHerdrAgent(async (_method, params) => {
    names.push(params.name);
    if (names.length === 1) throw new HerdrSocketRequestError({ code: "agent_name_taken" });
    return { result: {} };
  }, {
    name: "codex",
    kind: "codex",
    paneId: "p-new",
    args: [],
  }, {
    uniqueSuffix: () => "a1b2",
  });

  assert.deepEqual(names, ["codex", "codex-a1b2"]);
});

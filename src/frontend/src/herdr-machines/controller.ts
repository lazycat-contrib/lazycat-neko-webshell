import type { MessageKey } from "../i18n.ts";
import { sameMachineTarget, validMachineForm, type HostChoice, type MachineSetup, type MachineCatalog, type MachineForm, type MachineMutation, type MachineState, type MachineTarget } from "./model.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
export function createMachineController(options: {
  target: () => MachineTarget | undefined;
  request: (target: MachineTarget, action?: MachineMutation) => Promise<MachineCatalog>;
  hosts: (target: MachineTarget) => Promise<HostChoice[]>;
  changed: (state: MachineState) => void;
  close: () => void;
  setup: (target: MachineTarget, action: MachineSetup, done: (code: number, message?: string) => void) => () => void;
  tr: Translate;
}) {
  let target: MachineTarget | undefined;
  let version = 0;
  let stopSetup: (() => void) | undefined;
  let state: MachineState = initial();
  let drafts: Partial<Record<"config" | "manual", MachineForm>> = {};
  const publish = () => options.changed({ ...state, form: { ...state.form }, machines: [...state.machines] });
  const current = (operation = version) => operation === version && sameMachineTarget(target, options.target());
  const message = (key: MessageKey) => { state.message = options.tr(key); state.error = false; };
  function initial(): MachineState { return { screen: "list", source: "config", machines: [], supported: true, loaded: false, busy: false, hosts: [], hostError: false, query: "", form: { target: "", label: "", session: "default" }, message: "", error: false, setupFinished: false, setupMode: "add" }; }
  function fail(error: unknown, operation: number) {
    if (!current(operation)) { sync(); return; }
    state.busy = false; state.error = true; state.message = error instanceof Error ? error.message : String(error); publish();
  }
  function sync() { if (target && !current()) dismiss(); }
  function dismiss() { version++; target = undefined; stopSetup?.(); stopSetup = undefined; options.close(); }
  async function open() {
    dismiss(); const selected = options.target(); target = selected ? { ...selected } : undefined; if (!target) return;
    state = initial(); await refresh();
  }
  async function refresh() {
    if (!target || !current() || state.busy) return;
    const operation = ++version; state.busy = true; state.message = ""; state.error = false; publish();
    try {
      const catalog = await options.request(target);
      if (!current(operation)) { sync(); return; }
      state.machines = catalog.machines; state.supported = catalog.supported; state.loaded = true; state.busy = false; publish();
    } catch (error) { fail(error, operation); }
  }
  async function add() {
    if (!target || !current() || state.busy || !state.loaded || !state.supported) return;
    const operation = ++version;
    drafts = {}; state.screen = "add"; state.source = "config"; state.form = { target: "", label: "", session: "default" }; state.busy = true; state.message = ""; state.error = false; state.hostError = false; publish();
    try {
      const hosts = await options.hosts(target);
      if (!current(operation)) { sync(); return; }
      state.hosts = hosts.filter(host => typeof host.alias === "string" && host.alias && !/[!*?\[\]\s]/.test(host.alias));
      const first = state.hosts[0]?.alias ?? "";
      state.form = { target: first, label: first, session: "default" };
      state.source = first ? "config" : "manual";
    } catch { if (!current(operation)) { sync(); return; } state.hosts = []; state.hostError = true; state.source = "manual"; }
    state.busy = false; publish();
  }
  function source(source: "config" | "manual") {
    if (state.busy || state.screen !== "add" || source === state.source) return;
    drafts[state.source] = { ...state.form };
    state.source = source;
    const target = source === "config" ? state.hosts[0]?.alias ?? "" : "";
    state.form = drafts[source] ?? { target, label: target, session: "default" };
    state.message = ""; state.error = false; publish();
  }
  function setForm(field: keyof MachineForm, value: string) {
    if (state.busy) return;
    if (field === "target" && (!state.form.label || state.form.label === state.form.target)) state.form.label = value;
    state.form[field] = value;
    if (state.setupMode === "test") state.message = "";
    return { ...state.form };
  }
  function edit(id: string, remove = false) {
    if (!current() || state.busy) return;
    const machine = state.machines.find(item => item.id === id); if (!machine) return;
    state.editing = { ...machine }; state.form = { target: machine.target, label: machine.label, session: machine.session };
    state.screen = remove ? "remove" : "rename"; state.message = ""; state.error = false; publish();
  }
  function back() {
    if (state.busy && state.screen !== "setup" && state.screen !== "add") return;
    const returnToForm = state.screen === "setup" && state.setupMode === "test";
    version++; stopSetup?.(); stopSetup = undefined; state.busy = false; state.screen = returnToForm ? "add" : "list"; state.message = ""; state.error = false; publish();
    if (!returnToForm) void refresh();
  }
  async function mutate(action: MachineMutation) {
    if (!target || !current() || state.busy) return;
    const operation = ++version; state.busy = true; state.message = ""; state.error = false; publish();
    try {
      // Revalidate removal identity after the user has reviewed its label and target.
      if (action.action === "remove") {
        const catalog = await options.request(target);
        if (!current(operation)) { sync(); return; }
        const latest = catalog.machines.find(machine => machine.id === action.id);
        if (!latest || !state.editing || ["label", "target", "session", "enabled"].some(key => latest[key as keyof typeof latest] !== state.editing![key as keyof typeof latest])) throw new Error(options.tr("machines.changed"));
      }
      const catalog = await options.request(target, action);
      if (!current(operation)) { sync(); return; }
      state.machines = catalog.machines; state.supported = catalog.supported; state.busy = false; state.screen = "list";
      message("machines.saved"); publish();
    } catch (error) { fail(error, operation); }
  }
  function toggle(id: string) {
    const machine = state.machines.find(item => item.id === id);
    if (machine) void mutate({ action: machine.enabled ? "disable" : "enable", id });
  }
  function submit(test = false) {
    if (state.busy || !current() || !target) return;
    if (state.screen === "remove" && state.editing) { void mutate({ action: "remove", id: state.editing.id, expected: { ...state.editing } }); return; }
    const form = { target: state.form.target.trim(), label: state.form.label.trim(), session: state.form.session.trim() || "default" };
    if (!validMachineForm(test ? { ...form, label: form.label || form.target, session: "default" } : form)) { state.message = options.tr("machines.invalidForm"); state.error = true; publish(); return; }
    state.form = form;
    if (state.screen === "rename" && state.editing) { void mutate({ action: "rename", id: state.editing.id, label: form.label }); return; }
    if (state.screen !== "add") return;
    const operation = ++version;
    state.screen = "setup"; state.setupMode = test ? "test" : "add"; state.busy = true; state.setupFinished = false; message(test ? "machines.testHint" : "machines.setupHint"); publish();
    try {
      stopSetup = options.setup(target, test ? { action: "test", target: form.target } : { action: "add", ...form }, (code, detail) => {
        if (!current(operation)) { sync(); return; }
        state.setupFinished = true; state.busy = false; state.error = code !== 0;
        state.message = detail || options.tr(code === 0 ? test ? "machines.testPassed" : "machines.added" : test ? "machines.testFailed" : "machines.setupFailed");
        if (test && code === 0) { state.screen = "add"; stopSetup?.(); stopSetup = undefined; }
        publish();
        // Preserve terminal output until the user returns to the refreshed list.
        if (code === 0 && !test && target) void options.request(target).then(catalog => {
          if (!current(operation)) return;
          state.machines = catalog.machines; publish();
        }).catch(() => {});
      });
    } catch (error) { state.setupFinished = true; fail(error, operation); }
  }
  return { open, refresh, add, source, edit, toggle, submit, test: () => submit(true), setForm, back, dismiss, sync, setQuery(query: string) { state.query = query; publish(); } };
}

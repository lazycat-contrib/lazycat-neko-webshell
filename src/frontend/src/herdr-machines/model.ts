export type Machine = { id: string; label: string; target: string; session: string; enabled: boolean; selected: boolean };
export type MachineCatalog = { supported: boolean; machines: Machine[] };
export type MachineTarget = { selector: string; generation: number };
export type MachineAdd = { action: "add"; target: string; label: string; session: string };
export type MachineSetup = MachineAdd | { action: "test"; target: string };
export type MachineMutation = { action: "rename"; id: string; label: string } | { action: "remove"; id: string; expected: Machine } | { action: "enable" | "disable"; id: string };
export type HostChoice = { alias: string };
export type MachineForm = { target: string; label: string; session: string };
export type MachineScreen = "list" | "add" | "rename" | "remove" | "setup";
export type MachineState = {
  screen: MachineScreen; source: "config" | "manual"; machines: Machine[]; supported: boolean; loaded: boolean; busy: boolean;
  hosts: HostChoice[]; hostError: boolean; query: string; form: MachineForm; editing?: Machine;
  message: string; error: boolean; setupFinished: boolean; setupMode: "add" | "test";
};

export function parseMachineCatalog(value: unknown): MachineCatalog {
  const catalog = value as MachineCatalog | null;
  if (!catalog || typeof catalog.supported !== "boolean" || !Array.isArray(catalog.machines) || catalog.machines.length > 64) throw new Error("Invalid Herdr machine catalog");
  const ids = new Set<string>();
  for (const machine of catalog.machines) {
    if (!machine || typeof machine.id !== "string" || !/^[a-f0-9]{32}$/i.test(machine.id) || ids.has(machine.id)
      || typeof machine.label !== "string" || typeof machine.target !== "string" || typeof machine.session !== "string"
      || typeof machine.enabled !== "boolean" || typeof machine.selected !== "boolean") throw new Error("Invalid Herdr machine profile");
    ids.add(machine.id);
  }
  if (!catalog.supported && catalog.machines.length) throw new Error("Invalid unsupported Herdr machine catalog");
  return catalog;
}

export function visibleMachines(machines: Machine[], query: string): Machine[] {
  const needle = query.trim().toLocaleLowerCase();
  return machines.filter(machine => `${machine.label}\n${machine.target}\n${machine.session}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id));
}

export function sameMachineTarget(a: MachineTarget | undefined, b: MachineTarget | undefined): boolean {
  return Boolean(a && b && a.selector === b.selector && a.generation === b.generation);
}

export function validMachineForm(form: MachineForm): boolean {
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  return Boolean(form.label.trim() && bytes(form.label.trim()) <= 128 && !/[\x00-\x1f\x7f]/.test(form.label)
    && form.target.trim() && !/^[\s-]|[\s\x00-\x1f\x7f]/.test(form.target) && bytes(form.target) <= 1024
    && /^[a-z0-9_.-]{1,64}$/i.test(form.session) && ![".", ".."].includes(form.session));
}

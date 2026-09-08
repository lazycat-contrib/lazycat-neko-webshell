import { parseMachineCatalog, type MachineMutation } from "./model.ts";

export function machineUrl(selector: string, setup = false): URL {
  const url = new URL(`./api/herdr/machines${setup ? "/setup" : ""}`, window.location.href);
  url.searchParams.set("name", selector);
  if (setup) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export async function requestMachines(selector: string, action?: MachineMutation) {
  const response = await fetch(machineUrl(selector), {
    credentials: "same-origin", cache: "no-store",
    ...(action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) } : {}),
  });
  if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
  return parseMachineCatalog(await response.json());
}

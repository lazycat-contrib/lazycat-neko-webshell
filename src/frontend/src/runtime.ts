export type RuntimeInfo = {
  mode: "lightos" | "generic";
  lightosFeaturesEnabled: boolean;
  revision: string;
};

export async function fetchRuntimeInfo(): Promise<RuntimeInfo> {
  const response = await fetch(new URL("./api/runtime", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  const payload = await response.json() as Partial<RuntimeInfo>;
  return {
    mode: payload.mode === "generic" ? "generic" : "lightos",
    lightosFeaturesEnabled: Boolean(payload.lightosFeaturesEnabled),
    revision: typeof payload.revision === "string" ? payload.revision.trim().slice(0, 256) : "",
  };
}

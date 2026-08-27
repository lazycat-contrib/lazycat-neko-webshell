export type ProviderRevisionControllerOptions = {
  fetchRevision: () => Promise<string>;
  onChanged: (nextRevision: string, expectedRevision: string) => void;
};

export function createProviderRevisionController(options: ProviderRevisionControllerOptions) {
  let expectedRevision = "";
  let stale = false;
  let generation = 0;
  let checkInFlight: Promise<boolean> | undefined;

  function setInitialRevision(revision: string): void {
    expectedRevision = normalizeRevision(revision);
    stale = false;
    generation += 1;
  }

  function check(): Promise<boolean> {
    if (stale) return Promise.resolve(false);
    if (checkInFlight) return checkInFlight;
    const requestGeneration = generation;
    const request = options.fetchRevision().then((revision) => {
      const nextRevision = normalizeRevision(revision);
      if (requestGeneration !== generation || stale || !nextRevision) return false;
      if (!expectedRevision) {
        expectedRevision = nextRevision;
        return false;
      }
      if (nextRevision === expectedRevision) return false;
      stale = true;
      options.onChanged(nextRevision, expectedRevision);
      return true;
    }).catch(() => false);
    const tracked = request.finally(() => {
      if (checkInFlight === tracked) checkInFlight = undefined;
    });
    checkInFlight = tracked;
    return tracked;
  }

  return {
    check,
    setInitialRevision,
    isStale: () => stale,
    expectedRevision: () => expectedRevision,
  };
}

function normalizeRevision(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 256) : "";
}

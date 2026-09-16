import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBrowserDriverNavigation } from "./browser-driver.mjs";

const scenarios = new Map([
  ["mobile-workflow", { module: "./mobile-workflow/run.mjs", exportName: "runMobileWorkflowScenario" }],
  ["herdr-history", { module: "./herdr-history/run.mjs", exportName: "runHerdrHistoryScenario" }],
  ["mobile-keyboard", { module: "./mobile-keyboard/run.mjs", exportName: "runMobileKeyboardScenario" }],
  ["mobile-layout", { module: "./mobile-layout/run.mjs", exportName: "runMobileLayoutScenario" }],
  [
    "workspace-sync",
    {
      module: "./workspace-sync/run.mjs",
      exportName: "runWorkspaceSyncScenario",
    },
  ],
  [
    "herdr-pointer",
    {
      module: "./herdr-pointer/run.mjs",
      exportName: "runHerdrPointerScenario",
    },
  ],
]);

export async function runBrowserScenarios(requested = []) {
  const names = requested.length ? requested : [...scenarios.keys()];
  const unknown = names.filter((name) => !scenarios.has(name));
  if (unknown.length) {
    throw new Error(
      `unknown browser scenario${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}; expected ${[...scenarios.keys()].join(", ")}`,
    );
  }

  await verifyBrowserDriverNavigation();
  const results = [];
  for (const name of names) {
    const definition = scenarios.get(name);
    const module = await import(definition.module);
    const run = module[definition.exportName];
    if (typeof run !== "function") {
      throw new Error(`${definition.module} must export ${definition.exportName}()`);
    }
    const result = await run();
    if (result?.status !== "passed") {
      throw new Error(`${name} did not report a passed result: ${JSON.stringify(result)}`);
    }
    results.push(result);
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBrowserScenarios(process.argv.slice(2))
    .then((results) => {
      process.stdout.write(`${JSON.stringify({ status: "passed", scenarios: results }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}

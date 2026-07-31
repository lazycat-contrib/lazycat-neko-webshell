import type { HerdrInteractionQueue } from "./herdr-interaction-queue.ts";
import type { HerdrAction } from "./types.ts";

export type HerdrActionOptions = {
  workspaceId?: string;
  tabId?: string;
};

export type HerdrActionOptionsSource = HerdrActionOptions | (() => HerdrActionOptions);

export function scheduleHerdrAction<T>(
  queue: HerdrInteractionQueue,
  action: HerdrAction,
  options: HerdrActionOptionsSource,
  task: (resolvedOptions: HerdrActionOptions) => Promise<T>,
): Promise<T | undefined> {
  const scheduledTask = () => task(typeof options === "function" ? options() : options);
  return action === "focus_workspace" || action === "focus_tab"
    ? queue.runLatest("focus", scheduledTask)
    : queue.run(scheduledTask);
}

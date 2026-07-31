import type { HerdrInteractionQueue } from "./herdr-interaction-queue.ts";
import type { HerdrAction } from "./types.ts";

export type HerdrStructuralAction = Exclude<HerdrAction, "focus_workspace" | "focus_tab">;

export type HerdrActionOptions = {
  workspaceId?: string;
};

export type HerdrActionOptionsSource = HerdrActionOptions | (() => HerdrActionOptions);

export function scheduleHerdrAction<T>(
  queue: HerdrInteractionQueue,
  options: HerdrActionOptionsSource,
  task: (resolvedOptions: HerdrActionOptions) => Promise<T>,
): Promise<T> {
  const scheduledTask = () => task(typeof options === "function" ? options() : options);
  return queue.run(scheduledTask);
}

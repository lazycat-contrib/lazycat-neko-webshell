export type HerdrActivity = "blocked" | "working" | "done" | "idle" | "unknown" | "error";

const priority: Record<HerdrActivity, number> = { error: 5, blocked: 4, working: 3, done: 2, idle: 1, unknown: 0 };
const glyphs: Record<HerdrActivity, string> = { error: "!", blocked: "!", working: "◐", done: "✓", idle: "○", unknown: "·" };

export function normalizeHerdrActivity(value: string | undefined): HerdrActivity {
  return value && Object.hasOwn(priority, value) ? value as HerdrActivity : "unknown";
}

export function aggregateHerdrActivity(statuses: readonly string[]): HerdrActivity {
  let result: HerdrActivity = "unknown";
  for (const value of statuses) {
    const status = normalizeHerdrActivity(value);
    if (priority[status] > priority[result]) result = status;
  }
  return result;
}

export function herdrActivityGlyph(status: string): string {
  return glyphs[normalizeHerdrActivity(status)];
}

import { herdrAgentInfo } from "../../herdr-socket-api.ts";
import type { HerdrAgentInfo, JsonRecord, Tone } from "../../types";

export const HERDR_AGENT_PROMPT_TIMEOUT_MS = 120_000;

export function herdrAgentPromptParams(target: string, text: string): JsonRecord {
  return {
    target: target.trim(),
    text: text.trim(),
    wait: {
      until: ["done", "blocked"],
      timeout_ms: HERDR_AGENT_PROMPT_TIMEOUT_MS,
    },
  };
}

export function herdrAgentPromptResult(result: JsonRecord | undefined): HerdrAgentInfo | undefined {
  return herdrAgentInfo(result);
}

export async function submitHerdrAgentPrompt(
  request: (params: JsonRecord) => Promise<JsonRecord | undefined>,
  target: string,
  text: string,
): Promise<HerdrAgentInfo | undefined> {
  const result = await request(herdrAgentPromptParams(target, text));
  return herdrAgentPromptResult(result);
}

export function herdrAgentPromptTone(status: string): Tone {
  if (status === "blocked") return "error";
  if (status === "done" || status === "idle") return "ok";
  return "neutral";
}

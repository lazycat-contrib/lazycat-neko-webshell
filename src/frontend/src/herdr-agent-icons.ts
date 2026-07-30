const HERDR_AGENT_ICON_ALIASES = {
  pi: "pi",
  claude: "claudecode",
  codex: "codex",
  gemini: "geminicli",
  cursor: "cursor",
  devin: "devin",
  cline: "cline",
  mastracode: "mastra",
  agy: "antigravity",
  opencode: "opencode",
  copilot: "copilot",
  kimi: "kimi",
  kiro: "kiro",
  amp: "amp",
  grok: "grok",
  hermes: "hermesagent",
  kilo: "kilocode",
  qodercli: "qoder",
} as const;

export type HerdrAgentIconKey = typeof HERDR_AGENT_ICON_ALIASES[keyof typeof HERDR_AGENT_ICON_ALIASES];

export function herdrAgentIconKey(
  agent: string | undefined,
  fallbacks: Array<string | undefined> = [],
): HerdrAgentIconKey | undefined {
  const primary = normalizeAgentKey(agent);
  if (primary) return HERDR_AGENT_ICON_ALIASES[primary as keyof typeof HERDR_AGENT_ICON_ALIASES];
  for (const fallback of fallbacks) {
    const normalized = normalizeAgentKey(fallback);
    if (normalized) return HERDR_AGENT_ICON_ALIASES[normalized as keyof typeof HERDR_AGENT_ICON_ALIASES];
  }
  return undefined;
}

function normalizeAgentKey(value: string | undefined): keyof typeof HERDR_AGENT_ICON_ALIASES | undefined {
  const normalized = value?.trim().toLocaleLowerCase().replace(/[\s_-]+/g, "") ?? "";
  if (!normalized) return undefined;
  const aliases: Record<string, keyof typeof HERDR_AGENT_ICON_ALIASES> = {
    anthropic: "claude",
    antigravity: "agy",
    antigravitycli: "agy",
    claudecode: "claude",
    githubcopilot: "copilot",
    geminicli: "gemini",
    hermesagent: "hermes",
    kilocode: "kilo",
    mastracode: "mastracode",
    qoder: "qodercli",
  };
  const key = aliases[normalized] ?? normalized;
  return key in HERDR_AGENT_ICON_ALIASES ? key as keyof typeof HERDR_AGENT_ICON_ALIASES : undefined;
}

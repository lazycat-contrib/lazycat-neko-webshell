export const MAX_AI_CONTEXT_CHARS = 12000;

export function appendAIContextText(current: string, text: string): string {
  return `${current}${text}`.slice(-MAX_AI_CONTEXT_CHARS);
}

export function recentAIContextText(text: string, contextLines: number): string {
  const lines = stripAnsiForAI(text).split(/\r?\n/).filter((line) => line.trim());
  const selected = contextLines > 0 ? lines.slice(-contextLines) : [];
  return redactAIContext(selected.join("\n"));
}

export function stripAnsiForAI(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function redactAIContext(value: string): string {
  return value
    .replace(/-----BEGIN [\s\S]*?-----END [A-Z ]+-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bghp_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/\b([A-Z0-9_]*(?:PASS|PASSWORD|TOKEN|SECRET|KEY)[A-Z0-9_]*)=([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/(--password(?:=|\s+))\S+/gi, "$1[REDACTED]")
    .replace(/(-p\s+)\S+/gi, "$1[REDACTED]");
}

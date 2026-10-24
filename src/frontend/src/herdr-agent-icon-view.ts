import { SquareTerminal } from "lucide";
import type { HerdrAgentIconKey } from "./herdr-agent-icons.ts";
import { escapeAttr } from "./utils.ts";

export function renderHerdrAgentIcon(icon?: HerdrAgentIconKey): string {
  if (icon) return `<span class="herdr-agent-icon" data-agent-icon="${escapeAttr(icon)}" aria-hidden="true"></span>`;
  const content = SquareTerminal.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeAttr(String(value))}"`).join(" ")}></${tag}>`).join("");
  return `<svg class="herdr-agent-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
}

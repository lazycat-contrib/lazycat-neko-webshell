import { escapeAttr } from "./utils.ts";
import { herdrActivityGlyph } from "./herdr-activity.ts";
import type { ProgramStatusPresentation } from "./program-status.ts";

export function renderProgramStatusContent(status: ProgramStatusPresentation): string {
  const icon = status.icon
    ? `<span class="herdr-agent-icon" data-agent-icon="${escapeAttr(status.icon)}" aria-hidden="true"></span>`
    : "";
  return `${icon}<span class="herdr-jump-status" aria-hidden="true">${herdrActivityGlyph(status.state)}</span>`;
}

export function renderProgramStatusView(status?: ProgramStatusPresentation): string {
  return `<span class="tab-program-status" data-status="${status?.state ?? "unknown"}" ${status ? `title="${escapeAttr(status.label)}"` : "hidden"}>${status ? renderProgramStatusContent(status) : ""}</span>`;
}

export function syncProgramStatusView(root: HTMLElement, status?: ProgramStatusPresentation) {
  const node = root.querySelector<HTMLElement>(".tab-program-status");
  if (!node) return;
  node.hidden = !status;
  if (!status) { node.innerHTML = ""; node.dataset.signature = ""; return; }
  const signature = `${status.icon ?? ""}:${status.state}`;
  if (node.dataset.signature !== signature) {
    node.innerHTML = renderProgramStatusContent(status);
    node.dataset.signature = signature;
  }
  node.dataset.status = status.state;
  node.title = status.label;
}

import { escapeAttr } from "./utils.ts";
import { renderHerdrAgentIcon } from "./herdr-agent-icon-view.ts";
import type { ProgramStatusPresentation } from "./program-status.ts";

export function renderProgramStatusContent(status: ProgramStatusPresentation): string {
  return renderHerdrAgentIcon(status.icon);
}

export function renderProgramStatusView(status?: ProgramStatusPresentation): string {
  return `<span class="tab-program-status" role="img" data-status="${status?.state ?? "unknown"}" ${status ? `aria-label="${escapeAttr(status.label)}" title="${escapeAttr(status.label)}"` : "hidden"}>${status ? renderProgramStatusContent(status) : ""}</span>`;
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
  node.setAttribute("aria-label", status.label);
  node.title = status.label;
}

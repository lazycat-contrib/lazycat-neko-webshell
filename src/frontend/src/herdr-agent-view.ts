import type { HerdrAgentInfo, HerdrBridgeState } from "./types";
import { escapeAttr, escapeHtml } from "./utils.ts";

export type HerdrAgentFilter = "all" | "working" | "blocked" | "done";

export function normalizeHerdrAgentFilter(value: string | undefined): HerdrAgentFilter {
  return value === "working" || value === "blocked" || value === "done" ? value : "all";
}

export type HerdrAgentMenuLabels = {
  title: string;
  all: string;
  working: string;
  blocked: string;
  done: string;
  empty: string;
  focus: string;
};

export function herdrAgentInteractionsAvailable(
  state: Pick<HerdrBridgeState, "herdr_protocol" | "protocol_compatible"> | undefined,
): boolean {
  return state?.herdr_protocol === 17 && state.protocol_compatible !== false;
}

export function filterHerdrAgents(
  agents: HerdrAgentInfo[],
  filter: HerdrAgentFilter,
): HerdrAgentInfo[] {
  return agents
    .filter((agent) => filter === "all" || agent.agent_status === filter)
    .slice()
    .sort((left, right) => right.state_change_seq - left.state_change_seq);
}

export function herdrAgentLabel(agent: HerdrAgentInfo): string {
  return agent.display_agent?.trim()
    || agent.name?.trim()
    || agent.agent?.trim()
    || agent.pane_id;
}

export function renderHerdrAgentMenuView(
  agents: HerdrAgentInfo[],
  filter: HerdrAgentFilter,
  labels: HerdrAgentMenuLabels,
): string {
  const filtered = filterHerdrAgents(agents, filter);
  return `
    <section class="herdr-agent-section" aria-label="${escapeAttr(labels.title)}">
      <div class="herdr-agent-section-head">
        <strong>${escapeHtml(labels.title)}</strong>
        <div class="herdr-agent-filters" role="group" aria-label="${escapeAttr(labels.title)}">
          ${renderFilters(filter, labels)}
        </div>
      </div>
      <div class="herdr-agent-list">
        ${filtered.length ? filtered.map((agent) => renderAgentRow(agent, labels)).join("") : `<div class="empty">${escapeHtml(labels.empty)}</div>`}
      </div>
    </section>
  `;
}

function renderFilters(filter: HerdrAgentFilter, labels: HerdrAgentMenuLabels): string {
  const filters: Array<[HerdrAgentFilter, string]> = [
    ["all", labels.all],
    ["working", labels.working],
    ["blocked", labels.blocked],
    ["done", labels.done],
  ];
  return filters.map(([value, label]) => `
    <button type="button" data-herdr-agent-filter="${value}" aria-pressed="${filter === value}">${escapeHtml(label)}</button>
  `).join("");
}

function renderAgentRow(agent: HerdrAgentInfo, labels: HerdrAgentMenuLabels): string {
  const label = herdrAgentLabel(agent);
  const detail = [
    agent.agent_status,
    agent.title?.trim() || agent.terminal_title_stripped?.trim() || "",
  ].filter(Boolean).join(" · ");
  return `
    <button class="herdr-agent-row" type="button" data-herdr-agent-pane="${escapeAttr(agent.pane_id)}" data-status="${escapeAttr(agent.agent_status)}" aria-label="${escapeAttr(`${labels.focus}: ${label}`)}" title="${escapeAttr(`${labels.focus}: ${label}`)}">
      <span class="status-dot" data-status="${escapeAttr(agent.agent_status)}"></span>
      <span>
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(detail)}</small>
      </span>
      ${agent.focused ? `<i data-lucide="check"></i>` : ""}
    </button>
  `;
}

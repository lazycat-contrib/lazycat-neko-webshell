import type { MessageKey } from "../i18n.ts";
import { escapeAttr, escapeHtml } from "../utils.ts";
import type { HerdrIntegrationsScreen } from "./controller.ts";
import type { HerdrIntegrationInfo, HerdrIntegrationState } from "./model.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function renderHerdrIntegrationsDialog(
  screen: HerdrIntegrationsScreen,
  tr: Translate,
): string {
  const body = screen.state === "loading"
    ? `<div class="herdr-console-loading" aria-busy="true"><span>${escapeHtml(tr("integrations.loading"))}</span></div>`
    : screen.state === "error"
      ? `<p class="herdr-integrations-error" role="alert">${escapeHtml(screen.message)}</p>`
      : renderIntegrationList(screen.integrations, tr);
  const refresh = screen.state === "loading" ? "" : `
    <button class="command-button" type="button" data-herdr-integrations-refresh>
      <i data-lucide="refresh-cw" aria-hidden="true"></i>${escapeHtml(tr("integrations.refresh"))}
    </button>`;
  return `
      <header>
        <span class="herdr-console-dialog-icon" aria-hidden="true"><i data-lucide="plug-zap"></i></span>
        <span><h2 id="herdr-integrations-title">${escapeHtml(tr("integrations.title"))}</h2><p>${escapeHtml(tr("integrations.hint"))}</p></span>
        <button type="button" class="icon-button" data-herdr-integrations-close aria-label="${escapeAttr(tr("action.close"))}"><i data-lucide="x"></i></button>
      </header>
      <div class="herdr-console-dialog-body">${body}</div>
      <footer>
        ${refresh}
        <button class="command-button" type="button" data-herdr-integrations-close>${escapeHtml(tr("action.close"))}</button>
      </footer>`;
}

function renderIntegrationList(integrations: HerdrIntegrationInfo[], tr: Translate): string {
  if (!integrations.length) return `<p class="herdr-console-empty">${escapeHtml(tr("integrations.empty"))}</p>`;
  const current = integrations.filter((item) => item.available && item.state === "current").length;
  const outdated = integrations.filter((item) => item.available && item.state === "outdated").length;
  return `
    <p class="herdr-integrations-summary">${escapeHtml(tr("integrations.summary", { current, outdated, total: integrations.length }))}</p>
    <div class="herdr-integrations-list" role="list">
      ${integrations.map((integration) => renderIntegration(integration, tr)).join("")}
    </div>`;
}

function renderIntegration(integration: HerdrIntegrationInfo, tr: Translate): string {
  const state = integration.available ? integration.state : "unavailable";
  return `
    <article class="herdr-integration-row" role="listitem">
      <span class="herdr-integration-mark" data-state="${escapeAttr(state)}" aria-hidden="true"></span>
      <span class="herdr-integration-copy">
        <strong>${escapeHtml(integration.label)}</strong>
        <small>${escapeHtml(tr("integrations.command", { command: integration.command }))}</small>
      </span>
      <span class="herdr-integration-state" data-state="${escapeAttr(state)}">${escapeHtml(integrationStateLabel(state, tr))}</span>
    </article>`;
}

function integrationStateLabel(
  state: HerdrIntegrationState | "unavailable",
  tr: Translate,
): string {
  if (state === "current") return tr("integrations.stateCurrent");
  if (state === "outdated") return tr("integrations.stateOutdated");
  if (state === "not_installed") return tr("integrations.stateNotInstalled");
  return tr("integrations.stateUnavailable");
}

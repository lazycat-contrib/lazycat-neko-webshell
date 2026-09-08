import type { MessageKey } from "../i18n.ts";
import { escapeAttr, escapeHtml } from "../utils.ts";
import { visibleMachines, type Machine, type MachineState } from "./model.ts";
type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function renderMachineDialog(state: MachineState, tr: Translate): string {
  const text = (key: MessageKey) => escapeHtml(tr(key));
  const busy = state.busy ? "disabled" : "";
  const title = state.screen === "list" ? "machines.title" : state.screen === "add" ? "machines.add" : state.screen === "rename" ? "machines.rename" : state.screen === "remove" ? "machines.remove" : state.setupMode === "test" ? "machines.test" : "machines.setup";
  return `<header><span><h2 id="herdr-machines-title">${text(title)}</h2><p>${text("machines.scope")}</p></span>
    <button type="button" class="icon-button" data-machine-action="close" aria-label="${text("action.close")}"><i data-lucide="x" aria-hidden="true"></i></button></header>
    <div class="herdr-console-dialog-body machine-body" aria-busy="${state.busy}">
      ${state.screen === "list" ? list(state, tr) : state.screen === "setup" ? `<div class="machine-setup-identity"><strong>${escapeHtml(state.form.label)}</strong><code>${escapeHtml(state.form.target)} · ${escapeHtml(state.form.session)}</code></div><div class="machine-terminal" data-machine-terminal></div><button type="button" class="command-button" data-machine-action="keyboard" title="${text("machines.keyboardHint")}">${text("machines.keyboard")}</button>` : form(state, tr)}
      <p class="machine-message" data-machine-message role="status" data-error="${state.error}">${escapeHtml(state.message)}</p>
    </div>
    <footer>${state.screen === "list" ? `<span class="machine-count">${state.loaded && state.supported ? escapeHtml(tr("machines.count", { count: state.machines.length })) : ""}</span><button class="command-button" data-machine-action="refresh" ${busy}>${text("action.refresh")}</button>` : `<button type="button" class="command-button" data-machine-action="back" ${state.busy && ["rename", "remove"].includes(state.screen) ? "disabled" : ""}>${text(state.screen === "setup" && !state.setupFinished ? "machines.cancelSetup" : state.screen === "setup" ? "machines.back" : "action.cancel")}</button>`}
      ${state.screen === "add" ? `<button class="command-button" type="button" data-machine-action="test" ${busy}>${text("machines.test")}</button>` : ""}
      ${state.screen !== "list" && state.screen !== "setup" ? `<button class="command-button primary ${state.screen === "remove" ? "danger" : ""}" form="machine-form" type="submit" ${busy}>${text(state.screen === "add" ? "machines.startSetup" : state.screen === "rename" ? "action.save" : "machines.remove")}</button>` : ""}</footer>`;
}

function list(state: MachineState, tr: Translate): string {
  const text = (key: MessageKey) => escapeHtml(tr(key));
  if (state.loaded && !state.supported) return `<div class="machine-empty"><i data-lucide="monitor-up" aria-hidden="true"></i><h3>${text("machines.unsupported")}</h3><p>${text("machines.upgrade")}</p></div>`;
  const machines = visibleMachines(state.machines, state.query);
  return `<div class="machine-toolbar"><label class="machine-search"><i data-lucide="search" aria-hidden="true"></i><input type="search" name="machine-query" aria-label="${text("machines.search")}" placeholder="${text("machines.search")}" value="${escapeAttr(state.query)}" autocomplete="off"></label>
    <button type="button" class="command-button primary" data-machine-action="add" ${state.busy || !state.loaded ? "disabled" : ""}><i data-lucide="plus" aria-hidden="true"></i>${text("machines.add")}</button></div>
    <div class="machine-list">${!state.loaded ? `<p class="machine-empty">${text(state.busy ? "machines.loading" : "machines.loadFailed")}</p>` : !machines.length ? `<div class="machine-empty"><i data-lucide="server" aria-hidden="true"></i><h3>${text(state.query ? "machines.noMatches" : "machines.empty")}</h3><p>${text(state.query ? "machines.searchHelp" : "machines.emptyHelp")}</p></div>` : machines.map(machine => row(machine, state.busy, tr)).join("")}</div>`;
}

function row(machine: Machine, busy: boolean, tr: Translate): string {
  const text = (key: MessageKey) => escapeHtml(tr(key));
  return `<article class="machine-row" data-machine-id="${escapeAttr(machine.id)}" data-enabled="${machine.enabled}">
    <span class="machine-icon" aria-hidden="true"><i data-lucide="server"></i></span>
    <div class="machine-identity"><div class="machine-heading"><h3>${escapeHtml(machine.label.trim() || machine.target)}</h3><span class="machine-state">${text(machine.enabled ? "machines.enabled" : "machines.disabled")}</span></div><p><code>${escapeHtml(machine.target)}</code><span>${text("machines.session")}: ${escapeHtml(machine.session)}</span></p></div>
    <div class="machine-row-actions"><button type="button" class="command-button" data-machine-action="toggle" aria-label="${escapeAttr(tr(machine.enabled ? "machines.disableName" : "machines.enableName", { label: machine.label }))}" ${busy ? "disabled" : ""}>${text(machine.enabled ? "machines.disable" : "machines.enable")}</button>
      <button type="button" class="icon-button" data-machine-action="rename" aria-label="${escapeAttr(tr("machines.renameName", { label: machine.label }))}" title="${text("machines.rename")}" ${busy ? "disabled" : ""}><i data-lucide="pencil" aria-hidden="true"></i></button>
      <button type="button" class="icon-button machine-remove" data-machine-action="remove" aria-label="${escapeAttr(tr("machines.removeName", { label: machine.label }))}" title="${text("machines.remove")}" ${busy ? "disabled" : ""}><i data-lucide="trash-2" aria-hidden="true"></i></button></div></article>`;
}

function form(state: MachineState, tr: Translate): string {
  const text = (key: MessageKey) => escapeHtml(tr(key));
  const disabled = state.busy ? "disabled" : "";
  if (state.screen === "remove") return `<form id="machine-form"><div class="machine-remove-preview"><strong>${escapeHtml(state.form.label)}</strong><code>${escapeHtml(state.form.target)} · ${escapeHtml(state.form.session)}</code></div><p class="machine-help">${text("machines.removeHint")}</p></form>`;
  const selectedAlias = state.source === "config";
  return `<form id="machine-form" class="herdr-console-form">
    ${state.screen === "add" ? `<div class="machine-source-picker" role="group" aria-label="${text("machines.source")}"><button class="command-button" type="button" data-machine-source="config" aria-pressed="${selectedAlias}" ${disabled}>${text("machines.configSource")}</button><button class="command-button" type="button" data-machine-source="manual" aria-pressed="${!selectedAlias}" ${disabled}>${text("machines.manualSource")}</button></div><label ${!selectedAlias ? "hidden" : ""}>${text("machines.sshHost")}<select name="machine-host" ${disabled}>
      ${state.hosts.map(host => `<option value="${escapeAttr(host.alias)}" ${state.form.target === host.alias ? "selected" : ""}>${escapeHtml(host.alias)}</option>`).join("")}
      ${!state.hosts.length ? `<option value="">${text("machines.noHostOption")}</option>` : ""}</select></label>
      <label data-machine-manual ${selectedAlias ? "hidden" : ""}>${text("machines.target")}<input name="target" value="${escapeAttr(state.form.target)}" autocomplete="off" spellcheck="false" placeholder="user@host" maxlength="1024" ${disabled}></label>
      <p class="machine-help">${text(state.busy ? "machines.hostLoading" : !selectedAlias ? "machines.manualHint" : state.hostError ? "machines.hostFailed" : state.hosts.length ? "machines.hostHint" : "machines.noHosts")}</p>` : `<p class="machine-rename-target"><code>${escapeHtml(state.form.target)}</code></p>`}
    <label>${text("machines.label")}<input name="label" value="${escapeAttr(state.form.label)}" autocomplete="off" maxlength="128" required ${disabled}></label>
    ${state.screen === "add" ? `<details class="machine-advanced"><summary>${text("machines.sessionSettings")}</summary><label>${text("machines.session")}<input name="session" value="${escapeAttr(state.form.session)}" autocomplete="off" maxlength="64" pattern="[A-Za-z0-9_.-]+" required ${disabled}></label><p class="machine-help">${text("machines.sessionHint")}</p></details><p class="machine-help">${text("machines.addHint")}</p>` : ""}
    </form>`;
}

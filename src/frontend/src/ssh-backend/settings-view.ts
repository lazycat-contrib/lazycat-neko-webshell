import type { SshConfigHost, SshProfile, SshProfileKind } from "./api";
import { escapeAttr, escapeHtml } from "../utils";

export type SshProfileDraft = {
  id?: string;
  name: string;
  kind: SshProfileKind;
  enabled: boolean;
  host: string;
  port: string;
  username: string;
  target: string;
  strictHostKeyChecking: "accept-new" | "yes" | "no";
};

export type SshProfileSettingsViewState = {
  profiles: SshProfile[];
  configHosts: SshConfigHost[];
  draft: SshProfileDraft;
  selectedId?: string;
  status: string;
  tone: "neutral" | "ok" | "error";
  busy: boolean;
};

export function emptySshProfileDraft(kind: SshProfileKind = "managed-key"): SshProfileDraft {
  return {
    name: "",
    kind,
    enabled: true,
    host: "",
    port: kind === "managed-key" ? "22" : "",
    username: "",
    target: "",
    strictHostKeyChecking: "accept-new",
  };
}

export function draftFromProfile(profile: SshProfile): SshProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    enabled: profile.enabled,
    host: profile.host,
    port: profile.port ? String(profile.port) : "",
    username: profile.username,
    target: profile.target,
    strictHostKeyChecking: profile.strictHostKeyChecking,
  };
}

export function renderSshProfileSettingsView(state: SshProfileSettingsViewState): string {
  const selected = state.profiles.find((profile) => profile.id === state.selectedId);
  const busy = state.busy ? "disabled" : "";
  return `
    <div class="settings-section-head">
      <div>
        <div class="settings-group-title">SSH profiles</div>
        <p class="settings-help">Add remote SSH targets as first-class terminal backends.</p>
      </div>
      <button class="icon-button" type="button" data-ssh-profile-action="refresh" aria-label="Refresh SSH profiles" title="Refresh SSH profiles" ${busy}>
        <i data-lucide="refresh-cw"></i>
      </button>
    </div>
    <div class="ssh-profile-layout">
      <div class="ssh-profile-list" role="listbox" aria-label="SSH profiles">
        ${renderProfileList(state.profiles, state.selectedId)}
      </div>
      <div class="ssh-profile-editor">
        <div class="ssh-profile-actions">
          <button class="command-button" type="button" data-ssh-profile-action="new-managed" ${busy}>
            <i data-lucide="key-round"></i>
            <span>Managed key</span>
          </button>
          <button class="command-button" type="button" data-ssh-profile-action="new-openssh" ${busy}>
            <i data-lucide="terminal"></i>
            <span>OpenSSH</span>
          </button>
        </div>
        ${renderProfileForm(state.draft, selected, state.configHosts, busy)}
      </div>
    </div>
    <p class="field-status" data-tone="${escapeAttr(state.tone)}">${escapeHtml(state.status)}</p>
  `;
}

function renderProfileList(profiles: SshProfile[], selectedId: string | undefined): string {
  if (!profiles.length) {
    return `<div class="empty">No SSH profiles.</div>`;
  }
  return profiles.map((profile) => {
    const active = profile.id === selectedId;
    const target = profile.kind === "managed-key"
      ? [profile.username, profile.host].filter(Boolean).join("@")
      : profile.target;
    return `
      <button class="ssh-profile-row ${active ? "selected" : ""}" type="button" role="option" aria-selected="${active}" data-ssh-profile-id="${escapeAttr(profile.id)}">
        <span>
          <strong>${escapeHtml(profile.name)}</strong>
          <small>${escapeHtml(target || profile.selector)}</small>
        </span>
        <em>${escapeHtml(profile.kind === "managed-key" ? "key" : "ssh")}</em>
      </button>
    `;
  }).join("");
}

function renderProfileForm(
  draft: SshProfileDraft,
  selected: SshProfile | undefined,
  configHosts: SshConfigHost[],
  busy: string,
): string {
  const managed = draft.kind === "managed-key";
  return `
    <div class="ssh-profile-kind" role="radiogroup" aria-label="SSH profile type">
      ${kindButton("managed-key", "Managed public key", draft.kind, busy)}
      ${kindButton("device-openssh", "Device OpenSSH", draft.kind, busy)}
    </div>
    <label class="switch">
      <input type="checkbox" data-ssh-profile-field="enabled" ${draft.enabled ? "checked" : ""} ${busy} />
      <span>Enabled</span>
    </label>
    <label class="field">
      <span>Name</span>
      <input type="text" data-ssh-profile-field="name" value="${escapeAttr(draft.name)}" autocomplete="off" spellcheck="false" ${busy} />
    </label>
    ${managed ? renderManagedFields(draft, busy) : renderOpenSshFields(draft, configHosts, busy)}
    <label class="field">
      <span>Host key checking</span>
      <select data-ssh-profile-field="strictHostKeyChecking" ${busy}>
        ${hostKeyOption("accept-new", "Accept new hosts", draft.strictHostKeyChecking)}
        ${hostKeyOption("yes", "Strict", draft.strictHostKeyChecking)}
        ${hostKeyOption("no", "Off", draft.strictHostKeyChecking)}
      </select>
    </label>
    ${selected?.publicKey ? `
      <div class="ssh-public-key">
        <div class="settings-group-title">Public key</div>
        <pre>${escapeHtml(selected.publicKey)}</pre>
      </div>
    ` : ""}
    <div class="ssh-profile-actions">
      <button class="command-button primary" type="button" data-ssh-profile-action="save" ${busy}>
        <i data-lucide="save"></i>
        <span>Save profile</span>
      </button>
      <button class="command-button" type="button" data-ssh-profile-action="test" ${selected ? "" : "disabled"} ${busy}>
        <i data-lucide="plug-zap"></i>
        <span>Test</span>
      </button>
      <button class="command-button danger" type="button" data-ssh-profile-action="delete" ${selected ? "" : "disabled"} ${busy}>
        <i data-lucide="trash-2"></i>
        <span>Delete</span>
      </button>
    </div>
  `;
}

function renderManagedFields(draft: SshProfileDraft, busy: string): string {
  return `
    <label class="field">
      <span>Host</span>
      <input type="text" data-ssh-profile-field="host" value="${escapeAttr(draft.host)}" autocomplete="off" spellcheck="false" ${busy} />
    </label>
    <div class="ssh-profile-grid">
      <label class="field">
        <span>Port</span>
        <input type="number" data-ssh-profile-field="port" min="1" max="65535" value="${escapeAttr(draft.port)}" ${busy} />
      </label>
      <label class="field">
        <span>User</span>
        <input type="text" data-ssh-profile-field="username" value="${escapeAttr(draft.username)}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
    </div>
  `;
}

function renderOpenSshFields(draft: SshProfileDraft, configHosts: SshConfigHost[], busy: string): string {
  return `
    ${configHosts.length ? `
      <label class="field">
        <span>OpenSSH config</span>
        <select data-ssh-config-host ${busy}>
          <option value="">Choose Host from ~/.ssh/config</option>
          ${configHosts.map((host) => configHostOption(host, draft.target)).join("")}
        </select>
      </label>
    ` : ""}
    <label class="field">
      <span>OpenSSH target</span>
      <input type="text" data-ssh-profile-field="target" value="${escapeAttr(draft.target)}" placeholder="host-alias or user@example.com" autocomplete="off" spellcheck="false" ${busy} />
    </label>
    <div class="ssh-profile-grid">
      <label class="field">
        <span>Display host</span>
        <input type="text" data-ssh-profile-field="host" value="${escapeAttr(draft.host)}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
      <label class="field">
        <span>Display user</span>
        <input type="text" data-ssh-profile-field="username" value="${escapeAttr(draft.username)}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
    </div>
  `;
}

function configHostOption(host: SshConfigHost, selectedTarget: string): string {
  const detail = [
    host.username && host.host ? `${host.username}@${host.host}` : host.host,
    host.port ? `:${host.port}` : "",
  ].filter(Boolean).join("");
  const label = detail ? `${host.alias} (${detail})` : host.alias;
  return `<option value="${escapeAttr(host.alias)}" ${host.alias === selectedTarget ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function kindButton(kind: SshProfileKind, label: string, selected: SshProfileKind, busy: string): string {
  return `
    <button type="button" data-ssh-profile-kind="${escapeAttr(kind)}" aria-pressed="${kind === selected}" ${busy}>
      ${escapeHtml(label)}
    </button>
  `;
}

function hostKeyOption(value: SshProfileDraft["strictHostKeyChecking"], label: string, selected: string): string {
  return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

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
  query: string;
  status: string;
  tone: "neutral" | "ok" | "error";
  busy: boolean;
};

type ConnectionRow =
  | { type: "profile"; profile: SshProfile }
  | { type: "config"; host: SshConfigHost };

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

export function draftFromConfigHost(host: SshConfigHost): SshProfileDraft {
  return {
    ...emptySshProfileDraft("device-openssh"),
    name: host.alias,
    target: host.alias,
    host: host.host || host.alias,
    username: host.username,
    port: "",
  };
}

export function renderSshProfileSettingsView(state: SshProfileSettingsViewState): string {
  const selected = state.profiles.find((profile) => profile.id === state.selectedId);
  const busy = state.busy ? "disabled" : "";
  const rows = connectionRows(state.profiles, state.configHosts, state.query);
  return `
    <div class="settings-section-head">
      <div>
        <div class="settings-group-title">SSH connections</div>
        <p class="settings-help">Manage saved SSH terminals and import aliases from device OpenSSH config.</p>
      </div>
      <button class="icon-button" type="button" data-ssh-profile-action="refresh" aria-label="Refresh SSH connections" title="Refresh SSH connections" ${busy}>
        <i data-lucide="refresh-cw"></i>
      </button>
    </div>
    <div class="ssh-profile-toolbar">
      <label class="ssh-profile-search">
        <span class="sr-only">Search SSH connections</span>
        <i data-lucide="search"></i>
        <input type="search" data-ssh-search value="${escapeAttr(state.query)}" placeholder="Search profiles or ~/.ssh/config hosts" autocomplete="off" spellcheck="false" ${busy} />
      </label>
      <button class="command-button" type="button" data-ssh-profile-action="new-managed" ${busy}>
        <i data-lucide="key-round"></i>
        <span>Managed key</span>
      </button>
      <button class="command-button" type="button" data-ssh-profile-action="new-openssh" ${busy}>
        <i data-lucide="terminal"></i>
        <span>OpenSSH</span>
      </button>
    </div>
    <div class="ssh-profile-layout">
      <div class="ssh-profile-inventory">
        <div class="ssh-profile-count">${escapeHtml(connectionCountLabel(state.profiles, state.configHosts, rows, state.query))}</div>
        <div class="ssh-profile-list" role="list" aria-label="SSH connections">
          ${renderConnectionRows(rows, state.selectedId, busy)}
        </div>
      </div>
      <div class="ssh-profile-editor">
        ${renderProfileForm(state.draft, selected, state.configHosts, busy)}
      </div>
    </div>
    <p class="field-status" data-tone="${escapeAttr(state.tone)}">${escapeHtml(state.status)}</p>
  `;
}

function connectionRows(
  profiles: SshProfile[],
  configHosts: SshConfigHost[],
  query: string,
): ConnectionRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  const savedTargets = new Set(
    profiles
      .filter((profile) => profile.kind === "device-openssh")
      .map((profile) => profile.target.trim())
      .filter(Boolean),
  );
  const rows: ConnectionRow[] = [
    ...profiles.map((profile): ConnectionRow => ({ type: "profile", profile })),
    ...configHosts
      .filter((host) => !savedTargets.has(host.alias))
      .map((host): ConnectionRow => ({ type: "config", host })),
  ];
  if (!normalizedQuery) return rows;
  return rows.filter((row) => rowMatchesQuery(row, normalizedQuery));
}

function rowMatchesQuery(row: ConnectionRow, query: string): boolean {
  const text = row.type === "profile"
    ? [
        row.profile.name,
        row.profile.selector,
        row.profile.kind,
        row.profile.host,
        row.profile.username,
        row.profile.target,
      ].join(" ")
    : [
        row.host.alias,
        row.host.host,
        row.host.username,
        row.host.source,
      ].join(" ");
  return text.toLowerCase().includes(query);
}

function connectionCountLabel(
  profiles: SshProfile[],
  configHosts: SshConfigHost[],
  rows: ConnectionRow[],
  query: string,
): string {
  const total = `${profiles.length} saved / ${configHosts.length} config`;
  if (query.trim()) return `${rows.length} shown from ${total}`;
  return total;
}

function renderConnectionRows(rows: ConnectionRow[], selectedId: string | undefined, busy: string): string {
  if (!rows.length) {
    return `<div class="empty">No SSH connections match.</div>`;
  }
  return rows.map((row) => row.type === "profile"
    ? renderProfileRow(row.profile, selectedId, busy)
    : renderConfigHostRow(row.host, busy)).join("");
}

function renderProfileRow(profile: SshProfile, selectedId: string | undefined, busy: string): string {
  const active = profile.id === selectedId;
  const target = profileTargetLabel(profile);
  const badges = [
    "profile",
    profile.kind === "managed-key" ? "key" : "ssh",
    profile.enabled ? "enabled" : "disabled",
  ];
  const disabled = profile.enabled ? "" : "disabled";
  return `
    <div class="ssh-profile-row-shell ${active ? "selected" : ""}" role="listitem">
      <button class="ssh-profile-row-body" type="button" aria-pressed="${active}" data-ssh-profile-id="${escapeAttr(profile.id)}" ${busy}>
        <span class="ssh-profile-row-copy">
          <strong>${escapeHtml(profile.name)}</strong>
          <small>${escapeHtml(target || profile.selector)}</small>
        </span>
        <span class="ssh-profile-badges">${renderBadges(badges)}</span>
      </button>
      <button class="icon-button ssh-profile-open" type="button" data-ssh-profile-open="${escapeAttr(profile.id)}" aria-label="Open ${escapeAttr(profile.name)}" title="Open ${escapeAttr(profile.name)}" ${busy} ${disabled}>
        <i data-lucide="square-arrow-out-up-right"></i>
      </button>
    </div>
  `;
}

function renderConfigHostRow(host: SshConfigHost, busy: string): string {
  const target = configHostTargetLabel(host);
  return `
    <div class="ssh-profile-row-shell config" role="listitem">
      <button class="ssh-profile-row-body" type="button" data-ssh-config-host-row="${escapeAttr(host.alias)}" ${busy}>
        <span class="ssh-profile-row-copy">
          <strong>${escapeHtml(host.alias)}</strong>
          <small>${escapeHtml(target || host.source)}</small>
        </span>
        <span class="ssh-profile-badges">${renderBadges(["config", "openssh"])}</span>
      </button>
      <button class="icon-button ssh-profile-open" type="button" data-ssh-config-save="${escapeAttr(host.alias)}" aria-label="Save ${escapeAttr(host.alias)} as profile" title="Save as profile" ${busy}>
        <i data-lucide="bookmark-plus"></i>
      </button>
    </div>
  `;
}

function renderProfileForm(
  draft: SshProfileDraft,
  selected: SshProfile | undefined,
  configHosts: SshConfigHost[],
  busy: string,
): string {
  const managed = draft.kind === "managed-key";
  return `
    <div class="ssh-profile-editor-head">
      <div>
        <div class="settings-group-title">${escapeHtml(selected ? selected.name : "New SSH connection")}</div>
        <p class="settings-help">${escapeHtml(editorSubtitle(draft, selected))}</p>
      </div>
      <button class="command-button" type="button" data-ssh-profile-open="${escapeAttr(selected?.id ?? "")}" ${selected?.enabled ? "" : "disabled"} ${busy}>
        <i data-lucide="square-arrow-out-up-right"></i>
        <span>Open</span>
      </button>
    </div>
    <div class="ssh-profile-editor-section">
      <div class="settings-group-title">Basic</div>
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
    </div>
    <div class="ssh-profile-editor-section">
      <div class="settings-group-title">${managed ? "Managed key" : "OpenSSH"}</div>
      ${managed ? renderManagedFields(draft, selected, busy) : renderOpenSshFields(draft, configHosts, busy)}
    </div>
    <div class="ssh-profile-editor-section">
      <div class="settings-group-title">Advanced</div>
      <label class="field">
        <span>Host key checking</span>
        <select data-ssh-profile-field="strictHostKeyChecking" ${busy}>
          ${hostKeyOption("accept-new", "Accept new hosts", draft.strictHostKeyChecking)}
          ${hostKeyOption("yes", "Strict", draft.strictHostKeyChecking)}
          ${hostKeyOption("no", "Off", draft.strictHostKeyChecking)}
        </select>
      </label>
      ${selected?.publicKey ? renderPublicKey(selected.publicKey) : ""}
    </div>
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

function renderManagedFields(draft: SshProfileDraft, selected: SshProfile | undefined, busy: string): string {
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
    ${selected?.publicKey ? "" : `<p class="settings-help">A public key is generated after the profile is saved.</p>`}
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

function renderPublicKey(publicKey: string): string {
  return `
    <div class="ssh-public-key">
      <div class="settings-group-title">Public key</div>
      <pre>${escapeHtml(publicKey)}</pre>
    </div>
  `;
}

function profileTargetLabel(profile: SshProfile): string {
  if (profile.kind === "device-openssh") {
    return profile.target || profile.host;
  }
  const host = [profile.username, profile.host].filter(Boolean).join("@");
  return profile.port ? `${host}:${profile.port}` : host;
}

function configHostTargetLabel(host: SshConfigHost): string {
  const target = host.username && host.host ? `${host.username}@${host.host}` : host.host;
  return host.port ? `${target}:${host.port}` : target;
}

function editorSubtitle(draft: SshProfileDraft, selected: SshProfile | undefined): string {
  if (selected) return profileTargetLabel(selected) || selected.selector;
  return draft.kind === "managed-key"
    ? "Create a WebShell-managed key profile."
    : "Use an alias or target resolved by the device ssh command.";
}

function renderBadges(labels: string[]): string {
  return labels.map((label) => `<em>${escapeHtml(label)}</em>`).join("");
}

function configHostOption(host: SshConfigHost, selectedTarget: string): string {
  const detail = configHostTargetLabel(host);
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

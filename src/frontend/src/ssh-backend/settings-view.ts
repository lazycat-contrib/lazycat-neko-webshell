import type { SshConfigDocumentHost, SshConfigHost, SshConfigView, SshKeyFileView, SshProfile, SshProfileKind } from "./api";
import type { SshConfigHostDraft } from "./config-editor";
import type { MessageKey } from "../i18n";
import { escapeAttr, escapeHtml } from "../utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

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
  tr: Translate;
  profiles: SshProfile[];
  configHosts: SshConfigHost[];
  draft: SshProfileDraft;
  selectedId?: string;
  query: string;
  status: string;
  tone: "neutral" | "ok" | "error";
  busy: boolean;
  configView?: SshConfigView;
  configSource: "lightos" | "provider";
  configSourceLabel: string;
  lightosConfigAvailable: boolean;
  configMode: "hosts" | "raw";
  configContent: string;
  configDirty: boolean;
  selectedConfigHostAlias: string;
  hostDraft: SshConfigHostDraft;
  backupLimit: number;
  keyFile?: SshKeyFileView;
  keyPathDraft: string;
  keyContentDraft: string;
  keyContentVisible: boolean;
  keyDirty: boolean;
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
  const tr = state.tr;
  return `
    <div class="settings-section-head">
      <div>
        <div class="settings-group-title">${escapeHtml(tr("sshSettings.title"))}</div>
        <p class="settings-help">${escapeHtml(tr("sshSettings.help"))}</p>
      </div>
      <button class="icon-button" type="button" data-ssh-profile-action="refresh" aria-label="${escapeAttr(tr("sshSettings.refreshHosts"))}" title="${escapeAttr(tr("sshSettings.refreshHosts"))}" ${busy}>
        <i data-lucide="refresh-cw"></i>
      </button>
    </div>
    ${renderSshConfigManager(state, busy)}
    <div class="ssh-profile-toolbar">
      <label class="ssh-profile-search">
        <span class="sr-only">${escapeHtml(tr("sshSettings.searchLabel"))}</span>
        <i data-lucide="search"></i>
        <input type="search" data-ssh-search value="${escapeAttr(state.query)}" placeholder="${escapeAttr(tr("sshSettings.searchPlaceholder"))}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
      <button class="command-button" type="button" data-ssh-profile-action="new-managed" ${busy}>
        <i data-lucide="key-round"></i>
        <span>${escapeHtml(tr("sshSettings.managedKey"))}</span>
      </button>
      <button class="command-button" type="button" data-ssh-profile-action="new-openssh" ${busy}>
        <i data-lucide="terminal"></i>
        <span>${escapeHtml(tr("sshSettings.openSsh"))}</span>
      </button>
    </div>
    <div class="ssh-profile-layout">
      <div class="ssh-profile-inventory">
        <div class="ssh-profile-count">${escapeHtml(connectionCountLabel(state.profiles, state.configHosts, rows, state.query, tr))}</div>
        <div class="ssh-profile-list" role="list" aria-label="${escapeAttr(tr("sshSettings.connectionsAria"))}">
          ${renderConnectionRows(rows, state.selectedId, busy, tr)}
        </div>
      </div>
      <div class="ssh-profile-editor">
        ${renderProfileForm(state.draft, selected, state.configHosts, busy, tr)}
      </div>
    </div>
    <p class="field-status" data-tone="${escapeAttr(state.tone)}">${escapeHtml(state.status)}</p>
  `;
}

function renderSshConfigManager(state: SshProfileSettingsViewState, busy: string): string {
  const hostCount = state.configView?.document.hosts.length ?? 0;
  const tr = state.tr;
  return `
    <div class="ssh-config-manager">
      <div class="ssh-config-toolbar">
        <label class="field ssh-config-source">
          <span>${escapeHtml(tr("sshSettings.configSource"))}</span>
          <select data-ssh-config-source ${busy}>
            <option value="lightos" ${state.configSource === "lightos" ? "selected" : ""} ${state.lightosConfigAvailable ? "" : "disabled"}>${escapeHtml(state.configSourceLabel)}</option>
            <option value="provider" ${state.configSource === "provider" ? "selected" : ""}>${escapeHtml(tr("sshSettings.providerConfig"))}</option>
          </select>
        </label>
        <label class="field ssh-backup-limit">
          <span>${escapeHtml(tr("sshSettings.backupLimit"))}</span>
          <input type="number" min="1" max="100" data-ssh-backup-limit value="${escapeAttr(String(state.backupLimit))}" ${busy} />
        </label>
        <div class="ssh-config-mode" role="tablist" aria-label="${escapeAttr(tr("sshSettings.editModeAria"))}">
          <button type="button" data-ssh-config-mode="hosts" aria-pressed="${state.configMode === "hosts"}" ${busy}>${escapeHtml(tr("sshSettings.hostForm"))}</button>
          <button type="button" data-ssh-config-mode="raw" aria-pressed="${state.configMode === "raw"}" ${busy}>${escapeHtml(tr("sshSettings.rawConfig"))}</button>
        </div>
        <button class="command-button" type="button" data-ssh-config-refresh ${busy}>
          <i data-lucide="refresh-cw"></i>
          <span>${escapeHtml(tr("action.refresh"))}</span>
        </button>
      </div>
      <div class="ssh-config-meta">
        <span>${escapeHtml(state.configView?.source || "~/.ssh/config")}</span>
        <span>${escapeHtml(tr("sshSettings.hostCount", { count: hostCount }))}</span>
        ${state.configDirty ? `<strong>${escapeHtml(tr("sshSettings.unsaved"))}</strong>` : ""}
      </div>
      ${state.configMode === "raw" ? renderRawConfigEditor(state, busy) : renderHostConfigEditor(state, busy)}
    </div>
  `;
}

function renderRawConfigEditor(state: SshProfileSettingsViewState, busy: string): string {
  return `
    <div class="ssh-config-raw">
      <textarea data-ssh-config-content spellcheck="false" ${busy}>${escapeHtml(state.configContent)}</textarea>
      <div class="ssh-profile-actions">
        <button class="command-button primary" type="button" data-ssh-config-save ${state.configDirty ? "" : "disabled"} ${busy}>
          <i data-lucide="save"></i>
          <span>${escapeHtml(state.tr("sshSettings.saveConfig"))}</span>
        </button>
      </div>
    </div>
  `;
}

function renderHostConfigEditor(state: SshProfileSettingsViewState, busy: string): string {
  const hosts = state.configView?.document.hosts ?? [];
  return `
    <div class="ssh-config-host-layout">
      <div class="ssh-config-host-list" role="list" aria-label="${escapeAttr(state.tr("sshSettings.hostListAria"))}">
        <button class="command-button" type="button" data-ssh-config-host-new ${busy}>
          <i data-lucide="plus"></i>
          <span>${escapeHtml(state.tr("sshSettings.newHost"))}</span>
        </button>
        ${hosts.length ? hosts.map((host) => renderDocumentHostRow(host, state.selectedConfigHostAlias, busy, state.tr)).join("") : `<div class="empty">${escapeHtml(state.tr("sshSettings.noConfigHosts"))}</div>`}
      </div>
      <div class="ssh-config-host-editor">
        ${renderHostDraftForm(state, busy)}
      </div>
    </div>
  `;
}

function renderDocumentHostRow(host: SshConfigDocumentHost, selectedAlias: string, busy: string, tr: Translate): string {
  const alias = host.patterns.find(selectableHostPattern) || host.patterns[0] || "";
  const active = alias === selectedAlias;
  const detail = [host.user, host.hostName].filter(Boolean).join("@");
  return `
    <button class="ssh-config-host-row ${active ? "selected" : ""}" type="button" data-ssh-config-doc-host="${escapeAttr(alias)}" aria-pressed="${active}" ${busy}>
      <i data-lucide="server"></i>
      <span>
        <strong>${escapeHtml(alias || "Host")}</strong>
        <small>${escapeHtml(detail || host.identityFiles[0] || tr("sshSettings.noHostName"))}</small>
      </span>
      ${host.identityFiles[0] ? `<em>key</em>` : ""}
    </button>
  `;
}

function renderHostDraftForm(state: SshProfileSettingsViewState, busy: string): string {
  const draft = state.hostDraft;
  const tr = state.tr;
  return `
    <div class="ssh-profile-editor-section">
      <div class="settings-group-title">${escapeHtml(draft.originalAlias ? tr("sshSettings.editHostTitle", { host: draft.originalAlias }) : tr("sshSettings.newHostTitle"))}</div>
      <div class="ssh-profile-grid">
        ${hostField("host", "Host", draft.host, "DemoServerA", busy, "text", false, tr)}
        ${hostField("hostName", "HostName", draft.hostName, "host-a.example.net", busy, "text", false, tr)}
      </div>
      <div class="ssh-profile-grid">
        ${hostField("user", tr("sshSettings.user"), draft.user, "ubuntu", busy, "text", false, tr)}
        ${hostField("port", tr("sshSettings.port"), draft.port, "22", busy, "number", false, tr)}
      </div>
      ${hostField("identityFile", "IdentityFile", draft.identityFile, "~/.ssh/demo_a_key.pem", busy, "text", true, tr)}
      ${hostField("certificateFile", "CertificateFile", draft.certificateFile, "~/.ssh/demo_a_key-cert.pub", busy, "text", true, tr)}
    </div>
    <div class="ssh-profile-editor-section">
      <div class="settings-group-title">${escapeHtml(tr("sshSettings.advancedNetwork"))}</div>
      ${hostField("proxyJump", "ProxyJump", draft.proxyJump, "bastion", busy, "text", false, tr)}
      ${hostField("proxyCommand", "ProxyCommand", draft.proxyCommand, "nc -x 127.0.0.1:1080 %h %p", busy, "text", false, tr)}
      <div class="ssh-profile-grid">
        ${hostField("forwardAgent", "ForwardAgent", draft.forwardAgent, "yes/no", busy, "text", false, tr)}
        ${hostField("strictHostKeyChecking", "StrictHostKeyChecking", draft.strictHostKeyChecking, "accept-new", busy, "text", false, tr)}
      </div>
      <div class="ssh-profile-grid">
        ${hostField("serverAliveInterval", "ServerAliveInterval", draft.serverAliveInterval, "30", busy, "number", false, tr)}
        ${hostField("dynamicForward", "DynamicForward", draft.dynamicForward, "1080", busy, "text", false, tr)}
      </div>
      ${hostField("localForward", "LocalForward", draft.localForward, "8080 localhost:80", busy, "text", false, tr)}
      ${hostField("remoteForward", "RemoteForward", draft.remoteForward, "8080 localhost:80", busy, "text", false, tr)}
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.extraOptions"))}</span>
        <textarea data-ssh-config-host-field="extraOptionsText" spellcheck="false" ${busy}>${escapeHtml(draft.extraOptionsText)}</textarea>
      </label>
    </div>
    <div class="ssh-profile-actions">
      <button class="command-button primary" type="button" data-ssh-config-host-save ${busy}>
        <i data-lucide="save"></i>
        <span>${escapeHtml(tr("sshSettings.saveHost"))}</span>
      </button>
    </div>
    ${renderKeyEditor(state, busy)}
  `;
}

function hostField(
  field: keyof SshConfigHostDraft,
  label: string,
  value: string,
  placeholder: string,
  busy: string,
  type = "text",
  keyAction = false,
  tr: Translate,
): string {
  const keyLabel = tr("sshSettings.editKeyLabel", { label });
  return `
    <label class="field ssh-config-host-field">
      <span>${escapeHtml(label)}</span>
      <span class="ssh-config-host-input-line">
        <input type="${escapeAttr(type)}" data-ssh-config-host-field="${escapeAttr(field)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" autocomplete="off" spellcheck="false" ${busy} />
        ${keyAction ? `<button class="icon-button" type="button" data-ssh-key-open="${escapeAttr(value)}" aria-label="${escapeAttr(keyLabel)}" title="${escapeAttr(keyLabel)}" ${value.trim() ? "" : "disabled"} ${busy}><i data-lucide="file-key-2"></i></button>` : ""}
      </span>
    </label>
  `;
}

function renderKeyEditor(state: SshProfileSettingsViewState, busy: string): string {
  if (!state.keyFile && !state.keyPathDraft) return "";
  const keyContent = state.keyContentVisible
    ? state.keyContentDraft
    : hiddenKeyContentLabel(state.keyContentDraft, state.keyFile?.exists ?? false, state.tr);
  const hiddenAttrs = state.keyContentVisible ? "" : `readonly aria-readonly="true"`;
  const tr = state.tr;
  return `
    <div class="ssh-key-editor">
      <div class="ssh-profile-editor-head">
        <div>
          <div class="settings-group-title">${escapeHtml(tr("sshSettings.keyFile"))}</div>
          <p class="settings-help">${escapeHtml(state.keyFile?.source || state.keyPathDraft)}</p>
        </div>
        <button class="command-button" type="button" data-ssh-key-toggle-visible ${busy}>
          <i data-lucide="${state.keyContentVisible ? "eye-off" : "eye"}"></i>
          <span>${escapeHtml(state.keyContentVisible ? tr("sshSettings.hide") : tr("sshSettings.show"))}</span>
        </button>
      </div>
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.keyPath"))}</span>
        <input type="text" data-ssh-key-path value="${escapeAttr(state.keyPathDraft)}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.keyContent"))}</span>
        <textarea class="${state.keyContentVisible ? "" : "ssh-secret-hidden"}" data-ssh-key-content spellcheck="false" ${hiddenAttrs} ${busy}>${escapeHtml(keyContent)}</textarea>
      </label>
      <div class="ssh-profile-actions">
        <button class="command-button primary" type="button" data-ssh-key-save ${state.keyDirty ? "" : "disabled"} ${busy}>
          <i data-lucide="save"></i>
          <span>${escapeHtml(tr("sshSettings.saveKey"))}</span>
        </button>
      </div>
    </div>
  `;
}

function hiddenKeyContentLabel(content: string, exists: boolean, tr: Translate): string {
  if (!exists && !content) return tr("sshSettings.keyMissingHidden");
  const bytes = new TextEncoder().encode(content).length;
  return tr("sshSettings.keyHidden", { bytes });
}

function selectableHostPattern(value: string): boolean {
  return Boolean(value) && !value.startsWith("-") && !value.startsWith("!") && !/[?[*\s]/.test(value);
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
  tr: Translate,
): string {
  if (query.trim()) {
    return tr("sshSettings.connectionCountFiltered", {
      shown: rows.length,
      profiles: profiles.length,
      hosts: configHosts.length,
    });
  }
  return tr("sshSettings.connectionCount", {
    profiles: profiles.length,
    hosts: configHosts.length,
  });
}

function renderConnectionRows(rows: ConnectionRow[], selectedId: string | undefined, busy: string, tr: Translate): string {
  if (!rows.length) {
    return `<div class="empty">${escapeHtml(tr("sshSettings.noConnectionMatch"))}</div>`;
  }
  return rows.map((row) => row.type === "profile"
    ? renderProfileRow(row.profile, selectedId, busy, tr)
    : renderConfigHostRow(row.host, busy, tr)).join("");
}

function renderProfileRow(profile: SshProfile, selectedId: string | undefined, busy: string, tr: Translate): string {
  const active = profile.id === selectedId;
  const target = profileTargetLabel(profile);
  const badges = [
    tr("sshSettings.badgeProfile"),
    profile.kind === "managed-key" ? tr("sshSettings.badgeKey") : tr("sshSettings.badgeSsh"),
    profile.enabled ? tr("setting.pluginEnabled") : tr("setting.pluginDisabled"),
  ];
  const disabled = profile.enabled ? "" : "disabled";
  const openLabel = tr("sshSettings.openNamedProfile", { name: profile.name });
  return `
    <div class="ssh-profile-row-shell ${active ? "selected" : ""}" role="listitem">
      <button class="ssh-profile-row-body" type="button" aria-pressed="${active}" data-ssh-profile-id="${escapeAttr(profile.id)}" ${busy}>
        <span class="ssh-profile-row-copy">
          <strong>${escapeHtml(profile.name)}</strong>
          <small>${escapeHtml(target || profile.selector)}</small>
        </span>
        <span class="ssh-profile-badges">${renderBadges(badges)}</span>
      </button>
      <button class="icon-button ssh-profile-open" type="button" data-ssh-profile-open="${escapeAttr(profile.id)}" aria-label="${escapeAttr(openLabel)}" title="${escapeAttr(openLabel)}" ${busy} ${disabled}>
        <i data-lucide="square-arrow-out-up-right"></i>
      </button>
    </div>
  `;
}

function renderConfigHostRow(host: SshConfigHost, busy: string, tr: Translate): string {
  const target = configHostTargetLabel(host);
  const saveLabel = tr("sshSettings.saveAsProfile");
  return `
    <div class="ssh-profile-row-shell config" role="listitem">
      <button class="ssh-profile-row-body" type="button" data-ssh-config-host-row="${escapeAttr(host.alias)}" ${busy}>
        <span class="ssh-profile-row-copy">
          <strong>${escapeHtml(host.alias)}</strong>
          <small>${escapeHtml(target || host.source)}</small>
        </span>
        <span class="ssh-profile-badges">${renderBadges([tr("sshSettings.badgeConfig"), tr("sshSettings.badgeOpenSsh")])}</span>
      </button>
      <button class="icon-button ssh-profile-open" type="button" data-ssh-config-save="${escapeAttr(host.alias)}" aria-label="${escapeAttr(tr("sshSettings.saveNamedAsProfile", { name: host.alias }))}" title="${escapeAttr(saveLabel)}" ${busy}>
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
  tr: Translate,
): string {
  const managed = draft.kind === "managed-key";
  return `
    <div class="ssh-profile-editor-head">
      <div>
        <div class="settings-group-title">${escapeHtml(selected ? selected.name : tr("sshSettings.newConnection"))}</div>
        <p class="settings-help">${escapeHtml(editorSubtitle(draft, selected, tr))}</p>
      </div>
      <button class="command-button" type="button" data-ssh-profile-open="${escapeAttr(selected?.id ?? "")}" ${selected?.enabled ? "" : "disabled"} ${busy}>
        <i data-lucide="square-arrow-out-up-right"></i>
        <span>${escapeHtml(tr("sshSettings.open"))}</span>
      </button>
    </div>
    <div class="ssh-profile-editor-section">
      <div class="settings-group-title">${escapeHtml(tr("sshSettings.basic"))}</div>
      <div class="ssh-profile-kind" role="radiogroup" aria-label="${escapeAttr(tr("sshSettings.profileTypeAria"))}">
        ${kindButton("managed-key", tr("sshSettings.managedPublicKey"), draft.kind, busy)}
        ${kindButton("device-openssh", tr("sshSettings.deviceOpenSsh"), draft.kind, busy)}
      </div>
      <label class="switch">
        <input type="checkbox" data-ssh-profile-field="enabled" ${draft.enabled ? "checked" : ""} ${busy} />
        <span>${escapeHtml(tr("sshSettings.enabled"))}</span>
      </label>
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.name"))}</span>
        <input type="text" data-ssh-profile-field="name" value="${escapeAttr(draft.name)}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
    </div>
    <div class="ssh-profile-editor-section">
      <div class="settings-group-title">${escapeHtml(managed ? tr("sshSettings.managedKeyTitle") : tr("sshSettings.openSsh"))}</div>
      ${managed ? renderManagedFields(draft, selected, busy, tr) : renderOpenSshFields(draft, configHosts, busy, tr)}
    </div>
    <div class="ssh-profile-editor-section">
      <div class="settings-group-title">${escapeHtml(tr("sshSettings.advanced"))}</div>
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.hostKeyChecking"))}</span>
        <select data-ssh-profile-field="strictHostKeyChecking" ${busy}>
          ${hostKeyOption("accept-new", tr("sshSettings.acceptNewHosts"), draft.strictHostKeyChecking)}
          ${hostKeyOption("yes", tr("sshSettings.strict"), draft.strictHostKeyChecking)}
          ${hostKeyOption("no", tr("sshSettings.off"), draft.strictHostKeyChecking)}
        </select>
      </label>
      ${selected?.publicKey ? renderPublicKey(selected.publicKey, tr) : ""}
    </div>
    <div class="ssh-profile-actions">
      <button class="command-button primary" type="button" data-ssh-profile-action="save" ${busy}>
        <i data-lucide="save"></i>
        <span>${escapeHtml(tr("sshSettings.saveProfile"))}</span>
      </button>
      <button class="command-button" type="button" data-ssh-profile-action="test" ${selected ? "" : "disabled"} ${busy}>
        <i data-lucide="plug-zap"></i>
        <span>${escapeHtml(tr("sshSettings.test"))}</span>
      </button>
      <button class="command-button danger" type="button" data-ssh-profile-action="delete" ${selected ? "" : "disabled"} ${busy}>
        <i data-lucide="trash-2"></i>
        <span>${escapeHtml(tr("sshSettings.delete"))}</span>
      </button>
    </div>
  `;
}

function renderManagedFields(draft: SshProfileDraft, selected: SshProfile | undefined, busy: string, tr: Translate): string {
  return `
    <label class="field">
      <span>${escapeHtml(tr("sshSettings.host"))}</span>
      <input type="text" data-ssh-profile-field="host" value="${escapeAttr(draft.host)}" autocomplete="off" spellcheck="false" ${busy} />
    </label>
    <div class="ssh-profile-grid">
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.port"))}</span>
        <input type="number" data-ssh-profile-field="port" min="1" max="65535" value="${escapeAttr(draft.port)}" ${busy} />
      </label>
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.user"))}</span>
        <input type="text" data-ssh-profile-field="username" value="${escapeAttr(draft.username)}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
    </div>
    ${selected?.publicKey ? "" : `<p class="settings-help">${escapeHtml(tr("sshSettings.publicKeyPending"))}</p>`}
  `;
}

function renderOpenSshFields(draft: SshProfileDraft, configHosts: SshConfigHost[], busy: string, tr: Translate): string {
  return `
    ${configHosts.length ? `
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.configSelectLabel"))}</span>
        <select data-ssh-config-host ${busy}>
          <option value="">${escapeHtml(tr("sshSettings.chooseHost"))}</option>
          ${configHosts.map((host) => configHostOption(host, draft.target)).join("")}
        </select>
      </label>
    ` : ""}
    <label class="field">
      <span>${escapeHtml(tr("sshSettings.openSshTarget"))}</span>
      <input type="text" data-ssh-profile-field="target" value="${escapeAttr(draft.target)}" placeholder="host-alias or user@example.com" autocomplete="off" spellcheck="false" ${busy} />
    </label>
    <div class="ssh-profile-grid">
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.displayHost"))}</span>
        <input type="text" data-ssh-profile-field="host" value="${escapeAttr(draft.host)}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
      <label class="field">
        <span>${escapeHtml(tr("sshSettings.displayUser"))}</span>
        <input type="text" data-ssh-profile-field="username" value="${escapeAttr(draft.username)}" autocomplete="off" spellcheck="false" ${busy} />
      </label>
    </div>
  `;
}

function renderPublicKey(publicKey: string, tr: Translate): string {
  return `
    <div class="ssh-public-key">
      <div class="settings-group-title">${escapeHtml(tr("sshSettings.publicKey"))}</div>
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

function editorSubtitle(draft: SshProfileDraft, selected: SshProfile | undefined, tr: Translate): string {
  if (selected) return profileTargetLabel(selected) || selected.selector;
  return draft.kind === "managed-key"
    ? tr("sshSettings.managedSubtitle")
    : tr("sshSettings.openSshSubtitle");
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

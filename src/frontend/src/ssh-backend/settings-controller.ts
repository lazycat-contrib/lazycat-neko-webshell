import {
  deleteSshProfile,
  fetchSshConfig,
  fetchSshKeyFile,
  fetchSshProfiles,
  saveSshConfig,
  saveSshKeyFile,
  saveSshProfile,
  testSshProfile,
  type SshConfigDocumentHost,
  type SshConfigHost,
  type SshConfigView,
  type SshKeyFileView,
  type SshProfile,
  type SshProfileKind,
  type SshProfileSaveInput,
} from "./api";
import {
  applyHostDraftToConfig,
  emptyHostDraft,
  hostDraftFromDocumentHost,
  type SshConfigHostDraft,
} from "./config-editor";
import { isSshSelector } from "./selector";
import {
  draftFromConfigHost,
  draftFromProfile,
  emptySshProfileDraft,
  renderSshProfileSettingsView,
  type SshProfileDraft,
} from "./settings-view";
import type { MessageKey } from "../i18n";
import { clampNumber } from "../utils";

export type SshProfileSettingsControllerOptions = {
  root: HTMLElement;
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
  getSelectedSelector: () => string;
  getSelectedLabel: () => string;
  lightosFeaturesEnabled: () => boolean;
  getBackupLimit: () => number;
  setBackupLimit: (value: number) => void;
  updateIcons: () => void;
  confirmDanger: (request: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
  }) => Promise<boolean>;
  onOpenProfile: (selector: string) => void | Promise<void>;
  onProfilesChanged: () => void;
  onStatus: (message: string, tone?: "neutral" | "ok" | "error") => void;
};

export function createSshProfileSettingsController(options: SshProfileSettingsControllerOptions) {
  let profiles: SshProfile[] = [];
  let configHosts: SshConfigHost[] = [];
  let selectedId: string | undefined;
  let draft = emptySshProfileDraft();
  let status = "";
  let tone: "neutral" | "ok" | "error" = "neutral";
  let query = "";
  let busy = false;
  let configView: SshConfigView | undefined;
  let configSource: "lightos" | "provider" = "lightos";
  let configMode: "hosts" | "raw" = "hosts";
  let configContent = "";
  let configDirty = false;
  let selectedConfigHostAlias = "";
  let hostDraft: SshConfigHostDraft = emptyHostDraft();
  let keyFile: SshKeyFileView | undefined;
  let keyPathDraft = "";
  let keyContentDraft = "";
  let keyContentVisible = false;
  let keyDirty = false;

  options.root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const configModeButton = target?.closest<HTMLButtonElement>("[data-ssh-config-mode]");
    if (configModeButton) {
      const mode = configModeButton.dataset.sshConfigMode;
      if (mode === "hosts" || mode === "raw") {
        configMode = mode;
        render();
      }
      return;
    }
    if (target?.closest<HTMLButtonElement>("[data-ssh-config-refresh]")) {
      void loadConfigOnly();
      return;
    }
    if (target?.closest<HTMLButtonElement>("[data-ssh-config-host-new]")) {
      selectedConfigHostAlias = "";
      hostDraft = emptyHostDraft();
      keyFile = undefined;
      keyPathDraft = "";
      keyContentDraft = "";
      keyDirty = false;
      render();
      return;
    }
    const documentHost = target?.closest<HTMLButtonElement>("[data-ssh-config-doc-host]");
    if (documentHost) {
      selectDocumentHost(documentHost.dataset.sshConfigDocHost ?? "");
      return;
    }
    if (target?.closest<HTMLButtonElement>("[data-ssh-config-host-save]")) {
      void saveConfigHostDraft();
      return;
    }
    const keyOpen = target?.closest<HTMLButtonElement>("[data-ssh-key-open]");
    if (keyOpen) {
      void openKeyFile(keyOpen.dataset.sshKeyOpen ?? "");
      return;
    }
    if (target?.closest<HTMLButtonElement>("[data-ssh-key-toggle-visible]")) {
      keyContentVisible = !keyContentVisible;
      render();
      return;
    }
    if (target?.closest<HTMLButtonElement>("[data-ssh-key-save]")) {
      void saveKeyFileDraft();
      return;
    }
    const open = target?.closest<HTMLButtonElement>("[data-ssh-profile-open]");
    if (open) {
      void openProfile(open.dataset.sshProfileOpen ?? "");
      return;
    }
    const saveConfig = target?.closest<HTMLButtonElement>("[data-ssh-config-save]");
    if (saveConfig) {
      const alias = saveConfig.dataset.sshConfigSave ?? "";
      if (alias) {
        void importConfigHost(alias);
      } else {
        void saveRawConfig();
      }
      return;
    }
    const configRow = target?.closest<HTMLButtonElement>("[data-ssh-config-host-row]");
    if (configRow) {
      selectConfigHost(configRow.dataset.sshConfigHostRow ?? "");
      return;
    }
    const row = target?.closest<HTMLButtonElement>("[data-ssh-profile-id]");
    if (row) {
      selectProfile(row.dataset.sshProfileId ?? "");
      return;
    }
    const kind = target?.closest<HTMLButtonElement>("[data-ssh-profile-kind]");
    if (kind) {
      setDraftKind(kind.dataset.sshProfileKind as SshProfileKind);
      return;
    }
    const action = target?.closest<HTMLButtonElement>("[data-ssh-profile-action]")?.dataset.sshProfileAction;
    if (!action) return;
    if (action === "refresh") void load();
    if (action === "new-managed") startNew("managed-key");
    if (action === "new-openssh") startNew("device-openssh");
    if (action === "save") void save();
    if (action === "test") void test();
    if (action === "delete") void remove();
  });

  options.root.addEventListener("input", updateDraftFromEvent);
  options.root.addEventListener("change", updateDraftFromEvent);

  async function load() {
    await withBusy(async () => {
      profiles = await fetchSshProfiles();
      await loadConfigState();
      if (selectedId) {
        const selected = profiles.find((profile) => profile.id === selectedId);
        if (selected) {
          draft = draftFromProfile(selected);
        } else {
          selectedId = undefined;
          draft = emptySshProfileDraft();
        }
      }
      setStatus(options.tr(profiles.length ? "sshStatus.configLoaded" : "sshStatus.noProfiles"), "neutral", false);
    }, "sshError.loadProfiles");
  }

  async function loadConfigOnly() {
    await withBusy(async () => {
      await loadConfigState();
      setStatus(options.tr("sshStatus.configRefreshed"), "ok", false);
    }, "sshError.loadConfig");
  }

  async function loadConfigState() {
    normalizeConfigSource();
    configView = await fetchSshConfig(configSelector());
    configContent = configView.content;
    configDirty = false;
    configHosts = configView.hosts;
    selectFirstHostIfNeeded();
    keyFile = undefined;
    keyPathDraft = "";
    keyContentDraft = "";
    keyDirty = false;
    keyContentVisible = false;
  }

  function normalizeConfigSource() {
    if (!lightosConfigAvailable()) {
      configSource = "provider";
    }
  }

  function configSelector(): string | undefined {
    return configSource === "lightos" && lightosConfigAvailable()
      ? options.getSelectedSelector()
      : undefined;
  }

  function lightosConfigAvailable(): boolean {
    const selector = options.getSelectedSelector();
    return Boolean(options.lightosFeaturesEnabled() && selector && !isSshSelector(selector));
  }

  function selectFirstHostIfNeeded() {
    if (!configView?.document.hosts.length) {
      selectedConfigHostAlias = "";
      hostDraft = emptyHostDraft();
      return;
    }
    if (selectedConfigHostAlias && findDocumentHost(selectedConfigHostAlias)) {
      return;
    }
    const first = configView.document.hosts[0];
    selectedConfigHostAlias = documentHostAlias(first);
    hostDraft = hostDraftFromDocumentHost(first);
  }

  function findDocumentHost(alias: string): SshConfigDocumentHost | undefined {
    return configView?.document.hosts.find((host) => documentHostAlias(host) === alias);
  }

  function documentHostAlias(host: SshConfigDocumentHost): string {
    return host.patterns.find((pattern) => Boolean(pattern) && !pattern.startsWith("!") && !/[?[*\s]/.test(pattern))
      || host.patterns[0]
      || "";
  }

  function selectDocumentHost(alias: string) {
    const host = findDocumentHost(alias);
    if (!host) return;
    selectedConfigHostAlias = documentHostAlias(host);
    hostDraft = hostDraftFromDocumentHost(host);
    keyFile = undefined;
    keyPathDraft = "";
    keyContentDraft = "";
    keyDirty = false;
    keyContentVisible = false;
    render();
  }

  async function saveRawConfig() {
    await withBusy(async () => {
      const saved = await saveSshConfig(configContent, {
        selector: configSelector(),
        backupLimit: options.getBackupLimit(),
      });
      configView = {
        source: saved.source,
        content: configContent,
        document: saved.document,
        hosts: saved.hosts,
      };
      configHosts = saved.hosts;
      configDirty = false;
      selectFirstHostIfNeeded();
      setStatus(saved.backupPath
        ? options.tr("sshStatus.configSavedBackup", { path: saved.backupPath })
        : options.tr("sshStatus.configSaved"), "ok", false);
    }, "sshError.saveConfig");
  }

  async function saveConfigHostDraft() {
    await withBusy(async () => {
      configContent = applyHostDraftToConfig(configContent, hostDraft);
      const saved = await saveSshConfig(configContent, {
        selector: configSelector(),
        backupLimit: options.getBackupLimit(),
      });
      configView = {
        source: saved.source,
        content: configContent,
        document: saved.document,
        hosts: saved.hosts,
      };
      configHosts = saved.hosts;
      configDirty = false;
      selectedConfigHostAlias = hostDraft.host.trim().split(/\s+/)[0] || selectedConfigHostAlias;
      selectFirstHostIfNeeded();
      setStatus(options.tr("sshStatus.hostSaved"), "ok", false);
    }, "sshError.saveHost");
  }

  async function openKeyFile(path: string) {
    const normalized = path.trim();
    if (!normalized) return;
    await withBusy(async () => {
      const file = await fetchSshKeyFile(normalized, { selector: configSelector() });
      keyFile = file;
      keyPathDraft = file.path;
      keyContentDraft = file.content;
      keyDirty = false;
      keyContentVisible = false;
      setStatus(options.tr(file.exists ? "sshStatus.keyLoaded" : "sshStatus.keyMissing"), "neutral", false);
    }, "sshError.loadKey");
  }

  async function saveKeyFileDraft() {
    const path = keyPathDraft.trim();
    if (!path) {
      setStatus(options.tr("sshValidation.keyPathRequired"), "error");
      return;
    }
    await withBusy(async () => {
      const saved = await saveSshKeyFile(path, keyContentDraft, {
        selector: configSelector(),
        backupLimit: options.getBackupLimit(),
      });
      keyFile = saved;
      keyPathDraft = saved.path;
      keyContentDraft = saved.content;
      keyDirty = false;
      keyContentVisible = false;
      setStatus(saved.backupPath
        ? options.tr("sshStatus.keySavedBackup", { path: saved.backupPath })
        : options.tr("sshStatus.keySaved"), "ok", false);
    }, "sshError.saveKey");
  }

  function selectProfile(id: string) {
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return;
    selectedId = profile.id;
    draft = draftFromProfile(profile);
    setStatus("", "neutral", false);
    render();
  }

  function startNew(kind: SshProfileKind) {
    selectedId = undefined;
    draft = emptySshProfileDraft(kind);
    setStatus("", "neutral", false);
    render();
  }

  function setDraftKind(kind: SshProfileKind) {
    if (kind !== "managed-key" && kind !== "device-openssh") return;
    draft = {
      ...draft,
      kind,
      port: kind === "managed-key" ? draft.port || "22" : "",
    };
    render();
  }

  function updateDraftFromEvent(event: Event) {
    const input = event.target instanceof HTMLInputElement
      || event.target instanceof HTMLSelectElement
      || event.target instanceof HTMLTextAreaElement
      ? event.target
      : null;
    if (input instanceof HTMLInputElement && input.matches("[data-ssh-search]")) {
      query = input.value;
      render({ focusSearch: true });
      return;
    }
    if (input instanceof HTMLSelectElement && input.matches("[data-ssh-config-host]")) {
      selectConfigHost(input.value);
      return;
    }
    if (input instanceof HTMLSelectElement && input.matches("[data-ssh-config-source]")) {
      configSource = input.value === "provider" ? "provider" : "lightos";
      void loadConfigOnly();
      return;
    }
    if (input instanceof HTMLInputElement && input.matches("[data-ssh-backup-limit]")) {
      const value = Math.round(clampNumber(input.value, 1, 100, options.getBackupLimit()));
      options.setBackupLimit(value);
      return;
    }
    if (input instanceof HTMLTextAreaElement && input.matches("[data-ssh-config-content]")) {
      configContent = input.value;
      configDirty = configView?.content !== configContent;
      options.root.querySelector<HTMLButtonElement>("[data-ssh-config-save]")?.toggleAttribute("disabled", !configDirty);
      return;
    }
    const hostField = input?.dataset.sshConfigHostField as keyof SshConfigHostDraft | undefined;
    if (input && hostField) {
      hostDraft[hostField] = input.value as never;
      if (hostField === "identityFile" || hostField === "certificateFile") {
        const button = input
          .closest(".ssh-config-host-input-line")
          ?.querySelector<HTMLButtonElement>("[data-ssh-key-open]");
        if (button) {
          button.dataset.sshKeyOpen = input.value;
          button.toggleAttribute("disabled", !input.value.trim() || busy);
        }
      }
      return;
    }
    if (input instanceof HTMLInputElement && input.matches("[data-ssh-key-path]")) {
      keyPathDraft = input.value;
      keyDirty = true;
      options.root.querySelector<HTMLButtonElement>("[data-ssh-key-save]")?.removeAttribute("disabled");
      return;
    }
    if (input instanceof HTMLTextAreaElement && input.matches("[data-ssh-key-content]")) {
      if (!keyContentVisible) return;
      keyContentDraft = input.value;
      keyDirty = keyFile?.content !== keyContentDraft || keyFile?.path !== keyPathDraft;
      options.root.querySelector<HTMLButtonElement>("[data-ssh-key-save]")?.toggleAttribute("disabled", !keyDirty);
      return;
    }
    const field = input?.dataset.sshProfileField as keyof SshProfileDraft | undefined;
    if (!input || !field) return;
    if (field === "enabled" && input instanceof HTMLInputElement) {
      draft.enabled = input.checked;
      return;
    }
    if (field === "strictHostKeyChecking") {
      const value = input.value;
      draft.strictHostKeyChecking = value === "yes" || value === "no" ? value : "accept-new";
      return;
    }
    draft[field] = input.value as never;
  }

  function selectConfigHost(alias: string) {
    const host = configHosts.find((item) => item.alias === alias);
    if (!host) return;
    selectedId = undefined;
    draft = {
      ...draftFromConfigHost(host),
      strictHostKeyChecking: draft.strictHostKeyChecking,
    };
    render();
  }

  async function importConfigHost(alias: string) {
    const host = configHosts.find((item) => item.alias === alias);
    if (!host) return;
    selectedId = undefined;
    draft = {
      ...draftFromConfigHost(host),
      strictHostKeyChecking: draft.strictHostKeyChecking,
    };
    await save();
  }

  async function save() {
    const input = profileInputFromDraft();
    if (typeof input === "string") {
      setStatus(input, "error");
      return;
    }
    await withBusy(async () => {
      const saved = await saveSshProfile(input);
      profiles = upsertProfile(profiles, saved);
      selectedId = saved.id;
      draft = draftFromProfile(saved);
      setStatus(options.tr("sshStatus.profileSaved"), "ok", false);
      options.onProfilesChanged();
    }, "sshError.saveProfile");
  }

  async function test() {
    if (!selectedId) {
      setStatus(options.tr("sshValidation.saveBeforeTesting"), "error");
      return;
    }
    const profileId = selectedId;
    await withBusy(async () => {
      const message = await testSshProfile(profileId);
      setStatus(message, "ok", false);
    }, "sshError.testProfile");
  }

  async function openProfile(id: string) {
    const selected = profiles.find((profile) => profile.id === id);
    if (!selected) return;
    if (!selected.enabled) {
      setStatus(options.tr("sshValidation.enableBeforeOpening"), "error");
      return;
    }
    await withBusy(async () => {
      await options.onOpenProfile(selected.selector);
      setStatus(options.tr("sshStatus.openingProfile", { name: selected.name }), "ok", false);
    }, "sshError.openProfile");
  }

  async function remove() {
    if (!selectedId) return;
    const selected = profiles.find((profile) => profile.id === selectedId);
    if (!selected) return;
    const confirmed = await options.confirmDanger({
      title: options.tr("sshSettings.delete"),
      message: options.tr("sshConfirm.deleteProfile", { name: selected.name }),
      confirmLabel: options.tr("sshSettings.delete"),
      cancelLabel: options.tr("action.cancel"),
    });
    if (!confirmed) return;
    await withBusy(async () => {
      await deleteSshProfile(selected.id);
      profiles = profiles.filter((profile) => profile.id !== selected.id);
      selectedId = undefined;
      draft = emptySshProfileDraft();
      setStatus(options.tr("sshStatus.profileDeleted"), "ok", false);
      options.onProfilesChanged();
    }, "sshError.deleteProfile");
  }

  function profileInputFromDraft(): SshProfileSaveInput | string {
    const name = draft.name.trim();
    if (!name) return options.tr("sshValidation.nameRequired");
    const port = draft.port.trim() ? Number(draft.port) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      return options.tr("sshValidation.portRange");
    }
    if (draft.kind === "managed-key" && !draft.host.trim()) {
      return options.tr("sshValidation.hostRequired");
    }
    if (draft.kind === "device-openssh" && !draft.target.trim()) {
      return options.tr("sshValidation.openSshTargetRequired");
    }
    return {
      id: draft.id,
      name,
      kind: draft.kind,
      enabled: draft.enabled,
      host: draft.host.trim(),
      port,
      username: draft.username.trim(),
      target: draft.target.trim(),
      strictHostKeyChecking: draft.strictHostKeyChecking,
    };
  }

  async function withBusy(task: () => Promise<void>, errorKey: MessageKey) {
    busy = true;
    render();
    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(options.tr(errorKey, { message }), "error", false);
      options.onStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      busy = false;
      render();
    }
  }

  function setStatus(message: string, nextTone: "neutral" | "ok" | "error" = "neutral", rerender = true) {
    status = message;
    tone = nextTone;
    if (rerender) render();
  }

  type RenderOptions = {
    focusSearch?: boolean;
  };

  function render(renderOptions: RenderOptions = {}) {
    options.root.innerHTML = renderSshProfileSettingsView({
      tr: options.tr,
      profiles,
      configHosts,
      draft,
      selectedId,
      query,
      status,
      tone,
      busy,
      configView,
      configSource,
      configSourceLabel: lightosConfigAvailable()
        ? `${options.getSelectedLabel()} ~/.ssh/config`
        : options.tr("sshSettings.currentLightosConfig"),
      lightosConfigAvailable: lightosConfigAvailable(),
      configMode,
      configContent,
      configDirty,
      selectedConfigHostAlias,
      hostDraft,
      backupLimit: options.getBackupLimit(),
      keyFile,
      keyPathDraft,
      keyContentDraft,
      keyContentVisible,
      keyDirty,
    });
    options.updateIcons();
    if (renderOptions.focusSearch) {
      const search = options.root.querySelector<HTMLInputElement>("[data-ssh-search]");
      search?.focus();
      const end = search?.value.length ?? 0;
      search?.setSelectionRange(end, end);
    }
  }

  render();

  return {
    load,
    render,
  };
}

function upsertProfile(profiles: SshProfile[], profile: SshProfile): SshProfile[] {
  const next = profiles.filter((item) => item.id !== profile.id);
  next.push(profile);
  next.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return next;
}

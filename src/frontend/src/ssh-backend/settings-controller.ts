import {
  deleteSshProfile,
  fetchSshConfigHosts,
  fetchSshProfiles,
  saveSshProfile,
  testSshProfile,
  type SshConfigHost,
  type SshProfile,
  type SshProfileKind,
  type SshProfileSaveInput,
} from "./api";
import {
  draftFromProfile,
  emptySshProfileDraft,
  renderSshProfileSettingsView,
  type SshProfileDraft,
} from "./settings-view";

export type SshProfileSettingsControllerOptions = {
  root: HTMLElement;
  updateIcons: () => void;
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
  let busy = false;

  options.root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
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
      let configLoadError = "";
      try {
        configHosts = await fetchSshConfigHosts();
      } catch (error) {
        configHosts = [];
        configLoadError = error instanceof Error ? error.message : String(error);
      }
      if (selectedId) {
        const selected = profiles.find((profile) => profile.id === selectedId);
        if (selected) {
          draft = draftFromProfile(selected);
        } else {
          selectedId = undefined;
          draft = emptySshProfileDraft();
        }
      }
      const message = configLoadError
        ? `SSH profiles loaded. OpenSSH config was not readable: ${configLoadError}`
        : profiles.length
          ? "SSH profiles loaded"
          : "No SSH profiles yet";
      setStatus(message, configLoadError ? "error" : "neutral", false);
    }, "Failed to load SSH profiles");
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
    const input = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
      ? event.target
      : null;
    if (input instanceof HTMLSelectElement && input.matches("[data-ssh-config-host]")) {
      selectConfigHost(input.value);
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
      ...draft,
      kind: "device-openssh",
      name: draft.name.trim() || host.alias,
      target: host.alias,
      host: host.host || host.alias,
      username: host.username,
      port: "",
    };
    render();
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
      setStatus("SSH profile saved", "ok", false);
      options.onProfilesChanged();
    }, "Failed to save SSH profile");
  }

  async function test() {
    if (!selectedId) {
      setStatus("Save the SSH profile before testing it", "error");
      return;
    }
    const profileId = selectedId;
    await withBusy(async () => {
      const message = await testSshProfile(profileId);
      setStatus(message, "ok", false);
    }, "SSH test failed");
  }

  async function remove() {
    if (!selectedId) return;
    const selected = profiles.find((profile) => profile.id === selectedId);
    if (!selected) return;
    if (!window.confirm(`Delete SSH profile "${selected.name}"?`)) return;
    await withBusy(async () => {
      await deleteSshProfile(selected.id);
      profiles = profiles.filter((profile) => profile.id !== selected.id);
      selectedId = undefined;
      draft = emptySshProfileDraft();
      setStatus("SSH profile deleted", "ok", false);
      options.onProfilesChanged();
    }, "Failed to delete SSH profile");
  }

  function profileInputFromDraft(): SshProfileSaveInput | string {
    const name = draft.name.trim();
    if (!name) return "Name is required";
    const port = draft.port.trim() ? Number(draft.port) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      return "Port must be between 1 and 65535";
    }
    if (draft.kind === "managed-key" && !draft.host.trim()) {
      return "Host is required";
    }
    if (draft.kind === "device-openssh" && !draft.target.trim()) {
      return "OpenSSH target is required";
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

  async function withBusy(task: () => Promise<void>, errorPrefix: string) {
    busy = true;
    render();
    try {
      await task();
    } catch (error) {
      setStatus(`${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`, "error", false);
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

  function render() {
    options.root.innerHTML = renderSshProfileSettingsView({
      profiles,
      configHosts,
      draft,
      selectedId,
      status,
      tone,
      busy,
    });
    options.updateIcons();
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

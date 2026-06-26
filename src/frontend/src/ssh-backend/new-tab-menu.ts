import type { MessageKey } from "../i18n";
import type { Tone } from "../types";
import { escapeAttr, escapeHtml } from "../utils";
import { fetchSshConfigHosts, fetchSshProfiles, type SshConfigHost, type SshProfile } from "./api";
import { normalizeSshTarget } from "./target";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type SshNewTabMenuContext = {
  selectedSelector: string;
  selectedLabel: string;
  lightosDirectAvailable: boolean;
};

export type SshNewTabMenuRenderOptions = {
  backendHtml: string;
  context: SshNewTabMenuContext;
};

export type SshNewTabMenuControllerOptions = {
  root: HTMLElement;
  tr: Translate;
  updateIcons: () => void;
  onDirectTarget: (target: string) => void | Promise<void>;
  onProviderTarget: (target: string) => void | Promise<void>;
  onOpenProfile: (selector: string) => void | Promise<void>;
  onManageHosts: () => void;
  onStatus: (message: string, tone?: Tone) => void;
};

type LoadState = {
  key: string;
  loading: boolean;
  profiles: SshProfile[];
  configHosts: SshConfigHost[];
  error: string;
};

type MenuStage = "entry" | "chooser" | "manual";

export function createSshNewTabMenuController(options: SshNewTabMenuControllerOptions) {
  let targetDraft = "";
  let stage: MenuStage = "entry";
  let lastRender: SshNewTabMenuRenderOptions | undefined;
  let loadState: LoadState = {
    key: "",
    loading: false,
    profiles: [],
    configHosts: [],
    error: "",
  };

  options.root.addEventListener("input", (event) => {
    const input = event.target instanceof HTMLInputElement
      ? event.target.closest<HTMLInputElement>("[data-ssh-new-tab-target]")
      : null;
    if (input) {
      targetDraft = input.value;
    }
  });

  options.root.addEventListener("submit", (event) => {
    const form = event.target instanceof Element
      ? event.target.closest<HTMLFormElement>("[data-ssh-new-tab-form]")
      : null;
    if (!form) return;
    event.preventDefault();
    event.stopPropagation();
    void openTarget(targetDraft, currentMode());
  });

  options.root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const action = target?.closest<HTMLButtonElement>("[data-ssh-new-tab-action]")?.dataset.sshNewTabAction;
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      runMenuAction(action);
      return;
    }
    const config = target?.closest<HTMLButtonElement>("[data-ssh-new-tab-config-target]");
    if (config) {
      event.preventDefault();
      event.stopPropagation();
      void openTarget(config.dataset.sshNewTabConfigTarget ?? "", currentMode());
      return;
    }
    const profile = target?.closest<HTMLButtonElement>("[data-ssh-new-tab-profile-selector]");
    if (profile) {
      event.preventDefault();
      event.stopPropagation();
      void Promise.resolve(options.onOpenProfile(profile.dataset.sshNewTabProfileSelector ?? ""))
        .catch((error) => options.onStatus(error instanceof Error ? error.message : String(error), "error"));
      return;
    }
    const manage = target?.closest<HTMLButtonElement>("[data-ssh-new-tab-manage]");
    if (manage) {
      event.preventDefault();
      event.stopPropagation();
      options.onManageHosts();
    }
  });

  function render(renderOptions: SshNewTabMenuRenderOptions) {
    if (lastRender && loadKey(lastRender.context) !== loadKey(renderOptions.context)) {
      stage = "entry";
      targetDraft = "";
    }
    lastRender = renderOptions;
    refreshData(renderOptions.context, { force: options.root.hidden });
    options.root.innerHTML = renderSshNewTabMenu({
      ...renderOptions,
      stage,
      targetDraft,
      profiles: loadState.profiles.filter((profile) => profile.enabled),
      configHosts: loadState.configHosts,
      loading: loadState.loading,
      error: loadState.error,
      tr: options.tr,
    });
    options.updateIcons();
  }

  function runMenuAction(action: string) {
    if (action === "direct") {
      stage = shouldShowChooser()
        ? "chooser"
        : "manual";
      rerenderIfOpen();
      return;
    }
    if (action === "manual") {
      stage = "manual";
      rerenderIfOpen();
      window.requestAnimationFrame(() => {
        options.root.querySelector<HTMLInputElement>("[data-ssh-new-tab-target]")?.focus();
      });
      return;
    }
    if (action === "chooser") {
      stage = "chooser";
      rerenderIfOpen();
      return;
    }
    if (action === "back") {
      stage = "entry";
      rerenderIfOpen();
    }
  }

  function shouldShowChooser(): boolean {
    return Boolean(loadState.loading || loadState.configHosts.length || loadState.profiles.some((profile) => profile.enabled));
  }

  function refreshData(context: SshNewTabMenuContext, options: { force?: boolean } = {}) {
    const key = loadKey(context);
    if ((loadState.key === key && !options.force) || loadState.loading) return;
    loadState = {
      ...loadState,
      key,
      loading: true,
      error: "",
    };
    void Promise.all([
      fetchSshProfiles(),
      fetchSshConfigHosts(context.lightosDirectAvailable ? context.selectedSelector : undefined),
    ]).then(([profiles, configHosts]) => {
      if (loadState.key !== key) return;
      loadState = {
        key,
        loading: false,
        profiles,
        configHosts,
        error: "",
      };
      rerenderIfOpen();
    }).catch((error) => {
      if (loadState.key !== key) return;
      loadState = {
        ...loadState,
        loading: false,
        configHosts: [],
        error: error instanceof Error ? error.message : String(error),
      };
      rerenderIfOpen();
    });
  }

  function rerenderIfOpen() {
    if (!lastRender || options.root.hidden) return;
    render(lastRender);
  }

  function currentMode(): "lightos" | "provider" {
    return lastRender?.context.lightosDirectAvailable ? "lightos" : "provider";
  }

  async function openTarget(value: string, mode: "lightos" | "provider") {
    let target: string;
    try {
      target = normalizeSshTarget(value);
    } catch {
      options.onStatus(options.tr("ssh.validationTarget"), "error");
      return;
    }
    try {
      if (mode === "lightos") {
        await options.onDirectTarget(target);
        return;
      }
      await options.onProviderTarget(target);
    } catch (error) {
      options.onStatus(error instanceof Error ? error.message : String(error), "error");
    }
  }

  return {
    render,
  };
}

function loadKey(context: SshNewTabMenuContext): string {
  return context.lightosDirectAvailable ? `target:${context.selectedSelector}` : "provider";
}

function renderSshNewTabMenu(state: SshNewTabMenuRenderOptions & {
  stage: MenuStage;
  targetDraft: string;
  profiles: SshProfile[];
  configHosts: SshConfigHost[];
  loading: boolean;
  error: string;
  tr: Translate;
}): string {
  return `
    <div class="new-tab-menu-section">
      ${state.backendHtml}
    </div>
    <div class="new-tab-menu-divider"></div>
    ${state.context.lightosDirectAvailable
      ? renderLightosSshSection(state)
      : renderProviderSshSection(state)}
    ${state.loading ? `<div class="ssh-new-tab-status">${escapeHtml(state.tr("ssh.loading"))}</div>` : ""}
    ${state.error ? `<div class="ssh-new-tab-status" data-tone="error">${escapeHtml(state.tr("ssh.configLoadFailed", { message: state.error }))}</div>` : ""}
  `;
}

function renderLightosSshSection(state: Parameters<typeof renderSshNewTabMenu>[0]): string {
  if (state.stage === "manual") {
    return `
      ${renderSectionHead(state.tr, "ssh.manualTitle", "arrow-left", "back")}
      ${renderManualForm(state)}
    `;
  }
  if (state.stage === "chooser") {
    return `
      ${renderSectionHead(state.tr, "ssh.chooseTitle", "arrow-left", "back")}
      <p class="ssh-new-tab-help">${escapeHtml(state.tr("ssh.chooseHelp", { instance: state.context.selectedLabel }))}</p>
      ${renderQuickRows(state)}
      <button class="ssh-new-tab-wide-action" type="button" data-ssh-new-tab-action="manual">
        <i data-lucide="keyboard"></i>
        <span>${escapeHtml(state.tr("ssh.manualConnect"))}</span>
      </button>
    `;
  }
  return `
    <div class="ssh-new-tab-entry">
      <div class="ssh-new-tab-head">
        <span>
          <i data-lucide="network"></i>
          <strong>${escapeHtml(state.tr("ssh.quickTitle"))}</strong>
        </span>
        <button class="icon-button ssh-new-tab-manage" type="button" data-ssh-new-tab-manage aria-label="${escapeAttr(state.tr("ssh.manageHosts"))}" title="${escapeAttr(state.tr("ssh.manageHosts"))}">
          <i data-lucide="server-cog"></i>
        </button>
      </div>
      <p class="ssh-new-tab-help">${escapeHtml(state.tr("ssh.quickHelpLightos", { instance: state.context.selectedLabel }))}</p>
      <button class="ssh-new-tab-wide-action primary" type="button" data-ssh-new-tab-action="direct">
        <i data-lucide="network"></i>
        <span>${escapeHtml(state.tr("ssh.directAction"))}</span>
        <small>${escapeHtml(state.tr("ssh.directLightosHint"))}</small>
      </button>
    </div>
  `;
}

function renderProviderSshSection(state: Parameters<typeof renderSshNewTabMenu>[0]): string {
  return `
    <div class="ssh-new-tab-entry">
      <div class="ssh-new-tab-head">
        <span>
          <i data-lucide="network"></i>
          <strong>${escapeHtml(state.tr("ssh.quickTitle"))}</strong>
        </span>
        <button class="icon-button ssh-new-tab-manage" type="button" data-ssh-new-tab-manage aria-label="${escapeAttr(state.tr("ssh.manageHosts"))}" title="${escapeAttr(state.tr("ssh.manageHosts"))}">
          <i data-lucide="server-cog"></i>
        </button>
      </div>
      <p class="ssh-new-tab-help">${escapeHtml(state.tr("ssh.quickHelpProvider"))}</p>
      ${renderManualForm(state)}
      ${renderQuickRows(state)}
    </div>
  `;
}

function renderSectionHead(tr: Translate, titleKey: MessageKey, icon: string, action: string): string {
  return `
    <div class="ssh-new-tab-head">
      <span>
        <i data-lucide="network"></i>
        <strong>${escapeHtml(tr(titleKey))}</strong>
      </span>
      <button class="icon-button ssh-new-tab-manage" type="button" data-ssh-new-tab-action="${escapeAttr(action)}" aria-label="${escapeAttr(tr("ssh.back"))}" title="${escapeAttr(tr("ssh.back"))}">
        <i data-lucide="${escapeAttr(icon)}"></i>
      </button>
    </div>
  `;
}

function renderManualForm(state: {
  targetDraft: string;
  tr: Translate;
}): string {
  return `
    <form class="ssh-new-tab-form" data-ssh-new-tab-form>
      <label class="ssh-new-tab-target">
        <span class="sr-only">${escapeHtml(state.tr("field.sshTarget"))}</span>
        <input type="text" data-ssh-new-tab-target value="${escapeAttr(state.targetDraft)}" placeholder="${escapeAttr(state.tr("ssh.quickPlaceholder"))}" autocomplete="off" spellcheck="false" />
        <button class="ssh-new-tab-submit" type="submit" aria-label="${escapeAttr(state.tr("action.sshConnect"))}" title="${escapeAttr(state.tr("action.sshConnect"))}">
          <i data-lucide="corner-down-left"></i>
        </button>
      </label>
    </form>
  `;
}

function renderQuickRows(state: {
  profiles: SshProfile[];
  configHosts: SshConfigHost[];
  context: SshNewTabMenuContext;
  tr: Translate;
}): string {
  const configRows = state.configHosts.slice(0, 8).map((host) => renderConfigHostRow(host, state.context.lightosDirectAvailable, state.tr)).join("");
  const profileRows = state.profiles.slice(0, 5).map((profile) => renderProfileRow(profile, state.tr)).join("");
  if (!configRows && !profileRows) {
    return `<div class="ssh-new-tab-empty">${escapeHtml(state.tr("ssh.noHosts"))}</div>`;
  }
  return `
    <div class="ssh-new-tab-rows">
      ${configRows ? `<div class="ssh-new-tab-row-group"><small>${escapeHtml(state.tr("ssh.configHosts"))}</small>${configRows}</div>` : ""}
      ${profileRows ? `<div class="ssh-new-tab-row-group"><small>${escapeHtml(state.tr("ssh.savedProfiles"))}</small>${profileRows}</div>` : ""}
    </div>
  `;
}

function renderConfigHostRow(host: SshConfigHost, lightosDirectAvailable: boolean, tr: Translate): string {
  const detail = configHostTargetLabel(host);
  return `
    <button type="button" data-ssh-new-tab-config-target="${escapeAttr(host.alias)}">
      <i data-lucide="server"></i>
      <span>${escapeHtml(host.alias)}</span>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      <em>${escapeHtml(tr(lightosDirectAvailable ? "ssh.sourceLightosConfig" : "ssh.sourceProviderConfig"))}</em>
    </button>
  `;
}

function renderProfileRow(profile: SshProfile, tr: Translate): string {
  const detail = profileTargetLabel(profile);
  const source = profile.kind === "managed-key" ? tr("ssh.sourceManagedKey") : tr("ssh.sourceSavedProfile");
  return `
    <button type="button" data-ssh-new-tab-profile-selector="${escapeAttr(profile.selector)}">
      <i data-lucide="${profile.kind === "managed-key" ? "key-round" : "terminal"}"></i>
      <span>${escapeHtml(profile.name)}</span>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      <em>${escapeHtml(source)}</em>
    </button>
  `;
}

function configHostTargetLabel(host: SshConfigHost): string {
  const target = host.username && host.host ? `${host.username}@${host.host}` : host.host;
  return host.port ? `${target}:${host.port}` : target;
}

function profileTargetLabel(profile: SshProfile): string {
  if (profile.kind === "device-openssh") {
    return profile.target || profile.host;
  }
  const host = [profile.username, profile.host].filter(Boolean).join("@");
  return profile.port ? `${host}:${profile.port}` : host;
}

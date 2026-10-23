export function renderMobileRemoteDesktopSettings(): string {
  return `<div id="mobileRemoteDesktopSettings" hidden>
    <label class="switch">
      <input id="mobileRemoteDesktopEnabled" type="checkbox" aria-describedby="mobileRemoteDesktopHelp" />
      <span data-i18n="setting.mobileRemoteDesktop">Allow remote desktop on mobile</span>
    </label>
    <p id="mobileRemoteDesktopHelp" class="settings-help settings-help-inline" data-i18n="setting.mobileRemoteDesktopHelp">Show the remote desktop entry on the LightOS home page after returning home. Saved in this browser; off by default.</p>
  </div>`;
}

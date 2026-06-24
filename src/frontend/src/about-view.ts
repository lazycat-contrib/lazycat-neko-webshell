import { escapeAttr, escapeHtml } from "./utils";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
const APP_ICON_URL = "./icon.png";

export function renderAboutDialog(version = APP_VERSION): string {
  const safeVersion = escapeHtml(version);
  return `
    <div class="about-dialog-shell" id="aboutDialog" hidden>
      <section class="about-dialog" role="dialog" aria-modal="true" aria-label="About Neko Webshell" data-i18n-aria="about.title">
        <header class="about-dialog-head">
          <span class="about-mark" aria-hidden="true">
            <img src="${escapeAttr(APP_ICON_URL)}" alt="" decoding="async" />
          </span>
          <span class="about-heading">
            <strong data-i18n="app.title">Neko Webshell</strong>
            <small data-i18n="about.description">Browser terminal for LightOS devices.</small>
          </span>
          <button class="icon-button" id="aboutClose" type="button" aria-label="Close" title="Close" data-i18n-aria="action.close" data-i18n-title="action.close">
            <i data-lucide="x"></i>
          </button>
        </header>
        <div class="about-version-card" title="${escapeAttr(version)}">
          <span data-i18n="about.version">Version</span>
          <strong>${safeVersion}</strong>
        </div>
        <dl class="about-facts">
          <div>
            <dt data-i18n="about.session">Sessions</dt>
            <dd data-i18n="about.sessionValue">Native WebShell and Herdr spaces</dd>
          </div>
          <div>
            <dt data-i18n="about.tools">Tools</dt>
            <dd data-i18n="about.toolsValue">Files, themes, fonts, and chat</dd>
          </div>
        </dl>
        <p class="about-note" data-i18n="about.note">Built for fast terminal access from desktop and mobile browsers.</p>
      </section>
    </div>
  `;
}

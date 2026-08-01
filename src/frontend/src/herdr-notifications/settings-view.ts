export function renderHerdrNotificationSettingsView(): string {
  return `
    <div class="settings-group herdr-notification-settings" id="herdrNotificationSettings" hidden>
      <div class="settings-group-title" data-i18n="section.herdrNotifications">Herdr notifications</div>
      <label class="switch">
        <input id="herdrLazycatNotifications" type="checkbox" />
        <span data-i18n="setting.herdrLazycatNotifications">Send Herdr alerts with LazyCat notifications</span>
      </label>
      <p class="settings-help" data-i18n="setting.herdrLazycatNotificationsHelp">Notify this device when a Herdr Agent finishes or needs input.</p>
    </div>
  `;
}

export function renderMobileTouchSettingsView(): string {
  return `
              <label class="field mobile-only-setting">
                <span data-i18n="field.touchBehavior">Touch behavior</span>
                <select id="touchSelectionMode">
                  <option value="long-press" data-i18n="touch.longPress">Pan first, long-press select</option>
                  <option value="drag" data-i18n="touch.drag">Drag to select</option>
                  <option value="off" data-i18n="touch.off">Touch selection off</option>
                </select>
              </label>
  `;
}

import type { PluginSettingsViewState } from "../../plugin-views";

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type DraftField = { attribute: string; key: string; value: string; checked?: boolean };
const fieldSelector = "[data-ai-dialog-field], [data-tunnel-profile-field]";

export function settingsModalIdentity(state: PluginSettingsViewState): string {
  const ai = state.aiAccess.dialog;
  return JSON.stringify([
    ai ? [ai.type, "profile" in ai ? ai.profile.id : ai.index] : null,
    state.publicTunnel.dialog?.profile.id ?? null,
  ]);
}

export function captureModalDraft(container: HTMLElement): DraftField[] {
  const fields = container.querySelectorAll<FormControl>('[aria-modal="true"] :is([data-ai-dialog-field], [data-tunnel-profile-field])');
  return Array.from(fields).flatMap((field) => {
    if (field instanceof HTMLInputElement && field.type === "file") return [];
    const attribute = field.hasAttribute("data-ai-dialog-field") ? "data-ai-dialog-field" : "data-tunnel-profile-field";
    const checked = field instanceof HTMLInputElement && ["checkbox", "radio"].includes(field.type) ? field.checked : undefined;
    const defaultValue = field instanceof HTMLSelectElement
      ? Array.from(field.options).find((option) => option.defaultSelected)?.value ?? field.options[0]?.value ?? ""
      : field.defaultValue;
    if (checked === undefined && field.value === defaultValue) return [];
    if (field instanceof HTMLInputElement && checked !== undefined && checked === field.defaultChecked) return [];
    return [{ attribute, key: field.getAttribute(attribute) ?? "", value: field.value, checked }];
  });
}

export function restoreModalDraft(container: HTMLElement, draft: readonly DraftField[]) {
  const fields = Array.from(container.querySelectorAll<FormControl>(fieldSelector));
  for (const saved of draft) {
    const field = fields.find((candidate) => candidate.getAttribute(saved.attribute) === saved.key);
    if (!field) continue;
    field.value = saved.value;
    if (saved.checked !== undefined && field instanceof HTMLInputElement) field.checked = saved.checked;
  }
}

import { secretElement as element, type SecretTranslate } from "./view";
import { maskSecretText } from "./state.ts";

type Options = {
  tr: SecretTranslate;
  value: string;
  reread: () => void;
  changed: () => void;
  submit: (text: string) => void;
};

export function createSecretFileEditor(options: Options) {
  const { tr, reread, submit, changed } = options;
  let draft = options.value;
  let revealed = false;
  let reading = false;
  const root = element("div");
  const label = element("label", tr("secret.confirmContent"));
  const input = element("textarea", "", "secret-file-input");
  input.id = "secret-file-input";
  label.htmlFor = input.id;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("aria-describedby", "secret-file-manual-hint");
  const hint = element("p", tr("secret.editHint"), "secret-file-help");
  hint.id = "secret-file-manual-hint";
  const actions = element("div", "", "secret-file-actions");
  function button(text: string, handler: () => void) {
    const button = element("button", text, "command-button");
    button.type = "button";
    button.onclick = handler;
    return button;
  }
  const toggle = button("", () => {
    revealed = !revealed;
    render();
  });
  const rereadButton = button(tr("secret.reread"), reread);
  const generate = button(tr("secret.confirmCreate"), () => submit(draft));
  generate.classList.add("primary");
  input.oninput = () => {
    if (revealed) { draft = input.value; changed(); }
    generate.disabled = reading || draft.length === 0;
  };
  function render() {
    input.disabled = reading;
    toggle.disabled = reading;
    rereadButton.disabled = reading;
    root.setAttribute("aria-busy", String(reading));
    input.readOnly = !revealed;
    input.value = revealed ? draft : maskSecretText(draft);
    toggle.textContent = tr(revealed ? "secret.hideContent" : "secret.showContent");
    toggle.setAttribute("aria-pressed", String(revealed));
    generate.disabled = reading || draft.length === 0;
  }
  // Native paste works even when clipboard permission is denied. Replace the
  // draft when masked, rather than accidentally editing the displayed bullets.
  input.addEventListener("paste", event => {
    if (revealed || !event.clipboardData) return;
    event.preventDefault();
    draft = event.clipboardData.getData("text/plain");
    changed();
    render();
  });
  actions.append(toggle, rereadButton);
  const footer = element("div", "", "secret-file-actions");
  footer.append(generate);
  root.append(label, input, hint, actions, footer);
  render();
  return {
    root,
    clear: () => { draft = ""; input.value = ""; },
    setReading: (value: boolean) => { reading = value; render(); },
  };
}

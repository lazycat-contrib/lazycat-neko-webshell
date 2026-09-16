import type { MessageKey } from "../../i18n.ts";
import type { MobilePaletteChoice, MobilePaletteTab } from "./model.ts";
import "./styles.css";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type Handlers = {
  close: () => void;
  search: () => void;
  clear: () => void;
  selectTab: (tab: MobilePaletteTab) => void;
  activate: (choice: MobilePaletteChoice) => void;
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

export function createMobileCommandPaletteView(tr: Translate, handlers: Handlers) {
  const dialog = element("dialog", "", "mobile-command-palette");
  dialog.setAttribute("aria-labelledby", "mobile-command-palette-title");
  dialog.setAttribute("aria-describedby", "mobile-command-palette-status");

  const header = element("header", "", "mobile-command-palette-head");
  const heading = element("div", "", "mobile-command-palette-heading");
  const title = element("h2", tr("mobilePalette.title"));
  title.id = "mobile-command-palette-title";
  const target = element("p", "", "mobile-command-palette-target");
  heading.append(title, target);
  const close = element("button", "×", "icon-button mobile-command-palette-close");
  close.type = "button";
  close.setAttribute("aria-label", tr("mobilePalette.close"));
  close.addEventListener("click", handlers.close);
  header.append(heading, close);

  const searchLabel = element("label", tr("mobilePalette.search"), "mobile-command-palette-search-label");
  searchLabel.htmlFor = "mobile-command-palette-search";
  const searchRow = element("div", "", "mobile-command-palette-search-row");
  const search = element("input", "", "mobile-command-palette-search");
  search.id = "mobile-command-palette-search";
  search.type = "search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.setAttribute("autocapitalize", "off");
  search.setAttribute("autocorrect", "off");
  search.addEventListener("input", handlers.search);
  const clear = element("button", "×", "mobile-command-palette-clear");
  clear.type = "button";
  clear.setAttribute("aria-label", tr("mobilePalette.clear"));
  clear.addEventListener("click", handlers.clear);
  searchRow.append(search, clear);

  const tabs = element("div", "", "mobile-command-palette-tabs");
  tabs.setAttribute("role", "tablist");
  const tabButtons = new Map<MobilePaletteTab, HTMLButtonElement>();
  for (const [tab, key] of [
    ["recent", "mobilePalette.recent"],
    ["all", "mobilePalette.all"],
    ["keys", "mobilePalette.keys"],
  ] as const) {
    const button = element("button", tr(key), "mobile-command-palette-tab");
    button.type = "button";
    button.id = `mobile-command-palette-tab-${tab}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "mobile-command-palette-results");
    button.addEventListener("click", () => handlers.selectTab(tab));
    tabs.append(button);
    tabButtons.set(tab, button);
  }
  tabs.addEventListener("keydown", (event) => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const ordered: MobilePaletteTab[] = ["recent", "all", "keys"];
    const current = ordered.findIndex((name) => tabButtons.get(name) === event.target);
    if (current < 0) return;
    let next = current;
    if (event.key === "ArrowLeft") next = (current + ordered.length - 1) % ordered.length;
    else if (event.key === "ArrowRight") next = (current + 1) % ordered.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ordered.length - 1;
    else return;
    event.preventDefault();
    const nextTab = ordered[next];
    handlers.selectTab(nextTab);
    tabButtons.get(nextTab)?.focus({ preventScroll: true });
  });

  const results = element("div", "", "mobile-command-palette-results");
  results.id = "mobile-command-palette-results";
  results.setAttribute("role", "tabpanel");
  results.tabIndex = -1;
  const status = element("p", "", "mobile-command-palette-status");
  status.id = "mobile-command-palette-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  dialog.append(header, searchLabel, searchRow, tabs, results, status);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    handlers.close();
  });
  for (const type of ["keydown", "keyup", "beforeinput", "paste", "compositionstart", "compositionend"]) {
    dialog.addEventListener(type, (event) => event.stopPropagation());
  }
  document.body.append(dialog);

  let busy = false;
  let available = true;
  let signature = "";

  function applyDisabledState() {
    search.readOnly = busy;
    clear.disabled = busy || !search.value;
    for (const button of tabButtons.values()) button.disabled = busy;
    for (const button of results.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = busy || !available;
    }
  }

  function choiceButton(choice: MobilePaletteChoice): HTMLButtonElement {
    const button = element("button", "", `mobile-command-palette-choice is-${choice.kind}`);
    button.type = "button";
    button.dataset.paletteChoice = choice.id;
    button.addEventListener("click", () => handlers.activate(choice));
    const top = element("span", "", "mobile-command-palette-choice-top");
    if (choice.kind === "phrase") {
      const label = element("strong", choice.phrase.label || choice.phrase.text);
      const mode = element(
        "span",
        tr(choice.phrase.sendEnter ? "mobilePalette.enter" : "mobilePalette.insert"),
        `mobile-command-palette-mode${choice.phrase.sendEnter ? " sends-enter" : ""}`,
      );
      top.append(label, mode);
      if (choice.phrase.group) {
        top.append(element("span", choice.phrase.group, "mobile-command-palette-group"));
      }
      const preview = element("span", choice.phrase.text, "mobile-command-palette-preview");
      button.append(top, preview);
    } else {
      const label = element("strong", choice.key.label || choice.key.ariaLabel || choice.key.value);
      top.append(label);
      if (choice.key.autoEnter) {
        top.append(element("span", tr("mobilePalette.enter"), "mobile-command-palette-mode sends-enter"));
      }
      const value = element("code", choice.key.value, "mobile-command-palette-key-value");
      button.append(top, value);
    }
    return button;
  }

  function render(
    choices: readonly MobilePaletteChoice[],
    tab: MobilePaletteTab,
    emptyKey: MessageKey,
    canActivate: boolean,
  ) {
    available = canActivate;
    const nextSignature = JSON.stringify([choices, tab, emptyKey, canActivate]);
    if (nextSignature === signature) { applyDisabledState(); return; }
    signature = nextSignature;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.paletteChoice : undefined;
    const scroll = dialog.scrollTop;
    results.replaceChildren();
    results.setAttribute("aria-labelledby", `mobile-command-palette-tab-${tab}`);
    for (const [name, button] of tabButtons) {
      const selected = name === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (!choices.length) {
      results.append(element("p", tr(emptyKey), "mobile-command-palette-empty"));
    } else {
      const list = element("div", "", "mobile-command-palette-list");
      for (const choice of choices) list.append(choiceButton(choice));
      results.append(list);
    }
    applyDisabledState();
    if (focused) {
      const replacement = [...results.querySelectorAll<HTMLButtonElement>("[data-palette-choice]")].find(button => button.dataset.paletteChoice === focused);
      (replacement ?? results).focus({ preventScroll: true });
    }
    dialog.scrollTop = scroll;
  }

  function setBusy(next: boolean) {
    busy = next;
    dialog.setAttribute("aria-busy", String(next));
    applyDisabledState();
  }

  function syncViewport() {
    const viewport = window.visualViewport;
    if (!viewport || !dialog.open) return;
    dialog.style.setProperty("--mobile-palette-viewport-height", `${Math.max(160, viewport.height)}px`);
    dialog.style.setProperty(
      "--mobile-palette-viewport-bottom",
      `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
    );
  }

  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);

  function destroy() {
    window.visualViewport?.removeEventListener("resize", syncViewport);
    window.visualViewport?.removeEventListener("scroll", syncViewport);
    dialog.remove();
  }

  return {
    dialog,
    target,
    search,
    clear,
    close,
    status,
    render,
    setBusy,
    syncViewport,
    destroy,
  };
}

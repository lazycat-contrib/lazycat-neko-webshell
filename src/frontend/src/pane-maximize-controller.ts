export function createPaneMaximizeController() {
  let tabId = "";
  let paneId = "";
  let marked: HTMLElement[] = [];

  function clearMarkers() {
    for (const element of marked) {
      element.classList.remove("pane-maximized", "pane-maximize-path", "pane-maximized-target");
    }
    marked = [];
  }

  function clear() {
    clearMarkers();
    tabId = "";
    paneId = "";
  }

  function apply(tabMount: HTMLElement, paneMount: HTMLElement) {
    clearMarkers();
    tabMount.classList.add("pane-maximized");
    paneMount.classList.add("pane-maximized-target");
    marked.push(tabMount, paneMount);
    let parent = paneMount.parentElement;
    while (parent && parent !== tabMount) {
      parent.classList.add("pane-maximize-path");
      marked.push(parent);
      parent = parent.parentElement;
    }
  }

  function toggle(tabMount: HTMLElement, paneMount: HTMLElement): boolean {
    const nextTabId = tabMount.dataset.tabId ?? "";
    const nextPaneId = paneMount.dataset.paneId ?? "";
    if (tabId === nextTabId && paneId === nextPaneId) {
      clear();
      return false;
    }
    tabId = nextTabId;
    paneId = nextPaneId;
    apply(tabMount, paneMount);
    return true;
  }

  function sync(tabMount: HTMLElement | undefined, paneMount: HTMLElement | undefined) {
    if (!tabId || !paneId) return;
    if (
      !tabMount
      || !paneMount
      || tabMount.dataset.tabId !== tabId
      || paneMount.dataset.paneId !== paneId
      || !tabMount.isConnected
      || !paneMount.isConnected
    ) {
      clear();
      return;
    }
    apply(tabMount, paneMount);
  }

  return {
    toggle,
    sync,
    clear,
    isMaximized: () => Boolean(tabId && paneId),
    maximizedPaneId: () => paneId,
    allowsPane: (candidatePaneId: string) => !paneId || paneId === candidatePaneId,
  };
}

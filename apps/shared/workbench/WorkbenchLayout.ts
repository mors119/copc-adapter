export type WorkbenchTab = "code" | "source" | "health" | "data";

export type WorkbenchTabPanel = {
  readonly tab: WorkbenchTab;
  readonly label: string;
  readonly panel: HTMLElement;
};

export type WorkbenchRightTabs = {
  select(tab: WorkbenchTab): void;
  destroy(): void;
};

const TAB_ORDER: readonly WorkbenchTab[] = ["code", "source", "health", "data"];

/** Mount the shared, keyboard-operable Code/Source/Health/Data tab strip. */
export function mountWorkbenchRightTabs(options: {
  readonly target: HTMLElement;
  readonly tabs: readonly WorkbenchTabPanel[];
  readonly initialTab?: WorkbenchTab;
  readonly label?: string;
  readonly onChange?: (tab: WorkbenchTab) => void;
}): WorkbenchRightTabs {
  const tabsByName = new Map(options.tabs.map((tab) => [tab.tab, tab]));
  const available = TAB_ORDER.filter((tab) => tabsByName.has(tab));
  const initial = options.initialTab ?? "code";
  if (available.length !== TAB_ORDER.length) {
    throw new TypeError("Workbench right panel requires Code, Source, Health, and Data tabs.");
  }

  const tabList = document.createElement("div");
  tabList.className = "workbench-tabs";
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", options.label ?? "Workbench details");
  const buttons = new Map<WorkbenchTab, HTMLButtonElement>();

  for (const tabName of TAB_ORDER) {
    const tab = tabsByName.get(tabName)!;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workbench-tabs__tab";
    button.id = `workbench-tab-${tabName}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `workbench-panel-${tabName}`);
    button.textContent = tab.label;
    tab.panel.id = `workbench-panel-${tabName}`;
    tab.panel.classList.add("workbench-tabs__panel");
    tab.panel.setAttribute("role", "tabpanel");
    tab.panel.setAttribute("aria-labelledby", button.id);
    tab.panel.tabIndex = 0;
    buttons.set(tabName, button);
    tabList.append(button);
  }

  options.target.replaceChildren(tabList, ...TAB_ORDER.map((name) => tabsByName.get(name)!.panel));
  let active = available.includes(initial) ? initial : "code";

  const sync = (): void => {
    for (const name of TAB_ORDER) {
      const selected = name === active;
      const button = buttons.get(name)!;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      tabsByName.get(name)!.panel.hidden = !selected;
    }
    options.onChange?.(active);
  };
  const select = (name: WorkbenchTab): void => {
    if (!tabsByName.has(name)) return;
    active = name;
    sync();
  };
  const onClick = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
    const name = button?.id.replace("workbench-tab-", "") as WorkbenchTab | undefined;
    if (name) select(name);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const current = (event.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
    if (!current) return;
    const currentName = current.id.replace("workbench-tab-", "") as WorkbenchTab;
    const index = TAB_ORDER.indexOf(currentName);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? TAB_ORDER.length - 1
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? (index + 1) % TAB_ORDER.length
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? (index - 1 + TAB_ORDER.length) % TAB_ORDER.length
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = TAB_ORDER[nextIndex]!;
    select(next);
    buttons.get(next)!.focus();
  };
  tabList.addEventListener("click", onClick);
  tabList.addEventListener("keydown", onKeyDown);
  sync();

  return {
    select,
    destroy(): void {
      tabList.removeEventListener("click", onClick);
      tabList.removeEventListener("keydown", onKeyDown);
      tabList.remove();
      for (const tab of options.tabs) tab.panel.remove();
    },
  };
}

export type WorkbenchLayoutOptions = {
  readonly root: HTMLElement;
  readonly provenance: string;
  readonly leftPanel: HTMLElement;
  readonly viewport: HTMLElement;
  readonly rightPanel: HTMLElement;
  readonly status: HTMLElement;
  readonly leftLabel?: string;
  readonly rightLabel?: string;
  readonly provenanceId?: string;
  readonly leftToggle?: HTMLButtonElement;
  readonly rightToggle?: HTMLButtonElement;
  readonly leftExpandedInitially?: boolean;
  readonly rightExpandedInitially?: boolean;
  readonly leftToggleLabel?: string;
  readonly rightToggleLabel?: string;
  readonly keyboardShortcut?: {
    readonly panel: "left" | "right";
    readonly key: string;
    readonly shift?: boolean;
  };
  readonly onLeftExpandedChange?: (expanded: boolean) => void;
  readonly onRightExpandedChange?: (expanded: boolean) => void;
};

export type WorkbenchLayoutController = {
  setExpanded(panel: "left" | "right", expanded: boolean): void;
  destroy(): void;
};

function createPanelToggle(
  panel: "left" | "right",
  target: HTMLElement,
  supplied?: HTMLButtonElement,
): HTMLButtonElement {
  const toggle = supplied ?? document.createElement("button");
  toggle.type = "button";
  toggle.classList.add("workbench-panel-toggle", `workbench-panel-toggle--${panel}`);
  if (!toggle.id) toggle.id = `workbench-${panel}-toggle`;
  toggle.setAttribute("aria-controls", target.id);
  if (!toggle.firstElementChild) {
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    toggle.append(icon);
  }
  return toggle;
}

/** Place host-owned content in the common three-column Workbench shell. */
export function mountWorkbenchLayout(
  options: WorkbenchLayoutOptions,
): WorkbenchLayoutController {
  const header = document.createElement("header");
  header.className = "workbench-global-header";
  const provenance = document.createElement("span");
  provenance.className = "workbench-provenance";
  if (options.provenanceId) provenance.id = options.provenanceId;
  provenance.textContent = options.provenance;
  provenance.setAttribute("aria-label", "Installed adapter package source");
  header.append(provenance);

  const grid = document.createElement("main");
  grid.className = "workbench-three-column";
  grid.setAttribute("aria-label", "COPC Adapter Workbench");
  options.leftPanel.classList.add("workbench-left-panel");
  options.leftPanel.setAttribute("aria-label", options.leftLabel ?? "Configuration");
  options.viewport.classList.add("workbench-viewport");
  options.viewport.setAttribute("aria-label", "Point cloud viewport");
  options.rightPanel.classList.add("workbench-right-panel");
  options.rightPanel.setAttribute("aria-label", options.rightLabel ?? "Workbench details");

  const leftToggle = createPanelToggle("left", options.leftPanel, options.leftToggle);
  const rightToggle = createPanelToggle("right", options.rightPanel, options.rightToggle);
  const leftShell = document.createElement("div");
  leftShell.className = "workbench-panel-shell workbench-panel-shell--left";
  const rightShell = document.createElement("div");
  rightShell.className = "workbench-panel-shell workbench-panel-shell--right";
  leftShell.append(options.leftPanel, leftToggle);
  rightShell.append(options.rightPanel, rightToggle);
  grid.append(leftShell, options.viewport, rightShell);

  options.status.classList.add("workbench-statusbar");
  options.root.classList.add("workbench-root");
  options.root.replaceChildren(header, grid, options.status);

  const expanded = {
    left: options.leftExpandedInitially ?? true,
    right: options.rightExpandedInitially ?? true,
  };
  const panels = { left: options.leftPanel, right: options.rightPanel };
  const shells = { left: leftShell, right: rightShell };
  const toggles = { left: leftToggle, right: rightToggle };
  const labels = {
    left: options.leftLabel ?? "Configuration",
    right: options.rightLabel ?? "Workbench details",
  };
  const toggleLabels = {
    left: options.leftToggleLabel ?? labels.left.replace(/\s+panel$/iu, ""),
    right: options.rightToggleLabel ?? labels.right.replace(/\s+panel$/iu, ""),
  };
  const listeners = {
    left: () => setExpanded("left", !expanded.left),
    right: () => setExpanded("right", !expanded.right),
  };

  const sync = (panel: "left" | "right"): void => {
    const isExpanded = expanded[panel];
    const shell = shells[panel];
    const toggle = toggles[panel];
    panels[panel].hidden = !isExpanded;
    shell.dataset.expanded = String(isExpanded);
    grid.dataset[panel + "Expanded"] = String(isExpanded);
    const action = isExpanded ? "Collapse" : "Expand";
    toggle.setAttribute("aria-expanded", String(isExpanded));
    toggle.setAttribute("aria-label", `${action} ${toggleLabels[panel].toLowerCase()} panel`);
    toggle.title = `${action} ${toggleLabels[panel].toLowerCase()} panel`;
    const icon = toggle.querySelector<HTMLElement>("[aria-hidden='true']");
    if (icon) {
      icon.textContent = panel === "left"
        ? isExpanded ? "‹" : "›"
        : isExpanded ? "›" : "‹";
    }
    grid.style.setProperty(
      panel === "left" ? "--workbench-left-track" : "--workbench-right-track",
      isExpanded
        ? panel === "left" ? "minmax(15rem, 18rem)" : "minmax(16rem, 19rem)"
        : "0px",
    );
    grid.style.setProperty(
      panel === "left"
        ? "--workbench-left-mobile-row-track"
        : "--workbench-right-mobile-row-track",
      isExpanded
        ? panel === "left" ? "minmax(15rem, auto)" : "auto"
        : "2.5rem",
    );
    if (panel === "right") {
      grid.style.setProperty(
        "--workbench-right-tablet-row-track",
        isExpanded ? "minmax(0, 1fr)" : "2.5rem",
      );
    }
    (panel === "left" ? options.onLeftExpandedChange : options.onRightExpandedChange)?.(isExpanded);
  };
  function setExpanded(panel: "left" | "right", isExpanded: boolean): void {
    if (expanded[panel] === isExpanded) return;
    expanded[panel] = isExpanded;
    sync(panel);
  }

  leftToggle.addEventListener("click", listeners.left);
  rightToggle.addEventListener("click", listeners.right);
  const onShortcut = (event: KeyboardEvent): void => {
    const shortcut = options.keyboardShortcut;
    if (
      shortcut &&
      event.shiftKey === (shortcut.shift ?? false) &&
      event.key.toLowerCase() === shortcut.key.toLowerCase()
    ) {
      setExpanded(shortcut.panel, !expanded[shortcut.panel]);
    }
  };
  if (options.keyboardShortcut) window.addEventListener("keydown", onShortcut);
  sync("left");
  sync("right");

  return {
    setExpanded,
    destroy(): void {
      leftToggle.removeEventListener("click", listeners.left);
      rightToggle.removeEventListener("click", listeners.right);
      if (options.keyboardShortcut) window.removeEventListener("keydown", onShortcut);
    },
  };
}

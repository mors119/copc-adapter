export type WorkbenchPanel = {
  readonly panel: HTMLElement;
  readonly toggle: HTMLButtonElement;
  readonly label: string;
  readonly expandedInitially: boolean;
};

export type WorkbenchPanels = {
  setExpanded(panel: 'controls' | 'inspector', expanded: boolean): void;
  destroy(): void;
};

/** Mount accessible, independently collapsible controls and inspector panels. */
export function mountWorkbenchPanels(options: {
  readonly controls: WorkbenchPanel;
  readonly inspector: WorkbenchPanel;
}): WorkbenchPanels {
  const panels = {
    controls: options.controls,
    inspector: options.inspector,
  } as const;
  const expanded = {
    controls: options.controls.expandedInitially,
    inspector: options.inspector.expandedInitially,
  };

  const sync = (name: keyof typeof panels): void => {
    const { panel, toggle, label } = panels[name];
    const isExpanded = expanded[name];
    const action = isExpanded ? 'Collapse' : 'Expand';
    panel.hidden = !isExpanded;
    toggle.setAttribute('aria-expanded', String(isExpanded));
    toggle.setAttribute('aria-label', `${action} ${label.toLowerCase()} panel`);
    toggle.title = `${action} ${label.toLowerCase()} panel`;
    const icon = toggle.querySelector<HTMLElement>('[aria-hidden="true"]');
    if (icon) {
      icon.textContent = name === 'controls'
        ? isExpanded ? '‹' : '›'
        : isExpanded ? '›' : '‹';
    }
  };

  const setExpanded = (name: keyof typeof panels, value: boolean): void => {
    expanded[name] = value;
    sync(name);
  };
  const onControlsClick = (): void => setExpanded('controls', !expanded.controls);
  const onInspectorClick = (): void => setExpanded('inspector', !expanded.inspector);
  const onShortcut = (event: KeyboardEvent): void => {
    if (event.shiftKey && event.key.toLowerCase() === 'd') {
      setExpanded('inspector', !expanded.inspector);
    }
  };

  options.controls.toggle.addEventListener('click', onControlsClick);
  options.inspector.toggle.addEventListener('click', onInspectorClick);
  window.addEventListener('keydown', onShortcut);
  sync('controls');
  sync('inspector');

  return {
    setExpanded,
    destroy(): void {
      options.controls.toggle.removeEventListener('click', onControlsClick);
      options.inspector.toggle.removeEventListener('click', onInspectorClick);
      window.removeEventListener('keydown', onShortcut);
    },
  };
}

export type DiagnosticFieldDefinition = {
  readonly key: string;
  readonly label: string;
  readonly id?: string;
  readonly valueClassName?: string;
};

export type DiagnosticSectionDefinition = {
  readonly id: string;
  readonly title: string;
  readonly className?: string;
  readonly description?: string;
  readonly initiallyOpen?: boolean;
  readonly fields: readonly DiagnosticFieldDefinition[];
};

export type DiagnosticValues = Readonly<Record<string, string | undefined>>;

export type DiagnosticSectionsController = {
  update(values: object): void;
  destroy(): void;
};

/**
 * Check host supplied field groups before rendering them. Keeping this pure
 * makes tab ownership and duplicate-field mistakes testable without a DOM.
 */
export function validateDiagnosticSections(
  sections: readonly DiagnosticSectionDefinition[],
): void {
  const sectionIds = new Set<string>();
  const fieldKeys = new Set<string>();
  for (const section of sections) {
    if (!section.id.trim() || sectionIds.has(section.id)) {
      throw new TypeError(`Diagnostic section id must be unique: ${section.id}`);
    }
    sectionIds.add(section.id);
    if (!section.title.trim()) {
      throw new TypeError(`Diagnostic section ${section.id} needs a title.`);
    }
    for (const field of section.fields) {
      if (!field.key.trim() || fieldKeys.has(field.key)) {
        throw new TypeError(`Diagnostic field key must be unique: ${field.key}`);
      }
      if (!field.label.trim()) {
        throw new TypeError(`Diagnostic field ${field.key} needs a label.`);
      }
      fieldKeys.add(field.key);
    }
  }
}

/** Render stable, collapsible diagnostic groups and update text without remounting. */
export function mountDiagnosticSections(
  target: HTMLElement,
  sections: readonly DiagnosticSectionDefinition[],
  options: {
    readonly className?: string;
    readonly sectionClassName?: string;
  } = {},
): DiagnosticSectionsController {
  validateDiagnosticSections(sections);
  const root = document.createElement("div");
  root.className = options.className ?? "workbench-diagnostic-sections";
  const values = new Map<string, HTMLElement>();
  const sectionClassName = options.sectionClassName ?? "workbench-diagnostic-section";

  for (const section of sections) {
    const group = document.createElement("details");
    group.className = section.className
      ? `${sectionClassName} ${section.className}`
      : sectionClassName;
    group.dataset.diagnosticSection = section.id;
    group.open = section.initiallyOpen ?? false;

    const summary = document.createElement("summary");
    summary.textContent = section.title;
    group.append(summary);
    if (section.description) {
      const description = document.createElement("p");
      description.className = "workbench-diagnostic-description";
      description.textContent = section.description;
      group.append(description);
    }

    const list = document.createElement("dl");
    list.className = "workbench-diagnostic-list";
    for (const field of section.fields) {
      const row = document.createElement("div");
      row.dataset.diagnosticKey = field.key;
      const label = document.createElement("dt");
      label.textContent = field.label;
      const value = document.createElement("dd");
      value.className = [
        "workbench-diagnostic-value",
        field.valueClassName,
      ].filter(Boolean).join(" ");
      value.dataset.diagnosticValue = field.key;
      if (field.id) value.id = field.id;
      row.append(label, value);
      list.append(row);
      values.set(field.key, value);
    }
    group.append(list);
    root.append(group);
  }

  target.replaceChildren(root);
  const update = (nextValues: object): void => {
    const next = nextValues as DiagnosticValues;
    for (const [key, element] of values) {
      element.textContent = next[key] ?? "Not available";
    }
  };
  update({});

  return {
    update,
    destroy(): void {
      root.remove();
    },
  };
}

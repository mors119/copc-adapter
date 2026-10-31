import type {
  CapabilityContext,
  SchemaClassificationFilter,
  SchemaFocusLens,
} from "../schema/types.ts";
import type {
  SchemaSpecialControl,
  SchemaSpecialControlOptions,
} from "./SchemaOptionPanel.ts";

function textInput(
  id: string,
  labelText: string,
  value: string,
  inputMode: "decimal" | "numeric" = "decimal",
): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
  const wrapper = document.createElement("label");
  wrapper.className = "ui-field";
  wrapper.htmlFor = id;
  wrapper.append(document.createTextNode(labelText));
  const input = document.createElement("input");
  input.id = id;
  input.type = "text";
  input.inputMode = inputMode;
  input.value = value;
  wrapper.append(input);
  return { wrapper, input };
}

function parseCodes(value: string): number[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split(/[\s,]+/u).map((entry) => /^\d+$/u.test(entry) ? Number(entry) : Number.NaN);
}

function createClassificationControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  const root = document.createElement("div");
  root.className = "schema-special-classification";
  const includeEnabled = document.createElement("input");
  includeEnabled.type = "checkbox";
  includeEnabled.id = "schema-classification-include-enabled";
  const includeLabel = document.createElement("label");
  includeLabel.className = "ui-field ui-field--inline";
  includeLabel.htmlFor = includeEnabled.id;
  includeLabel.append(includeEnabled, document.createTextNode("Use include list"));
  const include = textInput("schema-classification-include", "Include codes (0–255)", "", "numeric");
  const excludeEnabled = document.createElement("input");
  excludeEnabled.type = "checkbox";
  excludeEnabled.id = "schema-classification-exclude-enabled";
  const excludeLabel = document.createElement("label");
  excludeLabel.className = "ui-field ui-field--inline";
  excludeLabel.htmlFor = excludeEnabled.id;
  excludeLabel.append(excludeEnabled, document.createTextNode("Use exclude list"));
  const exclude = textInput("schema-classification-exclude", "Exclude codes (0–255)", "", "numeric");
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear filter";
  clear.className = "schema-action";
  root.append(includeLabel, include.wrapper, excludeLabel, exclude.wrapper, clear);

  const emit = (): void => {
    if (!includeEnabled.checked && !excludeEnabled.checked) {
      options.onChange(undefined);
      return;
    }
    const filter: { include?: number[]; exclude?: number[] } = {};
    if (includeEnabled.checked) filter.include = parseCodes(include.input.value) ?? [];
    if (excludeEnabled.checked) filter.exclude = parseCodes(exclude.input.value) ?? [];
    options.onChange(filter satisfies SchemaClassificationFilter);
  };
  const listeners = [includeEnabled, excludeEnabled, include.input, exclude.input].map((input) => {
    const handler = (): void => emit();
    input.addEventListener("change", handler);
    return () => input.removeEventListener("change", handler);
  });
  const onClear = (): void => options.onChange(null);
  clear.addEventListener("click", onClear);

  const setValue = (value: unknown): void => {
    const filter = value && typeof value === "object"
      ? value as SchemaClassificationFilter
      : undefined;
    includeEnabled.checked = filter?.include !== undefined;
    excludeEnabled.checked = filter?.exclude !== undefined;
    include.input.disabled = !includeEnabled.checked;
    exclude.input.disabled = !excludeEnabled.checked;
    include.input.value = filter?.include?.join(", ") ?? "";
    exclude.input.value = filter?.exclude?.join(", ") ?? "";
  };
  setValue(options.value);
  return {
    element: root,
    setValue,
    destroy() {
      listeners.forEach((remove) => remove());
      clear.removeEventListener("click", onClear);
      root.remove();
    },
  };
}

function createFocusLensControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  const root = document.createElement("div");
  root.className = "schema-special-focus";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.id = "schema-focus-enabled";
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "ui-field ui-field--inline";
  enabledLabel.htmlFor = enabled.id;
  enabledLabel.append(enabled, document.createTextNode("Enable focus lens"));
  const centerX = textInput("schema-focus-x", "Center X (0–1)", "0.5");
  const centerY = textInput("schema-focus-y", "Center Y (0–1)", "0.5");
  const radius = textInput("schema-focus-radius", "Radius (0–1)", "0.15");
  const detailBias = textInput("schema-focus-detail-bias", "Detail bias (1–2)", "1.5");
  root.append(enabledLabel, centerX.wrapper, centerY.wrapper, radius.wrapper, detailBias.wrapper);

  const readNumber = (input: HTMLInputElement): number => {
    if (input.value.trim() === "") return Number.NaN;
    return Number(input.value);
  };
  const emit = (): void => {
    if (!enabled.checked) {
      options.onChange(undefined);
      return;
    }
    options.onChange({
      type: "screen-circle",
      center: { x: readNumber(centerX.input), y: readNumber(centerY.input) },
      radius: readNumber(radius.input),
      detailBias: readNumber(detailBias.input),
    } satisfies SchemaFocusLens);
  };
  const inputs = [enabled, centerX.input, centerY.input, radius.input, detailBias.input];
  const listeners = inputs.map((input) => {
    const handler = (): void => emit();
    input.addEventListener("change", handler);
    return () => input.removeEventListener("change", handler);
  });

  const setValue = (value: unknown): void => {
    const focus = value && typeof value === "object" && (value as SchemaFocusLens).type === "screen-circle"
      ? value as SchemaFocusLens
      : undefined;
    enabled.checked = focus !== undefined;
    for (const input of [centerX.input, centerY.input, radius.input, detailBias.input]) {
      input.disabled = !enabled.checked;
    }
    centerX.input.value = String(focus?.center.x ?? 0.5);
    centerY.input.value = String(focus?.center.y ?? 0.5);
    radius.input.value = String(focus?.radius ?? 0.15);
    detailBias.input.value = String(focus?.detailBias ?? 1.5);
  };
  setValue(options.value);
  return {
    element: root,
    setValue,
    destroy() {
      listeners.forEach((remove) => remove());
      root.remove();
    },
  };
}

const STANDARD_FIELD_LABELS: Readonly<Record<string, string>> = {
  position: "Position",
  rgb: "RGB",
  intensity: "Intensity",
  classification: "Classification",
};

function selectedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function initialStyleFields(context: CapabilityContext): string[] {
  switch (context.values?.["rendering.colorMode"]) {
    case "rgb": return ["position", "rgb"];
    case "intensity": return ["position", "intensity"];
    case "classification": return ["position", "classification"];
    default: return ["position"];
  }
}

function withClassificationFilter(fields: string[], context: CapabilityContext): string[] {
  const filter = context.values?.["style.classificationFilter"];
  if (filter !== undefined && filter !== null) fields.push("classification");
  return fields;
}

function createAttributeLoadingControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  const root = document.createElement("div");
  root.className = "schema-special-attribute-loading";
  const label = document.createElement("label");
  label.className = "ui-field";
  label.htmlFor = "schema-attribute-loading";
  label.textContent = options.option.label;
  const select = document.createElement("select");
  select.id = "schema-attribute-loading";
  select.setAttribute("aria-label", options.option.label);
  for (const choice of options.option.choices ?? []) {
    select.add(new Option(choice.label, choice.value));
  }
  const details = document.createElement("p");
  details.className = "schema-option__hint";
  details.setAttribute("aria-live", "polite");
  const updateDetails = (context: CapabilityContext): void => {
    const styleFields = [...new Set(withClassificationFilter(initialStyleFields(context), context))];
    const selectedFields = selectedStrings(context.values?.["attributes.pointFields"]);
    const loadingMode = context.values?.["attributes.attributeLoading"] ?? select.value;
    const retainedFields = loadingMode === "all"
      ? ["position", "rgb", "intensity", "classification"]
      : [...new Set([...styleFields, ...selectedFields])];
    const names = (fields: readonly string[]) => fields
      .map((field) => STANDARD_FIELD_LABELS[field] ?? field)
      .join(", ");
    details.textContent =
      "Pending style and filter fields: " + names(styleFields) +
      ". Pick metadata can include: " + names(retainedFields) +
      ". Fields unavailable in the source stay unavailable; Extra Bytes are separate.";
  };
  const onChange = (): void => options.onChange(select.value);
  select.addEventListener("change", onChange);
  root.append(label, select, details);

  const setValue = (value: unknown): void => {
    select.value = typeof value === "string" ? value : "all";
  };
  setValue(options.value);
  updateDetails(options.context);
  return {
    element: root,
    setValue,
    updateContext: updateDetails,
    destroy() {
      select.removeEventListener("change", onChange);
      root.remove();
    },
  };
}

function createPointFieldSelectionControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  const root = document.createElement("fieldset");
  root.className = "schema-special-point-fields";
  const legend = document.createElement("legend");
  legend.textContent = options.option.label;
  root.append(legend);
  const allowed = options.option.validation.kind === "string-array"
    ? options.option.validation.values ?? []
    : [];
  const inputs = allowed.map((field) => {
    const label = document.createElement("label");
    label.className = "ui-field ui-field--inline";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = field;
    input.id = "schema-point-field-" + field;
    label.htmlFor = input.id;
    label.append(input, document.createTextNode(STANDARD_FIELD_LABELS[field] ?? field));
    root.append(label);
    return { field, input };
  });
  const onChange = (): void => {
    const selected = inputs.filter(({ input }) => input.checked).map(({ field }) => field);
    options.onChange(selected.length > 0 ? selected : undefined);
  };
  for (const { input } of inputs) input.addEventListener("change", onChange);
  const setValue = (value: unknown): void => {
    const selected = new Set(selectedStrings(value));
    for (const { field, input } of inputs) input.checked = selected.has(field);
  };
  setValue(options.value);
  return {
    element: root,
    setValue,
    destroy() {
      for (const { input } of inputs) input.removeEventListener("change", onChange);
      root.remove();
    },
  };
}

/** Shared presentation for domain controls whose meaning is not a scalar input. */
export function renderSharedSpecialControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl | undefined {
  switch (options.option.control) {
    case "classification-filter":
      return createClassificationControl(options);
    case "focus-lens":
      return createFocusLensControl(options);
    case "attribute-loading":
      return createAttributeLoadingControl(options);
    case "point-field-selection":
      return createPointFieldSelectionControl(options);
    default:
      return undefined;
  }
}

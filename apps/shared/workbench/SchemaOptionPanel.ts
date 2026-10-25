import {
  getAvailableActions,
  getAvailableChoices,
  getAvailableOptions,
  getSupportedOptions,
  isOptionAvailable,
} from "../schema/capabilities.ts";
import { resolveOptionDefault } from "../schema/capabilities.ts";
import { validateOptionValue, validateSchemaValues } from "../schema/validation.ts";
import { OPTION_SCHEMA } from "../schema/options.ts";
import type {
  CapabilityContext,
  SchemaActionDefinition,
  SchemaHostValidators,
  SchemaOption,
  SchemaSection,
} from "../schema/types.ts";
import { mountSegmentedControl, type UiSegmentOption } from "../ui-controls.ts";

export type SchemaSpecialControlOptions = {
  readonly option: SchemaOption;
  readonly value: unknown;
  readonly context: CapabilityContext;
  readonly onChange: (value: unknown) => void;
  readonly hostValidators?: SchemaHostValidators;
};

export type SchemaSpecialControl = {
  readonly element: HTMLElement;
  setValue?(value: unknown): void;
  setChoices?(choices: readonly { readonly value: string; readonly label: string }[]): void;
  destroy?(): void;
};

export type SchemaOptionPanelOptions = {
  readonly target: HTMLElement;
  readonly context: CapabilityContext;
  readonly values: Readonly<Record<string, unknown>>;
  readonly onChange: (optionId: string, value: unknown) => void;
  readonly schema?: readonly SchemaOption[];
  readonly hostValidators?: SchemaHostValidators;
  readonly sections?: readonly SchemaSection[];
  readonly sectionLabels?: Partial<Record<SchemaSection, string>>;
  readonly openSections?: readonly SchemaSection[];
  readonly renderSpecialControl?: (
    options: SchemaSpecialControlOptions,
  ) => SchemaSpecialControl | undefined;
  readonly onAction?: (action: SchemaActionDefinition) => void;
  readonly actionSections?: readonly SchemaSection[];
  /** Host-owned workflows can remain beside the schema form during migration. */
  readonly excludeOptionIds?: readonly string[];
};

export type SchemaOptionPanel = {
  update(options: {
    readonly values: Readonly<Record<string, unknown>>;
    readonly context?: Partial<Omit<CapabilityContext, "values">>;
  }): void;
  setChoices(optionId: string, choices: readonly UiSegmentOption<string>[]): void;
  getValidationErrors(): readonly string[];
  destroy(): void;
};

type MountedOption = {
  readonly option: SchemaOption;
  readonly wrapper: HTMLElement;
  readonly error: HTMLElement;
  readonly input?: HTMLInputElement | HTMLSelectElement;
  readonly segmented?: ReturnType<typeof mountSegmentedControl<string>>;
  readonly specialized?: SchemaSpecialControl;
  readonly setValue: (value: unknown) => void;
  readonly setChoices?: (choices: readonly UiSegmentOption<string>[]) => void;
  readonly clearListeners: () => void;
};

const SECTION_LABELS: Readonly<Record<SchemaSection, string>> = {
  source: "Source",
  renderer: "Renderer",
  backend: "Backend",
  style: "Appearance",
  streaming: "Streaming",
  lod: "LoD & Refinement",
  focus: "Focus Lens",
  filtering: "Classification Filter",
  attributes: "Attributes",
  coordinates: "Coordinates",
  performance: "Performance",
  cache: "Cache",
  interaction: "Interaction",
};

const SECTION_ORDER: readonly SchemaSection[] = [
  "source",
  "renderer",
  "backend",
  "style",
  "streaming",
  "lod",
  "focus",
  "filtering",
  "attributes",
  "coordinates",
  "performance",
  "cache",
  "interaction",
];

function supportedAcrossRenderers(
  context: CapabilityContext,
  schema: readonly SchemaOption[],
): readonly SchemaOption[] {
  const ids = new Set<string>();
  for (const renderer of ["cesium", "three"] as const) {
    for (const option of getSupportedOptions({ ...context, renderer }, schema)) {
      ids.add(option.id);
    }
  }
  return schema.filter(({ id }) => ids.has(id));
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  return result;
}

function optionInputId(option: SchemaOption): string {
  return option.presentation?.inputId ??
    option.presentation?.controlId ??
    "workbench-option-" + option.id.replace(/[^a-z0-9-]+/giu, "-");
}

function numericDisplayValue(option: SchemaOption, value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const scale = option.presentation?.displayScale;
  const display = scale ? value / scale.factor : value;
  return String(Number(display.toFixed(scale?.fractionDigits ?? 12)));
}

function numericCanonicalValue(option: SchemaOption, value: number): number {
  return value * (option.presentation?.displayScale?.factor ?? 1);
}

function mountGenericOption(
  option: SchemaOption,
  value: unknown,
  choices: readonly UiSegmentOption<string>[],
  getContext: () => CapabilityContext,
  onChange: (value: unknown) => void,
  hostValidators: SchemaHostValidators | undefined,
  schema: readonly SchemaOption[],
): MountedOption {
  const wrapper = element("div", "schema-option");
  wrapper.dataset.optionId = option.id;
  if (option.presentation?.containerId) wrapper.id = option.presentation.containerId;
  const label = element("label", "ui-field");
  label.htmlFor = optionInputId(option);
  label.append(document.createTextNode(option.label));
  const description = element("span", "schema-option__description");
  description.textContent = option.description;
  const error = element("span", "schema-option__error");
  error.setAttribute("role", "status");
  error.hidden = true;
  const listeners: Array<() => void> = [];

  const report = (next: unknown): void => {
    const context = getContext();
    const localErrors = validateOptionValue(option, next, hostValidators);
    const currentValues = { ...context.values, [option.id]: next };
    const groupErrors = validateSchemaValues(
      currentValues,
      context,
      schema,
      hostValidators,
      { requireRequired: false },
    );
    const relevant = groupErrors.filter((message) =>
      message.startsWith(option.label + " ") ||
      message.includes(option.label + " and ") ||
      message.includes(" and " + option.label),
    );
    const messages = [...new Set([...localErrors, ...relevant])];
    error.textContent = messages.join(" ");
    error.hidden = messages.length === 0;
    if (input) {
      if (messages.length) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    // Keep an invalid edit in the control so it can explain the error, but do
    // not let it enter the pending adapter configuration. A later sync from a
    // valid edit restores the last accepted value.
    if (localErrors.length === 0) onChange(next);
  };

  let input: HTMLInputElement | HTMLSelectElement | undefined;
  let segmented: ReturnType<typeof mountSegmentedControl<string>> | undefined;
  let specialized: SchemaSpecialControl | undefined;
  let setChoices: MountedOption["setChoices"];
  let setValue: MountedOption["setValue"];

  if (option.presentation?.widget === "segmented") {
    const group = element("div", "schema-option__segmented");
    group.id = option.presentation.controlId ?? "";
    wrapper.append(label, group, description, error);
    const declaredChoices = option.valueType === "boolean"
      ? [
          { value: "true", label: "On" },
          { value: "false", label: "Off" },
        ]
      : choices;
    const optionChoices = declaredChoices.map(({ value, label, disabled, title }) => ({
      value,
      label,
      ...(disabled === undefined ? {} : { disabled }),
      ...(title === undefined ? {} : { title }),
    }));
    segmented = mountSegmentedControl(group, {
      label: option.presentation.ariaLabel ?? option.label,
      value: option.valueType === "boolean"
        ? String(value === true)
        : typeof value === "string"
          ? value
          : optionChoices[0]?.value ?? "",
      choices: optionChoices,
      onChange: (next) => report(option.valueType === "boolean" ? next === "true" : next),
    });
    setValue = (next) => {
      if (option.valueType === "boolean") segmented?.setValue(String(next === true));
      else if (typeof next === "string") segmented?.setValue(next);
    };
    setChoices = (next) => {
      if (option.valueType === "boolean") return;
      segmented?.setOptions(next);
    };
  } else if (option.control === "select" || option.control === "renderer" || option.control === "cesium-renderer") {
    const select = element("select");
    select.id = optionInputId(option);
    select.setAttribute("aria-label", option.presentation?.ariaLabel ?? option.label);
    select.title = option.description;
    for (const choice of choices) select.add(new Option(choice.label, choice.value));
    const onSelect = (): void => report(select.value);
    select.addEventListener("change", onSelect);
    listeners.push(() => select.removeEventListener("change", onSelect));
    input = select;
    wrapper.append(label, select, description, error);
    setValue = (next) => {
      select.value = typeof next === "string" ? next : "";
    };
    setChoices = (next) => {
      const previous = select.value;
      select.replaceChildren(...next.map(({ value: itemValue, label: itemLabel }) => new Option(itemLabel, itemValue)));
      select.value = next.some(({ value: itemValue }) => itemValue === previous)
        ? previous
        : "";
    };
  } else if (option.control === "number") {
    const numberInput = element("input");
    numberInput.id = optionInputId(option);
    numberInput.type = "number";
    numberInput.inputMode = option.valueType === "integer" ? "numeric" : "decimal";
    numberInput.step = option.valueType === "integer" ? "1" : "any";
    numberInput.setAttribute("aria-label", option.presentation?.ariaLabel ?? option.label);
    numberInput.title = option.description;
    const rules = option.validation.kind === "number" ? option.validation : undefined;
    if (rules?.minimum !== undefined) numberInput.min = String(rules.minimum + (rules.minimumExclusive ? Number.EPSILON : 0));
    if (rules?.maximum !== undefined) numberInput.max = String(rules.maximum - (rules.maximumExclusive ? Number.EPSILON : 0));
    const onInput = (): void => {
      if (numberInput.value.trim() === "") {
        report(undefined);
        return;
      }
      const displayed = Number(numberInput.value);
      report(Number.isFinite(displayed) ? numericCanonicalValue(option, displayed) : displayed);
    };
    numberInput.addEventListener("change", onInput);
    listeners.push(() => numberInput.removeEventListener("change", onInput));
    input = numberInput;
    wrapper.append(label, numberInput);
    if (option.presentation?.displayScale) {
      const unit = element("span", "schema-option__unit");
      unit.textContent = option.presentation.displayScale.unit;
      wrapper.append(unit);
    }
    if (option.presentation?.slider) {
      const slider = element("input", "schema-option__slider");
      slider.type = "range";
      slider.id = option.presentation.slider.id;
      slider.min = String(option.presentation.slider.minimum);
      slider.max = String(option.presentation.slider.maximum);
      slider.step = String(option.presentation.slider.step);
      slider.setAttribute("aria-label", option.presentation.slider.label);
      const sliderLabel = element("label", "schema-option__slider-label");
      sliderLabel.htmlFor = slider.id;
      sliderLabel.textContent = option.presentation.slider.label;
      const sliderWrap = element("div", "schema-option__slider-wrap");
      sliderWrap.append(sliderLabel, slider);
      wrapper.append(sliderWrap);
      const onSliderPreview = (): void => {
        numberInput.value = slider.value;
      };
      const onSliderCommit = (): void => onInput();
      slider.addEventListener("input", onSliderPreview);
      slider.addEventListener("change", onSliderCommit);
      listeners.push(() => slider.removeEventListener("input", onSliderPreview));
      listeners.push(() => slider.removeEventListener("change", onSliderCommit));
      const previousSetValue = (next: unknown): void => {
        const displayValue = numericDisplayValue(option, next);
        if (document.activeElement !== numberInput) numberInput.value = displayValue;
        const parsed = Number(displayValue);
        slider.disabled = !Number.isFinite(parsed) || parsed < Number(slider.min) || parsed > Number(slider.max);
        if (Number.isFinite(parsed) && !slider.disabled) slider.value = displayValue;
      };
      setValue = previousSetValue;
    } else {
      setValue = (next) => {
        if (document.activeElement !== numberInput) numberInput.value = numericDisplayValue(option, next);
      };
    }
    wrapper.append(description, error);
  } else if (option.control === "toggle") {
    const checkbox = element("input");
    checkbox.id = optionInputId(option);
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", option.presentation?.ariaLabel ?? option.label);
    checkbox.title = option.description;
    const onToggle = (): void => report(checkbox.checked);
    checkbox.addEventListener("change", onToggle);
    listeners.push(() => checkbox.removeEventListener("change", onToggle));
    input = checkbox;
    label.classList.add("ui-field--inline");
    label.prepend(checkbox);
    wrapper.append(label, description, error);
    setValue = (next) => { checkbox.checked = next === true; };
  } else if (option.control === "attribute-selection") {
    const textInput = element("input");
    textInput.id = optionInputId(option);
    textInput.type = "text";
    textInput.placeholder = "dimension_a, dimension_b or *";
    textInput.setAttribute("aria-label", option.label);
    textInput.title = option.description;
    const onInput = (): void => {
      const raw = textInput.value.trim();
      report(raw === "" ? undefined : raw === "*" ? "*" : raw.split(/[\s,]+/u));
    };
    textInput.addEventListener("change", onInput);
    listeners.push(() => textInput.removeEventListener("change", onInput));
    input = textInput;
    wrapper.append(label, textInput, description, error);
    setValue = (next) => {
      textInput.value = Array.isArray(next) ? next.join(", ") : typeof next === "string" ? next : "";
    };
  } else {
    throw new TypeError(`Schema control ${option.control} requires a shared specialized renderer.`);
  }

  if (option.control === "number" && !setValue) {
    throw new TypeError(`Numeric option ${option.id} has no value synchronizer.`);
  }
  setValue?.(value);
  return {
    option,
    wrapper,
    error,
    ...(input ? { input } : {}),
    ...(segmented ? { segmented } : {}),
    ...(specialized ? { specialized } : {}),
    setValue: setValue ?? (() => undefined),
    ...(setChoices ? { setChoices } : {}),
    clearListeners: () => {
      listeners.forEach((remove) => remove());
      segmented?.destroy();
      specialized?.destroy?.();
    },
  };
}

/** Mount schema-described settings once and update values without remounting controls. */
export function mountSchemaOptionPanel(options: SchemaOptionPanelOptions): SchemaOptionPanel {
  const schema = options.schema ?? OPTION_SCHEMA;
  const sectionSet = new Set(options.sections ?? SECTION_ORDER);
  const excludedOptionIds = new Set(options.excludeOptionIds ?? []);
  const openSections = new Set(options.openSections ?? ["source", "renderer", "backend", "style"]);
  const sections = new Map<SchemaSection, HTMLDetailsElement>();
  const mounted = new Map<string, MountedOption>();
  const actionButtons: Array<{ action: SchemaActionDefinition; button: HTMLButtonElement }> = [];
  const choiceOverrides = new Map<string, readonly UiSegmentOption<string>[]>();
  let context: CapabilityContext = { ...options.context, values: options.values };
  let values = options.values;

  const supported = supportedAcrossRenderers(context, schema);
  for (const option of supported) {
    if (excludedOptionIds.has(option.id)) continue;
    if (!sectionSet.has(option.section)) continue;
    let section = sections.get(option.section);
    if (!section) {
      section = element("details", "schema-control-section");
      section.dataset.section = option.section;
      section.open = openSections.has(option.section);
      const summary = element("summary");
      summary.textContent = options.sectionLabels?.[option.section] ?? SECTION_LABELS[option.section];
      section.append(summary);
      sections.set(option.section, section);
    }

    let control: MountedOption;
    const controlContext = option.renderers.includes(context.renderer) &&
      getSupportedOptions(context, schema).some(({ id }) => id === option.id)
      ? context
      : option.renderers
        .map((renderer) => ({ ...context, renderer }))
        .find((candidate) =>
          getSupportedOptions(candidate, schema).some(({ id }) => id === option.id),
        ) ?? context;
    const choices = getAvailableChoices(option, controlContext, schema);
    try {
      control = mountGenericOption(
        option,
        values[option.id] !== undefined
          ? values[option.id]
          : resolveOptionDefault(option.id, context.manifest, new Set(), schema, values),
        choices,
        () => context,
        (value) => options.onChange(option.id, value),
        options.hostValidators,
        schema,
      );
    } catch (error) {
      if (!options.renderSpecialControl) throw error;
      let specializedControl: SchemaSpecialControl | undefined;
      const specialized = options.renderSpecialControl({
        option,
        value: values[option.id] !== undefined
          ? values[option.id]
          : resolveOptionDefault(option.id, context.manifest, new Set(), schema, values),
        context: controlContext,
        onChange: (value) => {
          const localErrors = validateOptionValue(option, value, options.hostValidators);
          const valuesWithChange = { ...context.values, [option.id]: value };
          const groupErrors = validateSchemaValues(
            valuesWithChange,
            context,
            schema,
            options.hostValidators,
            { requireRequired: false },
          ).filter((message) =>
            message.startsWith(option.label + " ") ||
            message.includes(option.label + " and ") ||
            message.includes(" and " + option.label),
          );
          const messages = [...new Set([...localErrors, ...groupErrors])];
          errorText.textContent = messages.join(" ");
          errorText.hidden = messages.length === 0;
          if (messages.length) specializedControl?.element.setAttribute("aria-invalid", "true");
          else specializedControl?.element.removeAttribute("aria-invalid");
          if (localErrors.length === 0) options.onChange(option.id, value);
        },
        hostValidators: options.hostValidators,
      });
      if (!specialized) throw error;
      specializedControl = specialized;
      const wrapper = element("div", "schema-option");
      wrapper.dataset.optionId = option.id;
      const description = element("span", "schema-option__description");
      description.textContent = option.description;
      const errorText = element("span", "schema-option__error");
      errorText.hidden = true;
      errorText.setAttribute("role", "status");
      wrapper.append(specialized.element, description, errorText);
      control = {
        option,
        wrapper,
        error: errorText,
        specialized,
        setValue: (value) => specialized.setValue?.(value),
        ...(specialized.setChoices ? { setChoices: specialized.setChoices } : {}),
        clearListeners: () => specialized.destroy?.(),
      };
    }
    section.append(control.wrapper);
    mounted.set(option.id, control);
  }

  const actionSections = new Set(options.actionSections ?? ["source", "coordinates"]);
  for (const action of getAvailableActions(context)) {
    if (!sectionSet.has(action.section) || !actionSections.has(action.section)) continue;
    let section = sections.get(action.section);
    if (!section) {
      section = element("details", "schema-control-section");
      section.dataset.section = action.section;
      section.open = openSections.has(action.section);
      const summary = element("summary");
      summary.textContent = options.sectionLabels?.[action.section] ?? SECTION_LABELS[action.section];
      section.append(summary);
      sections.set(action.section, section);
    }
    if (!options.onAction) continue;
    const button = element("button", "schema-action");
    button.type = "button";
    button.dataset.actionId = action.id;
    button.textContent = action.label;
    button.title = action.description;
    button.addEventListener("click", () => options.onAction?.(action));
    actionButtons.push({ action, button });
    section.append(button);
  }

  const orderedSections = [...sectionSet]
    .sort((left, right) => SECTION_ORDER.indexOf(left) - SECTION_ORDER.indexOf(right))
    .flatMap((section) => sections.has(section) ? [sections.get(section)!] : []);
  options.target.replaceChildren(...orderedSections);

  const refresh = (): void => {
    const available = new Set(getAvailableOptions({ ...context, values }, schema).map(({ id }) => id));
    for (const [id, control] of mounted) {
      const isSupported = getSupportedOptions(context, schema).some(({ id: candidate }) => candidate === id);
      const isVisible = available.has(id) && isOptionAvailable(control.option, { ...context, values }, schema);
      control.wrapper.hidden = !isSupported || !isVisible;
      const choices = choiceOverrides.get(id) ?? getAvailableChoices(control.option, context, schema);
      control.setChoices?.(choices);
      control.setValue(values[id] !== undefined
        ? values[id]
        : resolveOptionDefault(id, context.manifest, new Set(), schema, values));
      const validationErrors = values[id] === undefined
        ? []
        : validateOptionValue(control.option, values[id], options.hostValidators);
      if (control.input) {
        if (validationErrors.length) control.input.setAttribute("aria-invalid", "true");
        else control.input.removeAttribute("aria-invalid");
      }
      const availableChoiceValues = new Set(
        (choiceOverrides.get(id) ?? getAvailableChoices(control.option, context, schema))
          .filter((choice) => !("disabled" in choice && choice.disabled))
          .map(({ value }) => value),
      );
      const unavailableChoice =
        typeof values[id] === "string" &&
        control.option.choices !== undefined &&
        !availableChoiceValues.has(values[id] as string);
      if (unavailableChoice) {
        validationErrors.push(
          control.option.label + " choice " + String(values[id]) + " is unavailable in the active runtime.",
        );
      }
      control.error.textContent = validationErrors.join(" ");
      control.error.hidden = validationErrors.length === 0;
    }
    for (const { action, button } of actionButtons) {
      button.disabled = !getAvailableActions(context).some(({ id }) => id === action.id);
    }
  };
  refresh();

  return {
    update(next) {
      values = next.values;
      context = { ...context, ...next.context, values };
      refresh();
    },
    setChoices(optionId, choices) {
      choiceOverrides.set(optionId, choices);
      refresh();
    },
    getValidationErrors() {
      const errors = validateSchemaValues(values, context, schema, options.hostValidators, {
        requireRequired: false,
      });
      for (const [id, choices] of choiceOverrides) {
        const selected = values[id];
        if (
          typeof selected === "string" &&
          !choices.some((choice) => choice.value === selected && !choice.disabled)
        ) {
          const option = schema.find((candidate) => candidate.id === id);
          errors.push((option?.label ?? id) + " is unavailable for the current source.");
        }
      }
      return errors;
    },
    destroy() {
      for (const control of mounted.values()) control.clearListeners();
      for (const { button } of actionButtons) button.remove();
      options.target.replaceChildren();
      mounted.clear();
      sections.clear();
    },
  };
}

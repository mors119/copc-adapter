import type {
  CapabilityContext,
  SchemaClippingVolume,
  SchemaClassificationFilter,
  SchemaFocusLens,
} from "../schema/types.ts";
import type {
  SchemaSpecialControl,
  SchemaSpecialControlOptions,
} from "./SchemaOptionPanel.ts";
import { appendClassificationCode, LAS_1_4_CLASSIFICATION_CATALOG } from "./lasClassification.ts";
import { createSelectedPointEcefBox } from "./clippingGeometry.ts";
import { renderDimensionSpecialControl } from "./dimensionControls.ts";

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
  const catalogLabel = document.createElement("label");
  catalogLabel.className = "ui-field";
  catalogLabel.htmlFor = "schema-classification-catalog";
  catalogLabel.append(document.createTextNode("Standard LAS 1.4 catalog"));
  const catalog = document.createElement("select");
  catalog.id = "schema-classification-catalog";
  catalog.setAttribute("aria-label", "Standard LAS 1.4 classification catalog");
  catalog.add(new Option("Choose a standard class…", ""));
  for (const item of LAS_1_4_CLASSIFICATION_CATALOG) {
    catalog.add(new Option(`${item.code} · ${item.label}`, String(item.code)));
  }
  catalogLabel.append(catalog);
  const addToInclude = document.createElement("button");
  addToInclude.type = "button";
  addToInclude.id = "schema-classification-add-include";
  addToInclude.className = "schema-action";
  addToInclude.textContent = "Add class to include";
  const addToExclude = document.createElement("button");
  addToExclude.type = "button";
  addToExclude.id = "schema-classification-add-exclude";
  addToExclude.className = "schema-action";
  addToExclude.textContent = "Add class to exclude";
  const catalogNote = document.createElement("p");
  catalogNote.className = "schema-option__hint";
  catalogNote.textContent = "These are standard catalog names, not classes verified in the selected source. LAS 1.4 user-defined codes (64–255) remain available through numeric entry.";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.id = "schema-classification-clear";
  clear.textContent = "Clear filter";
  clear.className = "schema-action";
  root.append(includeLabel, include.wrapper, excludeLabel, exclude.wrapper, catalogLabel, addToInclude, addToExclude, catalogNote, clear);

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
  const onAddToInclude = (): void => {
    if (!/^\d+$/u.test(catalog.value)) return;
    includeEnabled.checked = true;
    include.input.disabled = false;
    include.input.value = appendClassificationCode(include.input.value, Number(catalog.value));
    emit();
  };
  const onAddToExclude = (): void => {
    if (!/^\d+$/u.test(catalog.value)) return;
    excludeEnabled.checked = true;
    exclude.input.disabled = false;
    exclude.input.value = appendClassificationCode(exclude.input.value, Number(catalog.value));
    emit();
  };
  clear.addEventListener("click", onClear);
  addToInclude.addEventListener("click", onAddToInclude);
  addToExclude.addEventListener("click", onAddToExclude);

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
      addToInclude.removeEventListener("click", onAddToInclude);
      addToExclude.removeEventListener("click", onAddToExclude);
      root.remove();
    },
  };
}

function createFocusLensControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  const root = document.createElement("div");
  root.className = "schema-special-focus";
  let currentContext = options.context;
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.id = "schema-focus-enabled";
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "ui-field ui-field--inline";
  enabledLabel.htmlFor = enabled.id;
  enabledLabel.append(enabled, document.createTextNode("Enable focus lens"));
  const followCursor = options.followCursor
    ? document.createElement("input")
    : undefined;
  const followCursorLabel = followCursor
    ? document.createElement("label")
    : undefined;
  if (followCursor && followCursorLabel) {
    followCursor.type = "checkbox";
    followCursor.id = "schema-focus-follow-cursor";
    followCursor.checked = options.followCursor!.enabled;
    followCursorLabel.className = "ui-field ui-field--inline";
    followCursorLabel.htmlFor = followCursor.id;
    followCursorLabel.append(followCursor, document.createTextNode("Follow Cursor"));
  }
  const centerX = textInput("schema-focus-x", "Center X (0–1)", "0.5");
  const centerY = textInput("schema-focus-y", "Center Y (0–1)", "0.5");
  const radius = textInput("schema-focus-radius", "Radius (0–1)", "0.15");
  const detailBias = textInput("schema-focus-detail-bias", "Detail bias (1–2)", "1.5");
  root.append(enabledLabel);
  if (followCursorLabel) root.append(followCursorLabel);
  root.append(centerX.wrapper, centerY.wrapper, radius.wrapper, detailBias.wrapper);

  const readNumber = (input: HTMLInputElement): number => {
    if (input.value.trim() === "") return Number.NaN;
    return Number(input.value);
  };
  const makeFocus = (): SchemaFocusLens | undefined => {
    if (!enabled.checked) {
      return undefined;
    }
    return {
      type: "screen-circle",
      center: { x: readNumber(centerX.input), y: readNumber(centerY.input) },
      radius: readNumber(radius.input),
      detailBias: readNumber(detailBias.input),
    } satisfies SchemaFocusLens;
  };
  const syncDisabled = (): void => {
    const manualDisabled = !enabled.checked || (followCursor?.checked ?? false);
    for (const input of [centerX.input, centerY.input]) input.disabled = manualDisabled;
    radius.input.disabled = !enabled.checked;
    detailBias.input.disabled = !enabled.checked;
    if (followCursor) {
      followCursor.disabled = currentContext.renderer !== "cesium" ||
        !(options.followCursor?.isAvailable() ?? false) ||
        (options.followCursor?.isBusy() ?? false);
    }
  };
  const emit = (): void => {
    const focus = makeFocus();
    if (!focus && followCursor?.checked) {
      followCursor.checked = false;
    }
    syncDisabled();
    options.onChange(focus);
    if (followCursor) options.followCursor?.onChange(followCursor.checked, focus);
  };
  const onFollowCursorChange = (): void => {
    if (followCursor?.checked) enabled.checked = true;
    emit();
  };
  const refreshFollowCursorAvailability = (): void => {
    if (followCursor && !options.followCursor?.isAvailable() && followCursor.checked) {
      followCursor.checked = false;
      options.followCursor?.onChange(false, makeFocus());
    }
    syncDisabled();
  };
  const inputs = [enabled, centerX.input, centerY.input, radius.input, detailBias.input];
  const listeners = inputs.map((input) => {
    const handler = (): void => emit();
    input.addEventListener("change", handler);
    return () => input.removeEventListener("change", handler);
  });
  if (followCursor) {
    followCursor.addEventListener("change", onFollowCursorChange);
    listeners.push(() => followCursor.removeEventListener("change", onFollowCursorChange));
  }

  const setValue = (value: unknown): void => {
    const focus = value && typeof value === "object" && (value as SchemaFocusLens).type === "screen-circle"
      ? value as SchemaFocusLens
      : undefined;
    enabled.checked = focus !== undefined;
    centerX.input.value = String(focus?.center.x ?? 0.5);
    centerY.input.value = String(focus?.center.y ?? 0.5);
    radius.input.value = String(focus?.radius ?? 0.15);
    detailBias.input.value = String(focus?.detailBias ?? 1.5);
    if (!focus && followCursor?.checked) {
      followCursor.checked = false;
      options.followCursor?.onChange(false, undefined);
    }
    syncDisabled();
  };
  setValue(options.value);
  return {
    element: root,
    setValue,
    updateContext(context) {
      currentContext = context;
      refreshFollowCursorAvailability();
    },
    refreshAvailability: refreshFollowCursorAvailability,
    destroy() {
      listeners.forEach((remove) => remove());
      root.remove();
    },
  };
}

function createOpacityControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  const root = document.createElement("div");
  root.className = "schema-special-opacity";
  const useDefault = document.createElement("input");
  useDefault.type = "checkbox";
  useDefault.id = "schema-opacity-use-default";
  useDefault.checked = options.value === undefined;
  const defaultLabel = document.createElement("label");
  defaultLabel.className = "ui-field ui-field--inline";
  defaultLabel.htmlFor = useDefault.id;
  defaultLabel.append(useDefault, document.createTextNode("Use renderer defaults"));
  const range = document.createElement("input");
  range.type = "range";
  range.id = "schema-opacity-slider";
  range.min = "0";
  range.max = "1";
  range.step = "0.01";
  range.setAttribute("aria-label", "Layer opacity slider");
  const exact = document.createElement("input");
  exact.type = "number";
  exact.id = "schema-opacity-value";
  exact.min = "0";
  exact.max = "1";
  exact.step = "any";
  exact.inputMode = "decimal";
  exact.setAttribute("aria-label", "Layer opacity");
  const valueLabel = document.createElement("label");
  valueLabel.className = "ui-field";
  valueLabel.htmlFor = exact.id;
  valueLabel.append(document.createTextNode("Opacity (0–1)"), exact);
  const sliderLabel = document.createElement("label");
  sliderLabel.className = "ui-field";
  sliderLabel.htmlFor = range.id;
  sliderLabel.append(document.createTextNode("Layer opacity"), range);
  root.append(defaultLabel, sliderLabel, valueLabel);

  let current = typeof options.value === "number" ? options.value : 1;
  const syncDisabled = (): void => {
    range.disabled = useDefault.checked;
    exact.disabled = useDefault.checked;
  };
  const syncInputs = (value: number): void => {
    current = value;
    range.value = String(value);
    exact.value = String(value);
  };
  const onDefaultChange = (): void => {
    syncDisabled();
    if (useDefault.checked) options.onChange(undefined);
    else options.onChange(current);
  };
  const onRangeInput = (): void => {
    exact.value = range.value;
    options.onChange(Number(range.value));
  };
  const onExactChange = (): void => {
    const value = exact.value.trim() === "" ? Number.NaN : Number(exact.value);
    if (Number.isFinite(value) && value >= 0 && value <= 1) range.value = String(value);
    options.onChange(value);
  };
  useDefault.addEventListener("change", onDefaultChange);
  range.addEventListener("input", onRangeInput);
  exact.addEventListener("change", onExactChange);

  const setValue = (value: unknown): void => {
    useDefault.checked = value === undefined;
    if (typeof value === "number" && Number.isFinite(value)) syncInputs(value);
    syncDisabled();
  };
  setValue(options.value);
  return {
    element: root,
    setValue,
    destroy() {
      useDefault.removeEventListener("change", onDefaultChange);
      range.removeEventListener("input", onRangeInput);
      exact.removeEventListener("change", onExactChange);
      root.remove();
    },
  };
}

type ClippingPlaneInputs = {
  readonly element: HTMLFieldSetElement;
  readonly normal: readonly HTMLInputElement[];
  readonly point: readonly HTMLInputElement[];
};

function coordinateInput(
  parent: HTMLElement,
  id: string,
  labelText: string,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.inputMode = "decimal";
  input.id = id;
  input.dataset.ecefCoordinate = labelText;
  input.setAttribute("aria-label", labelText);
  const label = document.createElement("label");
  label.className = "ui-field";
  label.htmlFor = id;
  label.append(document.createTextNode(labelText), input);
  parent.append(label);
  return input;
}

function inputPoint(inputs: readonly HTMLInputElement[]): readonly [number, number, number] {
  return inputs.map((input) => input.value.trim() === "" ? Number.NaN : Number(input.value)) as [number, number, number];
}

function setPointInputs(
  inputs: readonly HTMLInputElement[],
  value: readonly [number, number, number],
): void {
  inputs.forEach((input, index) => { input.value = String(value[index]); });
}

function createClippingVolumeControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  const root = document.createElement("div");
  root.className = "schema-special-clipping";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.id = "schema-clipping-enabled";
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "ui-field ui-field--inline";
  enabledLabel.htmlFor = enabled.id;
  enabledLabel.append(enabled, document.createTextNode("Enable clipping volume"));
  const coordinateHelp = document.createElement("p");
  coordinateHelp.className = "schema-special-clipping__coordinates";
  coordinateHelp.textContent = "WGS 84 ECEF XYZ metres. Clipping affects rendered and picked points, not source loading.";
  const type = document.createElement("select");
  type.id = "schema-clipping-type";
  type.setAttribute("aria-label", "Clipping volume type");
  type.add(new Option("Axis-aligned ECEF box", "box"));
  type.add(new Option("Plane intersection", "planes"));
  const typeLabel = document.createElement("label");
  typeLabel.className = "ui-field";
  typeLabel.htmlFor = type.id;
  typeLabel.append(document.createTextNode("Volume type"), type);
  const assist = document.createElement("div");
  assist.className = "schema-special-clipping__assist";
  const assistLabel = document.createElement("label");
  assistLabel.className = "ui-field";
  const assistRadius = document.createElement("input");
  assistRadius.type = "number";
  assistRadius.min = "0.01";
  assistRadius.step = "any";
  assistRadius.value = "10";
  assistRadius.setAttribute("aria-label", "Selected point clipping box half-width in metres");
  assistLabel.append(document.createTextNode("Selected-point box half-width (m)"), assistRadius);
  const centerOnPoint = document.createElement("button");
  centerOnPoint.type = "button";
  centerOnPoint.className = "schema-action";
  centerOnPoint.textContent = "Center box on selected point";
  const assistStatus = document.createElement("p");
  assistStatus.className = "schema-option__hint";
  assistStatus.setAttribute("role", "status");
  assistStatus.textContent = "Select a point in the Cesium viewport to create a centred ECEF box.";
  assist.append(assistLabel, centerOnPoint, assistStatus);
  const advanced = document.createElement("details");
  advanced.className = "schema-special-clipping__advanced";
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = "Advanced · edit exact ECEF box or planes";
  advanced.append(advancedSummary);
  const advancedHelp = document.createElement("p");
  advancedHelp.className = "schema-option__hint";
  advancedHelp.textContent = "Enter Earth-centred coordinates in metres, not longitude/latitude or renderer-local coordinates.";
  advanced.append(advancedHelp);
  const editor = document.createElement("fieldset");
  editor.id = "schema-clipping-editor";
  const legend = document.createElement("legend");
  legend.textContent = "Volume coordinates · metres";
  editor.append(legend);
  const boxEditor = document.createElement("div");
  boxEditor.dataset.clippingEditor = "box";
  const minimum = ["X", "Y", "Z"].map((axis) => coordinateInput(boxEditor, `schema-clipping-min-${axis.toLowerCase()}`, `Minimum ${axis} (ECEF metres)`));
  const maximum = ["X", "Y", "Z"].map((axis) => coordinateInput(boxEditor, `schema-clipping-max-${axis.toLowerCase()}`, `Maximum ${axis} (ECEF metres)`));
  editor.append(boxEditor);
  const planesEditor = document.createElement("div");
  planesEditor.dataset.clippingEditor = "planes";
  const planes = document.createElement("div");
  planesEditor.append(planes);
  const addPlane = document.createElement("button");
  addPlane.type = "button";
  addPlane.id = "schema-clipping-add-plane";
  addPlane.className = "schema-action";
  addPlane.textContent = "Add plane (up to 6)";
  planesEditor.append(addPlane);
  editor.append(planesEditor);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.id = "schema-clipping-clear";
  clear.className = "schema-action";
  clear.textContent = "Clear clipping volume";
  advanced.append(typeLabel, editor);
  root.append(enabledLabel, assist, coordinateHelp, advanced, clear);

  let planeInputs: ClippingPlaneInputs[] = [];
  const createPlane = (index: number): ClippingPlaneInputs => {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "schema-clipping-plane";
    fieldset.dataset.planeIndex = String(index);
    const legend = document.createElement("legend");
    legend.textContent = `Plane ${index + 1} · non-negative side remains visible`;
    fieldset.append(legend);
    const normal = ["X", "Y", "Z"].map((axis) => coordinateInput(fieldset, `schema-clipping-plane-${index}-normal-${axis.toLowerCase()}`, `Plane ${index + 1} normal ${axis}`));
    const point = ["X", "Y", "Z"].map((axis) => coordinateInput(fieldset, `schema-clipping-plane-${index}-point-${axis.toLowerCase()}`, `Plane ${index + 1} point ${axis} (ECEF metres)`));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "schema-action";
    remove.dataset.removePlane = String(index);
    remove.textContent = "Remove plane";
    fieldset.append(remove);
    const record: ClippingPlaneInputs = { element: fieldset, normal, point };
    const onRemove = (): void => {
      planeInputs = planeInputs.filter((candidate) => candidate !== record);
      rebuildPlaneList();
      emit();
    };
    remove.addEventListener("click", onRemove);
    return record;
  };
  const readEnabledVolume = (): SchemaClippingVolume => {
    if (type.value === "box") {
      return {
        type: "box",
        coordinateSystem: "wgs84-ecef-meters",
        minimum: inputPoint(minimum),
        maximum: inputPoint(maximum),
      };
    }
    return {
      type: "planes",
      coordinateSystem: "wgs84-ecef-meters",
      planes: planeInputs.map(({ normal, point }) => ({
        normal: inputPoint(normal),
        point: inputPoint(point),
      })),
    };
  };
  const updateEditor = (): void => {
    editor.disabled = !enabled.checked;
    type.disabled = !enabled.checked;
    clear.disabled = !enabled.checked;
    boxEditor.hidden = type.value !== "box";
    planesEditor.hidden = type.value !== "planes";
    addPlane.disabled = !enabled.checked || planeInputs.length >= 6;
    for (const plane of planeInputs) {
      for (const input of [...plane.normal, ...plane.point]) input.disabled = !enabled.checked;
      const remove = plane.element.querySelector<HTMLButtonElement>("[data-remove-plane]");
      if (remove) remove.disabled = !enabled.checked || planeInputs.length <= 1;
    }
  };
  const emit = (): void => {
    updateEditor();
    options.onChange(enabled.checked ? readEnabledVolume() : undefined);
  };
  const rebuildPlaneList = (): void => {
    planes.replaceChildren(...planeInputs.map(({ element }) => element));
    updateEditor();
  };
  const onEnabledChange = (): void => emit();
  const onTypeChange = (): void => emit();
  const onAddPlane = (): void => {
    if (planeInputs.length >= 6) return;
    planeInputs = [...planeInputs, createPlane(planeInputs.length)];
    rebuildPlaneList();
    emit();
  };
  const onClear = (): void => {
    enabled.checked = false;
    type.value = "box";
    setPointInputs(minimum, [Number.NaN, Number.NaN, Number.NaN]);
    setPointInputs(maximum, [Number.NaN, Number.NaN, Number.NaN]);
    planeInputs = [createPlane(0)];
    rebuildPlaneList();
    emit();
  };
  const onCenterOnPoint = (): void => {
    const point = options.getSelectedPointEcef?.();
    const halfWidth = assistRadius.value.trim() === "" ? Number.NaN : Number(assistRadius.value);
    const box = createSelectedPointEcefBox(point, halfWidth);
    if (!point || point.some((value) => !Number.isFinite(value))) {
      assistStatus.textContent = "No selected point with retained WGS 84 ECEF coordinates is available. Pick a Cesium point first.";
      return;
    }
    if (!Number.isFinite(halfWidth) || halfWidth <= 0) {
      assistStatus.textContent = "Enter a positive half-width in metres.";
      assistRadius.setAttribute("aria-invalid", "true");
      return;
    }
    assistRadius.removeAttribute("aria-invalid");
    enabled.checked = true;
    type.value = "box";
    if (box?.type !== "box") return;
    setPointInputs(minimum, box.minimum);
    setPointInputs(maximum, box.maximum);
    assistStatus.textContent = `Pending ${halfWidth} m half-width box centered on the selected ECEF point. Apply the filter to activate it.`;
    updateEditor();
    emit();
  };
  const onCoordinateChange = (event: Event): void => {
    if (event.target instanceof HTMLInputElement && event.target.dataset.ecefCoordinate) emit();
  };
  root.addEventListener("change", onCoordinateChange);
  enabled.addEventListener("change", onEnabledChange);
  type.addEventListener("change", onTypeChange);
  addPlane.addEventListener("click", onAddPlane);
  clear.addEventListener("click", onClear);
  centerOnPoint.addEventListener("click", onCenterOnPoint);

  const setValue = (value: unknown): void => {
    const volume = value && typeof value === "object" ? value as SchemaClippingVolume : undefined;
    enabled.checked = volume !== undefined;
    if (volume?.type === "box") {
      type.value = "box";
      setPointInputs(minimum, volume.minimum);
      setPointInputs(maximum, volume.maximum);
      planeInputs = [createPlane(0)];
    } else if (volume?.type === "planes") {
      type.value = "planes";
      planeInputs = volume.planes.map((_, index) => createPlane(index));
      volume.planes.forEach(({ normal, point }, index) => {
        setPointInputs(planeInputs[index].normal, normal);
        setPointInputs(planeInputs[index].point, point);
      });
    } else {
      type.value = "box";
      setPointInputs(minimum, [Number.NaN, Number.NaN, Number.NaN]);
      setPointInputs(maximum, [Number.NaN, Number.NaN, Number.NaN]);
      planeInputs = [createPlane(0)];
    }
    rebuildPlaneList();
  };
  setValue(options.value);
  return {
    element: root,
    setValue,
    destroy() {
      enabled.removeEventListener("change", onEnabledChange);
      type.removeEventListener("change", onTypeChange);
      addPlane.removeEventListener("click", onAddPlane);
      clear.removeEventListener("click", onClear);
      centerOnPoint.removeEventListener("click", onCenterOnPoint);
      root.removeEventListener("change", onCoordinateChange);
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
  const dimensionControl = renderDimensionSpecialControl(options);
  if (dimensionControl) return dimensionControl;
  switch (options.option.control) {
    case "opacity":
      return createOpacityControl(options);
    case "classification-filter":
      return createClassificationControl(options);
    case "focus-lens":
      return createFocusLensControl(options);
    case "clipping-volume":
      return createClippingVolumeControl(options);
    case "attribute-loading":
      return createAttributeLoadingControl(options);
    case "point-field-selection":
      return createPointFieldSelectionControl(options);
    default:
      return undefined;
  }
}

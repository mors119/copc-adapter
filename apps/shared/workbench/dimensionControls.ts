import type {
  CapabilityContext,
  SchemaDimensionColorStop,
  SchemaDimensionFilter,
  SchemaDimensionStyle,
  SchemaNumericDimensionMetadata,
} from "../schema/types.ts";
import type {
  SchemaSpecialControl,
  SchemaSpecialControlOptions,
} from "./SchemaOptionPanel.ts";

const DEFAULT_PALETTE: readonly SchemaDimensionColorStop[] = [
  { position: 0, color: { red: 0.05, green: 0.2, blue: 0.65, alpha: 0.9 } },
  { position: 1 / 3, color: { red: 0, green: 0.75, blue: 1, alpha: 0.9 } },
  { position: 2 / 3, color: { red: 1, green: 0.85, blue: 0.1, alpha: 0.9 } },
  { position: 1, color: { red: 0.85, green: 0.1, blue: 0.05, alpha: 0.9 } },
];

const MAX_PALETTE_STOPS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericDimensionFields(context: CapabilityContext): readonly SchemaNumericDimensionMetadata[] {
  return (context.numericDimensions ?? []).filter(({ styleable }) => styleable);
}

function unsupportedDimensionSummary(context: CapabilityContext): string {
  const unsupported = context.numericDimensions?.filter(({ styleable }) => !styleable) ?? [];
  if (unsupported.length === 0) return "";
  return "Unsupported fields: " + unsupported
    .slice(0, 3)
    .map(({ name, unsupportedReason }) => `${name} (${unsupportedReason ?? "unsupported type"})`)
    .join("; ") + (unsupported.length > 3 ? `; and ${unsupported.length - 3} more` : "");
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function field(context: CapabilityContext, name: string | undefined): SchemaNumericDimensionMetadata | undefined {
  return numericDimensionFields(context).find((candidate) => candidate.name === name);
}

function createFieldSelect(
  id: string,
  context: CapabilityContext,
): HTMLSelectElement {
  const select = element("select");
  select.id = id;
  select.setAttribute("aria-label", "Numeric LAS field");
  const fields = numericDimensionFields(context);
  if (fields.length === 0) {
    const option = new Option("Load a source to detect numeric fields", "");
    option.disabled = true;
    select.add(option);
    select.disabled = true;
    return select;
  }
  for (const candidate of fields) {
    select.add(new Option(candidate.name, candidate.name));
  }
  return select;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function colorToHex(color: SchemaDimensionColorStop["color"]): string {
  return "#" + [color.red, color.green, color.blue]
    .map((component) => clampByte(component).toString(16).padStart(2, "0"))
    .join("");
}

function hexToColor(hex: string, alpha: number): SchemaDimensionColorStop["color"] {
  const value = hex.replace(/^#/u, "");
  return {
    red: Number.parseInt(value.slice(0, 2), 16) / 255,
    green: Number.parseInt(value.slice(2, 4), 16) / 255,
    blue: Number.parseInt(value.slice(4, 6), 16) / 255,
    alpha,
  };
}

function getCurrentStyle(value: unknown): SchemaDimensionStyle | undefined {
  return isRecord(value) && typeof value.name === "string"
    ? value as unknown as SchemaDimensionStyle
    : undefined;
}

function getCurrentFilter(value: unknown): SchemaDimensionFilter | undefined {
  return isRecord(value) && typeof value.name === "string"
    ? value as unknown as SchemaDimensionFilter
    : undefined;
}

function colorCss(stop: SchemaDimensionColorStop): string {
  const color = stop.color;
  return `rgba(${clampByte(color.red)}, ${clampByte(color.green)}, ${clampByte(color.blue)}, ${color.alpha ?? 0.9}) ${stop.position * 100}%`;
}

function rangeLegend(name: string, range: { min: number; max: number }, units: string): string {
  return `${name} · ${range.min}–${range.max} · ${units}`;
}

function defaultBoundsHelp(metadata: SchemaNumericDimensionMetadata): string {
  return `Starting bounds: ${metadata.defaultRange.min}–${metadata.defaultRange.max} ${metadata.units}. ${metadata.defaultRangeNote ?? "These bounds are not observed point-sample limits."}`;
}

function createPaletteRows(
  target: HTMLElement,
  palette: readonly SchemaDimensionColorStop[],
  onChange: (palette: readonly SchemaDimensionColorStop[]) => void,
): void {
  target.replaceChildren();
  palette.forEach((stop, index) => {
    const row = element("div", "dimension-ramp-stop");
    const positionLabel = element("label", "ui-field");
    positionLabel.textContent = `Stop ${index + 1} · position`;
    const position = element("input");
    position.type = "number";
    position.min = "0";
    position.max = "1";
    position.step = "0.01";
    position.value = String(stop.position);
    position.min = String(index === 0 ? 0 : palette[index - 1].position + Number.EPSILON);
    position.max = String(index === palette.length - 1 ? 1 : palette[index + 1].position - Number.EPSILON);
    position.setAttribute("aria-label", `Stop ${index + 1} position from 0 to 1`);
    position.disabled = index === 0 || index === palette.length - 1;
    positionLabel.append(position);

    const colorLabel = element("label", "ui-field");
    colorLabel.textContent = `Stop ${index + 1} · HEX color`;
    const color = element("input");
    color.type = "color";
    color.value = colorToHex(stop.color);
    color.setAttribute("aria-label", `Stop ${index + 1} HEX color`);
    colorLabel.append(color);

    const alphaLabel = element("label", "ui-field");
    alphaLabel.textContent = `Stop ${index + 1} · alpha`;
    const alpha = element("input");
    alpha.type = "number";
    alpha.min = "0";
    alpha.max = "1";
    alpha.step = "0.01";
    alpha.value = String(stop.color.alpha ?? 0.9);
    alpha.setAttribute("aria-label", `Stop ${index + 1} alpha from 0 to 1`);
    alphaLabel.append(alpha);

    const remove = element("button", "schema-action");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.disabled = index === 0 || index === palette.length - 1 || palette.length <= 2;
    remove.setAttribute("aria-label", `Remove palette stop ${index + 1}`);
    remove.addEventListener("click", () => {
      if (palette.length <= 2 || index === 0 || index === palette.length - 1) return;
      onChange(palette.filter((_, candidate) => candidate !== index));
    });

    const update = (): void => {
      const nextPosition = position.value.trim() === "" ? Number.NaN : Number(position.value);
      const nextAlpha = alpha.value.trim() === "" ? Number.NaN : Number(alpha.value);
      const next = [...palette];
      next[index] = {
        position: nextPosition,
        color: hexToColor(color.value, nextAlpha),
      };
      onChange(next);
    };
    position.addEventListener("change", update);
    color.addEventListener("input", update);
    alpha.addEventListener("change", update);
    row.append(positionLabel, colorLabel, alphaLabel, remove);
    target.append(row);
  });
}

function createDimensionStyleControl(options: SchemaSpecialControlOptions): SchemaSpecialControl {
  let context = options.context;
  let currentStyle = getCurrentStyle(options.value);
  const root = element("div", "schema-special-dimension");
  const fieldLabel = element("label", "ui-field");
  fieldLabel.htmlFor = "schema-dimension-field";
  fieldLabel.append(document.createTextNode("Numeric field"));
  let fieldSelect = createFieldSelect("schema-dimension-field", context);
  fieldLabel.append(fieldSelect);

  const rangeRow = element("div", "dimension-range-row");
  const minLabel = element("label", "ui-field");
  minLabel.textContent = "Color range · minimum";
  const minInput = element("input");
  minInput.type = "number";
  minInput.step = "any";
  minInput.setAttribute("aria-label", "Color range minimum");
  minLabel.append(minInput);
  const maxLabel = element("label", "ui-field");
  maxLabel.textContent = "Color range · maximum";
  const maxInput = element("input");
  maxInput.type = "number";
  maxInput.step = "any";
  maxInput.setAttribute("aria-label", "Color range maximum");
  maxLabel.append(maxInput);
  rangeRow.append(minLabel, maxLabel);

  const rangeHelp = element("p", "field-help");
  const paletteDisclosure = element("details", "dimension-palette-details");
  const paletteSummary = element("summary");
  paletteSummary.textContent = "Advanced · edit palette stops";
  const add = element("button", "schema-action");
  add.type = "button";
  add.textContent = "Add stop";
  const reset = element("button", "schema-action");
  reset.type = "button";
  reset.textContent = "Reset palette";
  const actions = element("div", "dimension-editor-actions");
  actions.append(add, reset);
  const linearNote = element("p", "field-help");
  linearNote.textContent = "Colors blend linearly between stops. Positions and alpha use normalized values from 0 to 1.";
  const rows = element("div", "dimension-ramp-stops");
  paletteDisclosure.append(paletteSummary, linearNote, rows, actions);
  const legend = element("div", "dimension-ramp-legend");
  legend.setAttribute("role", "img");
  legend.setAttribute("aria-label", "Numeric dimension color ramp legend");
  const legendLabel = element("p", "field-help");
  const missingRow = element("div", "dimension-missing-row");
  const missingEnabled = element("input");
  missingEnabled.type = "checkbox";
  missingEnabled.id = "schema-dimension-missing-enabled";
  const missingLabel = element("label", "ui-field ui-field--inline");
  missingLabel.htmlFor = missingEnabled.id;
  missingLabel.append(missingEnabled, document.createTextNode("Use a NoData / missing-value value"));
  const missingInput = element("input");
  missingInput.type = "number";
  missingInput.step = "any";
  missingInput.setAttribute("aria-label", "Numeric dimension NoData override");
  const missingNote = element("p", "field-help");
  missingRow.append(missingLabel, missingInput, missingNote);

  const help = element("p", "field-help");
  root.append(fieldLabel, rangeRow, rangeHelp, legend, legendLabel, paletteDisclosure, missingRow, help);

  const paletteFrom = (style: SchemaDimensionStyle | undefined) => style?.palette ?? DEFAULT_PALETTE;
  const renderPalette = (): void => createPaletteRows(rows, paletteFrom(currentStyle), (palette) => {
    currentStyle = {
      ...(currentStyle ?? { name: fieldSelect.value || "Intensity", range: { min: 0, max: 65535 } }),
      palette,
    };
    emit();
  });
  const selectedField = (): SchemaNumericDimensionMetadata | undefined => field(context, fieldSelect.value);
  const renderHelp = (): void => {
    const selected = selectedField();
    if (!selected) {
      rangeHelp.textContent = "";
      legendLabel.textContent = "";
      legend.setAttribute("aria-label", "Numeric dimension color ramp legend");
      legend.style.background = "none";
      help.textContent = context.numericDimensions === undefined
        ? "Load a COPC source to inspect exact LAS Extra Bytes metadata. No fields are assumed available before metadata is read."
        : [
            context.values?.["adapter.backend"] === "rust"
              ? "Rust/WASM exposes standard Intensity coloring. Named LAS Extra Bytes styling requires the JavaScript backend."
              : "This source has no supported numeric fields for styling.",
            unsupportedDimensionSummary(context),
          ].filter(Boolean).join(" ");
      return;
    }
    help.textContent = selected.decoded
      ? "This field is already decoded. Cesium palette and filter edits can reuse cached points."
      : "This field is defined by the source but is not decoded yet. Apply will request this exact Extra Bytes field and reload the layer.";
    rangeHelp.textContent = `${defaultBoundsHelp(selected)} Values outside the range use the nearest end color.`;
    const stops = paletteFrom(currentStyle);
    paletteSummary.textContent = `Advanced · edit palette stops (${stops.length})`;
    legend.style.background = `linear-gradient(to right, ${stops.map(colorCss).join(", ")})`;
    const legendDescription = rangeLegend(
      selected.name,
      currentStyle?.range ?? selected.defaultRange,
      selected.units,
    );
    legendLabel.textContent = legendDescription;
    legend.setAttribute("aria-label", legendDescription);
    missingNote.textContent = currentStyle?.missingValue === undefined
      ? "No NoData value is applied; missing or non-finite point values use the fixed fallback color."
      : currentStyle.missingValue === selected.noData
        ? `Detected NoData ${selected.noData} is treated as missing by this style.`
        : `Value ${currentStyle.missingValue} is treated as missing by this style.`;
    add.disabled = stops.length >= MAX_PALETTE_STOPS;
  };
  const emit = (): void => {
    const name = fieldSelect.value;
    const selected = field(context, name);
    if (!selected) {
      options.onChange(undefined);
      return;
    }
    currentStyle = {
      name,
      range: {
        min: minInput.value.trim() === "" ? Number.NaN : Number(minInput.value),
        max: maxInput.value.trim() === "" ? Number.NaN : Number(maxInput.value),
      },
      palette: paletteFrom(currentStyle),
      ...(missingEnabled.checked
        ? { missingValue: missingInput.value.trim() === "" ? Number.NaN : Number(missingInput.value) }
        : {}),
    };
    renderHelp();
    options.onChange(currentStyle);
  };
  const setValue = (value: unknown): void => {
    currentStyle = getCurrentStyle(value);
    const selected = field(context, currentStyle?.name);
    if (currentStyle && selected) {
      fieldSelect.value = currentStyle.name;
      minInput.value = String(currentStyle.range.min);
      maxInput.value = String(currentStyle.range.max);
    } else if (selectedField()) {
      const preset = selectedField()!;
      fieldSelect.value = preset.name;
      minInput.value = String(preset.defaultRange.min);
      maxInput.value = String(preset.defaultRange.max);
    } else {
      minInput.value = "";
      maxInput.value = "";
    }
    const metadata = selectedField();
    missingEnabled.checked = currentStyle?.missingValue !== undefined;
    missingInput.value = currentStyle?.missingValue === undefined
      ? String(metadata?.noData ?? "")
      : String(currentStyle.missingValue);
    missingInput.disabled = !missingEnabled.checked || !metadata;
    minInput.disabled = !metadata;
    maxInput.disabled = !metadata;
    fieldSelect.disabled = numericDimensionFields(context).length === 0;
    renderPalette();
    renderHelp();
  };
  const updateFieldChoices = (): void => {
    const currentName = fieldSelect.value || currentStyle?.name;
    const next = createFieldSelect("schema-dimension-field", context);
    next.value = currentName ?? "";
    fieldSelect.replaceWith(next);
    fieldSelect = next;
    fieldLabel.append(fieldSelect);
    fieldSelect.addEventListener("change", onFieldChange);
  };
  const onFieldChange = (): void => {
    const selected = selectedField();
    if (!selected) return;
    const priorPalette = paletteFrom(currentStyle);
    currentStyle = {
      name: selected.name,
      range: { ...selected.defaultRange },
      palette: priorPalette,
      ...(selected.noData === undefined ? {} : { missingValue: selected.noData }),
    };
    minInput.value = String(selected.defaultRange.min);
    maxInput.value = String(selected.defaultRange.max);
    missingEnabled.checked = false;
    missingInput.value = String(selected.noData ?? "");
    missingInput.disabled = true;
    renderHelp();
    options.onChange(currentStyle);
  };
  const onRangeChange = (): void => emit();
  const onMissingChange = (): void => {
    missingInput.disabled = !missingEnabled.checked;
    emit();
  };
  const onAdd = (): void => {
    const palette = [...paletteFrom(currentStyle)];
    if (palette.length >= MAX_PALETTE_STOPS) return;
    let largestGap = -1;
    let insertAfter = 0;
    for (let index = 1; index < palette.length; index += 1) {
      const gap = palette[index].position - palette[index - 1].position;
      if (gap > largestGap) {
        largestGap = gap;
        insertAfter = index - 1;
      }
    }
    const left = palette[insertAfter];
    const right = palette[insertAfter + 1];
    const amount = 0.5;
    const midpoint: SchemaDimensionColorStop = {
      position: (left.position + right.position) / 2,
      color: {
        red: left.color.red + (right.color.red - left.color.red) * amount,
        green: left.color.green + (right.color.green - left.color.green) * amount,
        blue: left.color.blue + (right.color.blue - left.color.blue) * amount,
        alpha: (left.color.alpha ?? 0.9) + ((right.color.alpha ?? 0.9) - (left.color.alpha ?? 0.9)) * amount,
      },
    };
    palette.splice(insertAfter + 1, 0, midpoint);
    currentStyle = { ...(currentStyle ?? { name: fieldSelect.value, range: { min: 0, max: 1 } }), palette };
    renderPalette();
    emit();
  };
  const onReset = (): void => {
    currentStyle = { ...(currentStyle ?? { name: fieldSelect.value, range: { min: 0, max: 1 } }), palette: DEFAULT_PALETTE };
    renderPalette();
    emit();
  };
  fieldSelect.addEventListener("change", onFieldChange);
  minInput.addEventListener("change", onRangeChange);
  maxInput.addEventListener("change", onRangeChange);
  missingEnabled.addEventListener("change", onMissingChange);
  missingInput.addEventListener("change", onRangeChange);
  add.addEventListener("click", onAdd);
  reset.addEventListener("click", onReset);
  setValue(options.value);

  return {
    element: root,
    setValue,
    updateContext(nextContext) {
      context = nextContext;
      updateFieldChoices();
      setValue(context.values?.["style.dimension"]);
    },
    destroy() {
      fieldSelect.removeEventListener("change", onFieldChange);
      minInput.removeEventListener("change", onRangeChange);
      maxInput.removeEventListener("change", onRangeChange);
      missingEnabled.removeEventListener("change", onMissingChange);
      missingInput.removeEventListener("change", onRangeChange);
      add.removeEventListener("click", onAdd);
      reset.removeEventListener("click", onReset);
      root.remove();
    },
  };
}

function createDimensionFilterControl(options: SchemaSpecialControlOptions): SchemaSpecialControl {
  let context = options.context;
  const root = element("div", "schema-special-dimension-filter");
  const enabled = element("input");
  enabled.type = "checkbox";
  enabled.id = "schema-dimension-filter-enabled";
  const enabledLabel = element("label", "ui-field ui-field--inline");
  enabledLabel.htmlFor = enabled.id;
  enabledLabel.append(enabled, document.createTextNode("Enable inclusive filter"));
  let fieldSelect = createFieldSelect("schema-dimension-filter-field", context);
  fieldSelect.setAttribute("aria-label", "Filter numeric LAS field");
  const minInput = element("input");
  minInput.type = "number";
  minInput.step = "any";
  minInput.setAttribute("aria-label", "Inclusive filter minimum");
  const maxInput = element("input");
  maxInput.type = "number";
  maxInput.step = "any";
  maxInput.setAttribute("aria-label", "Inclusive filter maximum");
  const rangeRow = element("div", "dimension-range-row");
  const minLabel = element("label", "ui-field");
  minLabel.textContent = "Keep values from";
  minLabel.append(minInput);
  const maxLabel = element("label", "ui-field");
  maxLabel.textContent = "through (inclusive)";
  maxLabel.append(maxInput);
  rangeRow.append(minLabel, maxLabel);
  const fieldRow = element("label", "ui-field");
  fieldRow.append(document.createTextNode("Filter field"), fieldSelect);
  const helper = element("p", "field-help");
  const legend = element("p", "dimension-filter-legend");
  const missingEnabled = element("input");
  missingEnabled.type = "checkbox";
  missingEnabled.id = "schema-dimension-filter-missing-enabled";
  const missingLabel = element("label", "ui-field ui-field--inline");
  missingLabel.htmlFor = missingEnabled.id;
  missingLabel.append(missingEnabled, document.createTextNode("Hide this NoData / missing value"));
  const missingInput = element("input");
  missingInput.type = "number";
  missingInput.step = "any";
  missingInput.setAttribute("aria-label", "Dimension filter NoData value");
  const clear = element("button", "schema-action");
  clear.type = "button";
  clear.textContent = "Clear filter";
  root.append(enabledLabel, fieldRow, rangeRow, missingLabel, missingInput, legend, helper, clear);

  const currentFilter = (): SchemaDimensionFilter | undefined => getCurrentFilter(context.values?.["style.dimensionFilter"]);
  const selectedField = (): SchemaNumericDimensionMetadata | undefined => field(context, fieldSelect.value);
  const emit = (): void => {
    if (!enabled.checked) {
      options.onChange(null);
      return;
    }
    const selected = selectedField();
    if (!selected) {
      options.onChange(undefined);
      return;
    }
    const filter: SchemaDimensionFilter = {
      name: selected.name,
      min: minInput.value.trim() === "" ? Number.NaN : Number(minInput.value),
      max: maxInput.value.trim() === "" ? Number.NaN : Number(maxInput.value),
      ...(missingEnabled.checked
        ? { missingValue: missingInput.value.trim() === "" ? Number.NaN : Number(missingInput.value) }
        : {}),
    };
    legend.textContent = rangeLegend(filter.name, { min: filter.min, max: filter.max }, selected.units);
    helper.textContent = selected.decoded
      ? `Inclusive bounds apply to cached values; NoData and missing values are hidden. ${defaultBoundsHelp(selected)}`
      : `This exact Extra Bytes field will be requested and decoded when you apply the filter. ${defaultBoundsHelp(selected)}`;
    options.onChange(filter);
  };
  const setValue = (value: unknown): void => {
    const filter = getCurrentFilter(value);
    const style = getCurrentStyle(context.values?.["style.dimension"]);
    const candidate = filter?.name ?? style?.name ?? numericDimensionFields(context)[0]?.name;
    fieldSelect.value = candidate ?? "";
    enabled.checked = filter !== undefined;
    const metadata = selectedField();
    const range = filter ?? (metadata ? { min: metadata.defaultRange.min, max: metadata.defaultRange.max } : undefined);
    minInput.value = range ? String(range.min) : "";
    maxInput.value = range ? String(range.max) : "";
    fieldSelect.disabled = numericDimensionFields(context).length === 0 || !enabled.checked;
    minInput.disabled = !enabled.checked || !metadata;
    maxInput.disabled = !enabled.checked || !metadata;
    missingEnabled.checked = filter?.missingValue !== undefined || (!filter && metadata?.noData !== undefined);
    missingInput.value = String(filter?.missingValue ?? metadata?.noData ?? "");
    missingInput.disabled = !enabled.checked || !missingEnabled.checked || !metadata;
    clear.disabled = !enabled.checked;
    if (filter && metadata) {
      legend.textContent = rangeLegend(filter.name, filter, metadata.units);
      helper.textContent = metadata.decoded
        ? `Bounds are inclusive. Values outside them and the configured missing value are hidden. ${defaultBoundsHelp(metadata)}`
        : `This exact Extra Bytes field will be requested and decoded when you apply the filter. ${defaultBoundsHelp(metadata)}`;
    } else {
      legend.textContent = "";
      helper.textContent = numericDimensionFields(context).length === 0
        ? context.values?.["adapter.backend"] === "rust"
          ? "Rust/WASM can filter standard Intensity; named Extra Bytes filters require copc-js."
          : "Load a source to inspect exact numeric LAS fields."
        : (() => {
            const selected = selectedField();
            return selected
              ? `Choose inclusive bounds. Values outside the interval are hidden; configure a missing value when needed. ${defaultBoundsHelp(selected)}`
              : "Choose a field and inclusive bounds. Values outside the interval are hidden; configure a missing value when needed.";
          })();
    }
  };
  const onFieldChange = (): void => {
    const selected = selectedField();
    if (!selected) return;
    minInput.value = String(selected.defaultRange.min);
    maxInput.value = String(selected.defaultRange.max);
    missingEnabled.checked = selected.noData !== undefined;
    missingInput.value = String(selected.noData ?? "");
    missingInput.disabled = !enabled.checked || !missingEnabled.checked;
    emit();
  };
  const onBoundChange = (): void => emit();
  const onMissingChange = (): void => {
    missingInput.disabled = !enabled.checked || !missingEnabled.checked;
    emit();
  };
  const onToggle = (): void => {
    fieldSelect.disabled = !enabled.checked;
    minInput.disabled = !enabled.checked;
    maxInput.disabled = !enabled.checked;
    if (enabled.checked) {
      const selected = selectedField();
      if (selected) {
        minInput.value = String(selected.defaultRange.min);
        maxInput.value = String(selected.defaultRange.max);
        missingEnabled.checked = selected.noData !== undefined;
        missingInput.value = String(selected.noData ?? "");
        missingInput.disabled = !missingEnabled.checked;
      }
    }
    emit();
  };
  const onClear = (): void => {
    enabled.checked = false;
    setValue(null);
    options.onChange(null);
  };
  fieldSelect.addEventListener("change", onFieldChange);
  minInput.addEventListener("change", onBoundChange);
  maxInput.addEventListener("change", onBoundChange);
  missingEnabled.addEventListener("change", onMissingChange);
  missingInput.addEventListener("change", onBoundChange);
  enabled.addEventListener("change", onToggle);
  clear.addEventListener("click", onClear);
  setValue(options.value);

  return {
    element: root,
    setValue,
    updateContext(nextContext) {
      context = nextContext;
      const name = fieldSelect.value;
      const next = createFieldSelect("schema-dimension-filter-field", context);
      next.value = name;
      next.disabled = !enabled.checked || numericDimensionFields(context).length === 0;
      fieldSelect.replaceWith(next);
      fieldSelect = next;
      fieldSelect.setAttribute("aria-label", "Filter numeric LAS field");
      fieldRow.replaceChildren(document.createTextNode("Filter field"), fieldSelect);
      fieldSelect.addEventListener("change", onFieldChange);
      setValue(currentFilter());
    },
    destroy() {
      fieldSelect.removeEventListener("change", onFieldChange);
      minInput.removeEventListener("change", onBoundChange);
      maxInput.removeEventListener("change", onBoundChange);
      missingEnabled.removeEventListener("change", onMissingChange);
      missingInput.removeEventListener("change", onBoundChange);
      enabled.removeEventListener("change", onToggle);
      clear.removeEventListener("click", onClear);
      root.remove();
    },
  };
}

/** Render the schema's dimension palette and numeric filter editors. */
export function renderDimensionSpecialControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl | undefined {
  if (options.option.control === "dimension-style") return createDimensionStyleControl(options);
  if (options.option.control === "dimension-filter") return createDimensionFilterControl(options);
  return undefined;
}

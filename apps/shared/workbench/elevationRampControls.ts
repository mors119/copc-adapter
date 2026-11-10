import type {
  SchemaDimensionColorStop,
  SchemaElevationRange,
  SchemaElevationStyle,
} from "../schema/types.ts";
import {
  colorCss,
  createPaletteRows,
  MAX_PALETTE_STOPS,
} from "./dimensionControls.ts";
import type {
  SchemaSpecialControl,
  SchemaSpecialControlOptions,
} from "./SchemaOptionPanel.ts";

const DEFAULT_ELEVATION_PALETTE: readonly SchemaDimensionColorStop[] = [
  { position: 0, color: { red: 0.05, green: 0.2, blue: 0.65, alpha: 0.9 } },
  { position: 0.25, color: { red: 0, green: 0.75, blue: 1, alpha: 0.9 } },
  { position: 0.5, color: { red: 0.15, green: 0.75, blue: 0.25, alpha: 0.9 } },
  { position: 0.75, color: { red: 1, green: 0.85, blue: 0.1, alpha: 0.9 } },
  { position: 1, color: { red: 0.85, green: 0.1, blue: 0.05, alpha: 0.9 } },
];

const PRESETS: Readonly<Record<string, readonly SchemaDimensionColorStop[]>> = {
  "blue-white-red": [
    { position: 0, color: { red: 0.13, green: 0.4, blue: 0.67, alpha: 0.9 } },
    { position: 0.5, color: { red: 0.97, green: 0.97, blue: 0.97, alpha: 0.9 } },
    { position: 1, color: { red: 0.7, green: 0.09, blue: 0.17, alpha: 0.9 } },
  ],
  grayscale: [
    { position: 0, color: { red: 0, green: 0, blue: 0, alpha: 0.9 } },
    { position: 1, color: { red: 1, green: 1, blue: 1, alpha: 0.9 } },
  ],
  thermal: [
    { position: 0, color: { red: 0.19, green: 0.07, blue: 0.23, alpha: 0.9 } },
    { position: 0.25, color: { red: 0.27, green: 0.42, blue: 0.89, alpha: 0.9 } },
    { position: 0.5, color: { red: 0.16, green: 0.73, blue: 0.93, alpha: 0.9 } },
    { position: 0.75, color: { red: 0.98, green: 0.91, blue: 0.13, alpha: 0.9 } },
    { position: 1, color: { red: 0.48, green: 0.02, blue: 0.01, alpha: 0.9 } },
  ],
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentRange(value: unknown): SchemaElevationRange | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.min === "number" && typeof value.max === "number"
    ? { min: value.min, max: value.max }
    : undefined;
}

function currentStyle(value: unknown): SchemaElevationStyle | undefined {
  return isRecord(value) ? value as SchemaElevationStyle : undefined;
}

function createElevationRangeControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  const root = element("div", "schema-special-elevation-range");
  const row = element("div", "elevation-range-row");
  const minLabel = element("label", "ui-field");
  minLabel.textContent = "Minimum height (m)";
  const min = element("input");
  min.type = "number";
  min.step = "any";
  min.placeholder = "Dataset minimum";
  min.setAttribute("aria-label", "Elevation range minimum metres");
  minLabel.append(min);

  const maxLabel = element("label", "ui-field");
  maxLabel.textContent = "Maximum height (m)";
  const max = element("input");
  max.type = "number";
  max.step = "any";
  max.placeholder = "Dataset maximum";
  max.setAttribute("aria-label", "Elevation range maximum metres");
  maxLabel.append(max);
  row.append(minLabel, maxLabel);

  const help = element("p", "field-help");
  help.textContent = "Absolute displayed WGS 84 ellipsoidal height, in metres. The height includes configured vertical transformation and manual height offset; it is not source Z, dataset-relative height, or height above ground.";
  const legend = element("p", "field-help elevation-range-legend");
  const reset = element("button", "schema-action");
  reset.type = "button";
  reset.textContent = "Use dataset range";
  const onReset = (): void => options.onChange(undefined);
  reset.addEventListener("click", onReset);
  root.append(row, legend, help, reset);

  const setValue = (value: unknown): void => {
    const range = currentRange(value);
    if (document.activeElement !== min) min.value = range ? String(range.min) : "";
    if (document.activeElement !== max) max.value = range ? String(range.max) : "";
    legend.textContent = range
      ? `Color range · ${range.min}–${range.max} m · displayed WGS 84 ellipsoidal height`
      : "Color range · dataset elevation bounds · displayed WGS 84 ellipsoidal height (m)";
  };
  const update = (): void => {
    if (min.value.trim() === "" && max.value.trim() === "") {
      options.onChange(undefined);
      return;
    }
    options.onChange({
      min: min.value.trim() === "" ? Number.NaN : Number(min.value),
      max: max.value.trim() === "" ? Number.NaN : Number(max.value),
    });
  };
  min.addEventListener("change", update);
  max.addEventListener("change", update);
  setValue(options.value);
  return {
    element: root,
    setValue,
    destroy() {
      min.removeEventListener("change", update);
      max.removeEventListener("change", update);
      reset.removeEventListener("click", onReset);
      root.remove();
    },
  };
}

function midpointStop(
  left: SchemaDimensionColorStop,
  right: SchemaDimensionColorStop,
): SchemaDimensionColorStop {
  const mix = (a: number | undefined, b: number | undefined): number =>
    ((a ?? 0.9) + (b ?? 0.9)) / 2;
  return {
    position: (left.position + right.position) / 2,
    color: {
      red: mix(left.color.red, right.color.red),
      green: mix(left.color.green, right.color.green),
      blue: mix(left.color.blue, right.color.blue),
      alpha: mix(left.color.alpha, right.color.alpha),
    },
  };
}

function presetValue(style: SchemaElevationStyle | undefined): string {
  if (!style) return "adapter-default";
  const palette = style.palette;
  if (!palette) return "custom";
  const key = Object.keys(PRESETS).find((candidate) =>
    JSON.stringify(PRESETS[candidate]) === JSON.stringify(palette),
  );
  return key ?? "custom";
}

function createElevationStyleControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl {
  let style = currentStyle(options.value);
  let context = options.context;
  const root = element("div", "schema-special-elevation-style");

  const presetLabel = element("label", "ui-field");
  presetLabel.textContent = "Color preset";
  const preset = element("select");
  preset.setAttribute("aria-label", "Elevation color preset");
  for (const [value, label] of [
    ["adapter-default", "Adapter default · terrain ramp"],
    ["blue-white-red", "Blue · white · red"],
    ["grayscale", "Grayscale"],
    ["thermal", "Thermal"],
    ["custom", "Custom"],
  ]) preset.add(new Option(label!, value!));
  presetLabel.append(preset);

  const interpolationLabel = element("label", "ui-field");
  interpolationLabel.textContent = "Interpolation";
  const interpolation = element("select");
  interpolation.setAttribute("aria-label", "Elevation ramp interpolation");
  interpolation.add(new Option("Linear", "linear"));
  interpolation.add(new Option("Step", "step"));
  interpolationLabel.append(interpolation);

  const legend = element("div", "dimension-ramp-legend");
  legend.setAttribute("role", "img");
  const legendLabel = element("p", "field-help elevation-ramp-legend-label");
  const details = element("details", "dimension-palette-details");
  const summary = element("summary");
  const stops = element("div", "dimension-ramp-stops");
  const add = element("button", "schema-action");
  add.type = "button";
  add.textContent = "Add stop";
  const reset = element("button", "schema-action");
  reset.type = "button";
  reset.textContent = "Reset ramp";
  const actions = element("div", "dimension-editor-actions");
  actions.append(add, reset);
  const note = element("p", "field-help");
  note.textContent = "Stop positions and alpha are normalized from 0 to 1. Missing or non-finite heights use the ramp midpoint.";
  details.append(summary, note, stops, actions);
  root.append(presetLabel, interpolationLabel, legend, legendLabel, details);

  const palette = (): readonly SchemaDimensionColorStop[] =>
    style?.palette ?? DEFAULT_ELEVATION_PALETTE;
  const renderLegend = (): void => {
    const selectedRange = currentRange(context.values?.["style.elevationRange"]);
    const colors = palette();
    const gradientStops = colors.flatMap((stop, index) => {
      const nextStop = colors[index + 1];
      if (style?.interpolation !== "step" || !nextStop) return [colorCss(stop)];
      return [colorCss(stop), colorCss({ ...stop, position: nextStop.position })];
    });
    legend.style.background = `linear-gradient(to right, ${gradientStops.join(", ")})`;
    const rangeText = selectedRange
      ? `${selectedRange.min}–${selectedRange.max} m`
      : "dataset bounds (m)";
    legendLabel.textContent = `${rangeText} · WGS 84 ellipsoidal height`;
    legend.setAttribute("aria-label", `Elevation color ramp · ${legendLabel.textContent}`);
    summary.textContent = `Advanced · edit color stops (${palette().length})`;
    add.disabled = palette().length >= MAX_PALETTE_STOPS;
  };
  const renderPalette = (): void => {
    createPaletteRows(stops, palette(), (nextPalette) => {
      style = { ...(style ?? {}), palette: nextPalette };
      emit();
    });
    renderLegend();
  };
  const emit = (): void => {
    if (!style || Object.keys(style).length === 0) {
      options.onChange(undefined);
      return;
    }
    options.onChange(style);
  };
  const setValue = (value: unknown): void => {
    style = currentStyle(value);
    preset.value = presetValue(style);
    interpolation.value = style?.interpolation ?? "linear";
    renderPalette();
  };
  const onPresetChange = (): void => {
    if (preset.value === "adapter-default") {
      style = undefined;
      options.onChange(undefined);
      return;
    }
    const nextPalette = PRESETS[preset.value];
    if (!nextPalette) return;
    style = { ...(style ?? {}), palette: nextPalette };
    renderPalette();
    emit();
  };
  const onInterpolationChange = (): void => {
    const nextInterpolation = interpolation.value as "linear" | "step";
    if (nextInterpolation === "linear" && style?.palette === undefined) {
      style = undefined;
      renderLegend();
      options.onChange(undefined);
      return;
    }
    style = { ...(style ?? {}), interpolation: nextInterpolation };
    renderLegend();
    emit();
  };
  const onAdd = (): void => {
    const current = palette();
    if (current.length >= MAX_PALETTE_STOPS) return;
    let widestIndex = 0;
    for (let index = 0; index < current.length - 1; index++) {
      if (current[index + 1].position - current[index].position >
        current[widestIndex + 1].position - current[widestIndex].position) {
        widestIndex = index;
      }
    }
    const next = [...current];
    next.splice(widestIndex + 1, 0, midpointStop(current[widestIndex], current[widestIndex + 1]));
    style = { ...(style ?? {}), palette: next };
    renderPalette();
    emit();
  };
  const onReset = (): void => {
    style = undefined;
    options.onChange(undefined);
  };
  preset.addEventListener("change", onPresetChange);
  interpolation.addEventListener("change", onInterpolationChange);
  add.addEventListener("click", onAdd);
  reset.addEventListener("click", onReset);
  setValue(options.value);

  return {
    element: root,
    setValue,
    updateContext(nextContext) {
      context = nextContext;
      renderLegend();
    },
    destroy() {
      preset.removeEventListener("change", onPresetChange);
      interpolation.removeEventListener("change", onInterpolationChange);
      add.removeEventListener("click", onAdd);
      reset.removeEventListener("click", onReset);
      root.remove();
    },
  };
}

/** Shared schema presentation for the public absolute elevation ramp options. */
export function renderElevationRampSpecialControl(
  options: SchemaSpecialControlOptions,
): SchemaSpecialControl | undefined {
  switch (options.option.control) {
    case "elevation-range":
      return createElevationRangeControl(options);
    case "elevation-style":
      return createElevationStyleControl(options);
    default:
      return undefined;
  }
}

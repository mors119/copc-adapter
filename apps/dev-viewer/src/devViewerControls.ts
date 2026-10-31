import type {
  CopcBackendName,
  RangeValidationPolicy,
  RefinementAlgorithm,
} from "@frillab/copc-adapter";
import type { WorkbenchColorMode } from "../../shared/workbench-config";
import { mountSegmentedControl } from "../../shared/ui-controls";
import { mountSchemaOptionPanel } from "../../shared/workbench/SchemaOptionPanel.ts";
import { renderSharedSpecialControl } from "../../shared/workbench/specialControls.ts";
import {
  getAvailableChoices,
  WORKSPACE_CURRENT_CAPABILITIES,
  WORKSPACE_CURRENT_MANIFEST,
  getOptionDefinition,
} from "../../shared/schema/index.ts";
import { transitionRendererOptionValues } from "../../shared/config/index.ts";
import type { SchemaRenderer } from "../../shared/schema/index.ts";
import type {
  SchemaDimensionFilter,
  SchemaDimensionStyle,
  SchemaNumericDimensionMetadata,
} from "../../shared/schema/types.ts";
import {
  createDefaultDimensionStyle,
  getWorkbenchNumericDimensions,
  withRequestedExtraDimensions,
} from "../../shared/workbench/dimensionModel.ts";
import type {
  CameraPreset,
  CesiumPointRendererVariant,
  DevViewerConfig,
  RenderingEngine,
} from "./devViewerConfig";
import { toWorkbenchOptionValues } from "./devViewerConfig";

export type DevViewerControlsOptions = {
  readonly initialConfig: DevViewerConfig;
  readonly sourcePresets: ReadonlyMap<string, string>;
  readonly onEngineSelected: (engine: RenderingEngine) => number;
  readonly onCesiumRendererSelected: (
    renderer: CesiumPointRendererVariant,
  ) => void;
  readonly onBackendSelected: (backend: CopcBackendName) => void;
  readonly onCameraPresetSelected: (preset: CameraPreset) => number;
  readonly onColorModeSelected: (
    mode: WorkbenchColorMode,
    dimension?: SchemaDimensionStyle,
  ) => void;
  readonly onRefinementAlgorithmSelected: (
    algorithm: RefinementAlgorithm,
  ) => void;
  readonly onMotionLookaheadSelected: (enabled: boolean) => void;
  readonly onRangeValidationSelected: (policy: RangeValidationPolicy) => void;
  readonly onPendingConfigChange: (update: Partial<DevViewerConfig>) => void;
  readonly onValidationChange: () => void;
  readonly onCameraDistanceSelected: (distance: number) => void;
  readonly onInvalidCameraDistance: () => void;
  readonly getCameraDistance: () => number;
};

export type DevViewerControls = {
  getSelectedSource(): string | File | undefined;
  getValidationErrors(): readonly string[];
  setNumericDimensionMetadata(
    metadata: Parameters<typeof getWorkbenchNumericDimensions>[0],
    decodedExtraDimensions?: readonly string[],
  ): void;
  destroy(): void;
};

const HOST_RUNTIME_CAPABILITIES = WORKSPACE_CURRENT_CAPABILITIES.filter(
  // No Dev Viewer GTX loader is registered yet; keep the package API capability
  // out of this host until the resource can be validated and loaded here.
  (capability) => capability !== "vertical.gtx-grid",
);

/** Mount shared schema controls while keeping source and camera ownership in the host. */
export function mountDevViewerControls(
  options: DevViewerControlsOptions,
): DevViewerControls {
  const sourceSelect = document.querySelector<HTMLSelectElement>("#source-selection")!;
  const customUrl = document.querySelector<HTMLInputElement>("#custom-source-url")!;
  const fileInput = document.querySelector<HTMLInputElement>("#local-source-file")!;
  const cameraDistanceInput = document.querySelector<HTMLInputElement>("#camera-render-distance")!;
  const cameraControlTarget = document.querySelector<HTMLElement>("#camera-control")!;
  const controlRoot = document.querySelector<HTMLElement>("#shared-schema-controls")!;
  const mountedControls: Array<{ destroy(): void }> = [];

  let openedLocalFile: File | undefined;
  let renderer: SchemaRenderer = options.initialConfig.renderer;
  let values: Record<string, unknown> = toWorkbenchOptionValues(options.initialConfig);
  let schemaOptionValues: Record<string, unknown> = {
    ...(options.initialConfig.schemaOptionValues ?? {}),
  };
  let sourceMetadata: Parameters<typeof getWorkbenchNumericDimensions>[0];
  let decodedExtraDimensions: readonly string[] = [];
  let numericDimensions: readonly SchemaNumericDimensionMetadata[] | undefined;
  const inactiveRendererValues = new Map<
    string,
    { readonly value: unknown; readonly schemaOnly: boolean }
  >();
  const initialUrl = typeof options.initialConfig.source === "string"
    ? options.initialConfig.source
    : "";
  const initialPreset = [...options.sourcePresets].find(
    ([, source]) => source === initialUrl,
  )?.[0];
  sourceSelect.value = initialPreset ?? "custom";
  customUrl.disabled = sourceSelect.value !== "custom";
  if (sourceSelect.value === "custom") customUrl.value = initialUrl;

  const getSelectedSource = (): string | File | undefined => {
    if (sourceSelect.value === "local-file") return openedLocalFile;
    if (sourceSelect.value === "custom") return customUrl.value.trim();
    return options.sourcePresets.get(sourceSelect.value);
  };
  const refreshDimensionContext = (): void => {
    const backend = values["adapter.backend"] === "rust" ? "rust" : "copc-js";
    numericDimensions = getWorkbenchNumericDimensions(
      sourceMetadata,
      backend,
      decodedExtraDimensions,
      true,
    );
  };
  const context = () => ({
    manifest: WORKSPACE_CURRENT_MANIFEST,
    renderer,
    runtimeCapabilities: HOST_RUNTIME_CAPABILITIES,
    values,
    ...(numericDimensions === undefined ? {} : { numericDimensions }),
  });
  const updateDimensionChoices = (): void => {
    const option = getOptionDefinition("rendering.colorMode");
    if (!option) return;
    const choices = getAvailableChoices(option, {
      manifest: WORKSPACE_CURRENT_MANIFEST,
      renderer,
      runtimeCapabilities: HOST_RUNTIME_CAPABILITIES,
    }).map(({ value, label }) => ({
      value,
      label,
      ...(value === "dimension" &&
        values["rendering.colorMode"] !== "dimension" &&
        !numericDimensions?.some(({ styleable }) => styleable)
        ? {
            disabled: true,
            title: "Load a COPC source to verify available numeric fields.",
          }
        : {}),
    }));
    schemaPanel?.setChoices("rendering.colorMode", choices);
  };
  const clearSourceDimensionMetadata = (): void => {
    sourceMetadata = undefined;
    decodedExtraDimensions = [];
    refreshDimensionContext();
    schemaPanel?.update({ values, context: context() });
    updateDimensionChoices();
  };
  const updateSelectedSource = (): void => {
    const source = getSelectedSource();
    if (source !== undefined) {
      clearSourceDimensionMetadata();
      options.onPendingConfigChange({ source });
    }
  };

  const onSourceSelectionChange = (): void => {
    customUrl.disabled = sourceSelect.value !== "custom";
    if (sourceSelect.value !== "local-file") fileInput.value = "";
    updateSelectedSource();
  };
  const onCustomUrlInput = (): void => {
    if (sourceSelect.value === "custom") updateSelectedSource();
  };
  const onLocalFileChange = (): void => {
    const file = fileInput.files?.[0];
    if (!file) return;
    openedLocalFile = file;
    let localFileOption = sourceSelect.querySelector<HTMLOptionElement>(
      'option[value="local-file"]',
    );
    if (!localFileOption) {
      localFileOption = document.createElement("option");
      localFileOption.value = "local-file";
      sourceSelect.append(localFileOption);
    }
    localFileOption.textContent = "Local file · " + file.name;
    sourceSelect.value = "local-file";
    customUrl.disabled = true;
    clearSourceDimensionMetadata();
    options.onPendingConfigChange({ source: file });
  };
  sourceSelect.addEventListener("change", onSourceSelectionChange);
  customUrl.addEventListener("input", onCustomUrlInput);
  fileInput.addEventListener("change", onLocalFileChange);

  const cameraControl = mountSegmentedControl<CameraPreset>(cameraControlTarget, {
    label: "Camera presets",
    value: options.initialConfig.cameraPreset,
    choices: [
      { value: "overview", label: "Overview" },
      { value: "far", label: "Far" },
      { value: "near", label: "Near" },
    ],
    onChange(value) {
      cameraDistanceInput.value = String(options.onCameraPresetSelected(value));
    },
  });
  mountedControls.push(cameraControl);

  cameraDistanceInput.value = String(options.initialConfig.cameraRenderDistance);
  const onCameraDistanceChange = (): void => {
    const distance = Number(cameraDistanceInput.value);
    if (!Number.isFinite(distance) || distance <= 0) {
      options.onInvalidCameraDistance();
      cameraDistanceInput.value = String(options.getCameraDistance());
      return;
    }
    options.onCameraDistanceSelected(distance);
  };
  cameraDistanceInput.addEventListener("change", onCameraDistanceChange);

  let schemaPanel: ReturnType<typeof mountSchemaOptionPanel> | undefined;
  let configuredExtraDimensions: readonly string[] | "*" =
    schemaOptionValues["attributes.extraDimensions"] === "*"
      ? "*"
      : Array.isArray(schemaOptionValues["attributes.extraDimensions"])
        ? (schemaOptionValues["attributes.extraDimensions"] as unknown[])
            .filter((name): name is string => typeof name === "string")
        : [];

  const setOption = (optionId: string, value: unknown): void => {
    values = { ...values, [optionId]: value };
    switch (optionId) {
      case "renderer.engine": {
        const nextRenderer = value as SchemaRenderer;
        if (nextRenderer !== renderer) {
          transitionRendererOptionValues(
            values,
            schemaOptionValues,
            renderer,
            nextRenderer,
            inactiveRendererValues,
            {
              support: {
                manifest: WORKSPACE_CURRENT_MANIFEST,
                runtimeCapabilities: HOST_RUNTIME_CAPABILITIES,
              },
            },
          );
          renderer = nextRenderer;
          options.onPendingConfigChange({ schemaOptionValues });
        }
        const cameraDistance = options.onEngineSelected(renderer);
        cameraDistanceInput.value = String(cameraDistance);
        break;
      }
      case "adapter.backend":
        options.onBackendSelected(value as CopcBackendName);
        refreshDimensionContext();
        break;
      case "rendering.colorMode":
        if (value === "dimension" && values["style.dimension"] === undefined && numericDimensions) {
          const first = numericDimensions.find(({ styleable }) => styleable);
          if (first) {
            const dimension = createDefaultDimensionStyle(numericDimensions, first.name);
            values = { ...values, "style.dimension": dimension };
            schemaOptionValues = { ...schemaOptionValues, "style.dimension": dimension };
          }
        }
        syncDimensionExtraDimensions();
        options.onPendingConfigChange({ schemaOptionValues });
        {
          const dimension = values["style.dimension"] as SchemaDimensionStyle | undefined;
          const field = dimension
            ? numericDimensions?.find(({ name }) => name === dimension.name)
            : undefined;
          if (value === "dimension" && dimension && field?.decoded !== true) {
            options.onPendingConfigChange({ colorMode: "dimension" });
          } else {
            options.onColorModeSelected(value as WorkbenchColorMode, dimension);
          }
        }
        break;
      case "rendering.cesiumPointRenderer":
        options.onCesiumRendererSelected(value as CesiumPointRendererVariant);
        break;
      case "streaming.refinementAlgorithm":
        options.onRefinementAlgorithmSelected(value as RefinementAlgorithm);
        break;
      case "streaming.motionLookahead":
        options.onMotionLookaheadSelected(value === true);
        break;
      case "source.rangeValidation":
        options.onRangeValidationSelected(value as RangeValidationPolicy);
        break;
      default: {
        if (optionId === "style.dimension" || optionId === "style.dimensionFilter") {
          schemaOptionValues = { ...schemaOptionValues, [optionId]: value };
          syncDimensionExtraDimensions();
          options.onPendingConfigChange({ schemaOptionValues });
          break;
        }
        if (optionId === "attributes.extraDimensions") {
          configuredExtraDimensions = value === "*"
            ? "*"
            : Array.isArray(value)
              ? value.filter((name): name is string => typeof name === "string")
              : [];
          syncDimensionExtraDimensions();
          options.onPendingConfigChange({ schemaOptionValues });
          break;
        }
        const definition = getOptionDefinition(optionId);
        const stateField = definition?.statePath.split(".").at(-1);
        const configuredFields = new Set(Object.keys(options.initialConfig));
        const hostField = optionId === "streaming.maxRenderDistanceMeters"
          ? "maxRenderDistance"
          : stateField;
        if (hostField && configuredFields.has(hostField)) {
          options.onPendingConfigChange({ [hostField]: value } as Partial<DevViewerConfig>);
        } else {
          schemaOptionValues = {
            ...schemaOptionValues,
            [optionId]: value,
          };
          options.onPendingConfigChange({ schemaOptionValues });
        }
      }
    }
    refreshDimensionContext();
    schemaPanel?.update({ values, context: context() });
    updateDimensionChoices();
  };

  function syncDimensionExtraDimensions(): void {
    const dimension = values["rendering.colorMode"] === "dimension"
      ? values["style.dimension"] as SchemaDimensionStyle | undefined
      : undefined;
    const filter = (values["style.dimensionFilter"] ?? undefined) as SchemaDimensionFilter | null | undefined;
    schemaOptionValues = withRequestedExtraDimensions(
      schemaOptionValues,
      configuredExtraDimensions,
      dimension,
      filter,
    );
    if (Object.hasOwn(schemaOptionValues, "attributes.extraDimensions")) {
      values = {
        ...values,
        "attributes.extraDimensions": schemaOptionValues["attributes.extraDimensions"],
      };
    } else {
      delete values["attributes.extraDimensions"];
    }
  }

  schemaPanel = mountSchemaOptionPanel({
    target: controlRoot,
    context: context(),
    values,
    excludeOptionIds: ["source.url", "coordinates.verticalTransform"],
    renderSpecialControl: renderSharedSpecialControl,
    onChange: setOption,
    onValidationChange: options.onValidationChange,
  });
  updateDimensionChoices();

  return {
    getSelectedSource,
    getValidationErrors: () => schemaPanel?.getValidationErrors() ?? [],
    setNumericDimensionMetadata(metadata, decoded): void {
      sourceMetadata = metadata;
      decodedExtraDimensions = decoded ?? [];
      refreshDimensionContext();
      schemaPanel?.update({ values, context: context() });
      updateDimensionChoices();
    },
    destroy(): void {
      mountedControls.forEach((control) => control.destroy());
      schemaPanel?.destroy();
      sourceSelect.removeEventListener("change", onSourceSelectionChange);
      customUrl.removeEventListener("input", onCustomUrlInput);
      fileInput.removeEventListener("change", onLocalFileChange);
      cameraDistanceInput.removeEventListener("change", onCameraDistanceChange);
    },
  };
}

import type {
  CopcBackendName,
  CopcColorMode,
  RangeValidationPolicy,
  RefinementAlgorithm,
} from '@frillab/copc-adapter';
import {
  mountSegmentedControl,
  mountSlider,
} from '../../shared/ui-controls';
import type {
  CameraPreset,
  CesiumPointRendererVariant,
  DevViewerConfig,
  RenderingEngine,
} from './devViewerConfig';

export type DevViewerControlsOptions = {
  readonly initialConfig: DevViewerConfig;
  readonly sourcePresets: ReadonlyMap<string, string>;
  readonly onEngineSelected: (engine: RenderingEngine) => number;
  readonly onCesiumRendererSelected: (renderer: CesiumPointRendererVariant) => void;
  readonly onBackendSelected: (backend: CopcBackendName) => void;
  readonly onCameraPresetSelected: (preset: CameraPreset) => number;
  readonly onColorModeSelected: (mode: CopcColorMode) => void;
  readonly onRefinementAlgorithmSelected: (algorithm: RefinementAlgorithm) => void;
  readonly onRangeValidationSelected: (policy: RangeValidationPolicy) => void;
  readonly onPendingConfigChange: (update: Partial<DevViewerConfig>) => void;
  readonly onCameraDistanceSelected: (distance: number) => void;
  readonly onInvalidCameraDistance: () => void;
  readonly getCameraDistance: () => number;
};

export type DevViewerControls = {
  getSelectedSource(): string | File | undefined;
  destroy(): void;
};

/** Mount the Dev Viewer controls while leaving applied configuration ownership with the caller. */
export function mountDevViewerControls(
  options: DevViewerControlsOptions,
): DevViewerControls {
  const mountedControls: Array<{ destroy(): void }> = [];
  const controls = options.initialConfig;
  const advancedInputs = {
    maxDepth: document.querySelector<HTMLInputElement>('#max-depth')!,
    maxScreenSpaceError: document.querySelector<HTMLInputElement>('#max-sse')!,
    cameraRenderDistance: document.querySelector<HTMLInputElement>('#camera-render-distance')!,
    maxRenderDistance: document.querySelector<HTMLInputElement>('#max-render-distance')!,
  };
  advancedInputs.maxDepth.value = String(controls.maxDepth);
  advancedInputs.maxScreenSpaceError.value = String(controls.maxScreenSpaceError);
  advancedInputs.cameraRenderDistance.value = String(controls.cameraRenderDistance);
  advancedInputs.maxRenderDistance.value = String(controls.maxRenderDistance);

  const sourceSelect = document.querySelector<HTMLSelectElement>('#source-selection')!;
  const customUrl = document.querySelector<HTMLInputElement>('#custom-source-url')!;
  const fileInput = document.querySelector<HTMLInputElement>('#local-source-file')!;
  let openedLocalFile: File | undefined;
  const initialUrl = typeof controls.source === 'string' ? controls.source : '';
  const initialPreset = [...options.sourcePresets]
    .find(([, source]) => source === initialUrl)?.[0];
  sourceSelect.value = initialPreset ?? 'custom';
  customUrl.disabled = sourceSelect.value !== 'custom';
  if (sourceSelect.value === 'custom') customUrl.value = initialUrl;

  const getSelectedSource = (): string | File | undefined => {
    if (sourceSelect.value === 'local-file') return openedLocalFile;
    if (sourceSelect.value === 'custom') return customUrl.value.trim();
    return options.sourcePresets.get(sourceSelect.value);
  };
  const updateSelectedSource = (): void => {
    const source = getSelectedSource();
    if (source !== undefined) options.onPendingConfigChange({ source });
  };

  const rendererControl = mountSegmentedControl<RenderingEngine>(
    document.querySelector<HTMLElement>('#renderer-control')!,
    {
      label: 'Rendering engine',
      value: controls.renderer,
      choices: [
        { value: 'cesium', label: 'Cesium' },
        { value: 'three', label: 'Three.js' },
      ],
      onChange(value) {
        advancedInputs.cameraRenderDistance.value = String(options.onEngineSelected(value));
      },
    },
  );
  mountedControls.push(rendererControl);

  const cesiumRendererControl = mountSegmentedControl<CesiumPointRendererVariant>(
    document.querySelector<HTMLElement>('#cesium-renderer-control')!,
    {
      label: 'Cesium point renderer',
      value: controls.cesiumRenderer,
      choices: [
        { value: 'point-primitive', label: 'PointPrimitive' },
        { value: 'batched-geometry', label: 'Batched Geometry' },
      ],
      onChange: options.onCesiumRendererSelected,
    },
  );
  mountedControls.push(cesiumRendererControl);

  const backendControl = mountSegmentedControl<CopcBackendName>(
    document.querySelector<HTMLElement>('#backend-control')!,
    {
      label: 'Backend',
      value: controls.backend,
      choices: [
        { value: 'copc-js', label: 'JavaScript' },
        { value: 'rust', label: 'Rust / WASM' },
      ],
      onChange: options.onBackendSelected,
    },
  );
  mountedControls.push(backendControl);

  const cameraControl = mountSegmentedControl<CameraPreset>(
    document.querySelector<HTMLElement>('#camera-control')!,
    {
      label: 'Camera presets',
      value: controls.cameraPreset,
      choices: [
        { value: 'overview', label: 'Overview' },
        { value: 'far', label: 'Far' },
        { value: 'near', label: 'Near' },
      ],
      onChange(value) {
        advancedInputs.cameraRenderDistance.value = String(
          options.onCameraPresetSelected(value),
        );
      },
    },
  );
  mountedControls.push(cameraControl);

  const colorControl = mountSegmentedControl<CopcColorMode>(
    document.querySelector<HTMLElement>('#color-control')!,
    {
      label: 'Point color mode',
      value: controls.colorMode,
      choices: [
        { value: 'rgb', label: 'RGB' },
        { value: 'elevation', label: 'Elevation' },
        { value: 'intensity', label: 'Intensity' },
        { value: 'classification', label: 'Class' },
      ],
      onChange: options.onColorModeSelected,
    },
  );
  mountedControls.push(colorControl);

  const refinementControl = mountSegmentedControl<RefinementAlgorithm>(
    document.querySelector<HTMLElement>('#refinement-control')!,
    {
      label: 'Refinement Algorithm',
      value: controls.refinementAlgorithm,
      choices: [
        { value: 'foveated', label: 'Foveated' },
        { value: 'screen-projection', label: 'Screen Projection' },
      ],
      onChange: options.onRefinementAlgorithmSelected,
    },
  );
  mountedControls.push(refinementControl);

  const rangeValidationControl = mountSegmentedControl<RangeValidationPolicy>(
    document.querySelector<HTMLElement>('#range-validation-control')!,
    {
      label: 'HTTP Range Validation',
      value: controls.rangeValidation,
      choices: [
        { value: 'head-fallback', label: 'HEAD Fallback' },
        { value: 'strict', label: 'Strict' },
      ],
      onChange: options.onRangeValidationSelected,
    },
  );
  mountedControls.push(rangeValidationControl);

  const pointSizeSlider = mountSlider(
    document.querySelector<HTMLElement>('#point-size-control')!,
    {
      id: 'dev-point-size',
      label: 'Point size',
      min: 1,
      max: 12,
      step: 0.5,
      value: controls.pointSize,
      formatValue: (value) => value + ' px',
      onCommit: (value) => options.onPendingConfigChange({ pointSize: value }),
    },
  );
  mountedControls.push(pointSizeSlider);

  const nodesSlider = mountSlider(
    document.querySelector<HTMLElement>('#max-nodes-control')!,
    {
      id: 'dev-max-nodes',
      label: 'Max selected nodes',
      min: 4,
      max: 64,
      step: 4,
      value: controls.maxNodes,
      onCommit: (value) => options.onPendingConfigChange({ maxNodes: value }),
    },
  );
  mountedControls.push(nodesSlider);

  const pointsSlider = mountSlider(
    document.querySelector<HTMLElement>('#max-points-control')!,
    {
      id: 'dev-max-points',
      label: 'Max rendered points',
      min: 50_000,
      max: 1_000_000,
      step: 50_000,
      value: Math.min(1_000_000, controls.maxRenderedPoints),
      onCommit: (value) => options.onPendingConfigChange({ maxRenderedPoints: value }),
    },
  );
  mountedControls.push(pointsSlider);

  const onSourceSelectionChange = (): void => {
    customUrl.disabled = sourceSelect.value !== 'custom';
    if (sourceSelect.value !== 'local-file') fileInput.value = '';
    updateSelectedSource();
  };
  const onCustomUrlInput = (): void => {
    if (sourceSelect.value === 'custom') updateSelectedSource();
  };
  const onLocalFileChange = (): void => {
    const file = fileInput.files?.[0];
    if (!file) return;
    openedLocalFile = file;
    let localFileOption = sourceSelect.querySelector<HTMLOptionElement>(
      'option[value="local-file"]',
    );
    if (!localFileOption) {
      localFileOption = document.createElement('option');
      localFileOption.value = 'local-file';
      sourceSelect.append(localFileOption);
    }
    localFileOption.textContent = 'Local file · ' + file.name;
    sourceSelect.value = 'local-file';
    customUrl.disabled = true;
    options.onPendingConfigChange({ source: file });
  };
  sourceSelect.addEventListener('change', onSourceSelectionChange);
  customUrl.addEventListener('input', onCustomUrlInput);
  fileInput.addEventListener('change', onLocalFileChange);

  const onMaxDepthInput = (): void => {
    options.onPendingConfigChange({ maxDepth: Number(advancedInputs.maxDepth.value) });
  };
  const onMaxScreenSpaceErrorInput = (): void => {
    options.onPendingConfigChange({
      maxScreenSpaceError: Number(advancedInputs.maxScreenSpaceError.value),
    });
  };
  const onMaxRenderDistanceInput = (): void => {
    options.onPendingConfigChange({
      maxRenderDistance: Number(advancedInputs.maxRenderDistance.value),
    });
  };
  const onCameraRenderDistanceChange = (): void => {
    const distance = Number(advancedInputs.cameraRenderDistance.value);
    if (!Number.isFinite(distance) || distance <= 0) {
      options.onInvalidCameraDistance();
      advancedInputs.cameraRenderDistance.value = String(options.getCameraDistance());
      return;
    }
    options.onCameraDistanceSelected(distance);
  };
  advancedInputs.maxDepth.addEventListener('input', onMaxDepthInput);
  advancedInputs.maxScreenSpaceError.addEventListener('input', onMaxScreenSpaceErrorInput);
  advancedInputs.maxRenderDistance.addEventListener('input', onMaxRenderDistanceInput);
  advancedInputs.cameraRenderDistance.addEventListener('change', onCameraRenderDistanceChange);

  return {
    getSelectedSource,
    destroy(): void {
      mountedControls.forEach((control) => control.destroy());
      sourceSelect.removeEventListener('change', onSourceSelectionChange);
      customUrl.removeEventListener('input', onCustomUrlInput);
      fileInput.removeEventListener('change', onLocalFileChange);
      advancedInputs.maxDepth.removeEventListener('input', onMaxDepthInput);
      advancedInputs.maxScreenSpaceError.removeEventListener('input', onMaxScreenSpaceErrorInput);
      advancedInputs.maxRenderDistance.removeEventListener('input', onMaxRenderDistanceInput);
      advancedInputs.cameraRenderDistance.removeEventListener('change', onCameraRenderDistanceChange);
    },
  };
}

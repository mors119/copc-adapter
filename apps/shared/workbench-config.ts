import type { UiSegmentOption } from "./ui-controls";

// Keep shared source dependency-free; each app checks this shape against its
// own package input (packed consumer in Playground, workspace source in Dev).
export type WorkbenchBackend = "copc-js" | "rust";
export type WorkbenchColorMode =
  | "fixed"
  | "rgb"
  | "elevation"
  | "intensity"
  | "classification";
export type WorkbenchRefinementAlgorithm =
  | "foveated"
  | "screen-projection";
export type WorkbenchRangeValidationPolicy = "head-fallback" | "strict";
export type WorkbenchRenderer = "cesium" | "three";
export type WorkbenchCameraPreset = "overview" | "far" | "near";

export const workbenchRendererOptions: readonly UiSegmentOption<WorkbenchRenderer>[] = [
  { value: "cesium", label: "Cesium" },
  { value: "three", label: "Three.js" },
];

export const workbenchBackendOptions: readonly UiSegmentOption<WorkbenchBackend>[] = [
  { value: "copc-js", label: "JavaScript" },
  { value: "rust", label: "Rust / WASM" },
];

/** Layer settings that the public Playground and Dev Viewer both support. */
export type WorkbenchLayerConfig = {
  readonly backend: WorkbenchBackend;
  readonly colorMode: WorkbenchColorMode;
  readonly pointSize: number;
  readonly maxRenderedPoints: number;
  /** Optional decoded point-buffer budget; omitted values use the package default. */
  readonly maxPointCacheBytes?: number;
  readonly maxNodes: number;
  readonly maxDepth?: number;
  readonly maxScreenSpaceError?: number;
  readonly maxRenderDistanceMeters?: number;
  readonly refinementAlgorithm: WorkbenchRefinementAlgorithm;
  readonly motionLookahead?: boolean;
  readonly rangeValidation?: WorkbenchRangeValidationPolicy;
};

/**
 * Public layer constructor options derived from shared workbench settings.
 * Renderer setup, diagnostics, and developer-only settings stay app-owned.
 */
export type WorkbenchLayerOptions = {
  readonly backend: WorkbenchBackend;
  readonly colorMode: WorkbenchColorMode;
  readonly pointSize: number;
  readonly maxRenderedPoints: number;
  readonly maxPointCacheBytes?: number;
  readonly rangeValidation?: WorkbenchRangeValidationPolicy;
  readonly streaming: {
    readonly maxNodes: number;
    readonly maxDepth?: number;
    readonly maxScreenSpaceError?: number;
    readonly maxRenderDistanceMeters?: number;
    readonly refinementAlgorithm: WorkbenchRefinementAlgorithm;
    readonly motionLookahead?: boolean;
  };
};

/** Convert shared controls into the public adapter's layer option shape. */
export function toWorkbenchLayerOptions(
  config: WorkbenchLayerConfig,
): WorkbenchLayerOptions {
  const {
    backend,
    colorMode,
    pointSize,
    maxRenderedPoints,
    maxPointCacheBytes,
    maxNodes,
    maxDepth,
    maxScreenSpaceError,
    maxRenderDistanceMeters,
    refinementAlgorithm,
    motionLookahead,
    rangeValidation,
  } = config;

  return {
    backend,
    colorMode,
    pointSize,
    maxRenderedPoints,
    ...(maxPointCacheBytes === undefined ? {} : { maxPointCacheBytes }),
    ...(rangeValidation === undefined ? {} : { rangeValidation }),
    streaming: {
      maxNodes,
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(maxScreenSpaceError === undefined ? {} : { maxScreenSpaceError }),
      ...(maxRenderDistanceMeters === undefined
        ? {}
        : { maxRenderDistanceMeters }),
      refinementAlgorithm,
      ...(motionLookahead === undefined ? {} : { motionLookahead }),
    },
  };
}

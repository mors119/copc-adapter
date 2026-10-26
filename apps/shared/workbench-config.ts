import type { SchemaChoiceValues } from "./schema/typeContracts.ts";

// Each app checks this host config against its own package input (published
// package in Playground, workspace source in Dev Viewer).
export type WorkbenchBackend = SchemaChoiceValues<"adapter.backend">;
export type WorkbenchColorMode = SchemaChoiceValues<"rendering.colorMode">;
export type WorkbenchRefinementAlgorithm = SchemaChoiceValues<
  "streaming.refinementAlgorithm"
>;
export type WorkbenchRangeValidationPolicy = SchemaChoiceValues<
  "source.rangeValidation"
>;
export type WorkbenchRenderer = SchemaChoiceValues<"renderer.engine">;
export type WorkbenchCameraPreset = "overview" | "far" | "near";

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

import type {
  RangeValidationPolicy,
  RefinementAlgorithm,
} from "@frillab/copc-adapter";

import type {
  WorkbenchCameraPreset,
  WorkbenchLayerConfig,
  WorkbenchRenderer,
} from "../../shared/workbench-config";
import {
  buildSchemaApplicationPlan,
  getChangedWorkbenchOptionIds,
  normalizeWorkbenchOptionValues,
} from "../../shared/config/index.ts";
import {
  WORKSPACE_CURRENT_CAPABILITIES,
  WORKSPACE_CURRENT_MANIFEST,
} from "../../shared/schema/index.ts";

export type RenderingEngine = WorkbenchRenderer;
export type CesiumPointRendererVariant = "point-primitive" | "batched-geometry";
export type CameraPreset = WorkbenchCameraPreset;

/** Complete Dev Viewer configuration, including developer-only settings. */
export type DevViewerConfig = Omit<
  WorkbenchLayerConfig,
  | "maxDepth"
  | "maxScreenSpaceError"
  | "maxRenderDistanceMeters"
  | "motionLookahead"
  | "rangeValidation"
> & {
  renderer: RenderingEngine;
  cesiumRenderer: CesiumPointRendererVariant;
  refinementAlgorithm: RefinementAlgorithm;
  motionLookahead: boolean;
  rangeValidation: RangeValidationPolicy;
  source: string | File;
  /** Additive metre correction applied to Cesium display heights. */
  heightOffsetMeters: number;
  /** Optional public or local Cesium quantized-mesh Terrain service root URL. */
  terrainUrl: string;
  maxDepth: number;
  maxScreenSpaceError: number;
  cameraPreset: CameraPreset;
  cameraRenderDistance: number;
  maxRenderDistance: number;
};

export function isRefinementAlgorithm(
  value: unknown,
): value is RefinementAlgorithm {
  return value === "foveated" || value === "screen-projection";
}

export function isRangeValidationPolicy(
  value: unknown,
): value is RangeValidationPolicy {
  return value === "head-fallback" || value === "strict";
}

export function sourceSupportsHttpRange(
  source: string | File,
  baseUrl: string,
): boolean {
  if (typeof source !== "string") return false;
  try {
    const protocol = new URL(source, baseUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Validate values at URL or DOM boundaries before they reach a layer constructor. */
export function validateDevViewerConfig(
  config: DevViewerConfig,
): string | undefined {
  if (config.renderer !== "cesium" && config.renderer !== "three") {
    return "Choose Cesium or Three.js as the rendering engine.";
  }
  if (
    config.cesiumRenderer !== "point-primitive" &&
    config.cesiumRenderer !== "batched-geometry"
  ) {
    return "Choose PointPrimitive or Batched Geometry for the Cesium point renderer.";
  }
  if (!isRefinementAlgorithm(config.refinementAlgorithm)) {
    return "Choose Foveated or Screen Projection as the refinement algorithm.";
  }
  if (typeof config.motionLookahead !== "boolean") {
    return "Choose whether Motion Lookahead is enabled.";
  }
  if (!isRangeValidationPolicy(config.rangeValidation)) {
    return "Choose HEAD Fallback or Strict for HTTP Range validation.";
  }
  if (!Number.isFinite(config.heightOffsetMeters)) {
    return "Height offset must be a finite number of metres.";
  }
  if (config.terrainUrl.trim()) {
    try {
      const terrainUrl = new URL(config.terrainUrl, globalThis.location?.href ?? "http://localhost/");
      if (
        (terrainUrl.protocol !== "http:" && terrainUrl.protocol !== "https:") ||
        terrainUrl.username ||
        terrainUrl.password ||
        terrainUrl.search ||
        terrainUrl.hash
      ) {
        return "Terrain URL must be an HTTP or HTTPS service root without credentials, query parameters, or a fragment.";
      }
    } catch {
      return "Enter a valid HTTP or HTTPS Cesium Terrain service root URL.";
    }
  }
  if (config.backend !== "copc-js" && config.backend !== "rust") {
    return "Choose JavaScript or Rust / WASM as the decoding backend.";
  }
  if (
    !Number.isFinite(config.pointSize) ||
    config.pointSize < 1 ||
    config.pointSize > 12
  ) {
    return "Point size must be between 1 and 12 pixels.";
  }
  if (
    !Number.isSafeInteger(config.maxNodes) ||
    config.maxNodes < 4 ||
    config.maxNodes > 64
  ) {
    return "Max selected nodes must be a whole number from 4 to 64.";
  }
  if (
    !Number.isSafeInteger(config.maxRenderedPoints) ||
    config.maxRenderedPoints < 50_000 ||
    config.maxRenderedPoints > 1_000_000
  ) {
    return "Max rendered points must be a whole number from 50,000 to 1,000,000.";
  }
  if (
    !Number.isSafeInteger(config.maxDepth) ||
    config.maxDepth < 1 ||
    config.maxDepth > 24
  ) {
    return "Max depth must be a whole number from 1 to 24.";
  }
  if (
    !Number.isFinite(config.maxScreenSpaceError) ||
    config.maxScreenSpaceError < 1 ||
    config.maxScreenSpaceError > 128
  ) {
    return "Screen-space error must be between 1 and 128 pixels.";
  }
  if (
    !Number.isFinite(config.cameraRenderDistance) ||
    config.cameraRenderDistance <= 0
  ) {
    return "Camera distance must be a positive number of metres.";
  }
  if (
    !Number.isFinite(config.maxRenderDistance) ||
    config.maxRenderDistance <= 0
  ) {
    return "Max render distance must be a positive number of metres.";
  }
  return undefined;
}

/** Normalize a Terrain service root for Cesium fromUrl, which appends layer.json itself. */
export function getCesiumTerrainProviderUrl(
  source: string,
  baseUrl: string,
): string {
  const url = new URL(source, baseUrl);
  url.pathname = url.pathname.replace(/\/layer\.json\/?$/i, "") || "/";
  return url.toString();
}

export function hasUnappliedSettings(
  applied: DevViewerConfig,
  pending: DevViewerConfig,
): boolean {
  return (
    getChangedWorkbenchOptionIds(
      toWorkbenchOptionValues(applied),
      toWorkbenchOptionValues(pending),
    ).length > 0 ||
    applied.terrainUrl !== pending.terrainUrl ||
    applied.cameraPreset !== pending.cameraPreset ||
    applied.cameraRenderDistance !== pending.cameraRenderDistance
  );
}

export function needsSessionRecreation(
  applied: DevViewerConfig,
  next: DevViewerConfig,
  hasActiveSession: boolean,
  currentSourceUsesHttp: boolean,
): boolean {
  if (!hasActiveSession) return true;
  const appliedValues = toWorkbenchOptionValues(applied);
  const nextValues = toWorkbenchOptionValues(next);
  if (!currentSourceUsesHttp) {
    delete appliedValues["source.rangeValidation"];
    delete nextValues["source.rangeValidation"];
  }
  if (next.renderer !== "cesium") {
    delete appliedValues["coordinates.heightOffsetMeters"];
    delete nextValues["coordinates.heightOffsetMeters"];
  }
  try {
    const plan = buildSchemaApplicationPlan(
      nextValues,
      {
        manifest: WORKSPACE_CURRENT_MANIFEST,
        renderer: applied.renderer,
        runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
      },
      appliedValues,
    );
    return plan.requiresLayerReplacement ||
      (next.renderer === "cesium" && applied.terrainUrl !== next.terrainUrl);
  } catch {
    // Unsupported or invalid pending state must be applied through a new checked plan.
    return true;
  }
}

/** Map the existing host config to stable schema IDs during Phase 2 migration. */
export function toWorkbenchOptionValues(
  config: DevViewerConfig,
): Record<string, unknown> {
  const values = normalizeWorkbenchOptionValues(
    config as unknown as Readonly<Record<string, unknown>>,
  );
  if (config.renderer !== "cesium") {
    delete values["rendering.cesiumPointRenderer"];
    delete values["coordinates.heightOffsetMeters"];
  }
  values["streaming.maxRenderDistanceMeters"] = config.maxRenderDistance;
  return values;
}

/** Display a configured Terrain URL without credentials or query data. */
export function getSafeTerrainSourceLabel(
  source: string,
  baseUrl: string,
): string {
  if (!source.trim()) return "Ellipsoid only";
  try {
    const url = new URL(source, baseUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "Invalid Terrain URL";
  }
}

/** Return a safe source label for the UI; credentials and URL query values are omitted. */
export function getSafeSourceLabel(
  source: string | File,
  baseUrl: string,
): string {
  if (typeof source !== "string") return source.name || "Local File";
  try {
    const url = new URL(source, baseUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "Invalid HTTP URL";
  }
}

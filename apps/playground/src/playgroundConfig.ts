import type { CopcClassificationFilter } from "@frillab/copc-adapter/cesium";
import type {
  WorkbenchLayerConfig,
  WorkbenchRenderer,
} from "../../shared/workbench-config";

const MIB = 1024 * 1024;

export type PlaygroundConfig = Omit<
  WorkbenchLayerConfig,
  | "maxPointCacheBytes"
  | "maxDepth"
  | "maxScreenSpaceError"
  | "maxRenderDistanceMeters"
> & {
  readonly renderer: WorkbenchRenderer;
  readonly maxPointCacheBytes: number;
  readonly maxDepth: number;
  readonly maxScreenSpaceError: number;
  readonly maxRenderDistanceMeters: number;
  /** Cesium-only runtime style. Undefined means that no filter is active. */
  readonly classificationFilter?: CopcClassificationFilter;
};

export const PLAYGROUND_DEFAULTS = {
  backend: "copc-js",
  colorMode: "elevation",
  pointSize: 3,
  maxRenderedPoints: 250_000,
  maxPointCacheBytes: 256 * MIB,
  maxNodes: 24,
  maxDepth: 6,
  maxScreenSpaceError: 8,
  maxRenderDistanceMeters: 12_000,
  refinementAlgorithm: "foveated",
} as const;

/** Convert a displayed cache budget in MiB to the exact public API byte value. */
export function cacheMibToBytes(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Cache budget must be a non-negative finite MiB value.");
  }
  const bytes = value * MIB;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("Cache budget must resolve to a safe integer byte count.");
  }
  return bytes;
}

/** Convert a public cache budget in bytes to MiB for the settings field. */
export function cacheBytesToMib(value: number): number {
  return value / MIB;
}

/** Parse a comma or whitespace separated list of LAS classification codes. */
export function parseClassificationCodes(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/[\s,]+/u);
  const codes = parts.map((part) => {
    if (!/^\d+$/u.test(part)) {
      throw new RangeError("Classification codes must be integers from 0 to 255.");
    }
    const code = Number(part);
    if (!Number.isInteger(code) || code < 0 || code > 255) {
      throw new RangeError("Classification codes must be integers from 0 to 255.");
    }
    return code;
  });
  return [...new Set(codes)].sort((left, right) => left - right);
}

/** Normalize list order and duplicates without changing filter meaning. */
export function normalizeClassificationFilter(
  filter: CopcClassificationFilter | undefined,
): CopcClassificationFilter | undefined {
  if (filter === undefined) return undefined;
  const normalized: { include?: number[]; exclude?: number[] } = {};
  if (filter.include !== undefined) {
    normalized.include = parseClassificationCodes(filter.include.join(","));
  }
  if (filter.exclude !== undefined) {
    normalized.exclude = parseClassificationCodes(filter.exclude.join(","));
  }
  return normalized;
}

/** Validate values against the supported package contract before construction. */
export function validatePlaygroundConfig(config: PlaygroundConfig): string[] {
  const errors: string[] = [];
  const positiveSafeInteger = (value: number, label: string): void => {
    if (!Number.isSafeInteger(value) || value < 1) {
      errors.push(`${label} must be a positive safe integer.`);
    }
  };
  positiveSafeInteger(config.maxRenderedPoints, "Max rendered points");
  positiveSafeInteger(config.maxNodes, "Max nodes");
  if (!Number.isFinite(config.pointSize) || config.pointSize <= 0) {
    errors.push("Point size must be a positive finite number.");
  }
  if (
    !Number.isSafeInteger(config.maxPointCacheBytes) ||
    config.maxPointCacheBytes < 0
  ) {
    errors.push("Cache budget must be a non-negative safe integer byte count.");
  }
  if (!Number.isSafeInteger(config.maxDepth) || config.maxDepth < 0) {
    errors.push("Max depth must be a non-negative safe integer.");
  }
  if (
    !Number.isFinite(config.maxScreenSpaceError) ||
    config.maxScreenSpaceError <= 0
  ) {
    errors.push("Screen-space error must be a positive finite number.");
  }
  if (
    !Number.isFinite(config.maxRenderDistanceMeters) ||
    config.maxRenderDistanceMeters <= 0
  ) {
    errors.push("Render distance must be a positive finite number of metres.");
  }
  if (config.renderer === "three" && config.classificationFilter !== undefined) {
    errors.push(
      "Clear the Cesium classification filter before applying the Three.js renderer; Three.js has no public runtime style setter.",
    );
  }
  try {
    normalizeClassificationFilter(config.classificationFilter);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

/** Compare only settings that require a new layer instance. */
export function hasConstructorChanges(
  pending: PlaygroundConfig,
  active: PlaygroundConfig,
): boolean {
  return (
    pending.renderer !== active.renderer ||
    pending.backend !== active.backend ||
    pending.pointSize !== active.pointSize ||
    pending.maxRenderedPoints !== active.maxRenderedPoints ||
    pending.maxPointCacheBytes !== active.maxPointCacheBytes ||
    pending.maxNodes !== active.maxNodes ||
    pending.maxDepth !== active.maxDepth ||
    pending.maxScreenSpaceError !== active.maxScreenSpaceError ||
    pending.maxRenderDistanceMeters !== active.maxRenderDistanceMeters ||
    pending.refinementAlgorithm !== active.refinementAlgorithm ||
    (pending.renderer === "three" && pending.colorMode !== active.colorMode)
  );
}

/** Return a detached configuration snapshot for the canonical pending/active state. */
export function clonePlaygroundConfig<T extends PlaygroundConfig>(
  config: T,
): T {
  const classificationFilter = normalizeClassificationFilter(
    config.classificationFilter,
  );
  return {
    ...config,
    ...(classificationFilter === undefined ? {} : { classificationFilter }),
  } as T;
}

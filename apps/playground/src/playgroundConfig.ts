import type { CopcClassificationFilter } from "@frillab/copc-adapter/cesium";
import type {
  WorkbenchLayerConfig,
  WorkbenchRenderer,
} from "../../shared/workbench-config";
import {
  buildSchemaApplicationPlan,
  normalizeWorkbenchOptionValues,
  validateWorkbenchConfiguration,
  type SchemaApplicationPlan,
  type WorkbenchOptionValues,
} from "../../shared/config/index.ts";
import {
  PLAYGROUND_0_7_1_RUNTIME_CAPABILITIES,
  NPM_0_7_1_MANIFEST,
} from "../../shared/schema/index.ts";
import type { SchemaHostValidators } from "../../shared/schema/types.ts";

const MIB = 1024 * 1024;

export type PlaygroundConfig = Omit<
  WorkbenchLayerConfig,
  | "colorMode"
  | "maxPointCacheBytes"
  | "maxDepth"
  | "maxScreenSpaceError"
  | "maxRenderDistanceMeters"
> & {
  /** Schema-defined options without a legacy flat setting in this host. */
  readonly schemaOptionValues?: Readonly<Record<string, unknown>>;
  readonly renderer: WorkbenchRenderer;
  /** The installed npm 0.6.0 package does not expose numeric dimensions. */
  readonly colorMode: Exclude<WorkbenchLayerConfig["colorMode"], "dimension">;
  readonly maxPointCacheBytes: number;
  readonly maxDepth: number;
  readonly maxScreenSpaceError: number;
  readonly maxRenderDistanceMeters: number;
  /** Optional consumer-owned Cesium quantized-mesh provider root URL. */
  readonly terrainUrl: string;
  /** Canonical manual or explicitly approved visual layer offset. */
  readonly heightOffsetMeters: number;
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
  terrainUrl: "",
  heightOffsetMeters: 0,
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
export function validatePlaygroundConfig(
  config: PlaygroundConfig,
  hostValidators: SchemaHostValidators = {},
): string[] {
  const values = normalizeWorkbenchOptionValues(
    {
      ...(config as unknown as Readonly<Record<string, unknown>>),
      ...(config.schemaOptionValues ?? {}),
    },
  );
  const validation = validateWorkbenchConfiguration(values, {
    manifest: NPM_0_7_1_MANIFEST,
    renderer: config.renderer,
    runtimeCapabilities: PLAYGROUND_0_7_1_RUNTIME_CAPABILITIES,
  }, undefined, hostValidators);
  const errors = [...validation.errors];
  if (config.terrainUrl.trim()) {
    try {
      const terrainUrl = new URL(config.terrainUrl, globalThis.location?.href ?? "http://localhost/");
      if (
        (terrainUrl.protocol !== "http:" && terrainUrl.protocol !== "https:") ||
        terrainUrl.username || terrainUrl.password || terrainUrl.search || terrainUrl.hash
      ) {
        throw new Error("unsupported or sensitive URL");
      }
    } catch {
      errors.push("Terrain provider URL must be HTTP(S) without credentials, a query string, or a fragment.");
    }
  }
  if (config.renderer === "three" && config.classificationFilter !== undefined) {
    errors.push(
      "Clear the Cesium classification filter before applying the Three.js renderer; Three.js has no public runtime style setter.",
    );
  }
  return errors;
}

/** Build a Playground plan while preserving host-owned resource validation. */
export function buildPlaygroundApplicationPlan(
  values: WorkbenchOptionValues,
  renderer: WorkbenchRenderer,
  previousValues?: WorkbenchOptionValues,
  hostValidators: SchemaHostValidators = {},
): SchemaApplicationPlan {
  return buildSchemaApplicationPlan(
    values,
    {
      manifest: NPM_0_7_1_MANIFEST,
      renderer,
      runtimeCapabilities: PLAYGROUND_0_7_1_RUNTIME_CAPABILITIES,
    },
    previousValues,
    undefined,
    hostValidators,
  );
}

/** Compare only settings that require a new layer instance. */
export function hasConstructorChanges(
  pending: PlaygroundConfig,
  active: PlaygroundConfig,
  hostValidators: SchemaHostValidators = {},
): boolean {
  if (pending.renderer === "cesium" && pending.terrainUrl !== active.terrainUrl) return true;
  try {
    const pendingValues = normalizeWorkbenchOptionValues(
      {
        ...(pending as unknown as Readonly<Record<string, unknown>>),
        ...(pending.schemaOptionValues ?? {}),
      },
    );
    const activeValues = normalizeWorkbenchOptionValues(
      {
        ...(active as unknown as Readonly<Record<string, unknown>>),
        ...(active.schemaOptionValues ?? {}),
      },
    );
    return buildPlaygroundApplicationPlan(
      pendingValues,
      active.renderer,
      activeValues,
      hostValidators,
    ).requiresLayerReplacement;
  } catch {
    // Invalid or newly unsupported state cannot be considered a live-only edit.
    return true;
  }
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
    ...(config.schemaOptionValues === undefined
      ? {}
      : { schemaOptionValues: { ...config.schemaOptionValues } }),
    ...(classificationFilter === undefined ? {} : { classificationFilter }),
  } as T;
}

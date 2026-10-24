import { OPTION_SCHEMA } from "./options.ts";
import type {
  AdapterManifest,
  PackageOrigin,
  SchemaDefault,
  SchemaOption,
  SchemaProfileKey,
} from "./types.ts";

const npm06SupportedOptionIds = [
  "source.url",
  "renderer.engine",
  "adapter.backend",
  "attributes.extraDimensions",
  "rendering.colorMode",
  "rendering.pointSize",
  "rendering.cesiumPointRenderer",
  "rendering.pointSizeMode",
  "rendering.minPointSize",
  "rendering.maxPointSize",
  "style.classificationFilter",
  "coordinates.heightOffsetMeters",
  "coordinates.verticalTransform",
  "performance.maxRenderedPoints",
  "cache.maxPointCacheBytes",
  "streaming.maxNodes",
  "streaming.maxDepth",
  "streaming.maxScreenSpaceError",
  "streaming.screenSpaceErrorHysteresis",
  "streaming.maxRenderDistanceMeters",
  "streaming.maxConcurrentNodeLoads",
  "streaming.refinementAlgorithm",
  "streaming.motionLookahead",
  "streaming.predictivePrefetch",
  "streaming.refinementFocus",
  "source.rangeValidation",
  "source.maxRangeBytes",
  "source.maxConcurrentRangeRequests",
  "interaction.pickingThreshold",
] as const;

const adapterCapabilities = [
  "renderer.cesium",
  "renderer.three",
  "source.probe",
  "source.load",
  "backend.copc-js",
  "backend.copc-js.extra-dimensions",
  "backend.rust",
  "source.file-blob",
  "source.range-policy",
  "cache.point-buffer",
  "cesium.batched-renderer",
  "cesium.shader-point-size",
  "cesium.runtime-style",
  "cesium.refinement-focus",
  "cesium.terrain-alignment",
  "vertical.gtx-grid",
  "streaming.predictive-prefetch",
  "three.point-picking",
] as const;

function getDefaults(
  origin: PackageOrigin,
  version: string,
  supportedOptionIds: readonly string[],
): Readonly<Record<string, SchemaDefault>> {
  const profileKey: SchemaProfileKey = origin + "@" + version;
  const supported = new Set(supportedOptionIds);
  const options: readonly SchemaOption[] = OPTION_SCHEMA;
  return Object.fromEntries(
    options.flatMap((option) => {
      if (!supported.has(option.id)) return [];
      const value = option.defaults[profileKey];
      return value === undefined ? [] : [[option.id, value]];
    }),
  );
}

function createManifest(
  origin: PackageOrigin,
  version: string,
  supportedOptionIds: readonly string[],
): AdapterManifest {
  return {
    origin,
    version,
    supportedOptionIds,
    capabilities: adapterCapabilities,
    defaults: getDefaults(origin, version, supportedOptionIds),
  };
}

/** Exact compatibility manifest for the installed published Playground release. */
export const NPM_0_6_MANIFEST = createManifest(
  "npm",
  "0.6.0",
  npm06SupportedOptionIds,
);

/**
 * The workspace profile follows the current audited source schema. New schema
 * definitions therefore become available to Dev Viewer without maintaining a
 * second option list; its host still supplies the actual package version.
 */
export const WORKSPACE_CURRENT_MANIFEST = createManifest(
  "workspace",
  "0.6.0",
  OPTION_SCHEMA.map(({ id }) => id),
);

const npmManifests = new Map([[NPM_0_6_MANIFEST.version, NPM_0_6_MANIFEST]]);
const workspaceManifests = new Map([
  [WORKSPACE_CURRENT_MANIFEST.version, WORKSPACE_CURRENT_MANIFEST],
]);

/** Resolve only explicitly audited package origins and versions. */
export function getAdapterManifest(
  origin: PackageOrigin,
  version: string,
): AdapterManifest | undefined {
  return (origin === "npm" ? npmManifests : workspaceManifests).get(version);
}

export const NPM_0_6_SUPPORTED_OPTION_IDS = npm06SupportedOptionIds;
export const ADAPTER_0_6_CAPABILITIES = adapterCapabilities;

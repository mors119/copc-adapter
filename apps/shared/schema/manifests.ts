import { OPTION_SCHEMA } from "./options.ts";
import type {
  AdapterManifest,
  PackageOrigin,
  SchemaDefault,
  SchemaOption,
  SchemaProfileKey,
  SchemaRenderer,
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

const npm06Capabilities = [
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
  "streaming.predictive-prefetch",
  "three.point-picking",
] as const;

const npm071SupportedOptionIds = [
  ...npm06SupportedOptionIds,
  "streaming.maxConcurrentNodeLoads",
  "attributes.attributeLoading",
  "attributes.pointFields",
  "cache.coordinateCacheLayout",
  "cache.retainSourceCoordinatesForQueries",
] as const;

const npm071Capabilities = [
  ...npm06Capabilities,
  "cesium.attribute-loading",
  "cesium.point-fields",
  "cache.coordinate-layout",
  "cache.source-coordinate-retention",
] as const;

const workspaceCapabilities = [
  ...npm06Capabilities,
  "cesium.attribute-loading",
  "cesium.point-fields",
  "cache.coordinate-layout",
  "cache.source-coordinate-retention",
  "style.numeric-dimension",
  "style.numeric-dimension-filter",
  "cesium.terrain-alignment",
  "vertical.gtx-grid",
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

function createManifest<
  const Origin extends PackageOrigin,
  const Version extends string,
  const OptionIds extends readonly string[],
  const Capabilities extends readonly string[],
  const RendererExclusions extends Partial<
    Record<SchemaRenderer, readonly string[]>
  >,
>(
  origin: Origin,
  version: Version,
  supportedOptionIds: OptionIds,
  capabilities: Capabilities,
  unsupportedOptionIdsByRenderer: RendererExclusions,
) {
  return {
    origin,
    version,
    supportedOptionIds,
    unsupportedOptionIdsByRenderer,
    capabilities,
    defaults: getDefaults(origin, version, supportedOptionIds),
  } satisfies AdapterManifest;
}

/** Exact compatibility manifest for the installed published Playground release. */
export const NPM_0_6_MANIFEST = createManifest(
  "npm",
  "0.6.0",
  npm06SupportedOptionIds,
  npm06Capabilities,
  { cesium: ["streaming.maxConcurrentNodeLoads"] },
);

/** Exact compatibility manifest for the published Playground package with cache policy APIs. */
export const NPM_0_7_1_MANIFEST = createManifest(
  "npm",
  "0.7.1",
  npm071SupportedOptionIds,
  npm071Capabilities,
  {},
);

/**
 * The workspace profile follows the current audited source schema. New schema
 * definitions therefore become available to Dev Viewer without maintaining a
 * second option list; its host still supplies the actual package version.
 */
export const WORKSPACE_CURRENT_MANIFEST = createManifest(
  "workspace",
  "0.7.1",
  OPTION_SCHEMA.map(({ id }) => id),
  workspaceCapabilities,
  {},
);

const npmManifests = new Map<string, AdapterManifest>([
  [NPM_0_6_MANIFEST.version, NPM_0_6_MANIFEST],
  [NPM_0_7_1_MANIFEST.version, NPM_0_7_1_MANIFEST],
]);
const workspaceManifests = new Map<string, AdapterManifest>([
  [WORKSPACE_CURRENT_MANIFEST.version, WORKSPACE_CURRENT_MANIFEST],
]);
const candidateManifests = new Map<string, AdapterManifest>();

/** Resolve only explicitly audited package origins and versions. */
export function getAdapterManifest(
  origin: PackageOrigin,
  version: string,
): AdapterManifest | undefined {
  const manifests =
    origin === "npm"
      ? npmManifests
      : origin === "workspace"
        ? workspaceManifests
        : candidateManifests;
  return manifests.get(version);
}

export const NPM_0_6_SUPPORTED_OPTION_IDS = npm06SupportedOptionIds;
export const NPM_0_6_CAPABILITIES = npm06Capabilities;
export const NPM_0_7_1_SUPPORTED_OPTION_IDS = npm071SupportedOptionIds;
export const NPM_0_7_1_CAPABILITIES = npm071Capabilities;
export const WORKSPACE_CURRENT_CAPABILITIES = workspaceCapabilities;

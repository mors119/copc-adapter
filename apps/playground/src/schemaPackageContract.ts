import type {
  Assert,
  AssertNoIncompatibleSchemaDefaults,
  AssertNoMissingPublicPaths,
  SchemaConstructorPaths,
} from "../../shared/schema/typeContracts.ts";
import type {
  SchemaClassificationFilter,
  SchemaFocusLens,
} from "../../shared/schema/types.ts";

type OptionUnion = (typeof import("../../shared/schema/options.ts").OPTION_SCHEMA)[number];
type NpmManifest = typeof import("../../shared/schema/manifests.ts").NPM_0_6_MANIFEST;
type CesiumApi = typeof import("@frillab/copc-adapter/cesium");
type ThreeApi = typeof import("@frillab/copc-adapter/three");
type CesiumOptions = import("@frillab/copc-adapter/cesium").CopcCesiumLayerOptions;
type ThreeOptions = import("@frillab/copc-adapter/three").CopcThreeLayerOptions;
type CesiumLayer = InstanceType<CesiumApi["CopcCesiumLayer"]>;
type ThreeLayer = InstanceType<ThreeApi["CopcThreeLayer"]>;

type NpmCesiumPaths = SchemaConstructorPaths<OptionUnion, "cesium", NpmManifest>;
type NpmThreePaths = SchemaConstructorPaths<OptionUnion, "three", NpmManifest>;
type Head<Path extends string> = Path extends `${infer Key}.${string}` ? Key : Path;
type NpmCesiumRoots = Head<NpmCesiumPaths>;
type NpmThreeRoots = Head<NpmThreePaths>;
type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertEqual<Left, Right> = Equal<Left, Right>;
type StreamingKeys<Options> = Options extends { readonly streaming?: infer Stream }
  ? keyof NonNullable<Stream>
  : never;
type SchemaStreamingKeys<Paths extends string> = Paths extends `streaming.${infer Key}`
  ? Key
  : never;
type StreamingCompatibilityExclusions =
  // Deprecated selector input, lower-level batching, and a duplicate
  // compatibility budget represented only by the canonical top-level option.
  | "refineDistanceMultiplier"
  | "maxRenderedPoints"
  | "maxPointsPerBatch";
// These stay public for host integration or compatibility but are not ordinary
// Workbench controls (logging, custom decoder injection, and callbacks).
type LayerCompatibilityExclusions = "debug" | "decoder" | "onPointPicked";

// Every declared user-facing npm 0.6.0 constructor path exists in its actual
// published package types, and every public option is represented or is an
// intentionally excluded callback/debug/compatibility alias.
export type NpmCesiumPathsExist = AssertNoMissingPublicPaths<CesiumOptions, NpmCesiumPaths>;
export type NpmThreePathsExist = AssertNoMissingPublicPaths<ThreeOptions, NpmThreePaths>;
export type NpmCesiumDefaultsMatchApiTypes = Assert<
  AssertNoIncompatibleSchemaDefaults<
    OptionUnion,
    "cesium",
    NpmManifest,
    CesiumOptions,
    "npm@0.6.0"
  >
>;
export type NpmThreeDefaultsMatchApiTypes = Assert<
  AssertNoIncompatibleSchemaDefaults<
    OptionUnion,
    "three",
    NpmManifest,
    ThreeOptions,
    "npm@0.6.0"
  >
>;
export type NpmCesiumLayerOptionCoverage = Assert<AssertEqual<
  Exclude<keyof CesiumOptions, LayerCompatibilityExclusions | "streaming">,
  Exclude<NpmCesiumRoots, "streaming">
>>;
export type NpmThreeLayerOptionCoverage = Assert<AssertEqual<
  Exclude<keyof ThreeOptions, LayerCompatibilityExclusions | "renderer" | "streaming">,
  Exclude<NpmThreeRoots, "streaming">
>>;
export type NpmCesiumStreamingCoverage = Assert<AssertEqual<
  Exclude<StreamingKeys<CesiumOptions>, StreamingCompatibilityExclusions>,
  SchemaStreamingKeys<NpmCesiumPaths>
>>;
export type NpmThreeStreamingCoverage = Assert<AssertEqual<
  Exclude<StreamingKeys<ThreeOptions>, StreamingCompatibilityExclusions>,
  SchemaStreamingKeys<NpmThreePaths>
>>;

type HasMethod<Type, Key extends PropertyKey> = Key extends keyof Type
  ? Type[Key] extends (...args: any[]) => unknown
    ? true
    : false
  : false;
type HasKey<Type, Key extends PropertyKey> = Key extends keyof Type ? true : false;
type OptionChoices<Id extends string> = Extract<OptionUnion, { readonly id: Id }> extends {
  readonly choices: readonly (infer Choice)[];
}
  ? Choice extends { readonly value: infer Value }
    ? Value
    : never
  : never;

export type NpmStyleSetterContract = Assert<HasMethod<CesiumLayer, "setStyle">>;
export type NpmFocusSetterContract = Assert<HasMethod<CesiumLayer, "setRefinementFocus">>;
type NpmFocusArgument = NonNullable<Parameters<CesiumLayer["setRefinementFocus"]>[0]>;
type NpmStyleFilter = NonNullable<
  Parameters<CesiumLayer["setStyle"]>[0]["classificationFilter"]
>;
export type NpmFocusShapeContract = Assert<SchemaFocusLens extends NpmFocusArgument ? true : false>;
export type NpmClassificationFilterContract = Assert<
  SchemaClassificationFilter extends NpmStyleFilter ? true : false
>;
export type NpmTerrainAlignmentAbsent = Assert<
  Equal<HasMethod<CesiumLayer, "estimateTerrainHeightAlignment">, false>
>;
export type NpmThreePickingContract = Assert<HasMethod<ThreeLayer, "pick">>;
export type NpmBatchedRendererContract = Assert<
  HasKey<CesiumApi, "BatchedGeometryPointRenderer">
>;
export type NpmPointRendererContract = Assert<HasKey<CesiumApi, "PointPrimitiveRenderer">>;
export type NpmProbeContract = Assert<HasKey<CesiumApi, "probeCopcSource">>;
export type NpmVerticalLayerOptionAbsent = Assert<
  Equal<HasKey<CesiumOptions, "verticalTransform">, false>
>;
export type NpmThreeVerticalLayerOptionAbsent = Assert<
  Equal<HasKey<ThreeOptions, "verticalTransform">, false>
>;
export type NpmCesiumConcurrentNodeLoadAbsent = Assert<
  Equal<HasKey<NonNullable<CesiumOptions["streaming"]>, "maxConcurrentNodeLoads">, false>
>;
export type NpmThreeConcurrentNodeLoadPresent = Assert<
  HasKey<NonNullable<ThreeOptions["streaming"]>, "maxConcurrentNodeLoads">
>;

type NpmColorMode = import("@frillab/copc-adapter/cesium").CopcColorMode;
type NpmPointSizeMode = import("@frillab/copc-adapter/cesium").CopcCesiumPointSizeMode;
type NpmRefinementAlgorithm = import("@frillab/copc-adapter/cesium").RefinementAlgorithm;
type NpmRangePolicy = import("@frillab/copc-adapter/cesium").RangeValidationPolicy;
type NpmBackendName = import("@frillab/copc-adapter/cesium").CopcBackendName;
type NpmExtraDimensions = NonNullable<
  import("@frillab/copc-adapter/cesium").CopcJsBackendOptions["extraDimensions"]
>;
type NpmRustBackend = import("@frillab/copc-adapter/cesium").RustCopcBackendOptions;
type NpmInputSource = import("@frillab/copc-adapter/cesium").CopcInputSource;

export type NpmColorModeChoicesMatch = AssertEqual<
  OptionChoices<"rendering.colorMode">,
  NpmColorMode
>;
export type NpmPointSizeChoicesMatch = AssertEqual<
  OptionChoices<"rendering.pointSizeMode">,
  NpmPointSizeMode
>;
export type NpmRefinementChoicesMatch = AssertEqual<
  OptionChoices<"streaming.refinementAlgorithm">,
  NpmRefinementAlgorithm
>;
export type NpmRangePolicyChoicesMatch = AssertEqual<
  OptionChoices<"source.rangeValidation">,
  NpmRangePolicy
>;
export type NpmBackendChoicesMatch = AssertEqual<
  OptionChoices<"adapter.backend">,
  NpmBackendName
>;
export type NpmExtraDimensionNamesSupported = Assert<
  ["legacy_id"] extends NpmExtraDimensions ? true : false
>;
export type NpmExtraDimensionWildcardSupported = Assert<
  "*" extends NpmExtraDimensions ? true : false
>;
export type NpmRustDoesNotClaimExtraDimensions = Assert<
  Equal<HasKey<NpmRustBackend, "extraDimensions">, false>
>;
export type NpmFilesAreValidSources = Assert<Blob extends NpmInputSource ? true : false>;

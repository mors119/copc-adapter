import type {
  Assert,
  AssertNoIncompatibleSchemaDefaults,
  AssertNoMissingPublicPaths,
  SchemaChoiceValues,
  SchemaConstructorPaths,
  SchemaOptionUnion,
} from "../../shared/schema/typeContracts.ts";
import type {
  SchemaClassificationFilter,
  SchemaFocusLens,
} from "../../shared/schema/types.ts";

type NpmManifest = typeof import("../../shared/schema/manifests.ts").NPM_0_7_1_MANIFEST;
type CesiumApi = typeof import("@frillab/copc-adapter/cesium");
type ThreeApi = typeof import("@frillab/copc-adapter/three");
type CesiumOptions = import("@frillab/copc-adapter/cesium").CopcCesiumLayerOptions;
type ThreeOptions = import("@frillab/copc-adapter/three").CopcThreeLayerOptions;
type CesiumLayer = InstanceType<CesiumApi["CopcCesiumLayer"]>;
type ThreeLayer = InstanceType<ThreeApi["CopcThreeLayer"]>;

type NpmCesiumPaths = SchemaConstructorPaths<SchemaOptionUnion, "cesium", NpmManifest>;
type NpmThreePaths = SchemaConstructorPaths<SchemaOptionUnion, "three", NpmManifest>;
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
// This comparison covers schema-emitted constructor paths. Host setup and
// runtime-setter options are checked through their separate contracts.
type LayerCompatibilityExclusions =
  | "classificationFilter"
  | "clippingVolume"
  | "debug"
  | "decoder"
  | "dimension"
  | "dimensionFilter"
  | "elevationRange"
  | "elevationStyle"
  | "extraDimensions"
  | "onPointPicked"
  | "opacity";

// Every declared user-facing npm 0.7.1 constructor path exists in its actual
// published package types, and every public option is represented or is an
// intentionally excluded callback/debug/compatibility alias.
export type NpmCesiumPathsExist = AssertNoMissingPublicPaths<CesiumOptions, NpmCesiumPaths>;
export type NpmThreePathsExist = AssertNoMissingPublicPaths<ThreeOptions, NpmThreePaths>;
export type NpmCesiumDefaultsMatchApiTypes = Assert<
  AssertNoIncompatibleSchemaDefaults<
    SchemaOptionUnion,
    "cesium",
    NpmManifest,
    CesiumOptions,
    "npm@0.7.1"
  >
>;
export type NpmThreeDefaultsMatchApiTypes = Assert<
  AssertNoIncompatibleSchemaDefaults<
    SchemaOptionUnion,
    "three",
    NpmManifest,
    ThreeOptions,
    "npm@0.7.1"
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
export type NpmStyleSetterContract = Assert<HasMethod<CesiumLayer, "setStyle">>;
export type NpmFocusSetterContract = Assert<HasMethod<CesiumLayer, "setRefinementFocus">>;
export type NpmOpacitySetterContract = Assert<HasMethod<CesiumLayer, "setOpacity">>;
export type NpmThreeOpacitySetterContract = Assert<HasMethod<ThreeLayer, "setOpacity">>;
export type NpmCesiumClippingSetterContract = Assert<
  HasMethod<CesiumLayer, "setClippingVolume">
>;
export type NpmOpacitySetterUsesNumericOverride = Assert<
  Equal<Parameters<CesiumLayer["setOpacity"]>[0], number>
>;
export type NpmThreeOpacitySetterUsesNumericOverride = Assert<
  Equal<Parameters<ThreeLayer["setOpacity"]>[0], number>
>;
type NpmFocusArgument = NonNullable<Parameters<CesiumLayer["setRefinementFocus"]>[0]>;
type NpmStyleFilter = NonNullable<
  Parameters<CesiumLayer["setStyle"]>[0]["classificationFilter"]
>;
export type NpmFocusShapeContract = Assert<SchemaFocusLens extends NpmFocusArgument ? true : false>;
export type NpmClassificationFilterContract = Assert<
  SchemaClassificationFilter extends NpmStyleFilter ? true : false
>;
export type NpmTerrainAlignmentPresent = Assert<
  HasMethod<CesiumLayer, "estimateTerrainHeightAlignment">
>;
export type NpmTerrainBatchAlignmentAbsent = Assert<
  Equal<HasMethod<CesiumLayer, "estimateTerrainHeightAlignmentBatch">, false>
>;
export type NpmThreePickingContract = Assert<HasMethod<ThreeLayer, "pick">>;
export type NpmBatchedRendererContract = Assert<
  HasKey<CesiumApi, "BatchedGeometryPointRenderer">
>;
export type NpmPointRendererContract = Assert<HasKey<CesiumApi, "PointPrimitiveRenderer">>;
export type NpmProbeContract = Assert<HasKey<CesiumApi, "probeCopcSource">>;
export type NpmVerticalLayerOptionPresent = Assert<
  HasKey<CesiumOptions, "verticalTransform">
>;
export type NpmThreeVerticalLayerOptionPresent = Assert<
  HasKey<ThreeOptions, "verticalTransform">
>;
export type NpmCesiumConcurrentNodeLoadPresent = Assert<
  HasKey<NonNullable<CesiumOptions["streaming"]>, "maxConcurrentNodeLoads">
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

export type NpmColorModeChoicesMatch = Assert<AssertEqual<
  Exclude<SchemaChoiceValues<"rendering.colorMode">, "dimension">,
  Exclude<NpmColorMode, "dimension">
>>;
export type NpmPointSizeChoicesMatch = AssertEqual<
  SchemaChoiceValues<"rendering.pointSizeMode">,
  NpmPointSizeMode
>;
export type NpmRefinementChoicesMatch = AssertEqual<
  SchemaChoiceValues<"streaming.refinementAlgorithm">,
  NpmRefinementAlgorithm
>;
export type NpmRangePolicyChoicesMatch = AssertEqual<
  SchemaChoiceValues<"source.rangeValidation">,
  NpmRangePolicy
>;
export type NpmAttributeLoadingChoicesMatch = AssertEqual<
  SchemaChoiceValues<"attributes.attributeLoading">,
  NonNullable<CesiumOptions["attributeLoading"]>
>;
export type NpmCoordinateCacheLayoutChoicesMatch = AssertEqual<
  SchemaChoiceValues<"cache.coordinateCacheLayout">,
  NonNullable<CesiumOptions["coordinateCacheLayout"]>
>;
type NpmPointFieldSelection = NonNullable<CesiumOptions["pointFields"]>;
export type NpmPointFieldSelectionIsReadonlySet = Assert<
  NpmPointFieldSelection extends ReadonlySet<"position" | "intensity" | "classification" | "rgb">
    ? true
    : false
>;
export type NpmBackendChoicesMatch = AssertEqual<
  SchemaChoiceValues<"adapter.backend">,
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

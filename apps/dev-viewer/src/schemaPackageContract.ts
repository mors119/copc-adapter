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
type WorkspaceManifest = typeof import("../../shared/schema/manifests.ts").WORKSPACE_CURRENT_MANIFEST;
type CesiumApi = typeof import("@frillab/copc-adapter/cesium");
type ThreeApi = typeof import("@frillab/copc-adapter/three");
type CesiumOptions = import("@frillab/copc-adapter/cesium").CopcCesiumLayerOptions;
type ThreeOptions = import("@frillab/copc-adapter/three").CopcThreeLayerOptions;
type CesiumLayer = InstanceType<CesiumApi["CopcCesiumLayer"]>;
type ThreeLayer = InstanceType<ThreeApi["CopcThreeLayer"]>;

type WorkspaceCesiumPaths = SchemaConstructorPaths<OptionUnion, "cesium", WorkspaceManifest>;
type WorkspaceThreePaths = SchemaConstructorPaths<OptionUnion, "three", WorkspaceManifest>;
type Head<Path extends string> = Path extends `${infer Key}.${string}` ? Key : Path;
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

// Dev Viewer is compiled against workspace declarations through its tsconfig
// aliases, so adding a new public option exposes schema drift in this build.
export type WorkspaceCesiumPathsExist = AssertNoMissingPublicPaths<CesiumOptions, WorkspaceCesiumPaths>;
export type WorkspaceThreePathsExist = AssertNoMissingPublicPaths<ThreeOptions, WorkspaceThreePaths>;
export type WorkspaceCesiumDefaultsMatchApiTypes = Assert<
  AssertNoIncompatibleSchemaDefaults<
    OptionUnion,
    "cesium",
    WorkspaceManifest,
    CesiumOptions,
    "workspace@0.6.0"
  >
>;
export type WorkspaceThreeDefaultsMatchApiTypes = Assert<
  AssertNoIncompatibleSchemaDefaults<
    OptionUnion,
    "three",
    WorkspaceManifest,
    ThreeOptions,
    "workspace@0.6.0"
  >
>;
export type WorkspaceCesiumLayerOptionCoverage = Assert<AssertEqual<
  Exclude<keyof CesiumOptions, LayerCompatibilityExclusions | "streaming">,
  Exclude<Head<WorkspaceCesiumPaths>, "streaming">
>>;
export type WorkspaceThreeLayerOptionCoverage = Assert<AssertEqual<
  Exclude<keyof ThreeOptions, LayerCompatibilityExclusions | "renderer" | "streaming">,
  Exclude<Head<WorkspaceThreePaths>, "streaming">
>>;
export type WorkspaceCesiumStreamingCoverage = Assert<AssertEqual<
  Exclude<StreamingKeys<CesiumOptions>, StreamingCompatibilityExclusions>,
  SchemaStreamingKeys<WorkspaceCesiumPaths>
>>;
export type WorkspaceThreeStreamingCoverage = Assert<AssertEqual<
  Exclude<StreamingKeys<ThreeOptions>, StreamingCompatibilityExclusions>,
  SchemaStreamingKeys<WorkspaceThreePaths>
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

export type WorkspaceStyleSetterContract = Assert<HasMethod<CesiumLayer, "setStyle">>;
export type WorkspaceFocusSetterContract = Assert<HasMethod<CesiumLayer, "setRefinementFocus">>;
type WorkspaceFocusArgument = NonNullable<
  Parameters<CesiumLayer["setRefinementFocus"]>[0]
>;
type WorkspaceStyleFilter = NonNullable<
  Parameters<CesiumLayer["setStyle"]>[0]["classificationFilter"]
>;
export type WorkspaceFocusShapeContract = Assert<
  SchemaFocusLens extends WorkspaceFocusArgument ? true : false
>;
export type WorkspaceClassificationFilterContract = Assert<
  SchemaClassificationFilter extends WorkspaceStyleFilter ? true : false
>;
export type WorkspaceTerrainAlignmentContract = Assert<
  HasMethod<CesiumLayer, "estimateTerrainHeightAlignment">
>;
export type WorkspaceThreePickingContract = Assert<HasMethod<ThreeLayer, "pick">>;
export type WorkspaceBatchedRendererContract = Assert<
  HasKey<CesiumApi, "BatchedGeometryPointRenderer">
>;
export type WorkspacePointRendererContract = Assert<HasKey<CesiumApi, "PointPrimitiveRenderer">>;
export type WorkspaceProbeContract = Assert<HasKey<CesiumApi, "probeCopcSource">>;
export type WorkspaceVerticalLayerOptionPresent = Assert<
  HasKey<CesiumOptions, "verticalTransform">
>;
export type WorkspaceThreeVerticalLayerOptionPresent = Assert<
  HasKey<ThreeOptions, "verticalTransform">
>;
export type WorkspaceCesiumConcurrentNodeLoadPresent = Assert<
  HasKey<NonNullable<CesiumOptions["streaming"]>, "maxConcurrentNodeLoads">
>;
export type WorkspaceThreeConcurrentNodeLoadPresent = Assert<
  HasKey<NonNullable<ThreeOptions["streaming"]>, "maxConcurrentNodeLoads">
>;

type WorkspaceColorMode = import("@frillab/copc-adapter/cesium").CopcColorMode;
type WorkspacePointSizeMode = import("@frillab/copc-adapter/cesium").CopcCesiumPointSizeMode;
type WorkspaceRefinementAlgorithm = import("@frillab/copc-adapter/cesium").RefinementAlgorithm;
type WorkspaceRangePolicy = import("@frillab/copc-adapter/cesium").RangeValidationPolicy;
type WorkspaceBackendName = import("@frillab/copc-adapter/cesium").CopcBackendName;
type WorkspaceExtraDimensions = NonNullable<
  import("@frillab/copc-adapter/cesium").CopcJsBackendOptions["extraDimensions"]
>;
type WorkspaceRustBackend = import("@frillab/copc-adapter/cesium").RustCopcBackendOptions;
type WorkspaceInputSource = import("@frillab/copc-adapter/cesium").CopcInputSource;

export type WorkspaceColorModeChoicesMatch = AssertEqual<
  OptionChoices<"rendering.colorMode">,
  WorkspaceColorMode
>;
export type WorkspacePointSizeChoicesMatch = AssertEqual<
  OptionChoices<"rendering.pointSizeMode">,
  WorkspacePointSizeMode
>;
export type WorkspaceRefinementChoicesMatch = AssertEqual<
  OptionChoices<"streaming.refinementAlgorithm">,
  WorkspaceRefinementAlgorithm
>;
export type WorkspaceRangePolicyChoicesMatch = AssertEqual<
  OptionChoices<"source.rangeValidation">,
  WorkspaceRangePolicy
>;
export type WorkspaceBackendChoicesMatch = AssertEqual<
  OptionChoices<"adapter.backend">,
  WorkspaceBackendName
>;
export type WorkspaceExtraDimensionNamesSupported = Assert<
  ["legacy_id"] extends WorkspaceExtraDimensions ? true : false
>;
export type WorkspaceExtraDimensionWildcardSupported = Assert<
  "*" extends WorkspaceExtraDimensions ? true : false
>;
export type WorkspaceRustDoesNotClaimExtraDimensions = Assert<
  Equal<HasKey<WorkspaceRustBackend, "extraDimensions">, false>
>;
export type WorkspaceFilesAreValidSources = Assert<
  Blob extends WorkspaceInputSource ? true : false
>;

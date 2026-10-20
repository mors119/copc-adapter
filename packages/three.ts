/**
 * Public Three.js adapter entrypoint.
 *
 * Keep this module independent from `index.ts`: the latter is the
 * backwards-compatible Cesium entrypoint and statically re-exports Cesium
 * integration modules. A Three.js consumer must be able to import this path
 * without resolving or initializing Cesium.
 *
 * The concrete `CopcThreeLayer` facade and its renderer remain isolated from
 * the Cesium root entry while sharing the project-owned COPC core and types.
 */
export {
  CopcHierarchyLoadError,
  CopcBackendError,
  CopcLoadError,
  CopcMetadataError,
  CopcSourceError,
} from "./core/copc/errors";
export type { CopcBackendErrorCode, CopcLoadStage } from "./core/copc/errors";
export {
  CopcJsBackend,
  copcJsBackend,
} from "./core/copc/backend/copcJsBackend";
export {
  RustCopcBackend,
  rustCopcBackend,
} from "./core/copc/backend/rustCopcBackend";
export type {
  CopcBackendName,
  CopcBackendSelection,
  CopcJsBackendOptions,
  RustByteSourceFactory,
  RustCopcBackendOptions,
} from "./core/copc/backend";
export type {
  CopcBackend,
  CopcBackendOpenOptions,
  CopcPointLoadOptions,
  CopcSource,
  CopcWorkerDiagnostics,
} from "./core/copc/backend/types";
export type {
  CopcPerformanceEvent,
  CopcPerformanceObserver,
} from "./core/copc/performance";
export { CopcWasmError } from "./core/wasm/copcWasm";
export { RustCrsTransformer } from "./core/coordinates/transform/rustCrsTransformer";
export type { RustPreparedCoordinateBuffer } from "./core/coordinates/transform/rustCrsTransformer";
export type {
  CopcHierarchyBounds,
  CopcHierarchyQueryBounds,
  CopcHierarchyDiagnostics,
  CopcHierarchyQuery,
  CopcProjectBounds,
} from "./core/copc/hierarchy/types";
export type { CopcPointDecoder } from "./core/copc/points/types";
export {
  HttpRangeByteSource,
  BlobByteSource,
  InMemoryByteSource,
  RangeSourceError,
  DEFAULT_MAX_RANGE_BYTES,
  DEFAULT_MAX_CONCURRENT_RANGE_REQUESTS,
  validateByteRange,
} from "./core/copc/range";
export type { BlobByteSourceOptions } from "./core/copc/range";
export type {
  ByteRange,
  RangeFetch,
  RangeReadOptions,
  RangeValidationLevel,
  RangeValidationPolicy,
  RangeSourceErrorCode,
  RangeSourceErrorDetails,
  RandomAccessByteSource,
  CopcInputSource,
} from "./core/copc/range";
export { probeCopcSource } from "./core/copc/sourceProbe";
export type {
  CopcSourceProbeOptions,
  CopcSourceProbeResult,
  ProbeTruth,
} from "./core/copc/sourceProbe";
export {
  allCopcPointFields,
  createCopcPointFieldSelection,
  getCopcPointFieldSelection,
} from "./core/copc/points/fieldSelection";
export type {
  CopcPointComponent,
  CopcPointField,
  CopcPointFieldSelection,
} from "./core/copc/points/fieldSelection";
export type {
  CopcMetadata,
  CopcPoint,
  CopcExtraDimensionValues,
  CopcPointAttributes,
  CopcPointBuffer,
  CopcPointData,
  PreparedPointData,
  PreparedPointStatistics,
  GeographicPoint,
  GeographicPointBuffer,
} from "./core/copc/types/copc";
export type {
  CoordinateBounds,
  CoordinateBuffer,
  CoordinateSystem,
  CoordinateVector3,
  DatasetLocalFrame,
  RendererLocalPoint,
  Wgs84EcefBounds,
  Wgs84EcefPoint,
  Wgs84GeographicBounds,
  Wgs84GeographicPoint,
} from "./core/coordinates/types";
export {
  transformPointBufferToPointData,
  transformPointBufferToPreparedPointData,
} from "./core/coordinates/transform/createPointTransformer";
export {
  assertPreparedPointData,
  createPreparedPointData,
  preparedPointDataToGeographicBuffer,
} from "./core/point/preparedPoint";
export {
  createDatasetLocalFrame,
  datasetLocalDirectionToWorld,
  datasetLocalToWorld,
  worldBoundsToDatasetLocal,
  worldBufferToDatasetLocal,
  worldDirectionToDatasetLocal,
  worldToDatasetLocal,
} from "./core/coordinates/transform/datasetLocalFrame";
export {
  worldBufferToLocal,
  worldToLocal,
} from "./core/coordinates/transform/worldCoordinates";
export {
  inspectCopcPoint,
  isCopcPointPickId,
} from "./core/copc/points/pointInspection";
export type {
  CopcPointInspection,
  CopcPointPickId,
} from "./core/copc/points/pointInspection";
export {
  CopcStreamingCore,
  CopcStreamingController,
} from "./core/streaming/CopcStreamingCore";
export type {
  CopcStreamingCoreOptions,
  CopcStreamingControllerOptions,
  CopcStreamingLifecycleState,
  CopcStreamingPerformanceSnapshot,
  PredictivePrefetchDiagnostics,
  CopcStreamingProgressHandler,
  CopcStreamingSnapshot,
  CopcStreamingTransitionState,
} from "./core/streaming/CopcStreamingCore";
export type {
  CopcPointRenderer,
  CopcPointRendererOptions,
  CopcValueRange,
} from "./core/streaming/renderer";
export type {
  BoundingSphere,
  BoundingSphereInput,
  ViewFrustum,
  ViewVector3,
  StreamingCameraState,
  CopcStreamingView,
  CopcViewState,
  StreamingView,
  StreamingHierarchy,
  StreamingHierarchyNode,
  StreamingSelectedNode,
  StreamingProgress,
  StreamingReplacementGroup,
  StreamingReplacementKind,
  StreamingSelectionContext,
  StreamingSelectionMetrics,
  StreamingSchedulingDiagnostics,
  StreamingSelectionOptions,
  StreamingUpdateResult,
} from "./core/streaming/types";
export type {
  RefinementAlgorithm,
  RefinementFocus,
} from "./core/streaming/refinementStrategies";
export {
  DEFAULT_REFINEMENT_ALGORITHM,
  MAX_REFINEMENT_FOCUS_DETAIL_BIAS,
} from "./core/streaming/refinementStrategies";
export type {
  AdaptiveViewDistanceDiagnostics,
  AdaptiveViewDistanceTransition,
  FrustumPlane,
  GeographicViewBounds,
  StreamingViewBounds,
  StreamingViewBoundsInput,
} from "./core/streaming/view";
export {
  createPerspectiveViewFrustum,
  createStreamingViewBounds,
  ecefToGeographic,
  geographicToEcef,
  intersectsViewFrustum,
} from "./core/streaming/view";
export { CopcThreeLayer } from "./three/layer/CopcThreeLayer";
export type {
  CopcThreeLayerAttachment,
  CopcThreeLayerErrorEvent,
  CopcThreeLayerEventMap,
  CopcThreeLayerEventType,
  CopcThreeLayerFirstVisibleEvent,
  CopcThreeLayerLifecycleState,
  CopcThreeLayerMetadataReadyEvent,
  CopcThreeLayerOptions,
  CopcThreeLayerPickOptions,
  CopcThreeLayerPickPosition,
  CopcThreeLayerProgressEvent,
  CopcThreeLayerSnapshot,
  CopcThreeLayerTransitionDiagnostics,
  CopcThreePointRenderer,
  CopcThreeRendererPerformanceSnapshot,
  CopcThreeLayerViewCancelledEvent,
  CopcThreeLayerViewSettledEvent,
  CopcLayerErrorEvent,
  CopcViewCancellationReason,
} from "./three/layer/CopcThreeLayer";
export {
  ThreePointRenderer,
  createThreeLocalOrigin,
} from "./three/render/ThreePointRenderer";
export type {
  ThreePointRendererConstructorOptions,
  ThreePointRendererOptions,
  ThreePointRendererPerformanceStage,
} from "./three/render/ThreePointRenderer";
export { createThreeStreamingView } from "./three/view/ThreeViewAdapter";
export type {
  ThreeStreamingViewOptions,
  ThreeViewportSource,
} from "./three/view/ThreeViewAdapter";

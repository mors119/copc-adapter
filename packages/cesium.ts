/**
 * Public Cesium adapter entrypoint.
 *
 * This is the explicit renderer-specific package path. The historical root
 * entrypoint re-exports the same Cesium API for backwards compatibility.
 */
export { CopcCesiumLayer } from './cesium/layer/CopcCesiumLayer';
export {
  CopcHierarchyLoadError,
  CopcBackendError,
  CopcLoadError,
  CopcMetadataError,
  CopcSourceError,
} from './core/copc/errors';
export type {
  CopcBackendErrorCode,
  CopcLoadStage,
} from './core/copc/errors';
export { CopcJsBackend, copcJsBackend } from './core/copc/backend/copcJsBackend';
export {
  RustCopcBackend,
  rustCopcBackend,
} from './core/copc/backend/rustCopcBackend';
export type {
  CopcBackendName,
  CopcBackendSelection,
  CopcJsBackendOptions,
  RustByteSourceFactory,
  RustCopcBackendOptions,
} from './core/copc/backend';
export type {
  CopcBackend,
  CopcBackendOpenOptions,
  CopcPointLoadOptions,
  CopcSource,
  CopcWorkerDiagnostics,
} from './core/copc/backend/types';
export type { CopcPerformanceEvent, CopcPerformanceObserver } from './core/copc/performance';
export {
  RustCopcDecodeWorkerPool,
  RustCopcWorkerError,
} from './core/copc/rustCopcDecodeWorkerPool';
export type {
  CopcHierarchyBounds,
  CopcHierarchyQueryBounds,
  CopcHierarchyDiagnostics,
  CopcHierarchyQuery,
  CopcProjectBounds,
} from './core/copc/hierarchy/types';
export { RustCopcParseError, RustCopcReader } from './core/copc/rustCopcReader';
export { CopcWasmError } from './core/wasm/copcWasm';
export { RustCrsTransformer } from './core/coordinates/transform/rustCrsTransformer';
export type { RustPreparedCoordinateBuffer } from './core/coordinates/transform/rustCrsTransformer';
export type {
  RustCopcHeader,
  RustCopcParseErrorCode,
} from './core/copc/rustCopcReader';
export type { CopcPointDecoder } from './core/copc/points/types';
export {
  HttpRangeByteSource,
  BlobByteSource,
  InMemoryByteSource,
  RangeSourceError,
  DEFAULT_MAX_RANGE_BYTES,
  DEFAULT_MAX_CONCURRENT_RANGE_REQUESTS,
  validateByteRange,
} from './core/copc/range';
export type { BlobByteSourceOptions } from './core/copc/range';
export { probeCopcSource } from './core/copc/sourceProbe';
export type {
  CopcSourceProbeOptions,
  CopcSourceProbeResult,
  ProbeTruth,
} from './core/copc/sourceProbe';
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
} from './core/copc/range';
export {
  allCopcPointFields,
  createCopcPointFieldSelection,
  getCopcPointFieldSelection,
} from './core/copc/points/fieldSelection';
export type {
  CopcPointComponent,
  CopcPointField,
  CopcPointFieldSelection,
} from './core/copc/points/fieldSelection';
export type {
  CopcCesiumLayerOptions,
  CopcCesiumLayerSnapshot,
  CopcColorMode,
  CopcStreamingOptions,
  CopcLayerErrorEvent,
  CopcViewCancellationReason,
} from './cesium/layer/CopcCesiumLayer';
export type { RefinementAlgorithm, RefinementFocus } from './cesium/layer/CopcCesiumLayer';
export type {
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
  CopcClassificationFilter,
} from './cesium/layer/CopcCesiumLayer';
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
} from './core/copc/types/copc';
export type {
  CoordinateDirection,
  CoordinateBounds,
  CoordinateBuffer,
  CoordinateSystem,
  CoordinateVector3,
  DatasetLocalFrame,
  RendererLocalBounds,
  RendererLocalPoint,
  Wgs84EcefBounds,
  Wgs84EcefPoint,
  Wgs84GeographicBounds,
  Wgs84GeographicPoint,
} from './core/coordinates/types';
export {
  transformPointBufferToPointData,
  transformPointBufferToPreparedPointData,
} from './core/coordinates/transform/createPointTransformer';
export {
  assertPreparedPointData,
  createPreparedPointData,
  preparedPointDataToGeographicBuffer,
} from './core/point/preparedPoint';
export {
  createDatasetLocalFrame,
  datasetLocalDirectionToWorld,
  datasetLocalToWorld,
  worldBoundsToDatasetLocal,
  worldBufferToDatasetLocal,
  worldDirectionToDatasetLocal,
  worldToDatasetLocal,
} from './core/coordinates/transform/datasetLocalFrame';
export {
  worldBufferToLocal,
  worldToLocal,
} from './core/coordinates/transform/worldCoordinates';
export {
  inspectCopcPoint,
  isCopcPointPickId,
} from './core/copc/points/pointInspection';
export type {
  CopcPointInspection,
  CopcPointPickId,
} from './core/copc/points/pointInspection';
export {
  PointPrimitiveRenderer,
} from './cesium/render/CopcPointRenderer';
export { BatchedGeometryPointRenderer } from './cesium/render/BatchedGeometryPointRenderer';
export {
  toCartesian3Array,
  toCartesian3ArrayFromBuffer,
  toCartesian3ArrayFromWorldBuffer,
} from './cesium/render/renderPoints';
export type {
  CesiumPointRenderer,
  CopcCesiumPointRenderer,
  CopcCesiumPointRendererOptions,
  CopcCesiumPointRendererPerformanceStage,
  CopcCesiumPointSizeMode,
  CopcPointRendererPerformanceStage,
} from './cesium/render/CopcPointRenderer';
export {
  DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
} from './cesium/render/projectedPointSize';
export type {
  CopcPointRenderer,
  CopcPointRendererOptions,
  CopcValueRange,
} from './core/streaming/renderer';
export {
  getPointBufferElevationRange,
  getPointBufferIntensityRange,
  getPointBufferRgbMax,
  getCopcPointColor,
  createCopcPointStyleState,
  normalizeElevation,
  normalizeIntensity,
  prepareCopcPointColorBuffer,
  resolveCopcPointStyleOptions,
} from './core/point/style/pointStyle';
export type {
  CopcElevationRange,
  CopcNormalizedColor,
  CopcPointStyleInput,
  CopcPointStyleOptions,
  CopcPointStyleState,
} from './core/point/style/pointStyle';
export type { NodePointCacheDiagnostics } from './core/streaming/createNodePointCache';
export {
  CopcStreamingCore,
  CopcStreamingController,
} from './core/streaming/CopcStreamingCore';
export type {
  CopcStreamingCoreOptions,
  CopcStreamingControllerOptions,
  CopcStreamingLifecycleState,
  CopcStreamingPerformanceSnapshot,
  PredictivePrefetchDiagnostics,
  CopcStreamingProgressHandler,
  CopcStreamingSnapshot,
  CopcStreamingTransitionState,
} from './core/streaming/CopcStreamingCore';
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
} from './core/streaming/types';
export { DEFAULT_REFINEMENT_ALGORITHM, MAX_REFINEMENT_FOCUS_DETAIL_BIAS } from './core/streaming/refinementStrategies';
export type {
  AdaptiveViewDistanceDiagnostics,
  AdaptiveViewDistanceTransition,
  FrustumPlane,
  GeographicViewBounds,
  StreamingViewBounds,
  StreamingViewBoundsInput,
} from './core/streaming/view';
export {
  createPerspectiveViewFrustum,
  createStreamingViewBounds,
  ecefToGeographic,
  geographicToEcef,
  intersectsViewFrustum,
} from './core/streaming/view';

/**
 * Public renderer-neutral entrypoint for the future Three.js adapter.
 *
 * Keep this module independent from `src/index.ts`: the latter is the
 * backwards-compatible Cesium entrypoint and statically re-exports Cesium
 * integration modules. A Three.js consumer must be able to import this path
 * without resolving or initializing Cesium.
 *
 * The concrete `CopcThreeLayer` facade is intentionally owned by the follow-up
 * renderer work. This entrypoint establishes its package boundary and exposes
 * the shared core/types that the facade will consume.
 */
export {
  CopcHierarchyLoadError,
  CopcBackendError,
  CopcLoadError,
  CopcMetadataError,
  CopcSourceError,
} from './copc/errors';
export type {
  CopcBackendErrorCode,
  CopcLoadStage,
} from './copc/errors';
export { CopcJsBackend, copcJsBackend } from './copc/backend/copcJsBackend';
export {
  RustCopcBackend,
  rustCopcBackend,
} from './copc/backend/rustCopcBackend';
export type {
  CopcBackendName,
  CopcBackendSelection,
  RustByteSourceFactory,
  RustCopcBackendOptions,
} from './copc/backend';
export type {
  CopcBackend,
  CopcSource,
  CopcWorkerDiagnostics,
} from './copc/backend/types';
export type { CopcPerformanceEvent, CopcPerformanceObserver } from './copc/performance';
export { CopcWasmError } from './wasm/copcWasm';
export type {
  CopcHierarchyBounds,
  CopcHierarchyQueryBounds,
  CopcHierarchyDiagnostics,
  CopcHierarchyQuery,
  CopcProjectBounds,
} from './copc/hierarchy/types';
export type { CopcPointDecoder } from './copc/points/types';
export {
  HttpRangeByteSource,
  InMemoryByteSource,
  RangeSourceError,
  validateByteRange,
} from './copc/range';
export type {
  ByteRange,
  RangeFetch,
  RangeReadOptions,
  RangeSourceErrorCode,
  RangeSourceErrorDetails,
  RandomAccessByteSource,
} from './copc/range';
export { probeCopcSource } from './copc/sourceProbe';
export type {
  CopcSourceProbeOptions,
  CopcSourceProbeResult,
  ProbeTruth,
} from './copc/sourceProbe';
export {
  allCopcPointFields,
  createCopcPointFieldSelection,
  getCopcPointFieldSelection,
} from './copc/points/fieldSelection';
export type {
  CopcPointComponent,
  CopcPointField,
  CopcPointFieldSelection,
} from './copc/points/fieldSelection';
export type {
  CopcMetadata,
  CopcPoint,
  CopcPointAttributes,
  CopcPointBuffer,
  CopcPointData,
  GeographicPoint,
  GeographicPointBuffer,
} from './copc/types/copc';
export type {
  CoordinateBounds,
  CoordinateBuffer,
  CoordinateSystem,
  CoordinateVector3,
  RendererLocalPoint,
  Wgs84EcefBounds,
  Wgs84EcefPoint,
  Wgs84GeographicBounds,
  Wgs84GeographicPoint,
} from './coordinates/types';
export {
  transformPointBufferToPointData,
} from './coordinates/transform/createPointTransformer';
export {
  worldBufferToLocal,
  worldToLocal,
} from './coordinates/transform/worldCoordinates';
export {
  inspectCopcPoint,
  isCopcPointPickId,
} from './copc/points/pointInspection';
export type {
  CopcPointInspection,
  CopcPointPickId,
} from './copc/points/pointInspection';
export {
  CopcStreamingCore,
  CopcStreamingController,
} from './viewer/streaming/CopcStreamingController';
export type {
  CopcStreamingCoreOptions,
  CopcStreamingControllerOptions,
  CopcStreamingLifecycleState,
  CopcStreamingPerformanceSnapshot,
  CopcStreamingProgressHandler,
  CopcStreamingSnapshot,
  CopcStreamingTransitionState,
} from './viewer/streaming/CopcStreamingController';
export type {
  CopcPointRenderer,
  CopcPointRendererOptions,
  CopcValueRange,
} from './viewer/streaming/renderer';
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
  StreamingProgress,
  StreamingReplacementGroup,
  StreamingReplacementKind,
  StreamingSelectionContext,
  StreamingSelectionMetrics,
  StreamingSelectionOptions,
  StreamingUpdateResult,
} from './viewer/streaming/types';
export type {
  FrustumPlane,
  GeographicViewBounds,
  StreamingViewBounds,
  StreamingViewBoundsInput,
} from './viewer/streaming/view';
export {
  createPerspectiveViewFrustum,
  createStreamingViewBounds,
  ecefToGeographic,
  geographicToEcef,
  intersectsViewFrustum,
} from './viewer/streaming/view';

/**
 * Provisional names reserved for the public Three layer facade. They keep
 * consumers and declaration tests on the renderer-neutral boundary until the
 * concrete layer is implemented in the follow-up Three renderer work.
 */
export type {
  CopcStreamingControllerOptions as CopcThreeLayerOptions,
  CopcStreamingSnapshot as CopcThreeLayerSnapshot,
} from './viewer/streaming/CopcStreamingController';

/**
 * Renderer-neutral COPC source and point-preparation entrypoint.
 *
 * Import this subpath when an application needs COPC byte access, hierarchy,
 * node decoding, CRS preparation, or provenance without CesiumJS or Three.js.
 */
export {
  CopcContext,
  CopcStaleSourceError,
  createCopcContext,
} from "./core/copc/context/createCopcContext";
export type {
  CopcContextInput,
  CopcContextOptions,
  CopcNodeSource,
  CopcPreparedNodeData,
} from "./core/copc/context/createCopcContext";

export {
  CopcBackendError,
  CopcHierarchyLoadError,
  CopcLoadError,
  CopcMetadataError,
  CopcSourceError,
} from "./core/copc/errors";
export type { CopcBackendErrorCode, CopcLoadStage } from "./core/copc/errors";
export {
  CopcJsBackend,
  copcJsBackend,
  RustCopcBackend,
  rustCopcBackend,
} from "./core/copc/backend";
export type {
  CopcBackend,
  CopcBackendName,
  CopcBackendOpenOptions,
  CopcBackendSelection,
  CopcJsBackendOptions,
  CopcPointLoadOptions,
  CopcSource,
  CopcWorkerDiagnostics,
  RustByteSourceFactory,
  RustCopcBackendOptions,
} from "./core/copc/backend";

export { HierarchyLoader, getCopcHierarchyCellBounds } from "./core/copc/hierarchy/HierarchyLoader";
export type { HierarchyQueryOptions } from "./core/copc/hierarchy/HierarchyLoader";
export {
  CopcHierarchyError,
  CopcHierarchyPageError,
  CopcHierarchyTraversalError,
} from "./core/copc/hierarchy/types";
export type {
  CopcHierarchyBounds,
  CopcHierarchyDiagnostics,
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcHierarchyPageLoadOptions,
  CopcHierarchyQuery,
  CopcHierarchyQueryBounds,
  CopcHierarchySource,
  CopcHierarchySubtree,
  CopcHierarchyTree,
  CopcProjectBounds,
} from "./core/copc/hierarchy/types";

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
export type { CopcExtraDimensionSelection } from "./core/copc/points/extraDimensions";
export type { CopcPointDecoder } from "./core/copc/points/types";
export type {
  CopcPerformanceEvent,
  CopcPerformanceObserver,
  CopcPerformanceStage,
} from "./core/copc/performance";
export {
  assertPreparedPointData,
  createPreparedPointData,
  getPreparedEcefBounds,
  preparedPointDataToGeographicBuffer,
} from "./core/point/preparedPoint";

export {
  createCoordinateTransformPlan,
  getCoordinateTransformPlan,
} from "./core/coordinates/transform/coordinateTransformPlan";
export type {
  CoordinateTransformCrsReference,
  CoordinateTransformGridProvenance,
  CoordinateTransformPlan,
  CoordinateTransformPlanOperation,
  CoordinateTransformPlanOptions,
  CoordinateTransformPlanReason,
} from "./core/coordinates/transform/coordinateTransformPlan";
export {
  applyPreparedPointHeightOffset,
  applyPreparedPointVerticalGrid,
  transformPointBufferToPreparedPointData,
} from "./core/coordinates/transform/createPointTransformer";
export type { PlannedCoordinateTransformer } from "./core/coordinates/transform/createPointTransformer";
export {
  GtxGeoidGrid,
  VerticalTransformError,
  loadGtxGeoidGrid,
} from "./core/coordinates/transform/verticalGrid";
export type {
  GtxGeoidGridOptions,
  VerticalGridBytes,
  VerticalGridValueUnit,
  VerticalHeightDirection,
  VerticalTransformErrorCode,
} from "./core/coordinates/transform/verticalGrid";
export { loadNgaEgm2008Grid } from "./core/coordinates/transform/egm2008Grid";
export type { NgaEgm2008GridOptions } from "./core/coordinates/transform/egm2008Grid";
export { resolveCopcCrsMetadata } from "./core/coordinates/crs/copcCrsMetadata";
export type {
  CopcCrsDiagnosticReason,
  CopcCrsDiagnosticReasonCode,
  CopcCrsEvidence,
  CopcCrsEvidenceCertainty,
  CopcCrsIdentityDiagnostic,
  CopcCrsMetadataDiagnostic,
  CopcCrsUnitDiagnostic,
  CopcCrsWktProvenance,
} from "./core/coordinates/crs/copcCrsMetadata";
export type {
  CoordinateBounds,
  CoordinateBuffer,
  CoordinateSystem,
  CoordinateVector3,
  Wgs84EcefBounds,
  Wgs84EcefPoint,
  Wgs84GeographicBounds,
  Wgs84GeographicPoint,
} from "./core/coordinates/types";

export type {
  CopcExtraDimensionMetadata,
  CopcExtraDimensionValues,
  CopcMetadata,
  CopcPoint,
  CopcPointAttributes,
  CopcPointBuffer,
  CopcPointData,
  CopcPointView,
  GeographicPoint,
  GeographicPointBuffer,
  PreparedPointData,
  PreparedPointStatistics,
} from "./core/copc/types/copc";
export {
  BlobByteSource,
  HttpRangeByteSource,
  InMemoryByteSource,
  RangeSourceError,
  DEFAULT_MAX_CONCURRENT_RANGE_REQUESTS,
  DEFAULT_MAX_RANGE_BYTES,
  validateByteRange,
} from "./core/copc/range";
export type {
  BlobByteSourceOptions,
  ByteRange,
  CopcInputSource,
  RandomAccessByteSource,
  RangeFetch,
  RangeReadOptions,
  RangeSourceErrorCode,
  RangeSourceErrorDetails,
  RangeValidationLevel,
  RangeValidationPolicy,
} from "./core/copc/range";

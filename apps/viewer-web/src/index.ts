/**
 * Public library entrypoint for the COPC Cesium viewer.
 *
 * Consumers should import from this module rather than deep internal paths.
 */
export { CopcCesiumLayer } from './api/CopcCesiumLayer';
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
export {
  RustCopcDecodeWorkerPool,
  RustCopcWorkerError,
} from './copc/rustCopcDecodeWorkerPool';
export type {
  CopcHierarchyBounds,
  CopcHierarchyDiagnostics,
  CopcHierarchyQuery,
} from './copc/hierarchy/types';
export { RustCopcParseError, RustCopcReader } from './copc/rustCopcReader';
export { CopcWasmError } from './wasm/copcWasm';
export type {
  RustCopcHeader,
  RustCopcParseErrorCode,
} from './copc/rustCopcReader';
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
  CopcCesiumLayerOptions,
  CopcCesiumLayerSnapshot,
  CopcColorMode,
  CopcStreamingOptions,
} from './api/CopcCesiumLayer';
export type {
  CopcMetadata,
  CopcPoint,
  CopcPointAttributes,
  CopcPointBuffer,
  GeographicPoint,
  GeographicPointBuffer,
} from './copc/types/copc';
export {
  PointPrimitiveRenderer,
} from './cesium/render/CopcPointRenderer';
export type {
  CopcPointRenderer,
  CopcPointRendererOptions,
  CopcPointRendererPerformanceStage,
} from './cesium/render/CopcPointRenderer';
export type { NodePointCacheDiagnostics } from './viewer/streaming/createNodePointCache';

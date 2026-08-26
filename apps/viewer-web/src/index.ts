/**
 * Public library entrypoint for the COPC Cesium viewer.
 *
 * Consumers should import from this module rather than deep internal paths.
 */
export { CopcCesiumLayer } from './api/CopcCesiumLayer';
export {
  CopcHierarchyLoadError,
  CopcLoadError,
  CopcMetadataError,
  CopcSourceError,
} from './copc/errors';
export type { CopcLoadStage } from './copc/errors';
export { CopcJsBackend, copcJsBackend } from './copc/backend/copcJsBackend';
export type { CopcBackend, CopcSource } from './copc/backend/types';
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

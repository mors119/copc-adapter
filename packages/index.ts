/**
 * Backwards-compatible root entrypoint for the COPC Cesium adapter.
 *
 * New Cesium integrations may use `@frillab/copc-adapter/cesium` to make the
 * renderer boundary explicit. The root remains a Cesium entrypoint so existing
 * consumers keep receiving the same public API.
 */
export * from './cesium';

// These Three.js styling helpers were already part of the root public API.
// Keep them here for compatibility while the explicit Cesium entry stays
// limited to Cesium and shared COPC APIs.
export {
  getThreePointsMaterialOptions,
  prepareThreePointColorBuffer,
  THREE_POINT_SIZE_ATTENUATION,
} from './three/style/pointStyle';
export type {
  CopcThreePointStyleOptions,
  CopcThreePointsMaterialOptions,
} from './three/style/pointStyle';

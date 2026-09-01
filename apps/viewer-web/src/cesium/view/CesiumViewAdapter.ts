import * as Cesium from 'cesium';
import type { StreamingView, ViewVector3 } from '../../viewer/streaming/types';
import { createPerspectiveViewFrustum } from '../../viewer/streaming/view';

type CesiumPerspectiveFrustum = {
  fov?: number;
  fovy?: number;
  aspectRatio?: number;
  near?: number;
  far?: number;
};

function toVector(value: Cesium.Cartesian3): ViewVector3 {
  return {
    x: value.x,
    y: value.y,
    z: value.z,
  };
}

function getCameraPosition(viewer: Cesium.Viewer): StreamingView {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);

  return {
    longitude: Cesium.Math.toDegrees(cartographic.longitude),
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
    height: cartographic.height,
    viewDistanceMeters: Math.max(cartographic.height * 6, 2000),
  };
}

function getViewportHeightPixels(viewer: Cesium.Viewer): number {
  return viewer.scene.drawingBufferHeight
    || viewer.scene.canvas.clientHeight
    || viewer.scene.canvas.height;
}

/**
 * Translate Cesium's live camera into the serializable view consumed by the
 * renderer-neutral streaming core.
 */
export function createCesiumStreamingView(viewer: Cesium.Viewer): StreamingView {
  const view = getCameraPosition(viewer);
  const camera = viewer.camera;
  const frustum = camera.frustum as unknown as CesiumPerspectiveFrustum | undefined;
  if (!frustum) {
    return view;
  }

  const { fov, fovy, aspectRatio, near, far } = frustum;
  const viewportHeightPixels = getViewportHeightPixels(viewer);
  const hasFov = typeof fov === 'number' && Number.isFinite(fov);
  const hasFovy = typeof fovy === 'number' && Number.isFinite(fovy);
  if (
    (!hasFov && !hasFovy)
    || typeof aspectRatio !== 'number'
    || typeof near !== 'number'
    || typeof far !== 'number'
    || !Number.isFinite(viewportHeightPixels)
    || viewportHeightPixels <= 0
    || !Number.isFinite(aspectRatio)
    || !Number.isFinite(near)
    || !Number.isFinite(far)
  ) {
    return view;
  }

  const verticalFovRadians = hasFovy
    ? fovy!
    : aspectRatio! > 1
      ? 2 * Math.atan(Math.tan(fov! / 2) / aspectRatio!)
      : fov!;

  try {
    const viewFrustum = createPerspectiveViewFrustum({
      position: toVector(camera.positionWC),
      direction: toVector(camera.directionWC),
      up: toVector(camera.upWC),
      right: toVector(camera.rightWC),
      verticalFovRadians,
      viewportHeightPixels,
      aspectRatio,
      nearMeters: near,
      farMeters: far,
    });

    return {
      ...view,
      viewDistanceMeters: Math.max(viewFrustum.farMeters, 2000),
      viewFrustum,
    };
  } catch {
    // Startup frames, orthographic frustums, and custom camera objects may not
    // expose a valid perspective basis. The core has a conservative fallback.
    return view;
  }
}

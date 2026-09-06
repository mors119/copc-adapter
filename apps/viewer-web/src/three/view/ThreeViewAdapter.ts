import * as THREE from 'three';
import {
  datasetLocalDirectionToWorld,
  datasetLocalToWorld,
} from '../../coordinates/transform/datasetLocalFrame';
import { ecefToGeographic } from '../../coordinates/transform/worldCoordinates';
import type { DatasetLocalFrame } from '../../coordinates/types';
import {
  createPerspectiveViewFrustum,
  type ViewVector3,
} from '../../viewer/streaming/view';
import type { StreamingView } from '../../viewer/streaming/types';

/** The small renderer surface used to obtain a pixel viewport for SSE. */
export type ThreeViewportSource = {
  getDrawingBufferSize?: (target: THREE.Vector2) => THREE.Vector2;
  getSize?: (target: THREE.Vector2) => THREE.Vector2;
  domElement?: {
    width?: number;
    height?: number;
    clientWidth?: number;
    clientHeight?: number;
  };
};

export type ThreeStreamingViewOptions = {
  camera: THREE.Camera;
  frame: DatasetLocalFrame;
  renderer?: ThreeViewportSource;
  /** Fallback when the camera does not expose a finite far plane. */
  maxRenderDistanceMeters?: number;
};

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function toViewVector(vector: THREE.Vector3): ViewVector3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function getViewportSize(renderer: ThreeViewportSource | undefined): THREE.Vector2 {
  const size = new THREE.Vector2();
  if (renderer?.getDrawingBufferSize) {
    renderer.getDrawingBufferSize(size);
    if (size.x > 0 && size.y > 0) {
      return size;
    }
  }
  if (renderer?.getSize) {
    renderer.getSize(size);
    if (size.x > 0 && size.y > 0) {
      return size;
    }
  }

  const element = renderer?.domElement;
  return new THREE.Vector2(
    finitePositive(element?.width ?? element?.clientWidth, 1),
    finitePositive(element?.height ?? element?.clientHeight, 1080),
  );
}

function getCameraBasis(camera: THREE.Camera): {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
} {
  camera.updateMatrixWorld(true);
  const position = camera.getWorldPosition(new THREE.Vector3());
  const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
  const up = new THREE.Vector3(0, 1, 0)
    .transformDirection(camera.matrixWorld)
    .normalize();
  const right = new THREE.Vector3(1, 0, 0)
    .transformDirection(camera.matrixWorld)
    .normalize();

  return { position, direction, up, right };
}

function localToWorldVector(vector: THREE.Vector3, frame: DatasetLocalFrame): ViewVector3 {
  return datasetLocalDirectionToWorld(toViewVector(vector), frame);
}

/** Convert a live Three camera into the renderer-neutral streaming view. */
export function createThreeStreamingView(
  options: ThreeStreamingViewOptions,
): StreamingView {
  const basis = getCameraBasis(options.camera);
  const worldPosition = datasetLocalToWorld({
    coordinateSystem: 'renderer-local',
    x: basis.position.x,
    y: basis.position.y,
    z: basis.position.z,
  }, options.frame);
  const geographicPosition = ecefToGeographic(worldPosition);
  const viewport = getViewportSize(options.renderer);
  const cameraWithPerspectiveFields = options.camera as THREE.Camera & {
    aspect?: number;
    fov?: number;
    near?: number;
    far?: number;
    isPerspectiveCamera?: boolean;
  };
  const farMeters = finitePositive(
    cameraWithPerspectiveFields.far,
    options.maxRenderDistanceMeters ?? 12000,
  );
  const nearMeters = finitePositive(cameraWithPerspectiveFields.near, 0.1);
  const aspectRatio = finitePositive(
    cameraWithPerspectiveFields.aspect,
    viewport.x / viewport.y,
  );

  const view: StreamingView = {
    longitude: geographicPosition.longitude,
    latitude: geographicPosition.latitude,
    height: geographicPosition.height,
    viewDistanceMeters: farMeters,
  };

  if (cameraWithPerspectiveFields.isPerspectiveCamera !== false
    && Number.isFinite(cameraWithPerspectiveFields.fov)) {
    view.viewFrustum = createPerspectiveViewFrustum({
      position: {
        x: worldPosition.x,
        y: worldPosition.y,
        z: worldPosition.z,
      },
      direction: localToWorldVector(basis.direction, options.frame),
      up: localToWorldVector(basis.up, options.frame),
      right: localToWorldVector(basis.right, options.frame),
      verticalFovRadians: THREE.MathUtils.degToRad(cameraWithPerspectiveFields.fov ?? 45),
      viewportHeightPixels: viewport.y,
      aspectRatio,
      nearMeters,
      farMeters,
    });
  }

  return view;
}

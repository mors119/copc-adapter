import * as Cesium from "cesium";

const DURATION_MS = 25_000;
const KEYFRAME_TIMES_MS = [0, 3_000, 11_000, 17_000, 21_000, DURATION_MS];
const DISTANCE_FACTORS = [1, 1.05, 1.05, 0.32, 0.27, 1];
const ELEVATIONS = [32, 32, 18, 18, 32].map(Cesium.Math.toRadians);

type CameraPath = {
  readonly target: Cesium.Cartesian3;
  readonly east: Cesium.Cartesian3;
  readonly north: Cesium.Cartesian3;
  readonly up: Cesium.Cartesian3;
  readonly startPosition: Cesium.Cartesian3;
  readonly startDirection: Cesium.Cartesian3;
  readonly startUp: Cesium.Cartesian3;
  readonly startDistance: number;
  readonly startElevation: number;
  readonly fitDistance: number;
  readonly startAngle: number;
};

export type CinematicCameraDemo = {
  canPlay(): boolean;
  play(): boolean;
  stop(): void;
  isPlaying(): boolean;
  invalidatePath(): void;
  destroy(): void;
};

/** Animate the current dataset framing without changing Cesium's input controls. */
export function createCinematicCameraDemo(
  viewer: Cesium.Viewer,
  onPlayingChange: (playing: boolean) => void = () => undefined,
): CinematicCameraDemo {
  let path: CameraPath | undefined;
  let frameId = 0;
  let startTimestamp: number | undefined;
  let playing = false;
  let destroyed = false;

  const canvas = viewer.scene.canvas;
  const centerPosition = new Cesium.Cartesian2();
  const relative = new Cesium.Cartesian3();
  const east = new Cesium.Cartesian3();
  const north = new Cesium.Cartesian3();
  const up = new Cesium.Cartesian3();
  const eastOffset = new Cesium.Cartesian3();
  const northOffset = new Cesium.Cartesian3();
  const upOffset = new Cesium.Cartesian3();
  const cameraPosition = new Cesium.Cartesian3();
  const direction = new Cesium.Cartesian3();
  const cameraUp = new Cesium.Cartesian3();
  const cameraRight = new Cesium.Cartesian3();
  const observedCameraPosition = new Cesium.Cartesian3();
  const observedCameraDirection = new Cesium.Cartesian3();
  const observedCameraUp = new Cesium.Cartesian3();
  const animatedViewOptions = {
    destination: cameraPosition,
    orientation: { direction, up: cameraUp },
  };
  const startCartographic = new Cesium.Cartographic();
  const targetCartographic = new Cesium.Cartographic();
  const enuColumn = new Cesium.Cartesian4();
  const enuFrame = new Cesium.Matrix4();
  let frameIndex = 0;

  const onManualCameraInput = (): void => stop();
  const onPointerDown = (): void => onManualCameraInput();
  const onWheel = (): void => onManualCameraInput();
  const onTouchStart = (): void => onManualCameraInput();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target === canvas || canvas.contains(event.target as Node)) {
      onManualCameraInput();
    }
  };

  const removeInputListeners = (): void => {
    canvas.removeEventListener("pointerdown", onPointerDown, true);
    canvas.removeEventListener("wheel", onWheel, true);
    canvas.removeEventListener("touchstart", onTouchStart, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };

  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("wheel", onWheel, true);
  canvas.addEventListener("touchstart", onTouchStart, {
    capture: true,
    passive: true,
  });
  window.addEventListener("keydown", onKeyDown, true);

  const captureCameraPose = (): void => {
    if (viewer.isDestroyed()) return;
    Cesium.Cartesian3.clone(viewer.camera.positionWC, observedCameraPosition);
    Cesium.Cartesian3.clone(viewer.camera.directionWC, observedCameraDirection);
    Cesium.Cartesian3.clone(viewer.camera.upWC, observedCameraUp);
  };

  const cameraPoseChanged = (): boolean =>
    Cesium.Cartesian3.distanceSquared(
      viewer.camera.positionWC,
      observedCameraPosition,
    ) > 1e-10 ||
    Cesium.Cartesian3.distanceSquared(
      viewer.camera.directionWC,
      observedCameraDirection,
    ) > 1e-14 ||
    Cesium.Cartesian3.distanceSquared(viewer.camera.upWC, observedCameraUp) >
      1e-14;

  const onPreRender = (): void => {
    if (destroyed || viewer.isDestroyed()) return;
    if (!playing && path && cameraPoseChanged()) path = undefined;
    captureCameraPose();
  };
  captureCameraPose();
  viewer.scene.preRender.addEventListener(onPreRender);

  const createPath = (): CameraPath | undefined => {
    if (viewer.isDestroyed()) return undefined;
    centerPosition.x = canvas.clientWidth / 2;
    centerPosition.y = canvas.clientHeight / 2;
    const centerRay = viewer.camera.getPickRay(centerPosition);
    const target =
      (centerRay ? viewer.scene.globe.pick(centerRay, viewer.scene) : undefined) ??
      viewer.camera.pickEllipsoid(centerPosition, Cesium.Ellipsoid.WGS84);
    if (!target) return undefined;

    Cesium.Transforms.eastNorthUpToFixedFrame(
      target,
      Cesium.Ellipsoid.WGS84,
      enuFrame,
    );
    Cesium.Cartesian3.fromCartesian4(
      Cesium.Matrix4.getColumn(enuFrame, 0, enuColumn),
      east,
    );
    Cesium.Cartesian3.fromCartesian4(
      Cesium.Matrix4.getColumn(enuFrame, 1, enuColumn),
      north,
    );
    Cesium.Cartesian3.fromCartesian4(
      Cesium.Matrix4.getColumn(enuFrame, 2, enuColumn),
      up,
    );

    const startPosition = Cesium.Cartesian3.clone(viewer.camera.positionWC);
    const startDirection = Cesium.Cartesian3.clone(viewer.camera.directionWC);
    const startUp = Cesium.Cartesian3.clone(viewer.camera.upWC);
    Cesium.Cartesian3.subtract(startPosition, target, relative);
    const startDistance = Cesium.Cartesian3.magnitude(relative);
    if (!Number.isFinite(startDistance) || startDistance < 1) return undefined;

    const eastDistance = Cesium.Cartesian3.dot(relative, east);
    const northDistance = Cesium.Cartesian3.dot(relative, north);
    const upDistance = Cesium.Cartesian3.dot(relative, up);
    const startAngle = Math.atan2(eastDistance, northDistance);
    Cesium.Ellipsoid.WGS84.cartesianToCartographic(
      startPosition,
      startCartographic,
    );
    Cesium.Ellipsoid.WGS84.cartesianToCartographic(target, targetCartographic);
    const verticalFramingDistance = Math.max(
      0,
      startCartographic.height - targetCartographic.height,
    );
    const fitDistance = Math.max(startDistance, verticalFramingDistance);
    const startElevation = Math.asin(
      Cesium.Math.clamp(upDistance / startDistance, -1, 1),
    );

    return {
      target: Cesium.Cartesian3.clone(target),
      east: Cesium.Cartesian3.clone(east),
      north: Cesium.Cartesian3.clone(north),
      up: Cesium.Cartesian3.clone(up),
      startPosition,
      startDirection,
      startUp,
      startDistance,
      startElevation,
      fitDistance,
      startAngle,
    };
  };

  const updateCamera = (elapsedMs: number): void => {
    frameIndex = 0;
    while (
      frameIndex < KEYFRAME_TIMES_MS.length - 2 &&
      elapsedMs >= KEYFRAME_TIMES_MS[frameIndex + 1]!
    ) {
      frameIndex += 1;
    }
    const segmentStart = KEYFRAME_TIMES_MS[frameIndex]!;
    const segmentEnd = KEYFRAME_TIMES_MS[frameIndex + 1]!;
    const amount = Cesium.Math.clamp(
      (elapsedMs - segmentStart) / (segmentEnd - segmentStart),
      0,
      1,
    );
    const eased = amount * amount * (3 - 2 * amount);
    const fromDistance = frameIndex === 0
      ? path!.startDistance
      : DISTANCE_FACTORS[frameIndex]! * path!.fitDistance;
    const toDistance = DISTANCE_FACTORS[frameIndex + 1]! * path!.fitDistance;
    const distance = fromDistance + (toDistance - fromDistance) * eased;
    const fromElevation = frameIndex === 0
      ? path!.startElevation
      : ELEVATIONS[frameIndex - 1]!;
    const toElevation = ELEVATIONS[frameIndex]!;
    const elevation = fromElevation + (toElevation - fromElevation) * eased;
    const angle = path!.startAngle + elapsedMs * (Math.PI * 2 / 15_000);
    const horizontalDistance = distance * Math.cos(elevation);
    const verticalDistance = distance * Math.sin(elevation);

    Cesium.Cartesian3.multiplyByScalar(
      path!.east,
      horizontalDistance * Math.sin(angle),
      eastOffset,
    );
    Cesium.Cartesian3.multiplyByScalar(
      path!.north,
      horizontalDistance * Math.cos(angle),
      northOffset,
    );
    Cesium.Cartesian3.multiplyByScalar(path!.up, verticalDistance, upOffset);
    Cesium.Cartesian3.add(path!.target, eastOffset, cameraPosition);
    Cesium.Cartesian3.add(cameraPosition, northOffset, cameraPosition);
    Cesium.Cartesian3.add(cameraPosition, upOffset, cameraPosition);

    Cesium.Cartesian3.subtract(path!.target, cameraPosition, direction);
    Cesium.Cartesian3.normalize(direction, direction);
    Cesium.Cartesian3.normalize(cameraPosition, cameraUp);
    Cesium.Cartesian3.cross(direction, cameraUp, cameraRight);
    if (Cesium.Cartesian3.magnitudeSquared(cameraRight) < 1e-8) {
      Cesium.Cartesian3.clone(path!.east, cameraRight);
    }
    Cesium.Cartesian3.normalize(cameraRight, cameraRight);
    Cesium.Cartesian3.cross(cameraRight, direction, cameraUp);
    Cesium.Cartesian3.normalize(cameraUp, cameraUp);

    if (elapsedMs <= 0) {
      setInitialView();
      return;
    }
    viewer.camera.setView(animatedViewOptions);
  };

  const setInitialView = (): void => {
    viewer.camera.setView({
      destination: path!.startPosition,
      orientation: {
        direction: path!.startDirection,
        up: path!.startUp,
      },
    });
  };

  const finish = (): void => {
    if (!playing) return;
    playing = false;
    startTimestamp = undefined;
    captureCameraPose();
    onPlayingChange(false);
  };

  const tick = (timestamp: number): void => {
    frameId = 0;
    if (destroyed || viewer.isDestroyed()) {
      finish();
      return;
    }
    startTimestamp ??= timestamp;
    const elapsedMs = Math.min(DURATION_MS, timestamp - startTimestamp);
    updateCamera(elapsedMs);
    if (elapsedMs >= DURATION_MS) {
      finish();
      return;
    }
    frameId = window.requestAnimationFrame(tick);
  };

  function stop(): void {
    if (frameId !== 0) window.cancelAnimationFrame(frameId);
    frameId = 0;
    finish();
  }

  const canPlay = (): boolean => {
    if (destroyed || viewer.isDestroyed()) return false;
    return path !== undefined || createPath() !== undefined;
  };

  return {
    canPlay,
    play(): boolean {
      if (destroyed || viewer.isDestroyed()) return false;
      if (playing) return true;
      path ??= createPath();
      if (!path) return false;
      playing = true;
      startTimestamp = undefined;
      setInitialView();
      onPlayingChange(true);
      frameId = window.requestAnimationFrame(tick);
      return true;
    },
    stop,
    isPlaying: () => playing,
    invalidatePath(): void {
      path = undefined;
    },
    destroy(): void {
      destroyed = true;
      stop();
      removeInputListeners();
      if (!viewer.isDestroyed()) {
        viewer.scene.preRender.removeEventListener(onPreRender);
      }
    },
  };
}

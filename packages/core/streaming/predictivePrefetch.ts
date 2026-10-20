import { createPerspectiveViewFrustum, intersectsViewFrustum } from "./view";
import type {
  BoundingSphere,
  StreamingView,
  ViewFrustum,
  ViewVector3,
} from "./types";
import type { CameraMotionPrediction } from "./motionLookahead";

const MIN_PREDICTED_DISPLACEMENT_DEGREES = 0.05;

function rotateAroundAxis(
  vector: ViewVector3,
  axis: ViewVector3,
  angleRadians: number,
): ViewVector3 {
  const cosine = Math.cos(angleRadians);
  const sine = Math.sin(angleRadians);
  const cross = {
    x: axis.y * vector.z - axis.z * vector.y,
    y: axis.z * vector.x - axis.x * vector.z,
    z: axis.x * vector.y - axis.y * vector.x,
  };
  const projection = axis.x * vector.x + axis.y * vector.y + axis.z * vector.z;
  return {
    x: vector.x * cosine + cross.x * sine + axis.x * projection * (1 - cosine),
    y: vector.y * cosine + cross.y * sine + axis.y * projection * (1 - cosine),
    z: vector.z * cosine + cross.z * sine + axis.z * projection * (1 - cosine),
  };
}

function normalize(vector: ViewVector3): ViewVector3 | undefined {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return Number.isFinite(length) && length > 1e-9
    ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
    : undefined;
}

function cross(left: ViewVector3, right: ViewVector3): ViewVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

/**
 * Build the fixed-horizon camera view predicted by measured angular motion.
 * The camera position and perspective extent stay fixed; only its orientation
 * changes, so the query covers the likely next view instead of padding the
 * current frustum in every direction.
 */
export function createPredictedStreamingView(
  view: StreamingView,
  prediction: CameraMotionPrediction,
): StreamingView | undefined {
  const current = view.viewFrustum;
  const horizontalDegrees = prediction.predictedHorizontalDisplacementDegrees;
  const verticalDegrees = prediction.predictedVerticalDisplacementDegrees;
  if (
    !prediction.enabled ||
    prediction.activity <= 0 ||
    !current ||
    !Number.isFinite(horizontalDegrees) ||
    !Number.isFinite(verticalDegrees) ||
    Math.hypot(horizontalDegrees, verticalDegrees) <
      MIN_PREDICTED_DISPLACEMENT_DEGREES
  ) {
    return undefined;
  }

  const yawRadians = (horizontalDegrees * Math.PI) / 180;
  const pitchRadians = (verticalDegrees * Math.PI) / 180;
  const yawAxis = normalize(cross(current.direction, current.right));
  if (!yawAxis) return undefined;
  const yawDirection = rotateAroundAxis(current.direction, yawAxis, yawRadians);
  const yawRight = rotateAroundAxis(current.right, yawAxis, yawRadians);
  const yawedUp = rotateAroundAxis(current.up, yawAxis, yawRadians);
  const pitchAxis = normalize(cross(yawDirection, yawedUp));
  if (!pitchAxis) return undefined;

  try {
    const frustum = createPerspectiveViewFrustum({
      position: current.position,
      direction: rotateAroundAxis(yawDirection, pitchAxis, pitchRadians),
      up: rotateAroundAxis(yawedUp, pitchAxis, pitchRadians),
      right: yawRight,
      verticalFovRadians: current.verticalFovRadians,
      viewportHeightPixels: current.viewportHeightPixels,
      aspectRatio: current.aspectRatio,
      nearMeters: current.nearMeters,
      farMeters: current.farMeters,
    });
    return { ...view, viewFrustum: frustum };
  } catch {
    return undefined;
  }
}

/** True when two valid perspective views have independently prepared frusta. */
export function isOffscreenFromCurrentView(
  current: ViewFrustum | undefined,
  candidate: ViewFrustum | undefined,
  sphere: BoundingSphere | Omit<BoundingSphere, "coordinateSystem"> | undefined,
): boolean {
  if (!current || !candidate || !sphere) return false;
  return (
    intersectsViewFrustum(candidate, sphere) &&
    !intersectsViewFrustum(current, sphere)
  );
}

import type { StreamingView } from "./types";

const POSITION_EPSILON_METERS = 0.1;
const ORIENTATION_EPSILON = 1e-5;
const DISTANCE_EPSILON_METERS = 1;

function isWithinEpsilon(
  left: number,
  right: number,
  epsilon: number,
): boolean {
  return Math.abs(left - right) <= epsilon;
}

/** Compare normalized views using the tolerances shared by all renderer adapters. */
export function areStreamingViewsEquivalent(
  left: StreamingView,
  right: StreamingView,
): boolean {
  if (
    !isWithinEpsilon(left.longitude, right.longitude, 1e-7) ||
    !isWithinEpsilon(left.latitude, right.latitude, 1e-7) ||
    !isWithinEpsilon(left.height, right.height, POSITION_EPSILON_METERS) ||
    !isWithinEpsilon(
      left.viewDistanceMeters,
      right.viewDistanceMeters,
      DISTANCE_EPSILON_METERS,
    )
  ) {
    return false;
  }

  const leftFrustum = left.viewFrustum;
  const rightFrustum = right.viewFrustum;
  if (!leftFrustum || !rightFrustum) {
    return leftFrustum === rightFrustum;
  }

  return (
    [
      [leftFrustum.position, rightFrustum.position],
      [leftFrustum.direction, rightFrustum.direction],
      [leftFrustum.up, rightFrustum.up],
      [leftFrustum.right, rightFrustum.right],
    ].every(
      ([leftVector, rightVector]) =>
        isWithinEpsilon(leftVector.x, rightVector.x, ORIENTATION_EPSILON) &&
        isWithinEpsilon(leftVector.y, rightVector.y, ORIENTATION_EPSILON) &&
        isWithinEpsilon(leftVector.z, rightVector.z, ORIENTATION_EPSILON),
    ) &&
    isWithinEpsilon(
      leftFrustum.verticalFovRadians,
      rightFrustum.verticalFovRadians,
      ORIENTATION_EPSILON,
    ) &&
    isWithinEpsilon(
      leftFrustum.aspectRatio,
      rightFrustum.aspectRatio,
      ORIENTATION_EPSILON,
    ) &&
    isWithinEpsilon(
      leftFrustum.viewportHeightPixels,
      rightFrustum.viewportHeightPixels,
      1,
    ) &&
    isWithinEpsilon(
      leftFrustum.nearMeters,
      rightFrustum.nearMeters,
      DISTANCE_EPSILON_METERS,
    ) &&
    isWithinEpsilon(
      leftFrustum.farMeters,
      rightFrustum.farMeters,
      DISTANCE_EPSILON_METERS,
    )
  );
}

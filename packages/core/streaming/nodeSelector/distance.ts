import type { StreamingCameraState, StreamingHierarchyNode } from "../types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function calculateSurfaceDistanceMeters(
  startLatitude: number,
  startLongitude: number,
  endLatitude: number,
  endLongitude: number,
): number {
  const earthRadiusMeters = 6371000;
  const latitude1 = toRadians(startLatitude);
  const latitude2 = toRadians(endLatitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(endLongitude - startLongitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(deltaLongitude / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

/**
 * Estimate camera-to-node-centre distance using a spherical WGS84 surface approximation and height delta.
 *
 * @param camera Camera longitude/latitude in degrees and height in metres.
 * @param node Hierarchy node with a geographic centre.
 * @returns Approximate centre distance in metres.
 */
export function calculateDistanceMeters(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): number {
  const surfaceDistance = calculateSurfaceDistanceMeters(
    camera.latitude,
    camera.longitude,
    node.center.latitude,
    node.center.longitude,
  );
  const heightDelta = node.center.height - camera.height;

  return Math.hypot(surfaceDistance, heightDelta);
}

/**
 * Estimate camera distance to the closest point in a node's geographic bounds.
 *
 * @param camera Camera longitude/latitude in degrees and height in metres.
 * @param node Hierarchy node with WGS84 geographic bounds.
 * @returns Approximate closest-bound distance in metres.
 */
export function calculateBoundsDistanceMeters(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): number {
  const closestLongitude = clamp(
    camera.longitude,
    node.bounds.minX,
    node.bounds.maxX,
  );
  const closestLatitude = clamp(
    camera.latitude,
    node.bounds.minY,
    node.bounds.maxY,
  );
  const closestHeight = clamp(
    camera.height,
    node.bounds.minZ,
    node.bounds.maxZ,
  );
  const surfaceDistance = calculateSurfaceDistanceMeters(
    camera.latitude,
    camera.longitude,
    closestLatitude,
    closestLongitude,
  );
  const heightDelta = closestHeight - camera.height;

  return Math.hypot(surfaceDistance, heightDelta);
}


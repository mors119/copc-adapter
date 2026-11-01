import type { SchemaClippingVolume } from "../schema/types.ts";

/** Build the supported ECEF axis-aligned box around one selected world point. */
export function createSelectedPointEcefBox(
  point: readonly [number, number, number] | undefined,
  halfWidthMeters: number,
): SchemaClippingVolume | undefined {
  if (
    !point ||
    point.length !== 3 ||
    !point.every(Number.isFinite) ||
    !Number.isFinite(halfWidthMeters) ||
    halfWidthMeters <= 0
  ) return undefined;
  return {
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: point.map((value) => value - halfWidthMeters) as [number, number, number],
    maximum: point.map((value) => value + halfWidthMeters) as [number, number, number],
  };
}

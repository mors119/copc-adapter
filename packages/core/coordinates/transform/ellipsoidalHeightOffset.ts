/**
 * Write ECEF positions for an absolute additive ellipsoidal-height offset
 * relative to an immutable prepared baseline.
 *
 * The baseline ECEF values must already include `baselineOffsetMeters` and
 * correspond point-for-point to the supplied WGS84 geographic triples. The
 * output is written to a separate Float64Array so repeated offset changes can
 * always start from the same baseline instead of accumulating deltas.
 *
 * This internal primitive only handles placement along the WGS84 ellipsoid
 * normal. Callers must verify source, vertical-grid, and transform provenance
 * before using it for a live layer update.
 *
 * @param baselineEcef Interleaved baseline WGS84 ECEF XYZ in metres.
 * @param baselineGeographic Interleaved WGS84 longitude/latitude/height triples; height is not used.
 * @param baselineOffsetMeters Additive height offset already included in `baselineEcef`.
 * @param targetOffsetMeters Desired absolute additive ellipsoidal-height offset.
 * @param output Optional separate Float64Array receiving the updated ECEF triples.
 * @returns `output`, or a newly allocated Float64Array when omitted.
 * @throws If a buffer is malformed, shares storage with the baseline ECEF array, or an offset is not finite.
 */
export function writeEcefForEllipsoidalHeightOffset(
  baselineEcef: Float64Array,
  baselineGeographic: Float64Array,
  baselineOffsetMeters: number,
  targetOffsetMeters: number,
  output?: Float64Array,
): Float64Array {
  if (
    baselineEcef.length === 0 ||
    baselineEcef.length % 3 !== 0 ||
    baselineGeographic.length !== baselineEcef.length
  ) {
    throw new RangeError(
      "Baseline ECEF and geographic buffers must contain matching XYZ triples",
    );
  }
  if (
    !Number.isFinite(baselineOffsetMeters) ||
    !Number.isFinite(targetOffsetMeters)
  ) {
    throw new RangeError("Height offsets must be finite numbers of metres");
  }

  const destination = output ?? new Float64Array(baselineEcef.length);
  if (destination.length !== baselineEcef.length) {
    throw new RangeError("Output ECEF buffer must match the baseline length");
  }
  if (destination.buffer === baselineEcef.buffer) {
    throw new TypeError("Output ECEF buffer must not share its baseline storage");
  }

  const delta = targetOffsetMeters - baselineOffsetMeters;
  for (let pointIndex = 0; pointIndex < baselineEcef.length; pointIndex += 3) {
    const longitudeDegrees = baselineGeographic[pointIndex];
    const latitudeDegrees = baselineGeographic[pointIndex + 1];
    const baselineX = baselineEcef[pointIndex];
    const baselineY = baselineEcef[pointIndex + 1];
    const baselineZ = baselineEcef[pointIndex + 2];
    if (
      !Number.isFinite(longitudeDegrees) ||
      !Number.isFinite(latitudeDegrees) ||
      latitudeDegrees < -90 ||
      latitudeDegrees > 90 ||
      !Number.isFinite(baselineX) ||
      !Number.isFinite(baselineY) ||
      !Number.isFinite(baselineZ)
    ) {
      throw new RangeError("Baseline positions must contain finite WGS84 values");
    }

    const longitude = (longitudeDegrees * Math.PI) / 180;
    const latitude = (latitudeDegrees * Math.PI) / 180;
    const cosLatitude = Math.cos(latitude);
    destination[pointIndex] =
      baselineX + delta * cosLatitude * Math.cos(longitude);
    destination[pointIndex + 1] =
      baselineY + delta * cosLatitude * Math.sin(longitude);
    destination[pointIndex + 2] = baselineZ + delta * Math.sin(latitude);
  }

  return destination;
}

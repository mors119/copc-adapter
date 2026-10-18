import type { GeographicPoint, CopcMetadata } from '../../core/copc/types/copc';
import { createPointTransformer, createProjectPointTransformer } from '../../core/coordinates/transform/createPointTransformer';
import { geographicToEcef } from '../../core/coordinates/transform/worldCoordinates';

/**
 * Derive one hierarchy node's approximate point spacing in metres.
 *
 * COPC spacing is expressed in source CRS units and represents root-level
 * spacing. Each octree level halves the nominal spacing. Horizontal offsets
 * are passed through the same CRS transforms used for point rendering, then
 * measured in WGS84 ECEF metres. This handles projected units and converts
 * geographic angular units at the node latitude instead of treating degrees
 * as metres.
 *
 * @param metadata Loaded COPC metadata with a usable spacing value.
 * @param level Zero-based octree level.
 * @param center Node center in WGS84 geographic coordinates.
 * @returns Local geometric-mean horizontal spacing in metres, or `undefined`
 * when spacing or CRS semantics cannot produce a finite metric distance.
 */
export function deriveNodePointSpacingMeters(
  metadata: CopcMetadata,
  level: number,
  center: GeographicPoint,
): number | undefined {
  if (!Number.isFinite(metadata.spacing) || (metadata.spacing ?? 0) <= 0
    || !Number.isSafeInteger(level) || level < 0 || level > 1023) {
    return undefined;
  }

  const levelDivisor = 2 ** level;
  const sourceSpacing = (metadata.spacing as number) / levelDivisor;
  if (!Number.isFinite(sourceSpacing) || sourceSpacing <= 0) {
    return undefined;
  }

  try {
    const sourceCenter = createProjectPointTransformer(metadata)(center);
    const toGeographic = createPointTransformer(metadata);
    const origin = geographicToEcef(toGeographic(sourceCenter));
    const east = geographicToEcef(toGeographic({
      ...sourceCenter,
      x: sourceCenter.x + sourceSpacing,
    }));
    const north = geographicToEcef(toGeographic({
      ...sourceCenter,
      y: sourceCenter.y + sourceSpacing,
    }));
    const eastSpacing = distance(origin, east);
    const northSpacing = distance(origin, north);
    const spacingMeters = Math.sqrt(eastSpacing * northSpacing);
    return Number.isFinite(spacingMeters) && spacingMeters > 0
      ? spacingMeters
      : undefined;
  } catch {
    // A usable fixed-size renderer remains available when source CRS
    // semantics cannot support a local spacing estimate.
    return undefined;
  }
}

function distance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

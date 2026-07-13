import proj4 from 'proj4';
import type { CopcMetadata, CopcPoint, GeographicPoint } from '../../copc/types/copc';

function extractHorizontalWkt(wkt: string): string {
  const start = wkt.indexOf('PROJCS[');

  if (start === -1) {
    throw new Error('COPC WKT does not contain a projected horizontal CRS');
  }

  let depth = 0;

  for (let index = start; index < wkt.length; index += 1) {
    const character = wkt[index];

    if (character === '[') {
      depth += 1;
    }

    if (character === ']') {
      depth -= 1;

      if (depth === 0) {
        return wkt.slice(start, index + 1);
      }
    }
  }

  throw new Error('Failed to parse projected CRS from COPC WKT');
}

function extractVerticalUnitScale(wkt: string): number {
  const match = wkt.match(
    /VERT_CS\[[\s\S]*?UNIT\["[^"]+",([0-9.]+(?:e-?\d+)?)(?:,AUTHORITY|\])/i,
  );

  if (!match) {
    return 1;
  }

  return Number(match[1]);
}

function hasGeographicBounds(metadata: CopcMetadata): boolean {
  const { minX, minY, maxX, maxY } = metadata.bounds;

  return (
    minX >= -180 &&
    maxX <= 180 &&
    minY >= -90 &&
    maxY <= 90
  );
}

export function createPointTransformer(
  metadata: CopcMetadata,
): (point: CopcPoint) => GeographicPoint {
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return (point: CopcPoint): GeographicPoint => ({
        longitude: point.x,
        latitude: point.y,
        height: point.z,
      });
    }

    throw new Error(
      'COPC metadata WKT is required to transform projected coordinates for Cesium rendering',
    );
  }

  const horizontalWkt = extractHorizontalWkt(metadata.wkt);
  const verticalUnitScale = extractVerticalUnitScale(metadata.wkt);

  return (point: CopcPoint): GeographicPoint => {
    const [longitude, latitude] = proj4(horizontalWkt, 'WGS84', [point.x, point.y]);

    return {
      longitude,
      latitude,
      height: point.z * verticalUnitScale,
    };
  };
}

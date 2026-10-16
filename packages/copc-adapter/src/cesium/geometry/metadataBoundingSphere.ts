import * as Cesium from 'cesium';
import type { CopcMetadata } from '../../core/copc/types/copc';
import { createPointTransformer } from '../../core/coordinates/transform/createPointTransformer';
import {
  extractHorizontalCrsWkt,
  extractHorizontalUnitScale,
  extractVerticalUnitScale,
} from '../../core/coordinates/crs/parseCopcWkt';

const MINIMUM_SUBDIVISIONS = 8;
const MAXIMUM_SUBDIVISIONS = 256;
const TARGET_PROJECTED_CELL_SIZE_METERS = 25_000;
const MAX_SUPPORTED_PROJECTED_SPAN_METERS = 2_000_000;
const MAX_SUPPORTED_GEOGRAPHIC_SPAN_METERS = 40_100_000;
const MAX_SUPPORTED_HEIGHT_SPAN_METERS = 1_000_000;
const BOUNDARY_PADDING_METERS = 0.05;

/**
 * Build a cached world-space sphere from the complete metadata bounds.
 *
 * Projected bounds are sampled across their full horizontal extent, including
 * each cell centre, and padded by the maximum observed cell spacing and
 * curvature residual. The bounded grid supports local, well-conditioned CRS
 * extents up to 2,000 km per horizontal axis. It deliberately returns
 * `undefined` for larger or invalid extents instead of claiming accuracy for
 * arbitrary projection singularities or global coordinate ranges.
 */
export function createMetadataBoundingSphere(
  metadata: CopcMetadata,
  heightOffsetMeters = 0,
): Cesium.BoundingSphere | undefined {
  try {
    const { minX, minY, minZ, maxX, maxY, maxZ } = metadata.bounds;
    const bounds = [minX, minY, minZ, maxX, maxY, maxZ];
    if (!bounds.every(Number.isFinite)
      || minX > maxX || minY > maxY || minZ > maxZ
      || !Number.isFinite(metadata.pointCount) || metadata.pointCount <= 0
      || !Number.isFinite(heightOffsetMeters)) {
      return undefined;
    }

    const transformPoint = createPointTransformer(metadata, heightOffsetMeters);
    const horizontalWkt = metadata.wkt
      ? extractHorizontalCrsWkt(metadata.wkt)
      : undefined;
    const geographicWkt = horizontalWkt?.startsWith('GEOGCS[') ?? false;
    const inferredGeographic = metadata.wkt === undefined
      && minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
    let horizontalUnitScale: number;
    if (metadata.wkt && geographicWkt) {
      const angularUnit = horizontalWkt?.match(/UNIT\["[^"]+",\s*([0-9.eE+-]+)\s*\]/i);
      const radiansPerSourceUnit = angularUnit ? Number(angularUnit[1]) : undefined;
      if (radiansPerSourceUnit === undefined || !Number.isFinite(radiansPerSourceUnit)
        || radiansPerSourceUnit <= 0) {
        return undefined;
      }
      horizontalUnitScale = radiansPerSourceUnit * 180 / Math.PI * 111_320;
    } else if (metadata.wkt) {
      horizontalUnitScale = extractHorizontalUnitScale(metadata.wkt);
    } else if (inferredGeographic) {
      horizontalUnitScale = 111_320;
    } else {
      horizontalUnitScale = 1;
    }
    const verticalUnitScale = metadata.wkt
      ? extractVerticalUnitScale(metadata.wkt)
      : 1;
    if (!Number.isFinite(horizontalUnitScale) || horizontalUnitScale <= 0
      || !Number.isFinite(verticalUnitScale) || verticalUnitScale <= 0) {
      return undefined;
    }

    const sourceWidthMeters = (maxX - minX) * horizontalUnitScale;
    const sourceHeightMeters = (maxY - minY) * horizontalUnitScale;
    const sourceVerticalSpanMeters = (maxZ - minZ) * verticalUnitScale;
    if (!Number.isFinite(sourceWidthMeters) || !Number.isFinite(sourceHeightMeters)
      || !Number.isFinite(sourceVerticalSpanMeters)
      || (inferredGeographic || geographicWkt
        ? sourceWidthMeters > MAX_SUPPORTED_GEOGRAPHIC_SPAN_METERS
          || sourceHeightMeters > MAX_SUPPORTED_GEOGRAPHIC_SPAN_METERS
        : sourceWidthMeters > MAX_SUPPORTED_PROJECTED_SPAN_METERS
          || sourceHeightMeters > MAX_SUPPORTED_PROJECTED_SPAN_METERS)
      || sourceVerticalSpanMeters > MAX_SUPPORTED_HEIGHT_SPAN_METERS) {
      return undefined;
    }

    const subdivisions = Math.min(
      MAXIMUM_SUBDIVISIONS,
      Math.max(
        MINIMUM_SUBDIVISIONS,
        Math.ceil(Math.max(sourceWidthMeters, sourceHeightMeters)
          / TARGET_PROJECTED_CELL_SIZE_METERS),
      ),
    );
    const positions: Cesium.Cartesian3[] = [];
    let maximumHorizontalSampleStep = 0;
    let maximumCellResidual = 0;

    const sourcePointAt = (xRatio: number, yRatio: number, z: number) => {
      const sourcePoint = {
        x: minX + (maxX - minX) * xRatio,
        y: minY + (maxY - minY) * yRatio,
        z,
      };
      const geographicPoint = transformPoint(sourcePoint);
      if (!Number.isFinite(geographicPoint.longitude)
        || !Number.isFinite(geographicPoint.latitude)
        || !Number.isFinite(geographicPoint.height)
        || geographicPoint.latitude < -90 || geographicPoint.latitude > 90) {
        throw new Error('Transformed COPC bounds contain invalid geographic coordinates');
      }
      const worldPoint = Cesium.Cartesian3.fromDegrees(
        geographicPoint.longitude,
        geographicPoint.latitude,
        geographicPoint.height,
      );
      if (![worldPoint.x, worldPoint.y, worldPoint.z].every(Number.isFinite)) {
        throw new Error('Transformed COPC bounds contain invalid ECEF coordinates');
      }
      return worldPoint;
    };

    const lowGrid: Cesium.Cartesian3[][] = [];
    const highGrid: Cesium.Cartesian3[][] = [];
    for (let yIndex = 0; yIndex <= subdivisions; yIndex += 1) {
      const yRatio = yIndex / subdivisions;
      const lowRow: Cesium.Cartesian3[] = [];
      const highRow: Cesium.Cartesian3[] = [];
      for (let xIndex = 0; xIndex <= subdivisions; xIndex += 1) {
        const xRatio = xIndex / subdivisions;
        const lowPoint = sourcePointAt(xRatio, yRatio, minZ);
        const highPoint = minZ === maxZ
          ? lowPoint
          : sourcePointAt(xRatio, yRatio, maxZ);
        lowRow.push(lowPoint);
        highRow.push(highPoint);
        positions.push(lowPoint);
        if (highPoint !== lowPoint) {
          positions.push(highPoint);
        }
        if (xIndex > 0) {
          maximumHorizontalSampleStep = Math.max(
            maximumHorizontalSampleStep,
            Cesium.Cartesian3.distance(lowPoint, lowRow[xIndex - 1]),
            Cesium.Cartesian3.distance(highPoint, highRow[xIndex - 1]),
          );
        }
        if (yIndex > 0) {
          maximumHorizontalSampleStep = Math.max(
            maximumHorizontalSampleStep,
            Cesium.Cartesian3.distance(lowPoint, lowGrid[yIndex - 1][xIndex]),
            Cesium.Cartesian3.distance(highPoint, highGrid[yIndex - 1][xIndex]),
          );
        }
      }
      lowGrid.push(lowRow);
      highGrid.push(highRow);
    }

    for (let yIndex = 0; yIndex < subdivisions; yIndex += 1) {
      for (let xIndex = 0; xIndex < subdivisions; xIndex += 1) {
        const xRatio = (xIndex + 0.5) / subdivisions;
        const yRatio = (yIndex + 0.5) / subdivisions;
        const cornerIndices = [
          [yIndex, xIndex],
          [yIndex, xIndex + 1],
          [yIndex + 1, xIndex],
          [yIndex + 1, xIndex + 1],
        ] as const;
        for (const z of minZ === maxZ ? [minZ] : [minZ, maxZ]) {
          const sample = sourcePointAt(xRatio, yRatio, z);
          positions.push(sample);
          const grid = z === minZ ? lowGrid : highGrid;
          const estimate = cornerIndices.reduce((sum, [row, column]) => {
            return Cesium.Cartesian3.add(sum, grid[row][column], sum);
          }, new Cesium.Cartesian3());
          Cesium.Cartesian3.multiplyByScalar(estimate, 0.25, estimate);
          maximumCellResidual = Math.max(
            maximumCellResidual,
            Cesium.Cartesian3.distance(sample, estimate),
          );
        }
      }
    }

    const sphere = Cesium.BoundingSphere.fromPoints(positions);
    const expectedCellDiagonalMeters = Math.hypot(
      sourceWidthMeters / subdivisions,
      sourceHeightMeters / subdivisions,
    );
    if (maximumHorizontalSampleStep > Math.max(1, expectedCellDiagonalMeters) * 4) {
      return undefined;
    }
    const padding = Math.SQRT2 * maximumHorizontalSampleStep
      + 4 * maximumCellResidual
      + BOUNDARY_PADDING_METERS;
    if (![sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius, padding]
      .every(Number.isFinite) || sphere.radius < 0 || padding < 0) {
      return undefined;
    }
    sphere.radius += padding;
    return sphere;
  } catch {
    return undefined;
  }
}

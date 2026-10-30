import * as Cesium from "cesium";
import type {
  GeographicPoint,
  GeographicPointBuffer,
} from "../../core/copc/types/copc";
import type { CopcElevationRange } from "../../core/point/style/pointStyle";
import type { RenderablePointData } from "../../core/point/compactEPointCache";
import {
  isCompactEPointCacheNode,
  getPreparedPointHeight,
  getPreparedWorldCoordinateBuffer,
} from "../../core/point/compactEPointCache";
import {
  getPointColor,
  type CopcColorMode,
  type CopcPointStyleOptions,
} from "../style/pointStyle";
import { resolveCopcPointStyleOptions } from "../../core/point/style/pointStyle";
import { performanceNow } from "../../core/copc/performance";

export {
  getPointBufferElevationRange,
  getPointBufferIntensityRange,
  getPointBufferRgbMax,
} from "../../core/point/style/pointStyle";
export type { CopcElevationRange } from "../../core/point/style/pointStyle";

/** Configuration for converting a prepared point buffer into Cesium primitives. */
export type CopcPointRenderOptions = {
  /** Cesium point diameter in screen pixels. */
  pointSize: number;
  /** Attribute-to-color mapping; defaults are resolved by the shared style helper. */
  colorMode?: CopcColorMode;
  /** Optional height range in metres used by elevation coloring. */
  elevationRange?: CopcElevationRange;
  /** Optional palette and interpolation used by elevation coloring. */
  elevationStyle?: CopcPointStyleOptions["elevationStyle"];
  /** Maximum expected source RGB channel value for normalization. */
  rgbMax?: 255 | 65535;
  /** Numeric dimension ramp for `colorMode: 'dimension'`. */
  dimension?: CopcPointStyleOptions["dimension"];
  /** Supplies the Cesium pick id for each zero-based point index. */
  pointId?: (pointIndex: number) => unknown;
  /** Controls whether each point primitive is shown. */
  pointFilter?: (pointIndex: number) => boolean;
  /** Receives elapsed CPU time for each completed preparation/rendering stage. */
  onPerformance?: (
    stage:
      | "geographicToCartesian"
      | "worldToCartesian"
      | "pointStylePreparation"
      | "pointCollectionCreation"
      | "pointAdd",
    durationMs: number,
  ) => void;
};

/**
 * Convert WGS84 geographic points to Cesium world positions.
 *
 * Longitudes and latitudes are degrees; heights are metres above the WGS84
 * ellipsoid, matching Cesium's `Cartesian3.fromDegrees` input convention.
 *
 * @param points Geographic positions to convert.
 * @returns One Cesium ECEF Cartesian position per input point.
 */
export function toCartesian3Array(
  points: GeographicPoint[],
): Cesium.Cartesian3[] {
  return points.map((point) =>
    Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
      point.height,
    ),
  );
}

/**
 * Convert a packed point buffer to Cesium world positions.
 *
 * Uses retained WGS84 ECEF metre coordinates when present; otherwise it
 * converts the buffer's WGS84 longitude/latitude/height triples.
 *
 * @param points Buffer containing one of the supported prepared coordinate spaces.
 * @returns One Cesium ECEF Cartesian position per point.
 * @throws If retained ECEF data is malformed, uses an unsupported coordinate
 * system, or contains non-finite values.
 */
export function toCartesian3ArrayFromBuffer(
  points: GeographicPointBuffer | RenderablePointData,
): Cesium.Cartesian3[] {
  if (isCompactEPointCacheNode(points)) {
    return toCartesian3ArrayFromWorldBuffer(points);
  }
  if (points.worldCoordinates !== undefined) {
    return toCartesian3ArrayFromWorldBuffer(points);
  }

  const positions: Cesium.Cartesian3[] = [];

  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;

    positions.push(
      Cesium.Cartesian3.fromDegrees(
        points.coordinates[offset],
        points.coordinates[offset + 1],
        getPreparedPointHeight(points, index),
      ),
    );
  }

  return positions;
}

/**
 * Wrap prepared WGS84 ECEF metres directly in Cesium Cartesian3 values.
 *
 * This deliberately does not call `Cartesian3.fromDegrees`; the Rust and JS
 * preparation paths already produced the authoritative ECEF render buffer.
 */
export function toCartesian3ArrayFromWorldBuffer(
  points: GeographicPointBuffer | RenderablePointData,
): Cesium.Cartesian3[] {
  const compactE = isCompactEPointCacheNode(points);
  const worldCoordinates = compactE ? points.ecef : points.worldCoordinates;
  if (!worldCoordinates) {
    throw new Error("Prepared point data is missing world coordinates");
  }
  if (!compactE && points.worldCoordinateSystem !== "wgs84-ecef-meters") {
    throw new Error("Prepared world coordinates must use wgs84-ecef-meters");
  }
  if (worldCoordinates.length !== points.pointCount * 3) {
    throw new Error(
      "Prepared world coordinates must contain three values per point",
    );
  }

  const positions: Cesium.Cartesian3[] = [];
  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;
    const x = worldCoordinates[offset];
    const y = worldCoordinates[offset + 1];
    const z = worldCoordinates[offset + 2];
    if (![x, y, z].every(Number.isFinite)) {
      throw new Error("Prepared world coordinates must be finite");
    }
    positions.push(new Cesium.Cartesian3(x, y, z));
  }

  return positions;
}

/**
 * Create and populate a Cesium point collection from prepared point data.
 *
 * The collection is added to `primitiveCollection`, which defaults to the
 * viewer's scene primitives. The caller controls its visibility and lifetime
 * through the returned collection or its parent collection.
 *
 * @param viewer Viewer whose Cesium scene supplies the default primitive collection.
 * @param points Prepared WGS84 geographic data, optionally with retained ECEF coordinates.
 * @param options Point size, styling, picking, filtering, and timing callbacks.
 * @param primitiveCollection Parent collection to receive the created collection.
 * @returns The populated point collection attached to `primitiveCollection`.
 * @throws If point conversion, style preparation, or Cesium primitive creation fails.
 */
export function renderCopcPoints(
  viewer: Cesium.Viewer,
  points: GeographicPointBuffer | RenderablePointData,
  options: CopcPointRenderOptions,
  primitiveCollection: Cesium.PrimitiveCollection = viewer.scene.primitives,
): Cesium.PointPrimitiveCollection {
  const collectionStartedAt = performanceNow();
  const collection = new Cesium.PointPrimitiveCollection();
  try {
    primitiveCollection.add(collection);
    options.onPerformance?.(
      "pointCollectionCreation",
      performanceNow() - collectionStartedAt,
    );
    const positionsStartedAt = performanceNow();
    const positions = toCartesian3ArrayFromBuffer(points);
    options.onPerformance?.(
      getPreparedWorldCoordinateBuffer(points) === undefined
        ? "geographicToCartesian"
        : "worldToCartesian",
      performanceNow() - positionsStartedAt,
    );
    const styleOptions: CopcPointStyleOptions = resolveCopcPointStyleOptions(
      points,
      {
        colorMode: options.colorMode,
        elevationRange: options.elevationRange,
        elevationStyle: options.elevationStyle,
        rgbMax: options.rgbMax,
        dimension: options.dimension,
      },
    );

    const styleStartedAt = performanceNow();
    const colors = positions.map((_, index) =>
      getPointColor(
        getPreparedPointHeight(points, index),
        styleOptions,
        points.attributes,
        index,
      ),
    );
    options.onPerformance?.(
      "pointStylePreparation",
      performanceNow() - styleStartedAt,
    );
    const addStartedAt = performanceNow();
    for (let index = 0; index < positions.length; index += 1) {
      collection.add({
        position: positions[index],
        pixelSize: options.pointSize,
        color: colors[index],
        id: options.pointId?.(index),
        show: options.pointFilter?.(index) ?? true,
      });
    }
    options.onPerformance?.("pointAdd", performanceNow() - addStartedAt);

    return collection;
  } catch (error: unknown) {
    primitiveCollection.remove(collection);
    throw error;
  }
}

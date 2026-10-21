import proj4 from "proj4";
import type {
  CopcMetadata,
  CopcPoint,
  CopcPointBuffer,
  GeographicPoint,
  GeographicPointBuffer,
  PreparedPointData,
} from "../../copc/types/copc";
import {
  createPreparedPointData,
  preparedPointDataToGeographicBuffer,
  assertPreparedPointData,
} from "../../point/preparedPoint";
import { geographicToEcef } from "./worldCoordinates";
import {
  extractHorizontalCrsWkt,
  extractVerticalUnitScale,
} from "../crs/parseCopcWkt";
import { resolveHeightOffsetMeters } from "./heightOffset";
import type { GtxGeoidGrid } from "./verticalGrid";

function hasGeographicBounds(metadata: CopcMetadata): boolean {
  const { minX, minY, maxX, maxY } = metadata.bounds;

  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
}

/**
 * Create a source-XYZ to WGS84 geographic transform for one dataset.
 *
 * Horizontal results use longitude/latitude degrees; height is WGS84
 * ellipsoidal metres. Projected source coordinates require metadata WKT. When
 * WKT is absent, only metadata whose bounds look geographic can use the
 * identity horizontal mapping.
 *
 * @param heightOffsetMeters Additive correction to transformed ellipsoidal height; defaults to 0.
 * @param options.sampleVerticalGrid Set false only for synthetic bounds that are expanded using the grid's extrema.
 * @throws If projected coordinates have no usable WKT.
 */
export function createPointTransformer(
  metadata: CopcMetadata,
  heightOffsetMeters = 0,
  verticalGrid?: GtxGeoidGrid,
  options: { sampleVerticalGrid?: boolean } = {},
): (point: CopcPoint) => GeographicPoint {
  const heightOffset = resolveHeightOffsetMeters(heightOffsetMeters);
  const sampleVerticalGrid = options.sampleVerticalGrid !== false;
  const verticalUnitScale = verticalGrid
    ? verticalGrid.getSourceVerticalUnitScale(metadata.wkt)
    : metadata.wkt
      ? extractVerticalUnitScale(metadata.wkt)
      : 1;
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return (point: CopcPoint): GeographicPoint => ({
        longitude: point.x,
        latitude: point.y,
        height: heightOffset === 0 ? point.z : point.z + heightOffset,
      });
    }

    throw new Error(
      "COPC metadata WKT is required to transform projected coordinates for geographic rendering",
    );
  }

  const horizontalWkt = extractHorizontalCrsWkt(metadata.wkt);
  const projection = proj4(horizontalWkt, "WGS84");

  return (point: CopcPoint): GeographicPoint => {
    const [longitude, latitude] = projection.forward([point.x, point.y]);
    const convertedHeight = point.z * verticalUnitScale;
    const verticalHeight =
      verticalGrid && sampleVerticalGrid
        ? verticalGrid.transformHeight(
            convertedHeight,
            longitude,
            latitude,
            "orthometric-to-ellipsoidal",
          )
        : convertedHeight;

    return {
      longitude,
      latitude,
      height:
        heightOffset === 0 ? verticalHeight : verticalHeight + heightOffset,
    };
  };
}

/**
 * Create a WGS84 geographic to COPC source-XYZ transform for view queries.
 *
 * @param heightOffsetMeters Correction previously applied to ellipsoidal height; defaults to 0 and is removed before inverse transformation.
 * @param options.sampleVerticalGrid Set false only for synthetic bounds that are expanded using the grid's extrema.
 * @throws If projected source coordinates have no usable WKT.
 */
export function createProjectPointTransformer(
  metadata: CopcMetadata,
  heightOffsetMeters = 0,
  verticalGrid?: GtxGeoidGrid,
  options: { sampleVerticalGrid?: boolean } = {},
): (point: GeographicPoint) => CopcPoint {
  const heightOffset = resolveHeightOffsetMeters(heightOffsetMeters);
  const sampleVerticalGrid = options.sampleVerticalGrid !== false;
  const verticalUnitScale = verticalGrid
    ? verticalGrid.getSourceVerticalUnitScale(metadata.wkt)
    : metadata.wkt
      ? extractVerticalUnitScale(metadata.wkt)
      : 1;
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return (point: GeographicPoint): CopcPoint => ({
        x: point.longitude,
        y: point.latitude,
        z: point.height - heightOffset,
      });
    }

    throw new Error(
      "COPC metadata WKT is required to transform projected view bounds",
    );
  }

  const horizontalWkt = extractHorizontalCrsWkt(metadata.wkt);
  const projection = proj4(horizontalWkt, "WGS84");

  return (point: GeographicPoint): CopcPoint => {
    const [x, y] = projection.inverse([point.longitude, point.latitude]);
    const offsetRemovedHeight = point.height - heightOffset;
    const sourceVerticalHeight =
      verticalGrid && sampleVerticalGrid
        ? verticalGrid.transformHeight(
            offsetRemovedHeight,
            point.longitude,
            point.latitude,
            "ellipsoidal-to-orthometric",
          )
        : offsetRemovedHeight;

    return {
      x,
      y,
      z: sourceVerticalHeight / verticalUnitScale,
    };
  };
}

/**
 * Transform decoded source triples to a geographic point buffer.
 *
 * Longitude/latitude are stored in degrees and height in WGS84 ellipsoidal
 * metres. Source and ECEF buffers are retained by the returned compatibility
 * shape when available.
 *
 * @param heightOffsetMeters Additive ellipsoidal-height correction; defaults to 0.
 */
export function transformPointBuffer(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
  heightOffsetMeters = 0,
  verticalGrid?: GtxGeoidGrid,
): GeographicPointBuffer {
  return preparedPointDataToGeographicBuffer(
    transformPointBufferToPreparedPointData(
      metadata,
      points,
      heightOffsetMeters,
      verticalGrid,
    ),
  );
}

/**
 * Prepare the shared point data after source CRS conversion.
 *
 * The result retains source, WGS84 geographic, and ECEF coordinate buffers in
 * Float64 form for renderer adapters and the streaming cache.
 */
export function transformPointBufferToPointData(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
  heightOffsetMeters = 0,
  verticalGrid?: GtxGeoidGrid,
): PreparedPointData {
  return transformPointBufferToPreparedPointData(
    metadata,
    points,
    heightOffsetMeters,
    verticalGrid,
  );
}

/**
 * Prepare source points into the shared, renderer-neutral data contract.
 *
 * Retains source CRS, WGS84 geographic, and ECEF buffers as Float64 arrays.
 *
 * @param heightOffsetMeters Additive ellipsoidal-height correction; defaults to 0.
 */
export function transformPointBufferToPreparedPointData(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
  heightOffsetMeters = 0,
  verticalGrid?: GtxGeoidGrid,
): PreparedPointData {
  const transformPoint = createPointTransformer(
    metadata,
    heightOffsetMeters,
    verticalGrid,
  );
  const sourceCoordinates = points.coordinates.slice();
  const geographicCoordinates = new Float64Array(points.coordinates.length);
  const worldCoordinates = new Float64Array(points.coordinates.length);

  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;
    const point = transformPoint({
      x: points.coordinates[offset],
      y: points.coordinates[offset + 1],
      z: points.coordinates[offset + 2],
    });

    geographicCoordinates[offset] = point.longitude;
    geographicCoordinates[offset + 1] = point.latitude;
    geographicCoordinates[offset + 2] = point.height;

    const world = geographicToEcef(point);
    worldCoordinates[offset] = world.x;
    worldCoordinates[offset + 1] = world.y;
    worldCoordinates[offset + 2] = world.z;
  }

  return createPreparedPointData({
    pointCount: points.pointCount,
    sourceCoordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes: points.attributes,
  });
}

/**
 * Apply an additional ellipsoidal-height correction to prepared points.
 *
 * Source coordinates are unchanged; geographic heights and ECEF positions
 * are recomputed. A zero correction returns the original prepared object.
 *
 * @param heightOffsetDeltaMeters Additional correction in metres.
 */
export function applyPreparedPointHeightOffset(
  prepared: PreparedPointData,
  heightOffsetDeltaMeters: number,
): PreparedPointData {
  const heightOffsetDelta = resolveHeightOffsetMeters(heightOffsetDeltaMeters);
  assertPreparedPointData(prepared);
  if (heightOffsetDelta === 0) {
    return prepared;
  }

  const geographicCoordinates = prepared.geographic.coordinates.slice();
  const worldCoordinates = new Float64Array(prepared.pointCount * 3);
  for (let index = 0; index < prepared.pointCount; index += 1) {
    const offset = index * 3;
    const point = {
      longitude: geographicCoordinates[offset],
      latitude: geographicCoordinates[offset + 1],
      height: geographicCoordinates[offset + 2] + heightOffsetDelta,
    };
    geographicCoordinates[offset + 2] = point.height;

    const world = geographicToEcef(point);
    worldCoordinates[offset] = world.x;
    worldCoordinates[offset + 1] = world.y;
    worldCoordinates[offset + 2] = world.z;
  }

  return createPreparedPointData({
    pointCount: prepared.pointCount,
    sourceCoordinates: prepared.source.coordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes: prepared.attributes,
  });
}

/**
 * Apply a vertical grid once to shared prepared data, including Rust/WASM
 * output. The source buffer remains untouched and ECEF is rebuilt from the
 * corrected geographic heights.
 */
export function applyPreparedPointVerticalGrid(
  prepared: PreparedPointData,
  verticalGrid: GtxGeoidGrid,
): PreparedPointData {
  assertPreparedPointData(prepared);
  const geographicCoordinates = prepared.geographic.coordinates.slice();
  const worldCoordinates = new Float64Array(prepared.pointCount * 3);
  for (let index = 0; index < prepared.pointCount; index += 1) {
    const offset = index * 3;
    const longitude = geographicCoordinates[offset];
    const latitude = geographicCoordinates[offset + 1];
    const height = verticalGrid.transformHeight(
      geographicCoordinates[offset + 2],
      longitude,
      latitude,
      "orthometric-to-ellipsoidal",
    );
    geographicCoordinates[offset + 2] = height;
    const world = geographicToEcef({ longitude, latitude, height });
    worldCoordinates[offset] = world.x;
    worldCoordinates[offset + 1] = world.y;
    worldCoordinates[offset + 2] = world.z;
  }
  return createPreparedPointData({
    pointCount: prepared.pointCount,
    sourceCoordinates: prepared.source.coordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes: prepared.attributes,
  });
}

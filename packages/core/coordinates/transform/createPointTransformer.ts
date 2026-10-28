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
  getPreparedCoordinateOperations,
  recordPreparedCoordinateOperations,
} from "../../point/preparedPoint";
import { geographicToEcef } from "./worldCoordinates";
import {
  extractHorizontalCrsWkt,
  extractVerticalUnitScale,
  getHorizontalAxisDirections,
} from "../crs/parseCopcWkt";
import { resolveHeightOffsetMeters } from "./heightOffset";
import type { GtxGeoidGrid } from "./verticalGrid";
import {
  getCoordinateTransformPlan,
  type CoordinateTransformPlan,
} from "./coordinateTransformPlan";

/** Coordinate conversion callable with the immutable plan used to build it. */
export type PlannedCoordinateTransformer<TInput, TOutput> = ((point: TInput) => TOutput) & {
  /** Dataset-scoped source/target, stage order, and operation provenance. */
  readonly plan: CoordinateTransformPlan;
};

function withPlan<TInput, TOutput>(
  transform: (point: TInput) => TOutput,
  plan: CoordinateTransformPlan,
): PlannedCoordinateTransformer<TInput, TOutput> {
  Object.defineProperty(transform, "plan", {
    value: plan,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return transform as PlannedCoordinateTransformer<TInput, TOutput>;
}

function verticalGridOperationIdentity(grid: GtxGeoidGrid): string {
  return JSON.stringify([
    grid.gridId,
    grid.sha256,
    grid.sourceVerticalCrs,
    grid.targetVerticalCrs,
    grid.horizontalCrs,
    grid.referenceEllipsoid,
    grid.valueUnit,
    grid.valueConvention,
    grid.noDataValue,
    grid.interpolation,
    grid.longitudeOrigin,
    grid.latitudeOrigin,
    grid.longitudeStep,
    grid.latitudeStep,
    grid.width,
    grid.height,
    grid.sourceCoordinateEpoch ?? null,
    grid.gridReferenceEpoch ?? null,
  ]);
}

function hasGeographicBounds(metadata: CopcMetadata): boolean {
  const { minX, minY, maxX, maxY } = metadata.bounds;

  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
}

type HorizontalAxisDirections = NonNullable<ReturnType<typeof getHorizontalAxisDirections>>;

function sourceAxesToProjectionTuple(
  first: number,
  second: number,
  directions: HorizontalAxisDirections | undefined,
): [number, number] {
  if (!directions) return [first, second];
  let eastOrLongitude = Number.NaN;
  let northOrLatitude = Number.NaN;
  directions.forEach((direction, index) => {
    const coordinate = index === 0 ? first : second;
    const sign = direction === "west" || direction === "south" ? -1 : 1;
    if (direction === "east" || direction === "west") eastOrLongitude = coordinate * sign;
    else northOrLatitude = coordinate * sign;
  });
  return [eastOrLongitude, northOrLatitude];
}

function projectionTupleToSourceAxes(
  eastOrLongitude: number,
  northOrLatitude: number,
  directions: HorizontalAxisDirections | undefined,
): [number, number] {
  if (!directions) return [eastOrLongitude, northOrLatitude];
  const coordinateFor = (direction: HorizontalAxisDirections[number]): number => {
    const value = direction === "east" || direction === "west"
      ? eastOrLongitude
      : northOrLatitude;
    return direction === "west" || direction === "south" ? -value : value;
  };
  return [coordinateFor(directions[0]), coordinateFor(directions[1])];
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
): PlannedCoordinateTransformer<CopcPoint, GeographicPoint> {
  const plan = getCoordinateTransformPlan(metadata, {
    heightOffsetMeters,
    verticalGrid,
    sampleVerticalGrid: options.sampleVerticalGrid,
  });
  const heightOffset = plan.manualHeightOffsetMeters;
  const sampleVerticalGrid = options.sampleVerticalGrid !== false;
  const verticalUnitScale = plan.source.verticalUnitConversion.scaleToMeters ??
    (verticalGrid
      ? verticalGrid.getSourceVerticalUnitScale(metadata.wkt)
      : metadata.wkt
        ? extractVerticalUnitScale(metadata.wkt)
        : 1);
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return withPlan(
        (point: CopcPoint): GeographicPoint => ({
          longitude: point.x,
          latitude: point.y,
          height: heightOffset === 0 ? point.z : point.z + heightOffset,
        }),
        plan,
      );
    }

    throw new Error(
      "COPC metadata WKT is required to transform projected coordinates for geographic rendering",
    );
  }

  const horizontalWkt = extractHorizontalCrsWkt(metadata.wkt);
  const sourceAxisDirections = getHorizontalAxisDirections(metadata.wkt);
  const projection = proj4(horizontalWkt, "WGS84");

  return withPlan((point: CopcPoint): GeographicPoint => {
    const [projectionX, projectionY] = sourceAxesToProjectionTuple(
      point.x,
      point.y,
      sourceAxisDirections,
    );
    const [longitude, latitude] = projection.forward([projectionX, projectionY]);
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
  }, plan);
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
): PlannedCoordinateTransformer<GeographicPoint, CopcPoint> {
  const plan = getCoordinateTransformPlan(metadata, {
    heightOffsetMeters,
    verticalGrid,
    sampleVerticalGrid: options.sampleVerticalGrid,
  });
  const heightOffset = plan.manualHeightOffsetMeters;
  const sampleVerticalGrid = options.sampleVerticalGrid !== false;
  const verticalUnitScale = plan.source.verticalUnitConversion.scaleToMeters ??
    (verticalGrid
      ? verticalGrid.getSourceVerticalUnitScale(metadata.wkt)
      : metadata.wkt
        ? extractVerticalUnitScale(metadata.wkt)
        : 1);
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return withPlan(
        (point: GeographicPoint): CopcPoint => ({
          x: point.longitude,
          y: point.latitude,
          z: point.height - heightOffset,
        }),
        plan,
      );
    }

    throw new Error(
      "COPC metadata WKT is required to transform projected view bounds",
    );
  }

  const horizontalWkt = extractHorizontalCrsWkt(metadata.wkt);
  const sourceAxisDirections = getHorizontalAxisDirections(metadata.wkt);
  const projection = proj4(horizontalWkt, "WGS84");

  return withPlan((point: GeographicPoint): CopcPoint => {
    const [projectionX, projectionY] = projection.inverse([point.longitude, point.latitude]);
    const [x, y] = projectionTupleToSourceAxes(
      projectionX,
      projectionY,
      sourceAxisDirections,
    );
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
  }, plan);
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

  const prepared = createPreparedPointData({
    pointCount: points.pointCount,
    sourceCoordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes: points.attributes,
  });
  recordPreparedCoordinateOperations(prepared, {
    manualHeightOffsetMeters: transformPoint.plan.manualHeightOffsetMeters,
    ...(verticalGrid
      ? { verticalGridIdentity: verticalGridOperationIdentity(verticalGrid) }
      : {}),
  });
  return prepared;
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

  const result = createPreparedPointData({
    pointCount: prepared.pointCount,
    sourceCoordinates: prepared.source.coordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes: prepared.attributes,
  });
  const state = getPreparedCoordinateOperations(prepared);
  recordPreparedCoordinateOperations(result, {
    ...(state?.verticalGridIdentity
      ? { verticalGridIdentity: state.verticalGridIdentity }
      : {}),
    manualHeightOffsetMeters:
      (state?.manualHeightOffsetMeters ?? 0) + heightOffsetDelta,
  });
  return result;
}

/**
 * Apply a vertical grid once to shared prepared data, including Rust/WASM
 * output. Any backend-fused manual offset is removed before grid conversion,
 * then the configured manual offset is applied after the grid. The source
 * buffer remains untouched and ECEF is rebuilt from the corrected heights.
 */
export function applyPreparedPointVerticalGrid(
  prepared: PreparedPointData,
  verticalGrid: GtxGeoidGrid,
  options: {
    /** Height offset already fused into backend-prepared input. */
    alreadyAppliedHeightOffsetMeters?: number;
    /** Manual ellipsoidal-height offset to apply after the grid operation. */
    targetHeightOffsetMeters?: number;
  } = {},
): PreparedPointData {
  assertPreparedPointData(prepared);
  const targetHeightOffset = resolveHeightOffsetMeters(
    options.targetHeightOffsetMeters,
  );
  const priorOperations = getPreparedCoordinateOperations(prepared);
  const priorOffset = priorOperations?.manualHeightOffsetMeters;
  if (
    priorOffset !== undefined &&
    options.alreadyAppliedHeightOffsetMeters !== undefined &&
    priorOffset !== options.alreadyAppliedHeightOffsetMeters
  ) {
    throw new Error(
      "Prepared manual height offset provenance does not match the configured backend offset",
    );
  }
  const alreadyAppliedOffset = priorOffset ?? resolveHeightOffsetMeters(
    options.alreadyAppliedHeightOffsetMeters,
  );
  const targetOffset = options.targetHeightOffsetMeters === undefined
    ? alreadyAppliedOffset
    : targetHeightOffset;
  const gridIdentity = verticalGridOperationIdentity(verticalGrid);
  if (priorOperations?.verticalGridIdentity) {
    if (priorOperations.verticalGridIdentity !== gridIdentity) {
      throw new Error(
        "Prepared points already contain a different vertical grid operation",
      );
    }
    return targetOffset === alreadyAppliedOffset
      ? prepared
      : applyPreparedPointHeightOffset(
          prepared,
          targetOffset - alreadyAppliedOffset,
        );
  }
  const geographicCoordinates = prepared.geographic.coordinates.slice();
  const worldCoordinates = new Float64Array(prepared.pointCount * 3);
  for (let index = 0; index < prepared.pointCount; index += 1) {
    const offset = index * 3;
    const longitude = geographicCoordinates[offset];
    const latitude = geographicCoordinates[offset + 1];
    const sourceEllipsoidalHeight =
      geographicCoordinates[offset + 2] - alreadyAppliedOffset;
    const gridCorrectedHeight = verticalGrid.transformHeight(
      sourceEllipsoidalHeight,
      longitude,
      latitude,
      "orthometric-to-ellipsoidal",
    );
    const height = targetOffset === 0
      ? gridCorrectedHeight
      : gridCorrectedHeight + targetOffset;
    geographicCoordinates[offset + 2] = height;
    const world = geographicToEcef({ longitude, latitude, height });
    worldCoordinates[offset] = world.x;
    worldCoordinates[offset + 1] = world.y;
    worldCoordinates[offset + 2] = world.z;
  }
  const result = createPreparedPointData({
    pointCount: prepared.pointCount,
    sourceCoordinates: prepared.source.coordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes: prepared.attributes,
  });
  recordPreparedCoordinateOperations(result, {
    manualHeightOffsetMeters: targetOffset,
    verticalGridIdentity: gridIdentity,
  });
  return result;
}

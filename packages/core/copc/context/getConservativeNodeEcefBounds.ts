import {
  getBilinearInterpolationErrorBoundMeters,
  getWgs84EllipsoidalHeightBounds,
  getWgs84GeodeticEcefBounds,
} from "../../coordinates/transform/geodeticEcefBounds";
import {
  extractHorizontalCrsWkt,
  getHorizontalAxisDirections,
} from "../../coordinates/crs/parseCopcWkt";
import type { CopcMetadata } from "../types/copc";
import type { CoordinateTransformPlan } from "../../coordinates/transform/coordinateTransformPlan";
import type { GtxGeoidGrid } from "../../coordinates/transform/verticalGrid";
import type {
  CopcConservativeBoundsResult,
  CopcConservativeBoundsUnsupportedReasonCode,
} from "./conservativeBounds";
import type { CopcHierarchyBounds } from "../hierarchy/types";

type BoundsContext = Readonly<{
  metadata: CopcMetadata;
  sourceIdentity: string;
  sourceGeneration: number;
  transformGeneration: number;
  transformPlan: CoordinateTransformPlan;
  verticalGrid?: GtxGeoidGrid;
}>;

type AngularAxis = "east" | "west" | "north" | "south";

function sourceAxisInterval(
  bounds: CopcHierarchyBounds,
  firstOrSecond: 0 | 1,
): readonly [number, number] {
  return firstOrSecond === 0
    ? [bounds.minX, bounds.maxX]
    : [bounds.minY, bounds.maxY];
}

function geographicAxisInterval(
  bounds: CopcHierarchyBounds,
  directions: readonly [AngularAxis, AngularAxis],
  axis: "longitude" | "latitude",
): readonly [number, number] {
  const expected = axis === "longitude" ? ["east", "west"] : ["north", "south"];
  const index = directions.findIndex((direction) => expected.includes(direction));
  if (index < 0) throw new RangeError(`WKT does not identify a ${axis} axis`);
  const [minimum, maximum] = sourceAxisInterval(bounds, index as 0 | 1);
  return directions[index] === "west" || directions[index] === "south"
    ? [-maximum, -minimum]
    : [minimum, maximum];
}

function createResultProvenance(
  context: BoundsContext,
  nodeKey: string,
  sourceCellBounds: CopcHierarchyBounds,
) {
  return {
    nodeKey,
    sourceCellBounds: Object.freeze({ ...sourceCellBounds }),
    sourceCoordinateSystem: "copc-source" as const,
    sourceIdentity: context.sourceIdentity,
    sourceGeneration: context.sourceGeneration,
    transformGeneration: context.transformGeneration,
    transformPlanIdentity: context.transformPlan.identity.key,
    heightOffsetMeters: context.transformPlan.manualHeightOffsetMeters,
    ...(context.transformPlan.verticalGrid
      ? { verticalGrid: context.transformPlan.verticalGrid }
      : {}),
  };
}

function unsupported(
  provenance: ReturnType<typeof createResultProvenance>,
  reasonCode: CopcConservativeBoundsUnsupportedReasonCode,
  reason: string,
): CopcConservativeBoundsResult {
  return Object.freeze({ status: "unsupported", ...provenance, reasonCode, reason });
}

function exactWgs84GeographicIdentity(
  context: BoundsContext,
): boolean {
  const horizontal = context.transformPlan.source.horizontalCrs;
  const identity = horizontal?.authority?.toUpperCase() === "EPSG"
    ? horizontal.code
    : undefined;
  return horizontal?.certainty === "explicit" &&
    (identity === "4326" || identity === "4979");
}

function hasSupportedHorizontalUnit(context: BoundsContext): boolean {
  const units = context.transformPlan.source.horizontalUnits;
  return units.kind === "angular" &&
    units.standard === "degree" &&
    units.certainty === "explicit";
}

function hasWgs84GeodeticDefinition(wkt: string): boolean {
  let horizontalWkt: string;
  try {
    horizontalWkt = extractHorizontalCrsWkt(wkt);
  } catch {
    return false;
  }
  if (!/^\s*(?:GEOGCS|GEOGCRS)\s*\[/i.test(horizontalWkt)) return false;
  if (/\b(?:TOWGS84|ABRIDGEDTRANSFORMATION|BOUNDCRS|DYNAMIC|COORDINATEEPOCH)\s*\[/i.test(horizontalWkt)) {
    return false;
  }

  const datum = /\b(?:DATUM|GEODETICDATUM|ENSEMBLE)\s*\[\s*"([^"]+)"/i.exec(horizontalWkt)?.[1];
  if (!datum || !/\b(?:WGS\s*[_-]?\s*(?:84|1984)|WORLD\s+GEODETIC\s+SYSTEM\s+1984)\b/i.test(datum)) {
    return false;
  }

  const ellipsoids = [
    ...horizontalWkt.matchAll(/\b(?:SPHEROID|ELLIPSOID)\s*\[\s*"([^"]+)"\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi),
  ];
  if (ellipsoids.length !== 1) return false;
  const ellipsoid = ellipsoids[0];
  if (
    !ellipsoid ||
    !/\bWGS\s*[_-]?\s*84\b/i.test(ellipsoid[1] ?? "") ||
    Number(ellipsoid[2]) !== 6_378_137 ||
    Number(ellipsoid[3]) !== 298.257223563
  ) {
    return false;
  }

  const primeMeridians = [
    ...horizontalWkt.matchAll(/\bPRIMEM\s*\[\s*"([^"]+)"\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi),
  ];
  return primeMeridians.length <= 1 && primeMeridians.every(
    (primeMeridian) =>
      /\bGreenwich\b/i.test(primeMeridian[1] ?? "") &&
      Number(primeMeridian[2]) === 0,
  );
}

function getVerticalUnitScale(context: BoundsContext):
  | { supported: true; scaleToMeters: number; verticalReference: "ellipsoidal" | "validated-grid" }
  | { supported: false; reasonCode: CopcConservativeBoundsUnsupportedReasonCode; reason: string } {
  const plan = context.transformPlan;
  const diagnostic = context.metadata.crsDiagnostic;
  const vertical = diagnostic?.vertical ?? {
    heightKind: plan.source.verticalHeightKind,
    units: plan.source.verticalUnits,
  };
  const scaleToMeters = plan.source.verticalUnitConversion.scaleToMeters;

  if (context.verticalGrid) {
    if (plan.verticalGrid?.compatibility !== "validated" || !Number.isFinite(scaleToMeters) || scaleToMeters! <= 0) {
      return {
        supported: false,
        reasonCode: "unsupported-vertical-grid",
        reason: plan.verticalGrid?.compatibilityMessage ?? "The configured vertical grid is not compatible with this source transform plan.",
      };
    }
    if (vertical.heightKind.value !== "gravity-related/orthometric" || vertical.heightKind.certainty !== "explicit") {
      return {
        supported: false,
        reasonCode: "unsupported-vertical-reference",
        reason: "A grid correction requires an explicitly identified gravity-related or orthometric source height.",
      };
    }
    if (context.verticalGrid.noDataValue !== null) {
      return {
        supported: false,
        reasonCode: "vertical-grid-has-nodata-sentinel",
        reason: "The grid declares a NoData sentinel, so the public grid contract cannot prove that every interpolation cell in this source cell is populated.",
      };
    }
    const sourceEpoch = context.verticalGrid.sourceCoordinateEpoch;
    const gridEpoch = context.verticalGrid.gridReferenceEpoch;
    if ((sourceEpoch !== undefined || gridEpoch !== undefined) && sourceEpoch !== gridEpoch) {
      return {
        supported: false,
        reasonCode: "unsupported-coordinate-epoch",
        reason: "The configured vertical grid does not have a matched source and grid-reference epoch.",
      };
    }
    return { supported: true, scaleToMeters: scaleToMeters!, verticalReference: "validated-grid" };
  }

  if (
    vertical.heightKind.value !== "ellipsoidal" ||
    vertical.heightKind.certainty !== "explicit" ||
    vertical.units.kind !== "linear" ||
    vertical.units.certainty !== "explicit" ||
    plan.source.verticalUnitConversion.source !== "wkt" ||
    !Number.isFinite(scaleToMeters) ||
    scaleToMeters! <= 0
  ) {
    return {
      supported: false,
      reasonCode: "unsupported-vertical-reference",
      reason: "Source Z is not explicitly declared as ellipsoidal height with a verified linear unit conversion.",
    };
  }
  return { supported: true, scaleToMeters: scaleToMeters!, verticalReference: "ellipsoidal" };
}

function mapPlanFailure(context: BoundsContext):
  | { reasonCode: CopcConservativeBoundsUnsupportedReasonCode; reason: string }
  | undefined {
  const reason = context.transformPlan.unsupportedReasons[0];
  if (!reason) return undefined;
  if (reason.code === "missing-coordinate-epoch") {
    return { reasonCode: "unsupported-coordinate-epoch", reason: reason.message };
  }
  if (reason.code === "unknown-vertical-reference" || reason.code.includes("vertical-unit")) {
    return { reasonCode: "unsupported-vertical-reference", reason: reason.message };
  }
  if (reason.code === "incompatible-grid-configuration") {
    return { reasonCode: "unsupported-vertical-grid", reason: reason.message };
  }
  return { reasonCode: "unsupported-horizontal-crs", reason: reason.message };
}

/** Evaluate a metadata-only, conservative ECEF bound for one source octree cell. */
export function getConservativeNodeEcefBounds(
  context: BoundsContext,
  nodeKey: string,
  sourceCellBounds: CopcHierarchyBounds,
): CopcConservativeBoundsResult {
  const provenance = createResultProvenance(context, nodeKey, sourceCellBounds);
  const wkt = context.metadata.wkt;
  if (!wkt) {
    return unsupported(
      provenance,
      "unsupported-horizontal-crs",
      "Conservative ECEF bounds currently support only an explicitly identified WGS 84 geographic source CRS (EPSG:4326 or EPSG:4979). Projected and other datum transformations do not have a certified region enclosure.",
    );
  }
  if (/\bDYNAMIC\s*\[|\bCOORDINATEEPOCH\s*\[/i.test(wkt)) {
    return unsupported(
      provenance,
      "unsupported-coordinate-epoch",
      "Dynamic or coordinate-epoch WKT is not supported by the current point transformation path.",
    );
  }
  if (!exactWgs84GeographicIdentity(context)) {
    return unsupported(
      provenance,
      "unsupported-horizontal-crs",
      "Conservative ECEF bounds currently support only an explicitly identified WGS 84 geographic source CRS (EPSG:4326 or EPSG:4979). Projected and other datum transformations do not have a certified region enclosure.",
    );
  }
  if (!hasWgs84GeodeticDefinition(wkt)) {
    return unsupported(
      provenance,
      "unsupported-horizontal-crs",
      "The source WKT does not establish the WGS 84 datum or ensemble, ellipsoid, and Greenwich prime meridian required by the analytic geodetic enclosure.",
    );
  }
  if (!hasSupportedHorizontalUnit(context)) {
    return unsupported(
      provenance,
      "unsupported-horizontal-units",
      "The WGS 84 geographic source does not declare supported angular degree units.",
    );
  }
  if (context.metadata.crsWktProvenance?.conflicting) {
    return unsupported(
      provenance,
      "unsupported-horizontal-crs",
      "The source contains conflicting CRS WKT declarations.",
    );
  }
  const planFailure = mapPlanFailure(context);
  if (planFailure) return unsupported(provenance, planFailure.reasonCode, planFailure.reason);
  let directions: readonly [AngularAxis, AngularAxis] | undefined;
  try {
    directions = getHorizontalAxisDirections(wkt);
  } catch (error: unknown) {
    return unsupported(
      provenance,
      "unsupported-axis-order",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!directions) {
    let horizontalWkt: string;
    try {
      horizontalWkt = extractHorizontalCrsWkt(wkt);
    } catch (error: unknown) {
      return unsupported(
        provenance,
        "unsupported-axis-order",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (/^\s*GEOGCS\s*\[/i.test(horizontalWkt) && !/\bAXIS\s*\[/i.test(horizontalWkt)) {
      // The point transformer preserves the established WKT1 GIS tuple order
      // (X=longitude, Y=latitude) when the WKT1 GEOGCS has no AXIS clauses.
      directions = ["east", "north"];
    } else {
      return unsupported(
        provenance,
        "unsupported-axis-order",
        "The source WKT does not declare two transformable horizontal axes.",
      );
    }
  }

  const vertical = getVerticalUnitScale(context);
  if (!vertical.supported) {
    return unsupported(provenance, vertical.reasonCode, vertical.reason);
  }

  let minimumLongitude: number;
  let maximumLongitude: number;
  let minimumLatitude: number;
  let maximumLatitude: number;
  try {
    [minimumLongitude, maximumLongitude] = geographicAxisInterval(
      sourceCellBounds,
      directions,
      "longitude",
    );
    [minimumLatitude, maximumLatitude] = geographicAxisInterval(
      sourceCellBounds,
      directions,
      "latitude",
    );
  } catch (error: unknown) {
    return unsupported(
      provenance,
      "unsupported-axis-order",
      error instanceof Error ? error.message : String(error),
    );
  }

  let verticalCorrection:
    | { minimumMeters: number; maximumMeters: number; numericalErrorBoundMeters: number }
    | undefined;
  if (context.verticalGrid) {
    const grid = context.verticalGrid;
    const gridMaximumLongitude = grid.longitudeOrigin + (grid.width - 1) * grid.longitudeStep;
    const longitudeCovered = grid.globalLongitudeCoverage !== "none" ||
      (minimumLongitude >= grid.longitudeOrigin && maximumLongitude <= gridMaximumLongitude);
    const latitudeCovered = minimumLatitude >= grid.latitudeOrigin &&
      maximumLatitude <= grid.latitudeOrigin + (grid.height - 1) * grid.latitudeStep;
    if (!longitudeCovered || !latitudeCovered) {
      return unsupported(
        provenance,
        "vertical-grid-outside-cell-coverage",
        "The complete geographic source-cell interval is not covered by the configured vertical grid.",
      );
    }
    const numericalErrorBoundMeters = getBilinearInterpolationErrorBoundMeters(
      grid.minimumUndulationMeters,
      grid.maximumUndulationMeters,
    );
    if (!Number.isFinite(numericalErrorBoundMeters)) {
      return unsupported(
        provenance,
        "numeric-range",
        "The configured vertical-grid interpolation error bound exceeds the finite numeric range.",
      );
    }
    verticalCorrection = {
      minimumMeters: grid.minimumUndulationMeters,
      maximumMeters: grid.maximumUndulationMeters,
      numericalErrorBoundMeters,
    };
  }

  try {
    const ellipsoidalHeight = getWgs84EllipsoidalHeightBounds(
      sourceCellBounds.minZ,
      sourceCellBounds.maxZ,
      vertical.scaleToMeters,
      context.transformPlan.manualHeightOffsetMeters,
      verticalCorrection,
    );
    const boundsEcef = getWgs84GeodeticEcefBounds({
      minimumLongitudeDegrees: minimumLongitude,
      maximumLongitudeDegrees: maximumLongitude,
      minimumLatitudeDegrees: minimumLatitude,
      maximumLatitudeDegrees: maximumLatitude,
      minimumEllipsoidalHeightMeters: ellipsoidalHeight.minimum,
      maximumEllipsoidalHeightMeters: ellipsoidalHeight.maximum,
    });
    const assumptions = [
      "The source WKT identifies WGS 84 geographic coordinates and the same WGS 84 datum or ensemble and ellipsoid used by the target ECEF equation; no cross-datum or epoch operation is applied.",
      "The source axes are the explicitly declared signed longitude and latitude directions.",
      vertical.verticalReference === "ellipsoidal"
        ? "Source Z is explicitly ellipsoidal height; only its declared linear unit conversion and the plan's uniform height offset are applied."
        : "The validated bilinear vertical grid has no NoData sentinel, covers the complete geographic interval, and its verified sample extrema bound interpolation.",
      "The returned interval uses the WGS 84 geodetic equations with outward-rounded arithmetic and includes interior angular extrema.",
      "A 3D Tiles content encoder must separately enclose its reconstruction error.",
    ];
    return Object.freeze({
      status: "supported",
      ...provenance,
      boundsEcef,
      coverage: "full-source-cell-and-descendant-cells",
      method: "wgs84-geodetic-interval-v1",
      verification: "analytic-interval",
      verticalReference: vertical.verticalReference,
      sourceVerticalUnitToMeters: vertical.scaleToMeters,
      encoderErrorPaddingRequired: true,
      assumptions: Object.freeze(assumptions),
    });
  } catch (error: unknown) {
    return unsupported(
      provenance,
      "unsupported-geographic-cell",
      error instanceof Error ? error.message : String(error),
    );
  }
}

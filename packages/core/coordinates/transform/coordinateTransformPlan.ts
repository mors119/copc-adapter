import type { CopcMetadata } from "../../copc/types/copc";
import {
  resolveCopcCrsMetadata,
  type CopcCrsDiagnosticReason,
  type CopcCrsIdentityDiagnostic,
  type CopcCrsMetadataDiagnostic,
  type CopcCrsUnitDiagnostic,
  type CopcCrsWktProvenance,
} from "../crs/copcCrsMetadata";
import type { GtxGeoidGrid } from "./verticalGrid";
import { extractVerticalUnitScale } from "../crs/parseCopcWkt";

/** One named stage in the version 1 logical coordinate operation order. */
export type CoordinateTransformPlanOperation = Readonly<{
  /** Stable operation name for diagnostics and serialized provenance. */
  name:
    | "decode-las-scale-offset"
    | "normalize-source-axes-and-units"
    | "transform-horizontal-reference"
    | "convert-vertical-datum"
    | "apply-manual-height-offset"
    | "apply-terrain-placement-residual"
    | "prepare-wgs84-ecef";
  /** Zero-based position in the canonical logical order. */
  order: number;
  /** Whether the operation is configured, an identity, or owned by the viewer. */
  disposition: "required" | "configured" | "identity" | "not-configured" | "viewer-owned";
  /** Concise explanation when this stage is not applied by the shared transform. */
  detail?: string;
}>;

/** Minimal normalized CRS identity retained by an auditable transform plan. */
export type CoordinateTransformCrsReference = Readonly<{
  name?: string;
  authority?: string;
  code?: string;
  certainty: "explicit" | "inferred" | "unknown";
}>;

/** Verified vertical-grid identity, operation metadata, and sampling extent. */
export type CoordinateTransformGridProvenance = Readonly<{
  id: string;
  sha256: string;
  sourceVerticalCrs: string;
  targetVerticalCrs: "EPSG:4979";
  samplingHorizontalCrs: "EPSG:4326";
  referenceEllipsoid: "WGS84";
  interpolation: "bilinear";
  valueUnit: string;
  valueConvention: "ellipsoidal-minus-orthometric";
  noDataValue: number | null;
  width: number;
  height: number;
  longitude: Readonly<{ min: number; max: number; coverage: "none" | "duplicated-seam" | "periodic" }>;
  latitude: Readonly<{ min: number; max: number }>;
  minimumUndulationMeters: number;
  maximumUndulationMeters: number;
  sourceCoordinateEpoch?: number;
  gridReferenceEpoch?: number;
  compatibility: "validated" | "unsupported";
  compatibilityMessage?: string;
}>;

/** A source CRS issue or an additional plan-specific limitation. */
export type CoordinateTransformPlanReason = CopcCrsDiagnosticReason | Readonly<{
  code: "missing-coordinate-epoch" | "incompatible-grid-configuration";
  message: string;
}>;

/**
 * Immutable, renderer-neutral description of one dataset's coordinate path.
 *
 * Version 1 records the logical order shared by Rust and TypeScript. A
 * backend may fuse adjacent numeric stages when it preserves their results.
 */
export type CoordinateTransformPlan = Readonly<{
  schema: "copc-coordinate-transform-plan";
  /** Increment when fields or operation semantics change incompatibly. */
  version: 1;
  /** Exact JSON tuple of transformation inputs; this is an identity key, not a checksum. */
  identity: Readonly<{ key: string }>;
  source: Readonly<{
    horizontalCrs?: CoordinateTransformCrsReference;
    verticalCrs?: CoordinateTransformCrsReference;
    horizontalAxisOrder: CopcCrsMetadataDiagnostic["horizontal"]["axisOrder"];
    horizontalUnits: CopcCrsUnitDiagnostic;
    verticalUnits: CopcCrsUnitDiagnostic;
    verticalHeightKind: CopcCrsMetadataDiagnostic["vertical"]["heightKind"];
    /** Numeric source-Z factor used by the active path, with its evidence source. */
    verticalUnitConversion: Readonly<{
      scaleToMeters?: number;
      source: "wkt" | "validated-grid" | "compatibility-default" | "unresolved";
    }>;
    /** Bounds-based geographic fallback used only when WKT is absent. */
    horizontalResolution: "wkt" | "geographic-bounds-fallback" | "unknown";
  }>;
  target: Readonly<{
    horizontalCrs: Readonly<{ authority: "EPSG"; code: "4326" }>;
    horizontalAxes: "longitude-latitude";
    horizontalUnits: "degrees";
    verticalCrs: Readonly<{ authority: "EPSG"; code: "4979" }>;
    verticalHeightKind: "ellipsoidal";
    verticalUnits: "metres";
    worldCoordinateSystem: "wgs84-ecef-meters";
  }>;
  /** Manual additive correction, applied once to ellipsoidal height in metres. */
  manualHeightOffsetMeters: number;
  /** Grid operation provenance; absent means no vertical datum conversion was configured. */
  verticalGrid?: CoordinateTransformGridProvenance;
  /** Source/grid epoch declarations carried by the configured operation. */
  epochs: Readonly<{
    sourceCoordinateEpoch?: number;
    gridReferenceEpoch?: number;
    status: "matched" | "not-declared" | "source-epoch-unresolved";
  }>;
  /** Ordered logical operations. Terrain placement is explicitly outside datum conversion. */
  operations: readonly CoordinateTransformPlanOperation[];
  /** Inverse semantics required by camera queries and source-space bounds. */
  inverse: Readonly<{
    required: true;
    support: "backend-dependent";
    syntheticBoundsPolicy: "use-grid-extrema-without-sampling-synthetic-corners";
  }>;
  /** Viewer placement is recorded separately and is not a geodetic operation. */
  terrainPlacementResidual: Readonly<{
    status: "viewer-owned";
    appliedByPlan: false;
    unit: "metres";
  }>;
  /** Metadata evidence is not a promise that every runtime backend supports the CRS. */
  confidence: "metadata-resolved" | "partial" | "unknown";
  unsupportedReasons: readonly CoordinateTransformPlanReason[];
  provenance: Readonly<{
    diagnosticVersion: 1;
    transformSupport: "backend-dependent";
    sourceWkt?: string;
    sourceWktProvenance?: CopcCrsWktProvenance;
  }>;
}>;

/** Inputs that vary while building a dataset's immutable transform plan. */
export type CoordinateTransformPlanOptions = Readonly<{
  heightOffsetMeters?: number;
  verticalGrid?: GtxGeoidGrid;
  /** False when transforming synthetic bounds that use grid extrema instead of sampling corners. */
  sampleVerticalGrid?: boolean;
}>;

const planCache = new WeakMap<CopcMetadata, Map<string, CoordinateTransformPlan>>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function identityDiagnostic(
  identity: CopcCrsIdentityDiagnostic | undefined,
): CoordinateTransformCrsReference | undefined {
  if (!identity) return undefined;
  return {
    name: identity.name,
    ...(identity.authority ? { authority: identity.authority } : {}),
    ...(identity.code ? { code: identity.code } : {}),
    certainty: identity.certainty,
  };
}

function inferredGeographicIdentity(): CoordinateTransformCrsReference {
  return {
    name: "WGS 84 geographic coordinates inferred from COPC bounds",
    authority: "EPSG",
    code: "4326",
    certainty: "inferred",
  };
}

function looksLikeGeographicBounds(metadata: CopcMetadata): boolean {
  const { minX, minY, maxX, maxY } = metadata.bounds;
  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
}

function describeGridProvenance(
  grid: GtxGeoidGrid,
  compatibility: "validated" | "unsupported",
  compatibilityMessage?: string,
): CoordinateTransformGridProvenance {
  return {
    id: grid.gridId,
    sha256: grid.sha256,
    sourceVerticalCrs: grid.sourceVerticalCrs,
    targetVerticalCrs: grid.targetVerticalCrs,
    samplingHorizontalCrs: "EPSG:4326",
    referenceEllipsoid: grid.referenceEllipsoid,
    interpolation: grid.interpolation,
    valueUnit: grid.valueUnit,
    valueConvention: grid.valueConvention,
    noDataValue: grid.noDataValue,
    width: grid.width,
    height: grid.height,
    longitude: {
      min: grid.longitudeOrigin,
      max: grid.longitudeOrigin + (grid.width - 1) * grid.longitudeStep,
      coverage: grid.globalLongitudeCoverage,
    },
    latitude: {
      min: grid.latitudeOrigin,
      max: grid.latitudeOrigin + (grid.height - 1) * grid.latitudeStep,
    },
    minimumUndulationMeters: grid.minimumUndulationMeters,
    maximumUndulationMeters: grid.maximumUndulationMeters,
    ...(grid.sourceCoordinateEpoch !== undefined
      ? { sourceCoordinateEpoch: grid.sourceCoordinateEpoch }
      : {}),
    ...(grid.gridReferenceEpoch !== undefined
      ? { gridReferenceEpoch: grid.gridReferenceEpoch }
      : {}),
    compatibility,
    ...(compatibilityMessage ? { compatibilityMessage } : {}),
  };
}

function planIdentityKey(
  metadata: CopcMetadata,
  options: CoordinateTransformPlanOptions,
  heightOffsetMeters: number,
): string {
  const grid = options.verticalGrid;
  return JSON.stringify([
    "copc-coordinate-transform-plan",
    1,
    metadata.wkt ?? null,
    metadata.crsWktProvenance?.selected ?? null,
    metadata.crsWktProvenance?.available ?? null,
    metadata.crsWktProvenance?.conflicting ?? null,
    metadata.crsDiagnostic ?? null,
    metadata.bounds.minX,
    metadata.bounds.minY,
    metadata.bounds.minZ,
    metadata.bounds.maxX,
    metadata.bounds.maxY,
    metadata.bounds.maxZ,
    metadata.scale ? [metadata.scale.x, metadata.scale.y, metadata.scale.z] : null,
    metadata.offset ? [metadata.offset.x, metadata.offset.y, metadata.offset.z] : null,
    grid
      ? [
          grid.gridId,
          grid.sha256,
          grid.sourceVerticalCrs,
          grid.targetVerticalCrs,
          grid.horizontalCrs,
          grid.referenceEllipsoid,
          grid.valueUnit,
          grid.valueConvention,
          grid.interpolation,
          grid.noDataValue,
          grid.longitudeOrigin,
          grid.latitudeOrigin,
          grid.longitudeStep,
          grid.latitudeStep,
          grid.width,
          grid.height,
          grid.sourceCoordinateEpoch ?? null,
          grid.gridReferenceEpoch ?? null,
        ]
      : null,
    heightOffsetMeters,
    options.sampleVerticalGrid !== false,
  ]);
}

function makeOperations(
  grid: GtxGeoidGrid | undefined,
  gridIsCompatible: boolean,
  gridCompatibilityMessage: string | undefined,
  heightOffsetMeters: number,
  sampleVerticalGrid: boolean,
  sourceVerticalHeightKind: CopcCrsMetadataDiagnostic["vertical"]["heightKind"]["value"],
): CoordinateTransformPlanOperation[] {
  let verticalDisposition: CoordinateTransformPlanOperation["disposition"];
  let verticalDetail: string;
  if (grid && !gridIsCompatible) {
    verticalDisposition = "not-configured";
    verticalDetail = gridCompatibilityMessage ??
      "The configured vertical grid is incompatible with the source CRS.";
  } else if (grid && !sampleVerticalGrid) {
    verticalDisposition = "not-configured";
    verticalDetail = "Synthetic bounds use conservative grid extrema without sampling synthetic corners.";
  } else if (grid) {
    verticalDisposition = "configured";
    verticalDetail = "Verified grid conversion is applied once.";
  } else if (sourceVerticalHeightKind === "ellipsoidal") {
    verticalDisposition = "identity";
    verticalDetail = "The source declares ellipsoidal height; no vertical datum operation is required.";
  } else {
    verticalDisposition = "not-configured";
    verticalDetail = "No verified vertical grid is configured; source height is passed through by the compatibility path.";
  }

  return [
    { name: "decode-las-scale-offset", order: 0, disposition: "required" },
    { name: "normalize-source-axes-and-units", order: 1, disposition: "required" },
    { name: "transform-horizontal-reference", order: 2, disposition: "required" },
    {
      name: "convert-vertical-datum",
      order: 3,
      disposition: verticalDisposition,
      detail: verticalDetail,
    },
    {
      name: "apply-manual-height-offset",
      order: 4,
      disposition: heightOffsetMeters === 0 ? "identity" : "configured",
    },
    {
      name: "apply-terrain-placement-residual",
      order: 5,
      disposition: "viewer-owned",
      detail: "Terrain placement is a separately approved viewer adjustment, not a vertical datum conversion.",
    },
    { name: "prepare-wgs84-ecef", order: 6, disposition: "required" },
  ];
}

/**
 * Create a version 1 coordinate plan for a COPC dataset and its transform inputs.
 *
 * The identity key includes retained source WKT, WKT selection provenance,
 * LAS scale/offset, verified grid identity/extent, and manual height offset.
 * It is a cache identity tuple and is not a cryptographic digest.
 */
export function createCoordinateTransformPlan(
  metadata: CopcMetadata,
  options: CoordinateTransformPlanOptions = {},
): CoordinateTransformPlan {
  const heightOffsetMeters = options.heightOffsetMeters ?? 0;
  if (!Number.isFinite(heightOffsetMeters)) {
    throw new RangeError("heightOffsetMeters must be a finite number");
  }
  const diagnostic = metadata.crsDiagnostic ?? resolveCopcCrsMetadata(
    metadata.wkt,
    metadata.crsWktProvenance,
  );
  const hasGeographicFallback = !metadata.wkt && looksLikeGeographicBounds(metadata);
  const grid = options.verticalGrid;
  let gridCompatibilityMessage: string | undefined;
  let gridIsCompatible = !grid;
  let verticalUnitConversion: CoordinateTransformPlan["source"]["verticalUnitConversion"];
  if (grid) {
    try {
      verticalUnitConversion = {
        scaleToMeters: grid.getSourceVerticalUnitScale(metadata.wkt),
        source: "validated-grid",
      };
      gridIsCompatible = true;
    } catch (error: unknown) {
      gridCompatibilityMessage = error instanceof Error ? error.message : String(error);
      verticalUnitConversion = { source: "unresolved" };
    }
  } else {
    const scaleToMeters = metadata.wkt
      ? extractVerticalUnitScale(metadata.wkt)
      : 1;
    const diagnosticScale = diagnostic.vertical.units.toSi;
    const scaleIsDeclared = diagnosticScale !== undefined &&
      Math.abs(scaleToMeters - diagnosticScale) <=
        Math.max(1e-14, Math.abs(diagnosticScale) * 1e-12);
    verticalUnitConversion = {
      scaleToMeters,
      source: scaleIsDeclared ? "wkt" : "compatibility-default",
    };
  }
  const key = planIdentityKey(metadata, options, heightOffsetMeters);
  const sourceHorizontal = identityDiagnostic(diagnostic.horizontal.identity) ??
    (hasGeographicFallback ? inferredGeographicIdentity() : undefined);
  const unsupportedReasons: CoordinateTransformPlanReason[] =
    diagnostic.reasons.map((reason) => ({ ...reason }));
  const sourceVertical = identityDiagnostic(diagnostic.vertical.identity);
  if (grid && !gridIsCompatible) {
    unsupportedReasons.push({
      code: "incompatible-grid-configuration",
      message: gridCompatibilityMessage ?? "The configured vertical grid is not compatible with the source CRS.",
    });
  }
  if (
    !grid &&
    diagnostic.vertical.heightKind.value === "local/unknown" &&
    !unsupportedReasons.some((reason) => reason.code === "unknown-vertical-reference")
  ) {
    unsupportedReasons.push({
      code: "unknown-vertical-reference",
      message: "No vertical datum conversion is configured and the source height reference is unknown.",
    });
  }
  const gridProvenance = grid
    ? describeGridProvenance(
        grid,
        gridIsCompatible ? "validated" : "unsupported",
        gridCompatibilityMessage,
      )
    : undefined;
  const sourceEpoch = gridProvenance?.sourceCoordinateEpoch;
  const gridEpoch = gridProvenance?.gridReferenceEpoch;
  const hasDynamicSourceCrs = /\bDYNAMIC\s*\[/i.test(metadata.wkt ?? "");
  if (
    hasDynamicSourceCrs &&
    sourceEpoch === undefined &&
    !unsupportedReasons.some((reason) => reason.code === "missing-coordinate-epoch")
  ) {
    unsupportedReasons.push({
      code: "missing-coordinate-epoch",
      message: "The source WKT declares a dynamic CRS, but this plan has no resolved source coordinate epoch.",
    });
  }
  const hasUnresolved = unsupportedReasons.length > 0 || !sourceHorizontal;

  return deepFreeze({
    schema: "copc-coordinate-transform-plan",
    version: 1,
    identity: { key },
    source: {
      ...(sourceHorizontal ? { horizontalCrs: sourceHorizontal } : {}),
      ...(sourceVertical ? { verticalCrs: sourceVertical } : {}),
      horizontalAxisOrder: { ...diagnostic.horizontal.axisOrder },
      horizontalUnits: { ...diagnostic.horizontal.units },
      verticalUnits: { ...diagnostic.vertical.units },
      verticalHeightKind: { ...diagnostic.vertical.heightKind },
      verticalUnitConversion,
      horizontalResolution: metadata.wkt
        ? "wkt"
        : hasGeographicFallback
          ? "geographic-bounds-fallback"
          : "unknown",
    },
    target: {
      horizontalCrs: { authority: "EPSG", code: "4326" },
      horizontalAxes: "longitude-latitude",
      horizontalUnits: "degrees",
      verticalCrs: { authority: "EPSG", code: "4979" },
      verticalHeightKind: "ellipsoidal",
      verticalUnits: "metres",
      worldCoordinateSystem: "wgs84-ecef-meters",
    },
    manualHeightOffsetMeters: heightOffsetMeters,
    ...(gridProvenance ? { verticalGrid: gridProvenance } : {}),
    epochs: {
      ...(sourceEpoch !== undefined ? { sourceCoordinateEpoch: sourceEpoch } : {}),
      ...(gridEpoch !== undefined ? { gridReferenceEpoch: gridEpoch } : {}),
      status: sourceEpoch !== undefined && sourceEpoch === gridEpoch
        ? "matched"
        : hasDynamicSourceCrs
          ? "source-epoch-unresolved"
          : "not-declared",
    },
    operations: makeOperations(
      grid,
      gridIsCompatible,
      gridCompatibilityMessage,
      heightOffsetMeters,
      options.sampleVerticalGrid !== false,
      diagnostic.vertical.heightKind.value,
    ),
    inverse: {
      required: true,
      support: "backend-dependent",
      syntheticBoundsPolicy: "use-grid-extrema-without-sampling-synthetic-corners",
    },
    terrainPlacementResidual: {
      status: "viewer-owned",
      appliedByPlan: false,
      unit: "metres",
    },
    confidence: !hasUnresolved
      ? "metadata-resolved"
      : !sourceHorizontal && diagnostic.wkt.metadataSupport === "missing"
        ? "unknown"
        : "partial",
    unsupportedReasons,
    provenance: {
      diagnosticVersion: 1,
      transformSupport: "backend-dependent",
      ...(metadata.wkt ? { sourceWkt: metadata.wkt } : {}),
      ...(metadata.crsWktProvenance
        ? { sourceWktProvenance: { ...metadata.crsWktProvenance, available: [...metadata.crsWktProvenance.available] } }
        : {}),
    },
  });
}

/** Return the memoized plan for a stable metadata object and transform input tuple. */
export function getCoordinateTransformPlan(
  metadata: CopcMetadata,
  options: CoordinateTransformPlanOptions = {},
): CoordinateTransformPlan {
  const heightOffsetMeters = options.heightOffsetMeters ?? 0;
  if (!Number.isFinite(heightOffsetMeters)) {
    throw new RangeError("heightOffsetMeters must be a finite number");
  }
  const key = planIdentityKey(metadata, options, heightOffsetMeters);
  let plans = planCache.get(metadata);
  if (!plans) {
    plans = new Map();
    planCache.set(metadata, plans);
  }
  const cached = plans.get(key);
  if (cached) return cached;
  const plan = createCoordinateTransformPlan(metadata, options);
  plans.set(key, plan);
  return plan;
}

import * as Cesium from "cesium";
import {
  getRootCrsIdentity,
  getVerticalCrsIdentity,
  isWgs84Geographic3dCrs,
} from "../../core/coordinates/crs/parseCopcWkt";
import type { CopcMetadata } from "../../core/copc/types/copc";
import type { CopcPointInspection } from "../../core/copc/points/pointInspection";
import type { GtxGeoidGrid } from "../../core/coordinates/transform/verticalGrid";
import {
  acquireTerrainSamplingSlot,
  releaseTerrainSamplingSlot,
} from "./terrainSamplingLock";

/** Result state for an explicitly requested Terrain height estimate. */
export type TerrainHeightAlignmentStatus =
  | "ready"
  | "uncertain"
  | "unavailable"
  | "cancelled";

/** A proposed Terrain residual; it never changes layer geometry. */
export type TerrainHeightAlignmentEstimate = {
  /** Whether the result is safe to preview and explicitly apply. */
  status: TerrainHeightAlignmentStatus;
  /** True only when both the anchor and height references passed validation. */
  actionable: boolean;
  /** Selected point identity and retained COPC source XYZ, when available. */
  anchor?: {
    ownerId?: string;
    nodeKey: string;
    pointIndex: number;
    longitudeDegrees: number;
    latitudeDegrees: number;
    displayedHeightMeters: number;
    source?: { x: number; y: number; z: number };
    classification?: number;
  };
  /** Terrain height sampled at the same longitude and latitude, when available. */
  terrainHeightMeters?: number;
  /** Terrain minus current displayed anchor height, in metres. */
  proposedOffsetMeters?: number;
  /** Existing constructor-time manual offset, in metres. */
  existingHeightOffsetMeters: number;
  /** Existing offset plus the proposed residual; suitable for a rebuilt layer. */
  effectiveProposedHeightOffsetMeters?: number;
  /** Vertical-reference assessment for the displayed point height. */
  verticalReference: {
    sourceVerticalCrs?: string;
    displayHeightReference: "wgs84-ellipsoidal" | "unverified";
    conversion: "validated-vertical-grid" | "source-declared-ellipsoidal" | "none";
    verticalGridId?: string;
  };
  /** Provider type only; Cesium does not expose a stable source URL for every provider. */
  terrainProvider?: {
    type: string;
    hasTileAvailability: boolean;
  };
  /** Sanitized application-provided Terrain label, when available. */
  terrainSourceId?: string;
  /** Safe caller-provided label for the COPC source, when available. */
  sourceId?: string;
  /** Number of public Cesium most-detailed sampling calls made for this anchor. */
  terrainSamplingCalls: number;
  /** Time spent awaiting Cesium terrain sampling, in milliseconds. */
  samplingDurationMs?: number;
  /** Conditions that lower confidence or explain rejection. */
  warnings: string[];
  rejectionReason?: string;
};

/** Options for one selected-point estimate. At most one anchor is sampled. */
export type TerrainHeightAlignmentOptions = {
  /** Required only when the selected point is not classified as ASPRS ground (class 2). */
  groundConfirmed?: boolean;
  /** A sanitized display label for the active Terrain source. */
  terrainSourceId?: string;
  /** Maximum wait for one Cesium sample call; defaults to 30 seconds and caps at 60 seconds. */
  timeoutMs?: number;
  /** Stops accepting the result. Cesium's terrain API does not accept an AbortSignal, so an in-flight tile request may finish in the background. */
  signal?: AbortSignal;
};

/** One rendered point candidate and any explicit caller confirmation of ground status. */
export type TerrainHeightAlignmentGroundCandidate = Readonly<{
  /** Point inspection retained from the current layer selection or point cache. */
  anchor: CopcPointInspection;
  /** Required when classification is absent or is not ASPRS ground (class 2). */
  groundConfirmed?: boolean;
}>;

/** Generation counters captured with a batch proposal for stale-result checks. */
export type TerrainHeightAlignmentGenerationIdentity = Readonly<{
  sourceGeneration: number;
  layerGeneration: number;
  terrainProviderGeneration: number;
  verticalTransformGeneration: number;
}>;

/** Options for a bounded request that samples several ground candidates together. */
export type TerrainHeightAlignmentBatchOptions = Omit<
  TerrainHeightAlignmentOptions,
  "groundConfirmed"
> & {
  /** Maximum candidate count to sample; defaults to 8 and cannot exceed 12. */
  maxAnchors?: number;
  /** Robust spread above which the proposal is returned as uncertain; defaults to 2 metres. */
  highSpreadWarningMeters?: number;
};

/** Outcome and provenance for one submitted anchor candidate. */
export type TerrainHeightAlignmentAnchorResult = {
  anchor: NonNullable<TerrainHeightAlignmentEstimate["anchor"]>;
  /** True only when this finite sample is an inlier used for batch statistics. */
  accepted: boolean;
  /** True when the anchor was included in the shared Cesium sampling request. */
  sampled: boolean;
  terrainHeightMeters?: number;
  residualMeters?: number;
  rejectionReason?: string;
  warnings: string[];
};

/** Robust, opt-in proposal for one uniform height offset across several anchors. */
export type TerrainHeightAlignmentBatchEstimate = {
  status: TerrainHeightAlignmentStatus;
  actionable: boolean;
  perAnchorResults: TerrainHeightAlignmentAnchorResult[];
  coverage: {
    requestedAnchorCount: number;
    sampledAnchorCount: number;
    acceptedAnchorCount: number;
    /** Accepted inliers divided by all submitted candidates. */
    acceptedFraction: number;
    /** Number of submitted candidates omitted from the response hard bound. */
    notEvaluatedAnchorCount: number;
  };
  /** Median residual after robust outlier rejection, in metres. */
  medianResidualMeters?: number;
  /** Scaled MAD (1.4826 × median absolute deviation) of accepted residuals, in metres. */
  robustSpreadMeters?: number;
  /** Existing constructor-time manual offset, in metres. */
  existingHeightOffsetMeters: number;
  /** Existing offset plus the batch median residual, once. */
  proposedHeightOffsetMeters?: number;
  /** Height-frame provenance; only verified WGS 84 ellipsoidal heights are sampled. */
  verticalReference: TerrainHeightAlignmentEstimate["verticalReference"];
  generationIdentity: TerrainHeightAlignmentGenerationIdentity;
  terrainProvider?: TerrainHeightAlignmentEstimate["terrainProvider"];
  terrainSourceId?: string;
  sourceId?: string;
  /** One shared Cesium call for the bounded batch, or zero when rejected before sampling. */
  terrainSamplingCalls: number;
  samplingDurationMs?: number;
  warnings: string[];
  rejectionReason?: string;
};

type VerticalReferenceAssessment = TerrainHeightAlignmentEstimate["verticalReference"] & {
  verified: boolean;
  reason?: string;
};

type EstimateTerrainHeightAlignmentInput = {
  viewer: Cesium.Viewer;
  provider: Cesium.TerrainProvider;
  metadata: Pick<CopcMetadata, "wkt">;
  verticalTransform?: GtxGeoidGrid;
  anchor?: CopcPointInspection;
  expectedOwnerId: string;
  existingHeightOffsetMeters: number;
  sourceId?: string;
  terrainSourceId?: string;
  options?: TerrainHeightAlignmentOptions;
  /** Validates source generation, selected point, viewer, and TerrainProvider before and after sampling. */
  isCurrent: () => boolean;
  /** Internal seam for deterministic tests; production always uses Cesium's public sampler. */
  sampleTerrainMostDetailed?: typeof Cesium.sampleTerrainMostDetailed;
};

const DEFAULT_TERRAIN_SAMPLE_TIMEOUT_MS = 30_000;
const MAX_TERRAIN_SAMPLE_TIMEOUT_MS = 60_000;
const TERRAIN_SAMPLE_TIMEOUT = Symbol("terrain-sample-timeout");
const TERRAIN_SAMPLE_ABORTED = Symbol("terrain-sample-aborted");

function sourceVerticalCrs(wkt: string | undefined): string | undefined {
  if (!wkt) return undefined;
  try {
    const rootIdentity = getRootCrsIdentity(wkt);
    if (isWgs84Geographic3dCrs(rootIdentity)) return "EPSG:4979";
    const identity = getVerticalCrsIdentity(wkt);
    if (!identity) return undefined;
    // EPSG:4979 identifies a 3D geographic CRS, not a standalone vertical CRS.
    // A VERT_CS carrying that ID is malformed and must not be reported as a
    // verified source vertical reference.
    if (
      identity.authority?.toUpperCase() === "EPSG" &&
      identity.code === "4979"
    ) {
      return identity.name;
    }
    return identity.authority && identity.code
      ? `${identity.authority}:${identity.code}`
      : identity.name;
  } catch {
    return undefined;
  }
}

function safeSourceLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, globalThis.location?.href ?? "http://localhost/");
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.hostname}${url.pathname}`;
    }
  } catch {
    // Fall through to conservative string redaction for application labels.
  }
  const sanitized = value
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1")
    .replace(/[?#].*$/, "");
  return sanitized || undefined;
}

/**
 * Assess whether the layer's current displayed heights are known to be WGS 84
 * ellipsoidal metres. Unknown and orthometric heights fail closed.
 */
export function assessDisplayedHeightReference(
  metadata: Pick<CopcMetadata, "wkt">,
  verticalTransform?: GtxGeoidGrid,
): VerticalReferenceAssessment {
  const sourceVerticalCrsId = sourceVerticalCrs(metadata.wkt);
  if (verticalTransform) {
    try {
      verticalTransform.assertCompatibleSourceWkt(metadata.wkt);
      return {
        sourceVerticalCrs: sourceVerticalCrsId,
        displayHeightReference: "wgs84-ellipsoidal",
        conversion: "validated-vertical-grid",
        verticalGridId: verticalTransform.gridId,
        verified: true,
      };
    } catch (error) {
      return {
        sourceVerticalCrs: sourceVerticalCrsId,
        displayHeightReference: "unverified",
        conversion: "none",
        verified: false,
        reason:
          error instanceof Error
            ? `Configured vertical grid is incompatible with the source CRS: ${error.message}`
            : "Configured vertical grid is incompatible with the source CRS.",
      };
    }
  }

  if (!metadata.wkt) {
    return {
      displayHeightReference: "unverified",
      conversion: "none",
      verified: false,
      reason: "The COPC source does not declare a vertical CRS.",
    };
  }

  try {
    const rootIdentity = getRootCrsIdentity(metadata.wkt);
    if (isWgs84Geographic3dCrs(rootIdentity)) {
      return {
        sourceVerticalCrs: "EPSG:4979",
        displayHeightReference: "wgs84-ellipsoidal",
        conversion: "source-declared-ellipsoidal",
        verified: true,
      };
    }
  } catch {
    return {
      sourceVerticalCrs: sourceVerticalCrsId,
      displayHeightReference: "unverified",
      conversion: "none",
      verified: false,
      reason: "The COPC vertical CRS declaration is malformed.",
    };
  }

  return {
    sourceVerticalCrs: sourceVerticalCrsId,
    displayHeightReference: "unverified",
    conversion: "none",
    verified: false,
    reason: sourceVerticalCrsId
      ? `COPC heights use ${sourceVerticalCrsId}; no validated transformation to WGS 84 ellipsoidal height is active.`
      : "The COPC source does not declare a supported ellipsoidal vertical CRS.",
  };
}

function anchorSnapshot(anchor: CopcPointInspection | undefined): TerrainHeightAlignmentEstimate["anchor"] {
  if (!anchor) return undefined;
  return {
    ...(anchor.ownerId === undefined ? {} : { ownerId: anchor.ownerId }),
    nodeKey: anchor.nodeKey,
    pointIndex: anchor.pointIndex,
    longitudeDegrees: anchor.longitude,
    latitudeDegrees: anchor.latitude,
    displayedHeightMeters: anchor.height,
    ...(anchor.source ? { source: { ...anchor.source } } : {}),
    ...(anchor.classification === undefined
      ? {}
      : { classification: anchor.classification }),
  };
}

function createEstimate(
  input: EstimateTerrainHeightAlignmentInput,
  status: TerrainHeightAlignmentStatus,
  rejectionReason: string,
  verticalReference: VerticalReferenceAssessment,
  warnings: string[] = [],
  terrainProvider?: TerrainHeightAlignmentEstimate["terrainProvider"],
): TerrainHeightAlignmentEstimate {
  return {
    status,
    actionable: false,
    ...(anchorSnapshot(input.anchor)
      ? { anchor: anchorSnapshot(input.anchor) }
      : {}),
    existingHeightOffsetMeters: input.existingHeightOffsetMeters,
    verticalReference: {
      sourceVerticalCrs: verticalReference.sourceVerticalCrs,
      displayHeightReference: verticalReference.displayHeightReference,
      conversion: verticalReference.conversion,
      ...(verticalReference.verticalGridId === undefined
        ? {}
        : { verticalGridId: verticalReference.verticalGridId }),
    },
    ...(terrainProvider ? { terrainProvider } : {}),
    ...(safeSourceLabel(input.sourceId)
      ? { sourceId: safeSourceLabel(input.sourceId) }
      : {}),
    ...(safeSourceLabel(input.terrainSourceId)
      ? { terrainSourceId: safeSourceLabel(input.terrainSourceId) }
      : {}),
    terrainSamplingCalls: 0,
    warnings,
    rejectionReason,
  };
}

function isFiniteAnchor(anchor: CopcPointInspection): boolean {
  const sourceIsFinite =
    anchor.source === undefined ||
    [anchor.source.x, anchor.source.y, anchor.source.z].every(Number.isFinite);
  return (
    Number.isFinite(anchor.longitude) &&
    anchor.longitude >= -180 &&
    anchor.longitude <= 180 &&
    Number.isFinite(anchor.latitude) &&
    anchor.latitude >= -90 &&
    anchor.latitude <= 90 &&
    Number.isFinite(anchor.height) &&
    sourceIsFinite
  );
}

/**
 * Estimate one residual from a selected layer-owned point and Cesium Terrain.
 * This function does not modify positions; its caller must still validate that
 * the anchor belongs to the live layer before invoking it.
 */
export async function estimateTerrainHeightAlignment(
  input: EstimateTerrainHeightAlignmentInput,
): Promise<TerrainHeightAlignmentEstimate> {
  const verticalReference = assessDisplayedHeightReference(
    input.metadata,
    input.verticalTransform,
  );
  const providerType = input.provider?.constructor?.name || "TerrainProvider";
  const providerSummary = {
    type: providerType,
    hasTileAvailability: input.provider?.availability !== undefined,
  };
  const warnings: string[] = [];
  const options = input.options ?? {};

  if (options.signal?.aborted) {
    return createEstimate(
      input,
      "cancelled",
      "Terrain estimation was cancelled before sampling.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  if (!input.anchor) {
    return createEstimate(
      input,
      "unavailable",
      "Select a rendered point owned by this COPC layer.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  if (!input.isCurrent()) {
    return createEstimate(
      input,
      "unavailable",
      "The selected point, source, or Viewer is no longer current.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  if (
    input.anchor.ownerId !== input.expectedOwnerId ||
    !input.anchor.nodeKey ||
    !Number.isSafeInteger(input.anchor.pointIndex) ||
    input.anchor.pointIndex < 0
  ) {
    return createEstimate(
      input,
      "unavailable",
      "Select a rendered point owned by this COPC layer.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  if (!isFiniteAnchor(input.anchor)) {
    return createEstimate(
      input,
      "unavailable",
      "The selected point must have finite longitude, latitude, displayed height, and any retained source XYZ coordinates.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  if (input.anchor.classification !== 2 && options.groundConfirmed !== true) {
    return createEstimate(
      input,
      "uncertain",
      "The selected point is not classified as ASPRS ground (class 2). Confirm explicitly that this point is ground before estimating.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  if (input.anchor.classification !== 2) {
    warnings.push(
      "Ground status was confirmed by the caller; the point classification does not independently verify ground.",
    );
  }
  if (!verticalReference.verified) {
    return createEstimate(
      input,
      "uncertain",
      verticalReference.reason ??
        "Displayed COPC height is not verified as WGS 84 ellipsoidal height.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  if (input.provider instanceof Cesium.EllipsoidTerrainProvider) {
    return createEstimate(
      input,
      "unavailable",
      "The active provider renders only the ellipsoid and has no real terrain elevation.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  if (!input.provider?.availability) {
    return createEstimate(
      input,
      "unavailable",
      "Cesium sampleTerrainMostDetailed requires a provider with tile availability; no fallback is configured.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TERRAIN_SAMPLE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TERRAIN_SAMPLE_TIMEOUT_MS
  ) {
    return createEstimate(
      input,
      "unavailable",
      `Terrain sample timeout must be a whole number from 1 to ${MAX_TERRAIN_SAMPLE_TIMEOUT_MS} ms.`,
      verticalReference,
      warnings,
      providerSummary,
    );
  }

  if (!acquireTerrainSamplingSlot(input.viewer)) {
    return createEstimate(
      input,
      "unavailable",
      "Another Terrain estimate is already sampling this Viewer. Wait for it to finish before starting another.",
      verticalReference,
      warnings,
      providerSummary,
    );
  }
  const sample =
    input.sampleTerrainMostDetailed ?? Cesium.sampleTerrainMostDetailed;
  const position = Cesium.Cartographic.fromDegrees(
    input.anchor.longitude,
    input.anchor.latitude,
    input.anchor.height,
  );
  const samplingStartedAt = performance.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const samplingPromise = Promise.resolve().then(() =>
    sample(input.provider, [position], true),
  );
  // Cesium's public sampler has no AbortSignal. Keep the per-Viewer lock until
  // its underlying requests settle, even if the caller times out or cancels.
  void samplingPromise
    .finally(() => releaseTerrainSamplingSlot(input.viewer))
    .catch(() => undefined);
  const boundedSamplingPromise = Promise.race([
    samplingPromise,
    new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(TERRAIN_SAMPLE_TIMEOUT),
        timeoutMs,
      );
    }),
    ...(options.signal
      ? [
          new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(TERRAIN_SAMPLE_ABORTED);
            options.signal?.addEventListener("abort", abortListener, {
              once: true,
            });
            if (options.signal?.aborted) abortListener();
          }),
        ]
      : []),
  ]);
  try {
    const positions = await boundedSamplingPromise;
    const samplingDurationMs = performance.now() - samplingStartedAt;
    if (options.signal?.aborted) {
      return {
        ...createEstimate(
          input,
          "cancelled",
          "Terrain estimation was cancelled while sampling; the result was discarded.",
          verticalReference,
          warnings,
          providerSummary,
        ),
        terrainSamplingCalls: 1,
        samplingDurationMs,
      };
    }
    if (!input.isCurrent()) {
      return {
        ...createEstimate(
          input,
          "unavailable",
          "The source, selected anchor, or TerrainProvider changed during sampling; the result was discarded.",
          verticalReference,
          warnings,
          providerSummary,
        ),
        terrainSamplingCalls: 1,
        samplingDurationMs,
      };
    }
    const terrainHeightMeters = positions[0]?.height;
    if (terrainHeightMeters === undefined || !Number.isFinite(terrainHeightMeters)) {
      return {
        ...createEstimate(
          input,
          "unavailable",
          "The TerrainProvider returned no finite height at this anchor.",
          verticalReference,
          warnings,
          providerSummary,
        ),
        terrainSamplingCalls: 1,
        samplingDurationMs,
      };
    }

    const proposedOffsetMeters =
      terrainHeightMeters - input.anchor.height;
    const effectiveProposedHeightOffsetMeters =
      input.existingHeightOffsetMeters + proposedOffsetMeters;
    if (
      !Number.isFinite(proposedOffsetMeters) ||
      !Number.isFinite(effectiveProposedHeightOffsetMeters)
    ) {
      return {
        ...createEstimate(
          input,
          "unavailable",
          "The sampled residual or effective height offset is not finite.",
          verticalReference,
          warnings,
          providerSummary,
        ),
        terrainSamplingCalls: 1,
        samplingDurationMs,
      };
    }

    warnings.push(
      "Terrain LOD, provider provenance, and ground-anchor quality limit confidence; this estimate is not survey-grade.",
    );
    return {
      status: "ready",
      actionable: true,
      anchor: anchorSnapshot(input.anchor),
      terrainHeightMeters,
      proposedOffsetMeters,
      existingHeightOffsetMeters: input.existingHeightOffsetMeters,
      effectiveProposedHeightOffsetMeters,
      verticalReference: {
        sourceVerticalCrs: verticalReference.sourceVerticalCrs,
        displayHeightReference: verticalReference.displayHeightReference,
        conversion: verticalReference.conversion,
        ...(verticalReference.verticalGridId === undefined
          ? {}
          : { verticalGridId: verticalReference.verticalGridId }),
      },
      terrainProvider: providerSummary,
      ...(safeSourceLabel(input.sourceId)
        ? { sourceId: safeSourceLabel(input.sourceId) }
        : {}),
      ...(safeSourceLabel(input.terrainSourceId)
        ? { terrainSourceId: safeSourceLabel(input.terrainSourceId) }
        : {}),
      terrainSamplingCalls: 1,
      samplingDurationMs,
      warnings,
    };
  } catch (error) {
    const timedOut = error === TERRAIN_SAMPLE_TIMEOUT;
    const cancelled = error === TERRAIN_SAMPLE_ABORTED || options.signal?.aborted;
    return {
      ...createEstimate(
        input,
        cancelled ? "cancelled" : "unavailable",
        cancelled
          ? "Terrain estimation was cancelled while sampling; the result was discarded."
          : timedOut
            ? `Terrain sampling exceeded its ${timeoutMs} ms deadline. The Cesium request may still complete in the background.`
            : "Cesium terrain sampling failed; check provider coverage and availability.",
        verticalReference,
        warnings,
        providerSummary,
      ),
      terrainSamplingCalls: 1,
      samplingDurationMs: performance.now() - samplingStartedAt,
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortListener) {
      options.signal?.removeEventListener("abort", abortListener);
    }
  }
}

/** Build a snapshot for one current or unavailable estimate without sampling. */
export function createUnavailableTerrainHeightAlignmentEstimate(
  input: Pick<EstimateTerrainHeightAlignmentInput, "anchor" | "metadata" | "verticalTransform" | "existingHeightOffsetMeters" | "sourceId">,
  reason: string,
  status: "uncertain" | "unavailable" | "cancelled" = "unavailable",
): TerrainHeightAlignmentEstimate {
  const verticalReference = assessDisplayedHeightReference(
    input.metadata,
    input.verticalTransform,
  );
  return createEstimate(
    input as EstimateTerrainHeightAlignmentInput,
    status,
    reason,
    verticalReference,
  );
}

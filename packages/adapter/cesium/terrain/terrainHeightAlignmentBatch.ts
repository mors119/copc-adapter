import * as Cesium from "cesium";
import type { CopcMetadata } from "../../core/copc/types/copc";
import type { CopcPointInspection } from "../../core/copc/points/pointInspection";
import type { GtxGeoidGrid } from "../../core/coordinates/transform/verticalGrid";
import {
  assessDisplayedHeightReference,
  type TerrainHeightAlignmentAnchorResult,
  type TerrainHeightAlignmentBatchEstimate,
  type TerrainHeightAlignmentBatchOptions,
  type TerrainHeightAlignmentGenerationIdentity,
  type TerrainHeightAlignmentGroundCandidate,
} from "./terrainHeightAlignment";
import {
  acquireTerrainSamplingSlot,
  releaseTerrainSamplingSlot,
} from "./terrainSamplingLock";

const DEFAULT_MAX_ANCHORS = 8;
const HARD_MAX_ANCHORS = 12;
const DEFAULT_HIGH_SPREAD_WARNING_METERS = 2;
const DEFAULT_TERRAIN_SAMPLE_TIMEOUT_MS = 30_000;
const MAX_TERRAIN_SAMPLE_TIMEOUT_MS = 60_000;
const TERRAIN_SAMPLE_TIMEOUT = Symbol("terrain-sample-timeout");
const TERRAIN_SAMPLE_ABORTED = Symbol("terrain-sample-aborted");

type VerticalReference = ReturnType<typeof assessDisplayedHeightReference>;

/** Inputs needed by the internal multi-anchor estimator. */
export type EstimateTerrainHeightAlignmentBatchInput = {
  viewer?: Cesium.Viewer;
  provider?: Cesium.TerrainProvider;
  metadata: Pick<CopcMetadata, "wkt">;
  verticalTransform?: GtxGeoidGrid;
  candidates: readonly TerrainHeightAlignmentGroundCandidate[];
  expectedOwnerId: string;
  existingHeightOffsetMeters: number;
  generationIdentity: TerrainHeightAlignmentGenerationIdentity;
  sourceId?: string;
  terrainSourceId?: string;
  options?: TerrainHeightAlignmentBatchOptions;
  /** Layer-state failure to report before attempting a sample. */
  unavailableReason?: string;
  /** Rechecks source, layer, provider, transform, and every submitted anchor identity. */
  isCurrent: () => boolean;
  /** Confirms that a point remains in the layer's current rendered cache. */
  isAnchorCurrent?: (anchor: CopcPointInspection) => boolean;
  /** Internal seam for deterministic tests; production uses Cesium's public sampler. */
  sampleTerrainMostDetailed?: typeof Cesium.sampleTerrainMostDetailed;
};

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

function anchorSnapshot(
  anchor: CopcPointInspection,
): NonNullable<TerrainHeightAlignmentAnchorResult["anchor"]> {
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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function emptyAnchorResult(
  candidate: TerrainHeightAlignmentGroundCandidate,
  rejectionReason: string,
  warnings: string[] = [],
): TerrainHeightAlignmentAnchorResult {
  return {
    anchor: anchorSnapshot(candidate.anchor),
    accepted: false,
    sampled: false,
    rejectionReason,
    warnings,
  };
}

function markRejected(
  result: TerrainHeightAlignmentAnchorResult,
  reason: string,
): TerrainHeightAlignmentAnchorResult {
  return { ...result, accepted: false, rejectionReason: reason };
}

function validGenerationIdentity(
  identity: TerrainHeightAlignmentGenerationIdentity,
): boolean {
  return [
    identity?.sourceGeneration,
    identity?.layerGeneration,
    identity?.terrainProviderGeneration,
    identity?.verticalTransformGeneration,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}

function createBatchEstimate(
  input: EstimateTerrainHeightAlignmentBatchInput,
  verticalReference: VerticalReference,
  perAnchorResults: TerrainHeightAlignmentAnchorResult[],
  status: TerrainHeightAlignmentBatchEstimate["status"],
  rejectionReason: string | undefined,
  warnings: string[],
  extras: Partial<TerrainHeightAlignmentBatchEstimate> = {},
): TerrainHeightAlignmentBatchEstimate {
  const sampledAnchorCount = perAnchorResults.filter((result) => result.sampled).length;
  const acceptedAnchorCount = perAnchorResults.filter((result) => result.accepted).length;
  const requestedAnchorCount = input.candidates.length;
  const coverage = {
    requestedAnchorCount,
    sampledAnchorCount,
    acceptedAnchorCount,
    acceptedFraction:
      requestedAnchorCount === 0 ? 0 : acceptedAnchorCount / requestedAnchorCount,
    notEvaluatedAnchorCount: Math.max(0, requestedAnchorCount - perAnchorResults.length),
    ...(extras.coverage ?? {}),
  };
  return {
    status,
    actionable: false,
    perAnchorResults,
    existingHeightOffsetMeters: input.existingHeightOffsetMeters,
    verticalReference: {
      sourceVerticalCrs: verticalReference.sourceVerticalCrs,
      displayHeightReference: verticalReference.displayHeightReference,
      conversion: verticalReference.conversion,
      ...(verticalReference.verticalGridId === undefined
        ? {}
        : { verticalGridId: verticalReference.verticalGridId }),
    },
    generationIdentity: { ...input.generationIdentity },
    ...(input.provider
      ? {
          terrainProvider: {
            type: input.provider.constructor?.name || "TerrainProvider",
            hasTileAvailability: input.provider.availability !== undefined,
          },
        }
      : {}),
    ...(safeSourceLabel(input.sourceId)
      ? { sourceId: safeSourceLabel(input.sourceId) }
      : {}),
    ...(safeSourceLabel(input.terrainSourceId)
      ? { terrainSourceId: safeSourceLabel(input.terrainSourceId) }
      : {}),
    terrainSamplingCalls: 0,
    warnings,
    ...(rejectionReason ? { rejectionReason } : {}),
    ...extras,
    coverage,
  };
}

/**
 * Compare a bounded set of explicitly supplied ground points with Cesium Terrain.
 * All eligible positions share one public Cesium sampling call. This internal
 * estimator never changes geometry and is not a datum or survey correction.
 */
export async function estimateTerrainHeightAlignmentBatch(
  input: EstimateTerrainHeightAlignmentBatchInput,
): Promise<TerrainHeightAlignmentBatchEstimate> {
  const verticalReference = assessDisplayedHeightReference(
    input.metadata,
    input.verticalTransform,
  );
  const options = input.options ?? {};
  const viewer = input.viewer;
  const provider = input.provider;
  const configuredMax = options.maxAnchors ?? DEFAULT_MAX_ANCHORS;
  const maxAnchorsValid =
    Number.isSafeInteger(configuredMax) &&
    configuredMax >= 2 &&
    configuredMax <= HARD_MAX_ANCHORS;
  const responseCandidates = input.candidates.slice(0, HARD_MAX_ANCHORS);
  const warnings: string[] = [];

  const baseFailure = (
    status: TerrainHeightAlignmentBatchEstimate["status"],
    reason: string,
    results = responseCandidates.map((candidate) =>
      emptyAnchorResult(candidate, reason),
    ),
    extraWarnings: string[] = warnings,
  ) =>
    createBatchEstimate(
      input,
      verticalReference,
      results,
      status,
      reason,
      extraWarnings,
    );

  if (options.signal?.aborted) {
    return baseFailure("cancelled", "Terrain estimation was cancelled before sampling.");
  }
  if (!validGenerationIdentity(input.generationIdentity)) {
    return baseFailure(
      "unavailable",
      "Source, layer, TerrainProvider, and vertical-transform generations must be non-negative safe integers.",
    );
  }
  if (!Number.isFinite(input.existingHeightOffsetMeters)) {
    return baseFailure("unavailable", "The existing height offset must be finite.");
  }
  if (!maxAnchorsValid) {
    return baseFailure(
      "unavailable",
      `The configured maximum anchor count must be a whole number from 2 to ${HARD_MAX_ANCHORS}.`,
    );
  }
  if (input.candidates.length > HARD_MAX_ANCHORS) {
    return baseFailure(
      "unavailable",
      `A batch may contain at most ${HARD_MAX_ANCHORS} anchor candidates; no Terrain samples were requested.`,
      responseCandidates.map((candidate) =>
        emptyAnchorResult(
          candidate,
          `The request exceeded the hard limit of ${HARD_MAX_ANCHORS}; no Terrain samples were requested.`,
        ),
      ),
    );
  }
  if (input.unavailableReason) {
    return baseFailure("unavailable", input.unavailableReason);
  }
  if (!viewer || !provider || viewer.isDestroyed?.()) {
    return baseFailure(
      "unavailable",
      "The layer must be loaded and attached to a live Cesium Viewer before estimating.",
    );
  }
  if (input.candidates.length === 0) {
    return baseFailure("unavailable", "Provide at least two ground-anchor candidates.");
  }
  if (input.candidates.length < 2) {
    return baseFailure("uncertain", "At least two independent ground anchors are required.");
  }
  if (!input.isCurrent()) {
    return baseFailure(
      "unavailable",
      "The source, layer, TerrainProvider, transform, or supplied anchors are no longer current.",
    );
  }

  const initialResults: TerrainHeightAlignmentAnchorResult[] = [];
  const eligibleIndices: number[] = [];
  const seenCoordinates = new Set<string>();
  let hasUnconfirmedGround = false;
  for (let index = 0; index < responseCandidates.length; index += 1) {
    const candidate = responseCandidates[index];
    const anchor = candidate.anchor;
    if (index >= configuredMax) {
      initialResults.push(
        emptyAnchorResult(
          candidate,
          `This anchor exceeds the configured maximum of ${configuredMax} candidates and was not sampled.`,
        ),
      );
      continue;
    }
    if (
      anchor.ownerId !== input.expectedOwnerId ||
      !anchor.nodeKey ||
      !Number.isSafeInteger(anchor.pointIndex) ||
      anchor.pointIndex < 0
    ) {
      initialResults.push(
        emptyAnchorResult(candidate, "The anchor is not owned by the current COPC layer."),
      );
      continue;
    }
    if (!isFiniteAnchor(anchor)) {
      initialResults.push(
        emptyAnchorResult(
          candidate,
          "The anchor must have finite longitude, latitude, displayed height, and finite source XYZ coordinates when retained.",
        ),
      );
      continue;
    }
    if (anchor.classification !== 2 && candidate.groundConfirmed !== true) {
      hasUnconfirmedGround = true;
      initialResults.push(
        emptyAnchorResult(
          candidate,
          "The anchor is not independently classified as ASPRS ground (class 2); confirm ground status explicitly.",
        ),
      );
      continue;
    }
    if (input.isAnchorCurrent && !input.isAnchorCurrent(anchor)) {
      initialResults.push(
        emptyAnchorResult(
          candidate,
          "The anchor is no longer present in this layer's current rendered point cache.",
        ),
      );
      continue;
    }
    const coordinateKey = `${anchor.longitude},${anchor.latitude}`;
    if (seenCoordinates.has(coordinateKey)) {
      initialResults.push(
        emptyAnchorResult(
          candidate,
          "This anchor duplicates the longitude and latitude of an earlier candidate and was not sampled.",
        ),
      );
      continue;
    }
    seenCoordinates.add(coordinateKey);
    const candidateWarnings =
      anchor.classification === 2
        ? []
        : ["Ground status was confirmed by the caller; classification does not independently verify ground."];
    initialResults.push({
      anchor: anchorSnapshot(anchor),
      accepted: false,
      sampled: false,
      warnings: candidateWarnings,
    });
    eligibleIndices.push(index);
  }

  if (!verticalReference.verified) {
    const reason =
      verticalReference.reason ??
      "Displayed COPC heights are not verified WGS 84 ellipsoidal heights.";
    for (const index of eligibleIndices) {
      initialResults[index] = markRejected(initialResults[index], reason);
    }
    return baseFailure(
      "uncertain",
      reason,
      initialResults,
      warnings,
    );
  }
  if (hasUnconfirmedGround) {
    warnings.push("One or more candidates were rejected because ground status was not confirmed.");
  }
  if (eligibleIndices.length === 0) {
    return baseFailure(
      hasUnconfirmedGround ? "uncertain" : "unavailable",
      "No eligible, distinct ground anchors remain for Terrain sampling.",
      initialResults,
    );
  }
  if (provider instanceof Cesium.EllipsoidTerrainProvider) {
    const reason = "The active provider renders only the ellipsoid and has no real terrain elevation.";
    for (const index of eligibleIndices) initialResults[index] = markRejected(initialResults[index], reason);
    return baseFailure("unavailable", reason, initialResults);
  }
  if (!provider.availability) {
    const reason = "Cesium sampleTerrainMostDetailed requires a provider with tile availability; no fallback is configured.";
    for (const index of eligibleIndices) initialResults[index] = markRejected(initialResults[index], reason);
    return baseFailure("unavailable", reason, initialResults);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TERRAIN_SAMPLE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TERRAIN_SAMPLE_TIMEOUT_MS
  ) {
    const reason = `Terrain sample timeout must be a whole number from 1 to ${MAX_TERRAIN_SAMPLE_TIMEOUT_MS} ms.`;
    for (const index of eligibleIndices) initialResults[index] = markRejected(initialResults[index], reason);
    return baseFailure("unavailable", reason, initialResults);
  }
  const highSpreadWarningMeters =
    options.highSpreadWarningMeters ?? DEFAULT_HIGH_SPREAD_WARNING_METERS;
  if (!Number.isFinite(highSpreadWarningMeters) || highSpreadWarningMeters < 0) {
    const reason = "The high-spread warning threshold must be a finite non-negative number of metres.";
    for (const index of eligibleIndices) initialResults[index] = markRejected(initialResults[index], reason);
    return baseFailure("unavailable", reason, initialResults);
  }
  if (!acquireTerrainSamplingSlot(viewer)) {
    const reason = "Another Terrain estimate is already sampling this Viewer. Wait for it to finish before starting another.";
    for (const index of eligibleIndices) initialResults[index] = markRejected(initialResults[index], reason);
    return baseFailure("unavailable", reason, initialResults);
  }

  const sample = input.sampleTerrainMostDetailed ?? Cesium.sampleTerrainMostDetailed;
  const positions = eligibleIndices.map((index) => {
    const anchor = responseCandidates[index].anchor;
    return Cesium.Cartographic.fromDegrees(anchor.longitude, anchor.latitude, anchor.height);
  });
  const samplingStartedAt = performance.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const samplingPromise = Promise.resolve().then(() =>
    sample(provider, positions, true),
  );
  // Cesium has no AbortSignal parameter; keep the shared Viewer slot until its
  // one underlying request settles, even when this caller times out or aborts.
  void samplingPromise
    .finally(() => releaseTerrainSamplingSlot(viewer))
    .catch(() => undefined);
  const boundedSamplingPromise = Promise.race([
    samplingPromise,
    new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(TERRAIN_SAMPLE_TIMEOUT), timeoutMs);
    }),
    ...(options.signal
      ? [
          new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(TERRAIN_SAMPLE_ABORTED);
            options.signal?.addEventListener("abort", abortListener, { once: true });
            if (options.signal?.aborted) abortListener();
          }),
        ]
      : []),
  ]);

  try {
    const sampledPositions = await boundedSamplingPromise;
    const samplingDurationMs = performance.now() - samplingStartedAt;
    const sampledResults = [...initialResults];
    for (let sampledIndex = 0; sampledIndex < eligibleIndices.length; sampledIndex += 1) {
      const resultIndex = eligibleIndices[sampledIndex];
      const terrainHeightMeters = sampledPositions[sampledIndex]?.height;
      if (terrainHeightMeters === undefined || !Number.isFinite(terrainHeightMeters)) {
        sampledResults[resultIndex] = markRejected(
          { ...sampledResults[resultIndex], sampled: true },
          "The TerrainProvider returned no finite height at this anchor.",
        );
        continue;
      }
      const residualMeters =
        terrainHeightMeters - responseCandidates[resultIndex].anchor.height;
      if (!Number.isFinite(residualMeters)) {
        sampledResults[resultIndex] = markRejected(
          {
            ...sampledResults[resultIndex],
            sampled: true,
            terrainHeightMeters,
          },
          "The terrain-minus-displayed-height residual is not finite.",
        );
        continue;
      }
      sampledResults[resultIndex] = {
        ...sampledResults[resultIndex],
        sampled: true,
        terrainHeightMeters,
        residualMeters,
      };
    }

    if (options.signal?.aborted) {
      const reason = "Terrain estimation was cancelled while sampling; the result was discarded.";
      return createBatchEstimate(
        input,
        verticalReference,
        sampledResults.map((result) =>
          result.sampled ? markRejected(result, reason) : result,
        ),
        "cancelled",
        reason,
        warnings,
        { terrainSamplingCalls: 1, samplingDurationMs },
      );
    }
    if (
      !input.isCurrent() ||
      eligibleIndices.some((index) =>
        input.isAnchorCurrent
          ? !input.isAnchorCurrent(responseCandidates[index].anchor)
          : false,
      )
    ) {
      const reason = "The source, layer, TerrainProvider, transform, or supplied anchors changed during sampling; the result was discarded.";
      return createBatchEstimate(
        input,
        verticalReference,
        sampledResults.map((result) =>
          result.sampled ? markRejected(result, reason) : result,
        ),
        "unavailable",
        reason,
        warnings,
        { terrainSamplingCalls: 1, samplingDurationMs },
      );
    }

    const finiteSamples = sampledResults.filter(
      (result): result is TerrainHeightAlignmentAnchorResult & { residualMeters: number } =>
        result.sampled && result.residualMeters !== undefined,
    );
    if (finiteSamples.length === 0) {
      const reason = "The TerrainProvider returned no finite heights for the eligible anchors.";
      return createBatchEstimate(
        input,
        verticalReference,
        sampledResults,
        "unavailable",
        reason,
        warnings,
        { terrainSamplingCalls: 1, samplingDurationMs },
      );
    }

    const firstMedian = median(finiteSamples.map((result) => result.residualMeters));
    const firstMad = median(
      finiteSamples.map((result) => Math.abs(result.residualMeters - firstMedian)),
    );
    const outlierThresholdMeters =
      firstMad === 0 ? 0.01 : 3.5 * 1.4826 * firstMad;
    for (const result of finiteSamples) {
      if (Math.abs(result.residualMeters - firstMedian) > outlierThresholdMeters) {
        const candidateIndex = sampledResults.indexOf(result);
        sampledResults[candidateIndex] = markRejected(
          result,
          `Residual is a robust outlier, more than ${outlierThresholdMeters.toFixed(3)} m from the batch median.`,
        );
      } else {
        const candidateIndex = sampledResults.indexOf(result);
        sampledResults[candidateIndex] = { ...result, accepted: true };
      }
    }

    const inlierResiduals = sampledResults
      .filter((result) => result.accepted && result.residualMeters !== undefined)
      .map((result) => result.residualMeters as number);
    const medianResidualMeters = median(inlierResiduals);
    const robustSpreadMeters =
      inlierResiduals.length > 0
        ? 1.4826 *
          median(inlierResiduals.map((residual) => Math.abs(residual - medianResidualMeters)))
        : undefined;
    const acceptedAnchorCount = inlierResiduals.length;
    const sharedWarnings = [
      ...warnings,
      "Terrain LOD and candidate quality limit confidence; this visual estimate does not establish survey or geoid accuracy.",
    ];
    if (hasUnconfirmedGround) {
      sharedWarnings.push("Some candidates were excluded because ground status was not confirmed.");
    }
    if (acceptedAnchorCount < 2) {
      const reason = "Fewer than two finite inlier anchors remain; a batch proposal requires at least two.";
      return createBatchEstimate(
        input,
        verticalReference,
        sampledResults,
        "uncertain",
        reason,
        sharedWarnings,
        {
          terrainSamplingCalls: 1,
          samplingDurationMs,
          ...(Number.isFinite(medianResidualMeters) ? { medianResidualMeters } : {}),
          ...(robustSpreadMeters === undefined ? {} : { robustSpreadMeters }),
        },
      );
    }

    const proposedHeightOffsetMeters =
      input.existingHeightOffsetMeters + medianResidualMeters;
    if (!Number.isFinite(proposedHeightOffsetMeters)) {
      const reason = "The proposed height offset is not finite.";
      return createBatchEstimate(
        input,
        verticalReference,
        sampledResults.map((result) =>
          result.accepted ? markRejected(result, reason) : result,
        ),
        "unavailable",
        reason,
        sharedWarnings,
        { terrainSamplingCalls: 1, samplingDurationMs },
      );
    }

    if (robustSpreadMeters !== undefined && robustSpreadMeters > highSpreadWarningMeters) {
      const reason = `Robust residual spread ${robustSpreadMeters.toFixed(3)} m exceeds the ${highSpreadWarningMeters.toFixed(3)} m warning threshold; review anchor quality and terrain variation.`;
      sharedWarnings.push(reason);
      return createBatchEstimate(
        input,
        verticalReference,
        sampledResults,
        "uncertain",
        reason,
        sharedWarnings,
        {
          terrainSamplingCalls: 1,
          samplingDurationMs,
          medianResidualMeters,
          robustSpreadMeters,
          existingHeightOffsetMeters: input.existingHeightOffsetMeters,
          proposedHeightOffsetMeters,
          actionable: false,
        },
      );
    }

    return createBatchEstimate(
      input,
      verticalReference,
      sampledResults,
      "ready",
      undefined,
      sharedWarnings,
      {
        terrainSamplingCalls: 1,
        samplingDurationMs,
        medianResidualMeters,
        robustSpreadMeters,
        proposedHeightOffsetMeters,
        actionable: true,
      },
    );
  } catch (error) {
    const timedOut = error === TERRAIN_SAMPLE_TIMEOUT;
    const cancelled = error === TERRAIN_SAMPLE_ABORTED || options.signal?.aborted;
    const reason = cancelled
      ? "Terrain estimation was cancelled while sampling; the result was discarded."
      : timedOut
        ? `Terrain sampling exceeded its ${timeoutMs} ms deadline. The Cesium request may still complete in the background.`
        : "Cesium terrain sampling failed; check provider coverage and availability.";
    const results = [...initialResults];
    for (const index of eligibleIndices) {
      results[index] = markRejected(
        { ...results[index], sampled: true },
        reason,
      );
    }
    return createBatchEstimate(
      input,
      verticalReference,
      results,
      cancelled ? "cancelled" : "unavailable",
      reason,
      warnings,
      {
        terrainSamplingCalls: 1,
        samplingDurationMs: performance.now() - samplingStartedAt,
      },
    );
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);
  }
}

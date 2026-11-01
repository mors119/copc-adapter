import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateTerrainHeightAlignmentBatch,
} from "../../../cesium/terrain/terrainHeightAlignmentBatch.ts";

const ELLIPSOIDAL_WKT =
  'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]],ID["EPSG",6326]],CS[ellipsoidal,3],AXIS["geodetic latitude (Lat)",north,ORDER[1],ANGLEUNIT["degree",0.0174532925199433]],AXIS["geodetic longitude (Lon)",east,ORDER[2],ANGLEUNIT["degree",0.0174532925199433]],AXIS["ellipsoidal height (h)",up,ORDER[3],LENGTHUNIT["metre",1]],ID["EPSG",4979]]';
const NAVD88_WKT =
  'COMPD_CS["NAD83 / Oregon GIC Lambert + NAVD88",PROJCS["NAD83 / Oregon GIC Lambert (ft)",GEOGCS["NAD83",DATUM["North American Datum 1983",SPHEROID["GRS 1980",6378137,298.257222101]],UNIT["degree",0.0174532925199433]],UNIT["US survey foot",0.3048006096012192]],VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum of 1988",2005],UNIT["US survey foot",0.3048006096012192],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","6360"]]]';

class FixtureTerrainProvider {
  availability = {};
}

const generationIdentity = {
  sourceGeneration: 3,
  layerGeneration: 5,
  terrainProviderGeneration: 7,
  verticalTransformGeneration: 0,
};

function createCandidates(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    anchor: {
      ownerId: "layer-1",
      nodeKey: `0-0-0-${index}`,
      level: 0,
      pointIndex: index,
      longitude: -122.5 + index * 0.001,
      latitude: 44.5 + index * 0.001,
      height: 100,
      source: { x: 1000 + index, y: 2000 + index, z: 300 + index },
      classification: 2,
      backend: "copc-js",
    },
    ...overrides[index],
  }));
}

function createInput(overrides = {}) {
  const viewer = {};
  const provider = new FixtureTerrainProvider();
  return {
    viewer,
    provider,
    metadata: { wkt: ELLIPSOIDAL_WKT },
    candidates: createCandidates(3),
    expectedOwnerId: "layer-1",
    existingHeightOffsetMeters: 0,
    generationIdentity,
    sourceId: "https://example.test/cloud.copc.laz?token=secret",
    isCurrent: () => true,
    sampleTerrainMostDetailed: async (_provider, positions) => positions,
    ...overrides,
  };
}

function sampleHeights(heights, overrides = {}) {
  let calls = 0;
  let sampledCount = 0;
  const customSampler = overrides.sampleTerrainMostDetailed;
  const estimate = estimateTerrainHeightAlignmentBatch({
    ...createInput(overrides),
    sampleTerrainMostDetailed: async (_provider, positions) => {
      calls += 1;
      sampledCount = positions.length;
      if (customSampler) return customSampler(_provider, positions, true);
      positions.forEach((position, index) => {
        position.height = heights[index];
      });
      return positions;
    },
  });
  return { estimate, get calls() { return calls; }, get sampledCount() { return sampledCount; } };
}

test("samples eligible anchors in one Cesium request and proposes a median after rejecting an outlier", async () => {
  const candidates = createCandidates(4);
  const originalSourceCoordinates = candidates.map(({ anchor }) => ({ ...anchor.source }));
  const sample = sampleHeights([110, 112, 111, 200], {
    candidates,
    existingHeightOffsetMeters: 3.2,
  });
  const estimate = await sample.estimate;

  assert.equal(sample.calls, 1);
  assert.equal(sample.sampledCount, 4);
  assert.equal(estimate.status, "ready");
  assert.equal(estimate.actionable, true);
  assert.equal(estimate.medianResidualMeters, 11);
  assert.equal(estimate.robustSpreadMeters, 1.4826);
  assert.equal(estimate.existingHeightOffsetMeters, 3.2);
  assert.equal(estimate.proposedHeightOffsetMeters, 14.2);
  assert.equal(estimate.coverage.acceptedAnchorCount, 3);
  assert.match(estimate.perAnchorResults[3].rejectionReason, /robust outlier/);
  assert.deepEqual(candidates.map(({ anchor }) => anchor.source), originalSourceCoordinates);
  assert.equal(estimate.sourceId, "example.test/cloud.copc.laz");
  assert.equal(estimate.generationIdentity.terrainProviderGeneration, 7);
});

test("rejects building-class roofs without ground evidence and deduplicates coordinates", async () => {
  const candidates = createCandidates(4);
  candidates[1].anchor.classification = 6;
  candidates[2].anchor.longitude = candidates[0].anchor.longitude;
  candidates[2].anchor.latitude = candidates[0].anchor.latitude;
  const sample = sampleHeights([110, 110], { candidates });
  const estimate = await sample.estimate;

  assert.equal(sample.calls, 1);
  assert.equal(sample.sampledCount, 2);
  assert.equal(estimate.actionable, true);
  assert.equal(estimate.coverage.acceptedAnchorCount, 2);
  assert.match(estimate.perAnchorResults[1].rejectionReason, /confirm ground status/);
  assert.match(estimate.perAnchorResults[2].rejectionReason, /duplicates/);

  const confirmed = sampleHeights([110, 110], {
    candidates: [
      { ...candidates[1], groundConfirmed: true },
      { ...candidates[3], groundConfirmed: true },
    ],
  });
  const confirmedEstimate = await confirmed.estimate;
  assert.equal(confirmedEstimate.actionable, true);
  assert.match(confirmedEstimate.perAnchorResults[0].warnings.join(" "), /confirmed by the caller/);
});

test("returns an uncertain proposal when independent anchors show high robust spread", async () => {
  const estimate = await sampleHeights([100, 110, 120], {
    existingHeightOffsetMeters: 5,
  }).estimate;

  assert.equal(estimate.status, "uncertain");
  assert.equal(estimate.actionable, false);
  assert.equal(estimate.medianResidualMeters, 10);
  assert.ok(Math.abs(estimate.robustSpreadMeters - 14.826) < 1e-10);
  assert.equal(estimate.proposedHeightOffsetMeters, 15);
  assert.match(estimate.rejectionReason, /exceeds the 2.000 m warning threshold/);
});

test("keeps centimetre-scale signed residuals and combines existing offset only once", async () => {
  const positive = await sampleHeights([101.01, 101.02, 101], {
    existingHeightOffsetMeters: 0.37,
  }).estimate;
  const negative = await sampleHeights([99.99, 99.98, 100], {
    existingHeightOffsetMeters: -0.02,
  }).estimate;

  assert.ok(Math.abs(positive.medianResidualMeters - 1.01) < 1e-10);
  assert.ok(Math.abs(positive.proposedHeightOffsetMeters - 1.38) < 1e-10);
  assert.ok(Math.abs(negative.medianResidualMeters - -0.01) < 1e-10);
  assert.ok(Math.abs(negative.proposedHeightOffsetMeters - -0.03) < 1e-10);
});

test("rejects unverified height frames and empty eligible sets without Terrain requests", async () => {
  const unverified = sampleHeights([110, 110, 110], {
    metadata: { wkt: NAVD88_WKT },
  });
  const unverifiedEstimate = await unverified.estimate;
  assert.equal(unverified.calls, 0);
  assert.equal(unverifiedEstimate.status, "uncertain");
  assert.equal(unverifiedEstimate.verticalReference.displayHeightReference, "unverified");

  const unconfirmedCandidates = createCandidates(3).map((candidate) => ({
    ...candidate,
    anchor: { ...candidate.anchor, classification: 6 },
  }));
  const noGround = sampleHeights([], { candidates: unconfirmedCandidates });
  const noGroundEstimate = await noGround.estimate;
  assert.equal(noGround.calls, 0);
  assert.equal(noGroundEstimate.status, "uncertain");
  assert.equal(noGroundEstimate.coverage.acceptedAnchorCount, 0);
});

test("enforces candidate and provider bounds before sampling", async () => {
  const configuredBound = sampleHeights([110, 110, 110], {
    candidates: createCandidates(4),
    options: { maxAnchors: 2 },
  });
  const configuredBoundEstimate = await configuredBound.estimate;
  assert.equal(configuredBound.sampledCount, 2);
  assert.equal(configuredBoundEstimate.actionable, true);
  assert.match(configuredBoundEstimate.perAnchorResults[2].rejectionReason, /configured maximum of 2/);

  const tooMany = sampleHeights([], {
    candidates: createCandidates(13),
  });
  const tooManyEstimate = await tooMany.estimate;
  assert.equal(tooMany.calls, 0);
  assert.equal(tooManyEstimate.coverage.notEvaluatedAnchorCount, 1);
  assert.match(tooManyEstimate.rejectionReason, /at most 12/);

  const noAvailability = sampleHeights([110, 110, 110], {
    provider: {},
  });
  const noAvailabilityEstimate = await noAvailability.estimate;
  assert.equal(noAvailability.calls, 0);
  assert.match(noAvailabilityEstimate.rejectionReason, /tile availability/);

  const missingHeights = sampleHeights([Number.NaN, undefined, Number.NaN]);
  const missingHeightsEstimate = await missingHeights.estimate;
  assert.equal(missingHeightsEstimate.status, "unavailable");
  assert.equal(missingHeightsEstimate.coverage.sampledAnchorCount, 3);
  assert.equal(missingHeightsEstimate.coverage.acceptedAnchorCount, 0);
  assert.ok(missingHeightsEstimate.perAnchorResults.every((result) => /no finite height/.test(result.rejectionReason)));
});

test("rejects stale source or provider generations after the shared sample call", async () => {
  let current = true;
  const sample = sampleHeights([110, 110, 110], {
    isCurrent: () => current,
    sampleTerrainMostDetailed: async (_provider, positions) => {
      current = false;
      positions.forEach((position) => {
        position.height = 110;
      });
      return positions;
    },
  });
  const estimate = await sample.estimate;

  assert.equal(sample.calls, 1);
  assert.equal(estimate.status, "unavailable");
  assert.equal(estimate.actionable, false);
  assert.match(estimate.rejectionReason, /changed during sampling/);
  assert.equal(estimate.perAnchorResults[0].accepted, false);
});

test("supports cancellation and holds the per-Viewer bound until Cesium settles", async () => {
  let finishSample;
  const controller = new AbortController();
  const input = createInput({
    options: { signal: controller.signal, timeoutMs: 500 },
    sampleTerrainMostDetailed: (_provider, positions) =>
      new Promise((resolve) => {
        finishSample = () => {
          positions.forEach((position) => {
            position.height = 110;
          });
          resolve(positions);
        };
      }),
  });
  const pending = estimateTerrainHeightAlignmentBatch(input);
  await Promise.resolve();
  controller.abort();
  const cancelled = await pending;
  const blocked = await estimateTerrainHeightAlignmentBatch({
    ...createInput({ viewer: input.viewer }),
  });
  finishSample();

  assert.equal(cancelled.status, "cancelled");
  assert.equal(blocked.status, "unavailable");
  assert.match(blocked.rejectionReason, /already sampling this Viewer/);
});

test("times out promptly and releases the shared Viewer lock only after the sample settles", async () => {
  let finishSample;
  const input = createInput({
    options: { timeoutMs: 5 },
    sampleTerrainMostDetailed: (_provider, positions) =>
      new Promise((resolve) => {
        finishSample = () => {
          positions.forEach((position) => {
            position.height = 110;
          });
          resolve(positions);
        };
      }),
  });
  const timedOut = await estimateTerrainHeightAlignmentBatch(input);
  assert.equal(timedOut.status, "unavailable");
  assert.match(timedOut.rejectionReason, /exceeded its 5 ms deadline/);

  const blocked = await estimateTerrainHeightAlignmentBatch({
    ...createInput({ viewer: input.viewer }),
  });
  assert.match(blocked.rejectionReason, /already sampling this Viewer/);
  finishSample();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const available = await sampleHeights([110, 110, 110], {
    viewer: input.viewer,
  }).estimate;
  assert.equal(available.actionable, true);
});

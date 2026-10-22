import assert from "node:assert/strict";
import test from "node:test";
import * as Cesium from "cesium";

import {
  assessDisplayedHeightReference,
  estimateTerrainHeightAlignment,
} from "../../../cesium/terrain/terrainHeightAlignment.ts";

const ELLIPSOIDAL_WKT =
  'VERT_CS["WGS 84 ellipsoidal height",VERT_DATUM["WGS_1984",2005],UNIT["metre",1],AXIS["Ellipsoidal height",UP],AUTHORITY["EPSG","4979"]]';
const NAVD88_WKT =
  'COMPD_CS["NAD83 / Oregon GIC Lambert + NAVD88",PROJCS["NAD83 / Oregon GIC Lambert (ft)",GEOGCS["NAD83",DATUM["North American Datum 1983",SPHEROID["GRS 1980",6378137,298.257222101]],UNIT["degree",0.0174532925199433]],UNIT["US survey foot",0.3048006096012192]],VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum of 1988",2005],UNIT["US survey foot",0.3048006096012192],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","6360"]]]';

class FixtureTerrainProvider {
  availability = {};
}

function createInput(overrides = {}) {
  const viewer = {};
  const provider = new FixtureTerrainProvider();
  const anchor = {
    ownerId: "layer-1",
    nodeKey: "0-0-0-0",
    level: 0,
    pointIndex: 3,
    longitude: -122.5,
    latitude: 44.5,
    height: 100,
    source: { x: 1000, y: 2000, z: 328.083333 },
    classification: 2,
    backend: "copc-js",
  };
  return {
    viewer,
    provider,
    metadata: { wkt: ELLIPSOIDAL_WKT },
    anchor,
    expectedOwnerId: "layer-1",
    existingHeightOffsetMeters: 0,
    sourceId: "https://example.test/cloud.copc.laz?token=secret",
    isCurrent: () => true,
    sampleTerrainMostDetailed: async (_provider, positions) => positions,
    ...overrides,
  };
}

async function estimateWithTerrainHeight(terrainHeight, overrides = {}) {
  return estimateTerrainHeightAlignment({
    ...createInput(overrides),
    sampleTerrainMostDetailed: async (_provider, positions) => {
      positions[0].height = terrainHeight;
      return positions;
    },
  });
}

test("calculates positive, negative, and zero Terrain residuals in metres", async () => {
  const positive = await estimateWithTerrainHeight(112.5);
  const negative = await estimateWithTerrainHeight(87.5);
  const zero = await estimateWithTerrainHeight(100);

  assert.equal(positive.proposedOffsetMeters, 12.5);
  assert.equal(negative.proposedOffsetMeters, -12.5);
  assert.equal(zero.proposedOffsetMeters, 0);
  assert.equal(positive.actionable, true);
  assert.equal(positive.anchor.source.z, 328.083333);
  assert.equal(positive.sourceId, "example.test/cloud.copc.laz");
  const labeledTerrain = await estimateWithTerrainHeight(112.5, {
    terrainSourceId: "https://terrain.example/tiles/layer.json?token=secret",
  });
  assert.equal(labeledTerrain.terrainSourceId, "terrain.example/tiles/layer.json");
  assert.doesNotMatch(labeledTerrain.terrainSourceId, /secret/);
});

test("combines the residual with positive and negative existing manual offsets once", async () => {
  const positiveManual = await estimateWithTerrainHeight(112, {
    existingHeightOffsetMeters: 7,
  });
  const negativeManual = await estimateWithTerrainHeight(112, {
    existingHeightOffsetMeters: -7,
  });

  assert.equal(positiveManual.proposedOffsetMeters, 12);
  assert.equal(positiveManual.existingHeightOffsetMeters, 7);
  assert.equal(positiveManual.effectiveProposedHeightOffsetMeters, 19);
  assert.equal(negativeManual.effectiveProposedHeightOffsetMeters, 5);
});

test("re-estimating after applying a correction does not add the correction twice", async () => {
  const first = await estimateWithTerrainHeight(110, {
    existingHeightOffsetMeters: 4,
  });
  assert.equal(first.proposedOffsetMeters, 10);
  assert.equal(first.effectiveProposedHeightOffsetMeters, 14);

  const displayedAfterApproval = {
    ...createInput().anchor,
    height: 110,
  };
  const second = await estimateWithTerrainHeight(110, {
    anchor: displayedAfterApproval,
    existingHeightOffsetMeters: first.effectiveProposedHeightOffsetMeters,
  });
  assert.equal(second.proposedOffsetMeters, 0);
  assert.equal(second.effectiveProposedHeightOffsetMeters, 14);
});

test("rejects missing, foreign, malformed, and non-ground anchors", async () => {
  const missing = await estimateWithTerrainHeight(110, { anchor: undefined });
  const foreign = await estimateWithTerrainHeight(110, {
    anchor: { ...createInput().anchor, ownerId: "another-layer" },
  });
  const missingSource = await estimateWithTerrainHeight(110, {
    anchor: { ...createInput().anchor, source: undefined },
  });
  const invalidLongitude = await estimateWithTerrainHeight(110, {
    anchor: { ...createInput().anchor, longitude: 181 },
  });
  const nonFiniteZ = await estimateWithTerrainHeight(110, {
    anchor: {
      ...createInput().anchor,
      source: { x: 1, y: 2, z: Number.NaN },
    },
  });
  const unconfirmed = await estimateWithTerrainHeight(110, {
    anchor: { ...createInput().anchor, classification: 6 },
  });

  for (const result of [missing, foreign, missingSource, invalidLongitude, nonFiniteZ]) {
    assert.equal(result.actionable, false);
    assert.equal(result.terrainSamplingCalls, 0);
  }
  assert.equal(unconfirmed.status, "uncertain");
  assert.match(unconfirmed.rejectionReason, /Confirm explicitly/);
});

test("requires explicit ground confirmation for unclassified points", async () => {
  const result = await estimateWithTerrainHeight(105, {
    anchor: { ...createInput().anchor, classification: 6 },
    options: { groundConfirmed: true },
  });
  assert.equal(result.actionable, true);
  assert.match(result.warnings.join(" "), /confirmed by the caller/);
});

test("rejects ellipsoid-only providers, missing availability, and undefined coverage", async () => {
  const ellipsoid = await estimateTerrainHeightAlignment({
    ...createInput(),
    provider: new Cesium.EllipsoidTerrainProvider(),
  });
  const unsupported = await estimateTerrainHeightAlignment({
    ...createInput(),
    provider: {},
  });
  const noCoverage = await estimateWithTerrainHeight(undefined);

  assert.equal(ellipsoid.status, "unavailable");
  assert.match(ellipsoid.rejectionReason, /only the ellipsoid/);
  assert.equal(unsupported.status, "unavailable");
  assert.match(unsupported.rejectionReason, /tile availability/);
  assert.equal(noCoverage.actionable, false);
  assert.match(noCoverage.rejectionReason, /no finite height/);
});

test("rejects nonfinite terrain heights, network failures, cancellation, and stale sources", async () => {
  const nonFinite = await estimateWithTerrainHeight(Number.NaN);
  const networkError = await estimateTerrainHeightAlignment({
    ...createInput(),
    sampleTerrainMostDetailed: async () => {
      throw new Error("secret token must not be surfaced");
    },
  });
  const controller = new AbortController();
  const cancelled = await estimateTerrainHeightAlignment({
    ...createInput({ options: { signal: controller.signal } }),
    sampleTerrainMostDetailed: async (_provider, positions) => {
      controller.abort();
      positions[0].height = 110;
      return positions;
    },
  });
  const stale = await estimateTerrainHeightAlignment({
    ...createInput({ isCurrent: () => false }),
    sampleTerrainMostDetailed: async (_provider, positions) => {
      positions[0].height = 110;
      return positions;
    },
  });

  assert.equal(nonFinite.status, "unavailable");
  assert.equal(networkError.status, "unavailable");
  assert.doesNotMatch(networkError.rejectionReason, /secret token/);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(stale.status, "unavailable");
  assert.match(stale.rejectionReason, /no longer current/);
});

test("does not sample or return an actionable result for unverified NAVD88 heights", async () => {
  let sampled = false;
  const result = await estimateTerrainHeightAlignment({
    ...createInput({ metadata: { wkt: NAVD88_WKT } }),
    sampleTerrainMostDetailed: async (_provider, positions) => {
      sampled = true;
      positions[0].height = 120;
      return positions;
    },
  });

  assert.equal(sampled, false);
  assert.equal(result.status, "uncertain");
  assert.equal(result.actionable, false);
  assert.equal(result.verticalReference.sourceVerticalCrs, "EPSG:6360");
  assert.equal(result.verticalReference.displayHeightReference, "unverified");
  assert.match(result.rejectionReason, /no validated transformation/);
});

test("recognizes only an active, source-compatible validated vertical grid", async () => {
  const incompatibleGrid = {
    gridId: "unverified-grid",
    assertCompatibleSourceWkt() {
      throw new Error("the grid does not cover this source CRS");
    },
  };
  const incompatible = await estimateTerrainHeightAlignment({
    ...createInput({
      metadata: { wkt: NAVD88_WKT },
      verticalTransform: incompatibleGrid,
    }),
  });
  const compatibleGrid = {
    gridId: "verified-test-grid",
    assertCompatibleSourceWkt(wkt) {
      assert.equal(wkt, NAVD88_WKT);
    },
  };
  const compatible = await estimateWithTerrainHeight(125, {
    metadata: { wkt: NAVD88_WKT },
    verticalTransform: compatibleGrid,
  });

  assert.equal(incompatible.status, "uncertain");
  assert.equal(incompatible.actionable, false);
  assert.equal(compatible.actionable, true);
  assert.equal(compatible.verticalReference.conversion, "validated-vertical-grid");
  assert.equal(compatible.verticalReference.verticalGridId, "verified-test-grid");
});

test("does not accept an estimate after source or TerrainProvider replacement", async () => {
  let current = true;
  const staleSource = await estimateTerrainHeightAlignment({
    ...createInput({ isCurrent: () => current }),
    sampleTerrainMostDetailed: async (_provider, positions) => {
      current = false;
      positions[0].height = 110;
      return positions;
    },
  });
  current = false;
  assert.equal(staleSource.actionable, false);
  assert.equal(staleSource.status, "unavailable");
});

test("bounds one concurrent Terrain estimate per Viewer", async () => {
  let finishFirst;
  const firstInput = createInput({
    sampleTerrainMostDetailed: (_provider, positions) =>
      new Promise((resolve) => {
        finishFirst = () => {
          positions[0].height = 110;
          resolve(positions);
        };
      }),
  });
  const firstEstimate = estimateTerrainHeightAlignment(firstInput);
  await Promise.resolve();
  const secondEstimate = await estimateTerrainHeightAlignment({
    ...createInput({ viewer: firstInput.viewer }),
  });
  finishFirst();
  const first = await firstEstimate;

  assert.equal(secondEstimate.status, "unavailable");
  assert.match(secondEstimate.rejectionReason, /already sampling this Viewer/);
  assert.equal(first.actionable, true);
});

test("times out promptly and retains the request bound until the Cesium sampler settles", async () => {
  let finishSample;
  const input = createInput({
    options: { timeoutMs: 5 },
    sampleTerrainMostDetailed: (_provider, positions) =>
      new Promise((resolve) => {
        finishSample = () => {
          positions[0].height = 110;
          resolve(positions);
        };
      }),
  });
  const timedOut = await estimateTerrainHeightAlignment(input);
  assert.equal(timedOut.status, "unavailable");
  assert.match(timedOut.rejectionReason, /exceeded its 5 ms deadline/);

  const blocked = await estimateTerrainHeightAlignment({
    ...createInput({ viewer: input.viewer }),
  });
  assert.match(blocked.rejectionReason, /already sampling this Viewer/);

  finishSample();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const available = await estimateWithTerrainHeight(110, {
    viewer: input.viewer,
  });
  assert.equal(available.actionable, true);
});

test("AbortSignal returns a cancelled result while keeping pending Terrain work bounded", async () => {
  let finishSample;
  const controller = new AbortController();
  const input = createInput({
    options: { signal: controller.signal, timeoutMs: 500 },
    sampleTerrainMostDetailed: (_provider, positions) =>
      new Promise((resolve) => {
        finishSample = () => {
          positions[0].height = 110;
          resolve(positions);
        };
      }),
  });
  const pending = estimateTerrainHeightAlignment(input);
  await Promise.resolve();
  controller.abort();
  const cancelled = await pending;
  const blocked = await estimateTerrainHeightAlignment({
    ...createInput({ viewer: input.viewer }),
  });
  finishSample();

  assert.equal(cancelled.status, "cancelled");
  assert.match(blocked.rejectionReason, /already sampling this Viewer/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  getCurrentTerrainAlignmentResidual,
  getVerticalTransformIdentity,
} from "../terrainAlignmentProvenance.ts";

test("approved Terrain residual is current only for its source, provider, grid, and offset", () => {
  const verticalTransform = { grid: "nga-egm2008" };
  const verticalTransformIdentity = getVerticalTransformIdentity(verticalTransform);
  const provenance = {
    source: "https://example.test/data.copc.laz",
    terrainUrl: "https://example.test/terrain-a",
    verticalTransformIdentity,
    finalHeightOffsetMeters: 2.25,
    residualMeters: 2,
  };
  const context = {
    source: provenance.source,
    terrainUrl: provenance.terrainUrl,
    verticalTransformIdentity,
    heightOffsetMeters: provenance.finalHeightOffsetMeters,
  };
  const sameSource = (left, right) => left === right;

  assert.equal(getCurrentTerrainAlignmentResidual(provenance, context, sameSource), 2);
  assert.equal(
    getCurrentTerrainAlignmentResidual(
      provenance,
      { ...context, terrainUrl: "https://example.test/terrain-b" },
      sameSource,
    ),
    undefined,
  );
  assert.equal(
    getCurrentTerrainAlignmentResidual(
      provenance,
      { ...context, verticalTransformIdentity: undefined },
      sameSource,
    ),
    undefined,
  );
  assert.equal(
    getCurrentTerrainAlignmentResidual(
      provenance,
      {
        ...context,
        verticalTransformIdentity: getVerticalTransformIdentity({ grid: "nga-egm2008" }),
      },
      sameSource,
    ),
    undefined,
  );
  assert.equal(
    getCurrentTerrainAlignmentResidual(
      provenance,
      { ...context, source: "https://example.test/other.copc.laz" },
      sameSource,
    ),
    undefined,
  );
  assert.equal(
    getCurrentTerrainAlignmentResidual(
      provenance,
      { ...context, heightOffsetMeters: 3 },
      sameSource,
    ),
    undefined,
  );
  assert.equal(
    getCurrentTerrainAlignmentResidual(
      provenance,
      { ...context, source: undefined },
      sameSource,
    ),
    undefined,
  );
});

test("grid identity does not keep grid objects in approved provenance", () => {
  const grid = { backingBuffer: new ArrayBuffer(16) };
  const identity = getVerticalTransformIdentity(grid);

  assert.equal(typeof identity, "symbol");
  assert.equal(getVerticalTransformIdentity(grid), identity);
  assert.notEqual(getVerticalTransformIdentity({ backingBuffer: new ArrayBuffer(16) }), identity);
  assert.equal(getVerticalTransformIdentity(undefined), undefined);
});

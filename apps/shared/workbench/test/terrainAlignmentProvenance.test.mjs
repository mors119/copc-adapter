import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentTerrainAlignmentResidual } from "../terrainAlignmentProvenance.ts";

test("approved Terrain residual is current only for its source, provider, and offset", () => {
  const provenance = {
    source: "https://example.test/data.copc.laz",
    terrainUrl: "https://example.test/terrain-a",
    finalHeightOffsetMeters: 2.25,
    residualMeters: 2,
  };
  const context = {
    source: provenance.source,
    terrainUrl: provenance.terrainUrl,
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

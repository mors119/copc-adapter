import assert from "node:assert/strict";
import test from "node:test";
import { getPointInspectionRows } from "../pointFormatting.ts";

const basePoint = {
  nodeKey: "0-0-0-0-0-0-0",
  level: 0,
  pointIndex: 14,
  longitude: -122.12345678901234,
  latitude: 44.12345678901234,
  height: 842.1234567890123,
  backend: "rust",
};

test("point formatting preserves coordinates without fixed precision", () => {
  const rows = getPointInspectionRows(basePoint);
  assert.deepEqual(rows.summary, [
    {
      label: "Geographic position (WGS84)",
      value: "-122.12345678901234°, 44.12345678901234°",
    },
    {
      label: "WGS84 ellipsoidal height (m)",
      value: "842.1234567890123",
    },
  ]);
  assert.equal(
    rows.details.find((row) => row.label === "Point index")?.value,
    "14",
  );
});

test("only actual available attributes are shown", () => {
  const rows = getPointInspectionRows({
    ...basePoint,
    intensity: Number.NaN,
    source: { x: 12, y: 34, z: 56 },
    world: {
      coordinateSystem: "wgs84-ecef-meters",
      x: 1,
      y: 2,
      z: 3,
    },
    classification: 2,
    classificationLabel: "Ground",
    rgb: { red: 0, green: 128, blue: 255 },
    dimensions: { waveform: 12.5, gpsTime: 9_007_199_254_740_993n },
  });

  assert.deepEqual(rows.summary, [
    {
      label: "Geographic position (WGS84)",
      value: "-122.12345678901234°, 44.12345678901234°",
    },
    {
      label: "WGS84 ellipsoidal height (m)",
      value: "842.1234567890123",
    },
    { label: "Classification", value: "2 · Ground" },
    { label: "RGB", value: "0 / 128 / 255" },
  ]);
  assert.equal(
    rows.details.find((row) => row.label.startsWith("Source coordinates"))?.value,
    "12 / 34 / 56",
  );
  assert.equal(
    rows.details.find((row) => row.label.startsWith("ECEF coordinates"))?.value,
    "1 / 2 / 3",
  );
  assert.equal(
    rows.details.find((row) => row.label === "Extra dimension · gpsTime")?.value,
    "9007199254740993",
  );
  assert.equal(rows.details.some((row) => row.label === "Intensity"), false);
});

test("invalid coordinate triples are omitted instead of reformatted", () => {
  const rows = getPointInspectionRows({
    ...basePoint,
    source: { x: 1, y: Number.POSITIVE_INFINITY, z: 3 },
    rgb: { red: 1, green: Number.NaN, blue: 3 },
  });
  assert.equal(rows.details.some((row) => row.label.startsWith("Source coordinates")), false);
  assert.equal(rows.summary.some((row) => row.label === "RGB"), false);
});

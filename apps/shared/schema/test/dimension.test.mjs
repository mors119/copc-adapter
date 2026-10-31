import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultDimensionStyle,
  getWorkbenchNumericDimensions,
  requestedDimensionNames,
  withRequestedExtraDimensions,
} from "../../workbench/dimensionModel.ts";

const metadata = {
  extraDimensions: [
    { name: "height", type: "float", length: 4, noData: -9999 },
    { name: "scaled_float", type: "float", length: 4, scale: 2, offset: -3 },
    { name: "rank", type: "unsigned", length: 4, scale: 2, offset: -1 },
    { name: "record_id", type: "unsigned", length: 8 },
    { name: "vector", type: "float", length: 12 },
    { name: "Intensity", type: "unsigned", length: 2 },
  ],
};

test("numeric fields use exact metadata, supported scalar types, and truthful decode state", () => {
  const fields = getWorkbenchNumericDimensions(metadata, "copc-js", ["rank"]);
  assert.deepEqual(fields.map(({ name }) => name), ["Intensity", "height", "scaled_float", "rank", "record_id", "vector"]);
  assert.equal(fields[0].decoded, true);
  assert.equal(fields.find(({ name }) => name === "height").decoded, false);
  assert.equal(fields.find(({ name }) => name === "height").styleable, true);
  assert.deepEqual(fields.find(({ name }) => name === "height").defaultRange, { min: 0, max: 1 });
  assert.match(fields.find(({ name }) => name === "height").defaultRangeNote, /not been scanned/u);
  assert.deepEqual(fields.find(({ name }) => name === "scaled_float").defaultRange, { min: -3, max: -1 });
  assert.deepEqual(fields.find(({ name }) => name === "rank").defaultRange, {
    min: -1,
    max: 8_589_934_589,
  });
  assert.equal(fields.find(({ name }) => name === "rank").decoded, true);
  assert.equal(fields.find(({ name }) => name === "record_id").styleable, false);
  assert.match(fields.find(({ name }) => name === "record_id").unsupportedReason, /BigInt/u);
  assert.equal(fields.find(({ name }) => name === "vector").styleable, false);
});

test("Rust metadata does not advertise named Extra Bytes as usable color fields", () => {
  const fields = getWorkbenchNumericDimensions(metadata, "rust", ["rank"]);
  assert.equal(fields.find(({ name }) => name === "Intensity").styleable, true);
  assert.equal(fields.find(({ name }) => name === "rank").styleable, false);
  assert.match(fields.find(({ name }) => name === "rank").unsupportedReason, /Rust\/WASM/u);
  assert.equal(fields.find(({ name }) => name === "rank").decoded, false);
});

test("default ramps use the exact selected descriptor and carry declared NoData", () => {
  const fields = getWorkbenchNumericDimensions(metadata, "copc-js");
  const style = createDefaultDimensionStyle(fields, "height");
  assert.equal(style.name, "height");
  assert.equal(style.missingValue, -9999);
  assert.equal(style.palette.length, 4);
  assert.equal(style.palette[0].position, 0);
  assert.equal(style.palette.at(-1).position, 1);
  assert.throws(() => createDefaultDimensionStyle(fields, "record_id"), /supported/u);
  assert.deepEqual(requestedDimensionNames(style, { name: "rank", min: 0, max: 3 }), ["height", "rank"]);
  assert.deepEqual(requestedDimensionNames(createDefaultDimensionStyle(fields, "Intensity"), undefined), []);
});

test("Extra Bytes requests replace schema state without mutating the applied snapshot", () => {
  const applied = {
    "attributes.extraDimensions": ["A"],
    "style.dimension": { name: "Intensity", range: { min: 0, max: 65_535 } },
  };
  const next = withRequestedExtraDimensions(applied, ["B"], undefined, null);
  assert.deepEqual(next["attributes.extraDimensions"], ["B"]);
  assert.deepEqual(applied["attributes.extraDimensions"], ["A"]);
  assert.notEqual(next, applied);
});

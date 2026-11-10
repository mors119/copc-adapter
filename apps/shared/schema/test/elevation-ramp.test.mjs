import assert from "node:assert/strict";
import test from "node:test";

import {
  getOptionApplyMode,
  getOptionDefinition,
  getSupportedOptions,
  NPM_0_6_CAPABILITIES,
  NPM_0_6_MANIFEST,
  NPM_0_7_1_CAPABILITIES,
  NPM_0_7_1_MANIFEST,
  NPM_0_8_0_CAPABILITIES,
  NPM_0_8_0_MANIFEST,
  PLAYGROUND_0_8_0_RUNTIME_CAPABILITIES,
  serializeSchemaValues,
  deserializeSchemaValues,
  validateOptionValue,
  WORKSPACE_CURRENT_CAPABILITIES,
  WORKSPACE_CURRENT_MANIFEST,
} from "../index.ts";

const palette = [
  { position: 0, color: { red: 0, green: 0.1, blue: 0.4, alpha: 0.25 } },
  { position: 0.5, color: { red: 0.2, green: 0.8, blue: 0.3, alpha: 0.6 } },
  { position: 1, color: { red: 1, green: 0.2, blue: 0, alpha: 1 } },
];

test("elevation controls are available only for verified 0.8.0 profiles", () => {
  const ids = ["style.elevationRange", "style.elevationStyle"];
  for (const [manifest, runtimeCapabilities] of [
    [NPM_0_6_MANIFEST, NPM_0_6_CAPABILITIES],
    [NPM_0_7_1_MANIFEST, NPM_0_7_1_CAPABILITIES],
  ]) {
    for (const renderer of ["cesium", "three"]) {
      const supported = getSupportedOptions({ manifest, runtimeCapabilities, renderer });
      for (const id of ids) assert.equal(supported.some((option) => option.id === id), false);
    }
  }

  for (const [manifest, runtimeCapabilities] of [
    [NPM_0_8_0_MANIFEST, PLAYGROUND_0_8_0_RUNTIME_CAPABILITIES],
    [WORKSPACE_CURRENT_MANIFEST, WORKSPACE_CURRENT_CAPABILITIES],
  ]) {
    for (const renderer of ["cesium", "three"]) {
      const supported = getSupportedOptions({ manifest, runtimeCapabilities, renderer });
      for (const id of ids) assert.equal(supported.some((option) => option.id === id), true);
    }
  }

  const range = getOptionDefinition(ids[0]);
  const style = getOptionDefinition(ids[1]);
  assert.equal(getOptionApplyMode(range, "cesium"), "runtime");
  assert.equal(getOptionApplyMode(style, "cesium"), "runtime");
  assert.equal(getOptionApplyMode(range, "three"), "constructor");
  assert.equal(getOptionApplyMode(style, "three"), "constructor");
});

test("elevation range and ramp validation enforce public bounds and reuse palette rules", () => {
  const range = getOptionDefinition("style.elevationRange");
  const style = getOptionDefinition("style.elevationStyle");
  assert.deepEqual(validateOptionValue(range, { min: -25, max: 1200 }), []);
  assert.match(validateOptionValue(range, { min: 2, max: 2 })[0], /minimum less than maximum/u);
  assert.match(validateOptionValue(range, { min: Number.NaN, max: 12 })[0], /finite metre bounds/u);
  assert.match(validateOptionValue(range, { min: 0, max: 1, units: "source Z" })[0], /only minimum and maximum/u);

  assert.deepEqual(validateOptionValue(style, { palette, interpolation: "step" }), []);
  assert.deepEqual(validateOptionValue(style, { interpolation: "linear" }), []);
  assert.match(validateOptionValue(style, { interpolation: "cubic" })[0], /linear or step/u);
  assert.match(validateOptionValue(style, {
    palette: [palette[0], { ...palette[1], position: 0 }, palette[2]],
  })[0], /increase strictly/u);
  assert.match(validateOptionValue(style, {
    palette: [palette[0], { ...palette[1], color: { ...palette[1].color, alpha: 1.1 } }, palette[2]],
  })[0], /normalized values/u);
});

test("custom elevation values round-trip through schema share state", () => {
  const context = {
    manifest: NPM_0_8_0_MANIFEST,
    runtimeCapabilities: NPM_0_8_0_CAPABILITIES,
    renderer: "cesium",
  };
  const values = {
    "renderer.engine": "cesium",
    "rendering.colorMode": "elevation",
    "style.elevationRange": { min: -25, max: 1200 },
    "style.elevationStyle": { palette, interpolation: "step" },
  };
  const query = serializeSchemaValues(values, context);
  assert.deepEqual(JSON.parse(query.get("elevationRange")), values["style.elevationRange"]);
  assert.deepEqual(JSON.parse(query.get("elevationStyle")), values["style.elevationStyle"]);
  const restored = deserializeSchemaValues(query, context);
  for (const [id, value] of Object.entries(values)) assert.deepEqual(restored.values[id], value, id);
  assert.deepEqual(restored.warnings, []);
});

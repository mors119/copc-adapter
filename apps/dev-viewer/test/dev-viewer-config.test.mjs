import assert from "node:assert/strict";
import test from "node:test";

import {
  getSafeSourceLabel,
  hasUnappliedSettings,
  isRangeValidationPolicy,
  isRefinementAlgorithm,
  needsSessionRecreation,
  sourceSupportsHttpRange,
  validateDevViewerConfig,
} from "../src/devViewerConfig.ts";

function createConfig(overrides = {}) {
  return {
    renderer: "cesium",
    cesiumRenderer: "point-primitive",
    backend: "copc-js",
    refinementAlgorithm: "foveated",
    motionLookahead: true,
    rangeValidation: "head-fallback",
    source: "https://example.test/autzen.copc.laz?token=secret",
    colorMode: "rgb",
    pointSize: 3,
    maxNodes: 24,
    maxRenderedPoints: 250_000,
    maxDepth: 6,
    maxScreenSpaceError: 8,
    cameraPreset: "overview",
    cameraRenderDistance: 5_000,
    maxRenderDistance: 12_000,
    ...overrides,
  };
}

test("recognizes only the public refinement and range validation values", () => {
  assert.equal(isRefinementAlgorithm("foveated"), true);
  assert.equal(isRefinementAlgorithm("screen-projection"), true);
  assert.equal(isRefinementAlgorithm("nearest"), false);
  assert.equal(isRangeValidationPolicy("head-fallback"), true);
  assert.equal(isRangeValidationPolicy("strict"), true);
  assert.equal(isRangeValidationPolicy("best-effort"), false);
  assert.equal(validateDevViewerConfig(createConfig()), undefined);
  assert.match(
    validateDevViewerConfig(createConfig({ refinementAlgorithm: "unknown" })),
    /Foveated or Screen Projection/,
  );
});

test("marks constructor-time settings pending and keeps Cesium color updates live", () => {
  const applied = createConfig();
  assert.equal(
    hasUnappliedSettings(
      applied,
      createConfig({ refinementAlgorithm: "screen-projection" }),
    ),
    true,
  );
  assert.equal(
    needsSessionRecreation(
      applied,
      createConfig({ refinementAlgorithm: "screen-projection" }),
      true,
      true,
    ),
    true,
  );
  assert.equal(
    hasUnappliedSettings(applied, createConfig({ motionLookahead: false })),
    true,
  );
  assert.equal(
    needsSessionRecreation(
      applied,
      createConfig({ motionLookahead: false }),
      true,
      true,
    ),
    true,
  );
  assert.equal(
    needsSessionRecreation(
      applied,
      createConfig({ colorMode: "elevation" }),
      true,
      true,
    ),
    false,
  );
  assert.equal(
    needsSessionRecreation(
      applied,
      createConfig({ colorMode: "elevation", renderer: "three" }),
      true,
      true,
    ),
    true,
  );
});

test("only recreates a local File session for applicable constructor changes", () => {
  const localConfig = createConfig({
    source: new File(["COPC"], "local.copc.laz"),
  });
  assert.equal(
    sourceSupportsHttpRange(localConfig.source, "https://viewer.test/"),
    false,
  );
  assert.equal(
    needsSessionRecreation(
      localConfig,
      createConfig({ ...localConfig, rangeValidation: "strict" }),
      true,
      false,
    ),
    false,
  );
  assert.equal(
    needsSessionRecreation(
      localConfig,
      createConfig({
        ...localConfig,
        rangeValidation: "strict",
        source: localConfig.source,
      }),
      true,
      false,
    ),
    false,
  );
});

test("redacts credentials and signed query values from source labels", () => {
  const source =
    "https://user:password@example.test/path/data.copc.laz?token=secret";
  assert.equal(
    getSafeSourceLabel(source, "https://viewer.test/"),
    "example.test/path/data.copc.laz",
  );
  assert.equal(
    getSafeSourceLabel(
      new File(["COPC"], "local.copc.laz"),
      "https://viewer.test/",
    ),
    "local.copc.laz",
  );
});

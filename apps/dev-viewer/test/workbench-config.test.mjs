import assert from "node:assert/strict";
import test from "node:test";

import {
  toWorkbenchLayerOptions,
  workbenchBackendOptions,
  workbenchRendererOptions,
} from "../../shared/workbench-config.ts";

const baseConfig = {
  backend: "rust",
  colorMode: "intensity",
  pointSize: 3.5,
  maxRenderedPoints: 250_000,
  maxNodes: 24,
  refinementAlgorithm: "foveated",
};

test("shared renderer and backend choices preserve the supported public values", () => {
  assert.deepEqual(
    workbenchRendererOptions.map(({ value }) => value),
    ["cesium", "three"],
  );
  assert.deepEqual(
    workbenchBackendOptions.map(({ value }) => value),
    ["copc-js", "rust"],
  );
});

test("maps shared controls to constructor options without adding unset policies", () => {
  assert.deepEqual(toWorkbenchLayerOptions(baseConfig), {
    backend: "rust",
    colorMode: "intensity",
    pointSize: 3.5,
    maxRenderedPoints: 250_000,
    streaming: {
      maxNodes: 24,
      refinementAlgorithm: "foveated",
    },
  });
});

test("includes extended dev settings while preserving public option meanings", () => {
  assert.deepEqual(
    toWorkbenchLayerOptions({
      ...baseConfig,
      maxDepth: 12,
      maxScreenSpaceError: 6,
      maxRenderDistanceMeters: 8_000,
      motionLookahead: false,
      rangeValidation: "strict",
    }),
    {
      backend: "rust",
      colorMode: "intensity",
      pointSize: 3.5,
      maxRenderedPoints: 250_000,
      rangeValidation: "strict",
      streaming: {
        maxNodes: 24,
        maxDepth: 12,
        maxScreenSpaceError: 6,
        maxRenderDistanceMeters: 8_000,
        refinementAlgorithm: "foveated",
        motionLookahead: false,
      },
    },
  );
});

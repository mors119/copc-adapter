import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchConfigurationState,
  serializeWorkbenchConfiguration,
} from "../../shared/config/index.ts";
import {
  WORKSPACE_CURRENT_CAPABILITIES,
  WORKSPACE_CURRENT_MANIFEST,
} from "../../shared/schema/index.ts";

import {
  commitRuntimeColorMode,
  getCesiumTerrainProviderUrl,
  getSafeSourceLabel,
  getSafeTerrainSourceLabel,
  getTilesVerticalGrid,
  getTilesUnsupportedFilteringError,
  hasUnappliedSettings,
  isRangeValidationPolicy,
  isRefinementAlgorithm,
  needsSessionRecreation,
  restoreDevViewerShareConfiguration,
  sourceSupportsHttpRange,
  toWorkbenchOptionValues,
  validateDevViewerConfig,
} from "../src/devViewerConfig.ts";

function createConfig(overrides = {}) {
  return {
    renderer: "cesium",
    pipeline: "direct",
    cesiumRenderer: "point-primitive",
    backend: "copc-js",
    refinementAlgorithm: "foveated",
    motionLookahead: true,
    rangeValidation: "head-fallback",
    source: "https://example.test/autzen.copc.laz?token=secret",
    heightOffsetMeters: 0,
    terrainUrl: "",
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

test("passes only a host-verified vertical grid into the Tiles pipeline", () => {
  const grid = { gridId: "verified-grid" };
  const config = createConfig({
    pipeline: "tiles",
    schemaOptionValues: { "coordinates.verticalTransform": grid },
  });

  assert.equal(getTilesVerticalGrid(config, (value) => value === grid), grid);
  assert.equal(getTilesVerticalGrid(createConfig(), () => false), undefined);
  assert.throws(
    () => getTilesVerticalGrid(config, () => false),
    /loaded, verified vertical grid/,
  );
});

test("rejects filters and clipping that the Tiles pipeline cannot apply", () => {
  const cleanTiles = createConfig({ pipeline: "tiles" });
  assert.equal(getTilesUnsupportedFilteringError(cleanTiles), undefined);

  const unsupportedSettings = [
    ["style.classificationFilter", { include: [2] }, "Classification Filter"],
    ["style.dimensionFilter", { name: "Intensity", min: 0, max: 100 }, "Numeric Dimension Filter"],
    ["filtering.cesiumClippingVolume", {
      type: "box",
      coordinateSystem: "wgs84-ecef-meters",
      minimum: [-1, -1, -1],
      maximum: [1, 1, 1],
    }, "Clipping Volume"],
  ];
  for (const [optionId, value, label] of unsupportedSettings) {
    const error = getTilesUnsupportedFilteringError(createConfig({
      pipeline: "tiles",
      schemaOptionValues: { [optionId]: value },
    }));
    assert.match(error, new RegExp(label));
    assert.match(error, /clear these settings/);
  }
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

test("treats the experimental rendering pipeline as a session setting without changing the Direct default", () => {
  const applied = createConfig();
  assert.equal(applied.pipeline, "direct");
  const pending = createConfig({ pipeline: "tiles" });
  assert.equal(hasUnappliedSettings(applied, pending), true);
  assert.equal(needsSessionRecreation(applied, pending, true, true), true);
  assert.equal(
    needsSessionRecreation(pending, createConfig({ renderer: "three", pipeline: "tiles" }), true, true),
    true,
  );
  assert.equal(validateDevViewerConfig(createConfig({ pipeline: "unknown" })), "Choose Direct COPC or the experimental 3D Tiles pipeline.");
});

test("runtime color changes preserve pending non-color schema edits", () => {
  const appliedFilter = { name: "Intensity", min: 0, max: 65_535 };
  const pendingFilter = { name: "Intensity", min: 25, max: 500 };
  const applied = createConfig({
    schemaOptionValues: {
      "style.dimensionFilter": appliedFilter,
      "attributes.extraDimensions": ["CanopyHeight"],
    },
  });
  const dimension = {
    name: "Intensity",
    range: { min: 10, max: 60_000 },
  };

  const nextApplied = commitRuntimeColorMode(applied, "elevation");
  const pending = createConfig({
    colorMode: "elevation",
    schemaOptionValues: {
      ...applied.schemaOptionValues,
      "style.dimensionFilter": pendingFilter,
    },
  });
  assert.equal(nextApplied.colorMode, "elevation");
  assert.deepEqual(nextApplied.schemaOptionValues, applied.schemaOptionValues);
  assert.equal(hasUnappliedSettings(nextApplied, pending), true);

  const nextDimension = commitRuntimeColorMode(applied, "dimension", dimension);
  assert.deepEqual(nextDimension.schemaOptionValues["style.dimension"], dimension);
  assert.deepEqual(nextDimension.schemaOptionValues["style.dimensionFilter"], appliedFilter);
  assert.deepEqual(
    nextDimension.schemaOptionValues["attributes.extraDimensions"],
    ["CanopyHeight"],
  );
});

test("opacity and clipping stay runtime-only, but the applied settings carry to a source switch", () => {
  const box = {
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: [-1_000, -2_000, -3_000],
    maximum: [1_000, 2_000, 3_000],
  };
  const applied = createConfig({
    schemaOptionValues: {
      "rendering.opacity": 0.6,
      "filtering.cesiumClippingVolume": box,
    },
  });
  const runtimeEdit = createConfig({
    ...applied,
    schemaOptionValues: {
      "rendering.opacity": 0.25,
      "filtering.cesiumClippingVolume": undefined,
    },
  });
  assert.equal(hasUnappliedSettings(applied, runtimeEdit), true);
  assert.equal(needsSessionRecreation(applied, runtimeEdit, true, true), false);

  const switchedSource = createConfig({
    ...runtimeEdit,
    source: "https://example.test/chicago.copc.laz",
  });
  assert.equal(needsSessionRecreation(runtimeEdit, switchedSource, true, true), true);
  const switchedValues = toWorkbenchOptionValues(switchedSource);
  assert.equal(switchedValues["rendering.opacity"], 0.25);
  assert.equal(Object.hasOwn(switchedValues, "filtering.cesiumClippingVolume"), true);
  assert.equal(switchedValues["filtering.cesiumClippingVolume"], undefined);
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

test("normalizes active renderer settings without applying inactive Cesium renderer choices", () => {
  const cesium = toWorkbenchOptionValues(createConfig());
  assert.equal(cesium["rendering.cesiumPointRenderer"], "point-primitive");
  assert.equal(cesium["streaming.maxRenderDistanceMeters"], 12_000);

  const three = toWorkbenchOptionValues(createConfig({ renderer: "three" }));
  assert.equal(Object.hasOwn(three, "rendering.cesiumPointRenderer"), false);
  assert.equal(Object.hasOwn(three, "coordinates.heightOffsetMeters"), false);
  assert.equal(three["streaming.maxRenderDistanceMeters"], 12_000);
});

test("restores schema-serialized settings from a share URL into host configuration", () => {
  const appliedConfig = createConfig({
    pointSize: 7,
    maxNodes: 32,
    maxRenderedPoints: 500_000,
    maxDepth: 9,
    maxRenderDistance: 20_000,
    refinementAlgorithm: "screen-projection",
  });
  const values = toWorkbenchOptionValues(appliedConfig);
  const params = serializeWorkbenchConfiguration(
    createWorkbenchConfigurationState(values, values),
    {
      manifest: WORKSPACE_CURRENT_MANIFEST,
      renderer: appliedConfig.renderer,
      runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
    },
    "applied",
  );
  params.set("debugPanel", "0");
  params.set("scenario", "issue61");

  const restored = restoreDevViewerShareConfiguration(params, createConfig());
  assert.equal(restored.config.pointSize, 7);
  assert.equal(restored.config.maxNodes, 32);
  assert.equal(restored.config.maxRenderedPoints, 500_000);
  assert.equal(restored.config.maxDepth, 9);
  assert.equal(restored.config.maxRenderDistance, 20_000);
  assert.equal(restored.config.refinementAlgorithm, "screen-projection");
  assert.deepEqual(restored.warnings, []);
});

test("dimension share state restores exact Extra Bytes requests for the next layer load", () => {
  const dimension = {
    name: "CanopyHeight",
    range: { min: 0, max: 50 },
    palette: [
      { position: 0, color: { red: 0, green: 0.2, blue: 1, alpha: 0.9 } },
      { position: 1, color: { red: 1, green: 0.1, blue: 0, alpha: 0.9 } },
    ],
    missingValue: -9999,
  };
  const dimensionFilter = { name: "CanopyHeight", min: 2, max: 40, missingValue: -9999 };
  const values = toWorkbenchOptionValues(createConfig({
    colorMode: "dimension",
    schemaOptionValues: {
      "style.dimension": dimension,
      "style.dimensionFilter": dimensionFilter,
    },
  }));
  assert.deepEqual(values["attributes.extraDimensions"], ["CanopyHeight"]);

  const params = serializeWorkbenchConfiguration(
    createWorkbenchConfigurationState(values, values),
    {
      manifest: WORKSPACE_CURRENT_MANIFEST,
      renderer: "cesium",
      runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
    },
    "applied",
  );
  const restored = restoreDevViewerShareConfiguration(params, createConfig());
  assert.equal(restored.config.colorMode, "dimension");
  assert.deepEqual(restored.config.schemaOptionValues?.["style.dimension"], dimension);
  assert.deepEqual(restored.config.schemaOptionValues?.["style.dimensionFilter"], dimensionFilter);
  assert.deepEqual(restored.config.schemaOptionValues?.["attributes.extraDimensions"], ["CanopyHeight"]);
  assert.deepEqual(toWorkbenchOptionValues(restored.config)["attributes.extraDimensions"], ["CanopyHeight"]);
  assert.deepEqual(restored.warnings, []);
});

test("uses the renderer alias and ignores unrelated developer URL parameters during share restore", () => {
  const params = new URLSearchParams(
    "renderer=public-batched&backend=rust&maxNodes=32&scenario=issue61&debugPanel=0&budget=123456",
  );
  const restored = restoreDevViewerShareConfiguration(params, createConfig());
  assert.equal(restored.config.renderer, "cesium");
  assert.equal(restored.config.backend, "rust");
  assert.equal(restored.config.maxNodes, 32);
  assert.deepEqual(restored.warnings, []);
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

test("validates an explicit public Terrain endpoint and keeps its label safe", () => {
  assert.equal(
    validateDevViewerConfig(
      createConfig({ terrainUrl: "http://localhost:8080/terrain" }),
    ),
    undefined,
  );
  assert.equal(
    validateDevViewerConfig(
      createConfig({ terrainUrl: "http://localhost:8080/terrain/layer.json" }),
    ),
    undefined,
  );
  assert.equal(
    getCesiumTerrainProviderUrl(
      "http://localhost:8080/terrain",
      "http://viewer.test/",
    ),
    "http://localhost:8080/terrain",
  );
  assert.equal(
    getCesiumTerrainProviderUrl(
      "http://localhost:8080/terrain/layer.json",
      "http://viewer.test/",
    ),
    "http://localhost:8080/terrain",
  );
  assert.equal(
    getCesiumTerrainProviderUrl(
      "http://localhost:8080/terrain/layer.json/",
      "http://viewer.test/",
    ),
    "http://localhost:8080/terrain",
  );
  assert.match(
    validateDevViewerConfig(
      createConfig({ terrainUrl: "https://terrain.example/layer.json?token=secret" }),
    ),
    /without credentials, query parameters/,
  );
  assert.equal(
    getSafeTerrainSourceLabel(
      "https://terrain.example/tiles/layer.json?token=secret",
      "https://viewer.example/",
    ),
    "terrain.example/tiles/layer.json",
  );
  assert.equal(
    hasUnappliedSettings(
      createConfig(),
      createConfig({ heightOffsetMeters: 12 }),
    ),
    true,
  );
  assert.equal(
    needsSessionRecreation(
      createConfig(),
      createConfig({ heightOffsetMeters: 12 }),
      true,
      true,
    ),
    true,
  );
});

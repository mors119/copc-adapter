import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheBytesToMib,
  cacheMibToBytes,
  hasConstructorChanges,
  normalizeClassificationFilter,
  parseClassificationCodes,
  validatePlaygroundConfig,
} from "../src/playgroundConfig.ts";
import {
  defaultPlaygroundUrlConfig,
  readPlaygroundUrlConfig,
  writePlaygroundUrlConfig,
} from "../src/playgroundUrlConfig.ts";
import { defaultPlaygroundRefinementConfig } from "../src/refinementConfig.ts";

test("URL settings round-trip every constructor, refinement, and classification option", () => {
  const config = {
    ...defaultPlaygroundUrlConfig,
    renderer: "three",
    backend: "rust",
    colorMode: "rgb",
    heightOffsetMeters: 2.25,
    pointSize: 5.5,
    maxRenderedPoints: 420_000,
    maxPointCacheBytes: 13 * 1024 * 1024,
    maxNodes: 31,
    maxDepth: 9,
    maxScreenSpaceError: 2.75,
    maxRenderDistanceMeters: 88_000,
    refinementAlgorithm: "screen-projection",
    classificationFilter: { include: [2, 6], exclude: [7, 18] },
  };
  const refinement = {
    ...defaultPlaygroundRefinementConfig,
    focusMode: "pinned",
    focusEnabled: true,
    center: { x: 0.23, y: 0.78 },
    radius: 0.22,
    detailBias: 1.75,
  };
  const encoded = writePlaygroundUrlConfig(config, refinement);
  const decoded = readPlaygroundUrlConfig(new URLSearchParams(encoded));
  assert.deepEqual(decoded.config, config);
  assert.deepEqual(decoded.refinementConfig, {
    ...refinement,
    center: { x: 0.23, y: 0.78 },
  });
  assert.deepEqual([...encoded.keys()], [
    "renderer", "backend", "colorMode", "heightOffsetMeters", "pointSize", "maxRenderedPoints",
    "maxPointCacheBytes", "maxNodes", "maxDepth", "maxScreenSpaceError",
    "maxRenderDistanceMeters", "classificationInclude", "classificationExclude",
    "refinementAlgorithm", "focusMode", "focusEnabled", "showFocusGuide",
    "focusX", "focusY", "focusRadius", "focusBias",
  ]);
});

test("invalid numeric URL values normalize to documented defaults and unknown keys are ignored", () => {
  const decoded = readPlaygroundUrlConfig(new URLSearchParams([
    ["pointSize", "NaN"],
    ["heightOffsetMeters", "NaN"],
    ["maxRenderedPoints", "-1"],
    ["maxPointCacheBytes", "Infinity"],
    ["maxNodes", "9007199254740992"],
    ["maxDepth", "-2"],
    ["maxScreenSpaceError", "0"],
    ["maxRenderDistanceMeters", "-Infinity"],
    ["unexpected", "value"],
  ]));
  assert.equal(decoded.config.pointSize, defaultPlaygroundUrlConfig.pointSize);
  assert.equal(decoded.config.heightOffsetMeters, defaultPlaygroundUrlConfig.heightOffsetMeters);
  assert.equal(decoded.config.maxRenderedPoints, defaultPlaygroundUrlConfig.maxRenderedPoints);
  assert.equal(decoded.config.maxPointCacheBytes, defaultPlaygroundUrlConfig.maxPointCacheBytes);
  assert.equal(decoded.config.maxNodes, defaultPlaygroundUrlConfig.maxNodes);
  assert.equal(decoded.config.maxDepth, defaultPlaygroundUrlConfig.maxDepth);
  assert.equal(decoded.config.maxScreenSpaceError, defaultPlaygroundUrlConfig.maxScreenSpaceError);
  assert.equal(decoded.config.maxRenderDistanceMeters, defaultPlaygroundUrlConfig.maxRenderDistanceMeters);
  assert.match(decoded.warning, /Invalid pointSize/);
  assert.doesNotMatch(decoded.warning, /unexpected/);
});

test("classification filters preserve no-filter, empty-list, and include/exclude meaning", () => {
  assert.equal(normalizeClassificationFilter(undefined), undefined);
  assert.deepEqual(normalizeClassificationFilter({ include: [] }), { include: [] });
  assert.deepEqual(
    normalizeClassificationFilter({ include: [6, 2, 2], exclude: [18, 7, 18] }),
    { include: [2, 6], exclude: [7, 18] },
  );
  assert.deepEqual(parseClassificationCodes("255, 0 17,17"), [0, 17, 255]);

  const config = {
    ...defaultPlaygroundUrlConfig,
    classificationFilter: { include: [], exclude: [7] },
  };
  const encoded = writePlaygroundUrlConfig(config, defaultPlaygroundRefinementConfig);
  assert.equal(encoded.get("classificationInclude"), "");
  assert.equal(encoded.get("classificationExclude"), "7");
  assert.deepEqual(
    readPlaygroundUrlConfig(new URLSearchParams(encoded)).config.classificationFilter,
    { include: [], exclude: [7] },
  );
  assert.equal(
    readPlaygroundUrlConfig(new URLSearchParams()).config.classificationFilter,
    undefined,
  );
});

test("classification parsing rejects non-integers and values outside the LAS byte range", () => {
  for (const value of ["-1", "256", "1.5", "NaN"]) {
    assert.throws(() => parseClassificationCodes(value), /integers from 0 to 255/);
  }
  const decoded = readPlaygroundUrlConfig(new URLSearchParams("classificationInclude=2%2C256"));
  assert.equal(decoded.config.classificationFilter, undefined);
  assert.match(decoded.warning, /Invalid classification filter/);
});

test("cache display conversion produces exact non-negative safe integer bytes", () => {
  assert.equal(cacheMibToBytes(0), 0);
  assert.equal(cacheMibToBytes(0.25), 262_144);
  assert.equal(cacheBytesToMib(13 * 1024 * 1024), 13);
  assert.throws(() => cacheMibToBytes(-1), /non-negative/);
  assert.throws(() => cacheMibToBytes(Number.NaN), /non-negative/);
  assert.throws(() => cacheMibToBytes(Number.POSITIVE_INFINITY), /non-negative/);
  assert.throws(() => cacheMibToBytes(Number.MAX_SAFE_INTEGER), /safe integer/);
});

test("constructor change detection distinguishes Cesium runtime color from Three constructor color", () => {
  const cesium = { ...defaultPlaygroundUrlConfig };
  assert.deepEqual(validatePlaygroundConfig(cesium), []);
  assert.equal(
    hasConstructorChanges({ ...cesium, colorMode: "rgb" }, cesium),
    false,
  );
  assert.equal(
    hasConstructorChanges({ ...cesium, pointSize: 4 }, cesium),
    true,
  );
  assert.equal(
    hasConstructorChanges({ ...cesium, terrainUrl: "https://terrain.example/service" }, cesium),
    true,
  );
  assert.equal(
    hasConstructorChanges(
      { ...cesium, renderer: "three", terrainUrl: "https://terrain.example/service" },
      { ...cesium, renderer: "three" },
    ),
    false,
  );
  assert.equal(
    hasConstructorChanges(
      { ...cesium, renderer: "three", colorMode: "rgb" },
      { ...cesium, renderer: "three" },
    ),
    true,
  );
  assert.match(
    validatePlaygroundConfig({ ...cesium, renderer: "three", classificationFilter: { include: [1] } }).join(" "),
    /Clear the Cesium classification filter/,
  );
});

test("safe URL sharing excludes credentials, query strings, fragments, local paths, and File bytes", () => {
  const config = {
    ...defaultPlaygroundUrlConfig,
    terrainUrl: "https://user:secret@example.test/terrain?token=secret",
  };
  for (const source of [
    "https://user:secret@example.test/data.copc.laz",
    "https://example.test/data.copc.laz?token=secret",
    "https://example.test/data.copc.laz#secret",
    "file:///private/data.copc.laz",
  ]) {
    const encoded = writePlaygroundUrlConfig(config, defaultPlaygroundRefinementConfig, source);
    assert.equal(encoded.has("sourceUrl"), false);
    assert.doesNotMatch(encoded.toString(), /secret|private/);
    assert.equal(encoded.has("terrainUrl"), false);
  }
  const safe = writePlaygroundUrlConfig(config, defaultPlaygroundRefinementConfig, "https://example.test/data.copc.laz");
  assert.equal(safe.get("sourceUrl"), "https://example.test/data.copc.laz");
  assert.equal(safe.has("file"), false);
});

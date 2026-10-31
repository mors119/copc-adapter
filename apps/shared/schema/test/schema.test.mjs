import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getAdapterManifest,
  ACTION_SCHEMA,
  getAvailableActions,
  getAvailableChoices,
  getAvailableOptions,
  isOptionAvailable,
  getOptionApplyMode,
  getOptionDefault,
  getOptionDefinition,
  getSupportedOptions,
  isKnownManifest,
  NPM_0_6_MANIFEST,
  NPM_0_6_CAPABILITIES,
  NPM_0_7_1_MANIFEST,
  PLAYGROUND_0_7_1_RUNTIME_CAPABILITIES,
  NPM_0_7_1_CAPABILITIES,
  OPTION_SCHEMA,
  resolveOptionDefault,
  serializeSchemaValues,
  deserializeSchemaValues,
  MAX_SCHEMA_SHARE_QUERY_LENGTH,
  MAX_SCHEMA_SHARE_PARAMETER_LENGTH,
  getSchemaConstraintViolations,
  validateOptionValue,
  validateSchemaValues,
  WORKSPACE_CURRENT_MANIFEST,
  WORKSPACE_CURRENT_CAPABILITIES,
} from "../index.ts";

const cesiumContext = {
  manifest: NPM_0_6_MANIFEST,
  renderer: "cesium",
};

test("schema choices are the shared renderer and adapter option inventory", () => {
  for (const [id, values] of [
    ["renderer.engine", ["cesium", "three"]],
    ["adapter.backend", ["copc-js", "rust"]],
    [
      "rendering.colorMode",
      ["fixed", "rgb", "elevation", "intensity", "classification", "dimension"],
    ],
    ["streaming.refinementAlgorithm", ["foveated", "screen-projection"]],
    ["source.rangeValidation", ["head-fallback", "strict"]],
  ]) {
    const option = getOptionDefinition(id);
    assert.ok(option, id);
    assert.deepEqual(option.choices?.map(({ value }) => value), values, id);
  }
});

test("schema integrity: IDs, mappings, defaults, controls, references, and capability names", () => {
  const ids = OPTION_SCHEMA.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  const capabilities = new Set([
    ...NPM_0_6_CAPABILITIES,
    ...NPM_0_7_1_CAPABILITIES,
    ...WORKSPACE_CURRENT_CAPABILITIES,
  ]);
  const sections = new Set([
    "source", "renderer", "backend", "style", "streaming", "lod", "focus",
    "filtering", "attributes", "coordinates", "performance", "cache", "interaction",
  ]);
  const controls = new Set([
    "source", "renderer", "select", "attribute-selection", "number", "toggle",
    "attribute-loading", "point-field-selection",
    "classification-filter", "dimension-style", "dimension-filter", "focus-lens",
    "opacity", "clipping-volume",
    "vertical-grid", "cesium-renderer",
  ]);
  const validationByValueType = {
    "input-source": "source",
    enum: "enum",
    "string-array": "string-array",
    number: "number",
    integer: "number",
    boolean: "boolean",
    "classification-filter": "classification-filter",
    "dimension-style": "dimension-style",
    "dimension-filter": "dimension-filter",
    "focus-lens": "focus-lens",
    "clipping-volume": "clipping-volume",
    "vertical-grid": "vertical-grid",
  };
  const controlsByValueType = {
    "input-source": ["source"],
    enum: ["select", "renderer", "cesium-renderer", "attribute-loading"],
    "string-array": ["attribute-selection", "point-field-selection"],
    number: ["number", "opacity"],
    integer: ["number"],
    boolean: ["toggle"],
    "classification-filter": ["classification-filter"],
    "dimension-style": ["dimension-style"],
    "dimension-filter": ["dimension-filter"],
    "focus-lens": ["focus-lens"],
    "clipping-volume": ["clipping-volume"],
    "vertical-grid": ["vertical-grid"],
  };
  const serializationKeys = [];

  for (const option of OPTION_SCHEMA) {
    assert.ok(sections.has(option.section), option.id + " section");
    assert.ok(controls.has(option.control), option.id + " control");
    assert.ok(option.valueType, option.id);
    assert.ok(option.stability, option.id);
    assert.ok(option.codeGeneration.kind, option.id);
    assert.ok(option.serialization.kind, option.id);
    assert.ok(option.validation.kind, option.id);
    assert.ok(option.applyMode, option.id);
    assert.equal(option.validation.kind, validationByValueType[option.valueType], option.id + " validation kind");
    assert.ok(controlsByValueType[option.valueType]?.includes(option.control), option.id + " control/value type");
    assert.ok(option.statePath.split(".").every(Boolean), option.id + " state path");
    if (option.apiPath) {
      assert.ok(option.apiPath.split(".").every(Boolean), option.id + " API path");
    }
    for (const mode of ["cesium", "three"]) {
      if (option.renderers.includes(mode)) assert.ok(getOptionApplyMode(option, mode), option.id + " apply mode");
    }
    const referencedIds = [
      option.condition?.optionId,
      option.availabilityCondition?.optionId,
      ...(option.constraints ?? []).map(({ otherOptionId }) => otherOptionId),
    ].filter(Boolean);
    for (const reference of referencedIds) assert.ok(ids.includes(reference), option.id + " references " + reference);
    for (const condition of [option.condition, option.availabilityCondition].filter(Boolean)) {
      const dependency = OPTION_SCHEMA.find(({ id }) => id === condition.optionId);
      if (dependency.validation.kind === "enum") {
        assert.ok(
          dependency.choices.some(({ value }) => value === condition.equals),
          option.id + " condition must use a supported dependency value",
        );
      }
    }
    for (const constraint of option.constraints ?? []) {
      const other = OPTION_SCHEMA.find(({ id }) => id === constraint.otherOptionId);
      assert.ok(["number", "integer"].includes(option.valueType), option.id + " constraint source is numeric");
      assert.ok(["number", "integer"].includes(other.valueType), option.id + " constraint target is numeric");
      assert.ok(option.renderers.some((renderer) => other.renderers.includes(renderer)), option.id + " constraint renderer overlap");
    }
    if (option.validation.kind === "number") {
      for (const [bound, value] of [["minimum", option.validation.minimum], ["maximum", option.validation.maximum]]) {
        if (value !== undefined) assert.ok(Number.isFinite(value), option.id + " finite " + bound);
      }
      if (option.validation.minimum !== undefined && option.validation.maximum !== undefined) {
        assert.ok(option.validation.minimum < option.validation.maximum, option.id + " ordered numeric limits");
      }
    }
    const referencedCapabilities = [
      ...(option.requiredCapabilities ?? []),
      ...(option.choices ?? []).flatMap(({ requiredCapabilities = [] }) => requiredCapabilities),
    ];
    for (const capability of referencedCapabilities) assert.ok(capabilities.has(capability), option.id + " capability " + capability);
    if (option.codeGeneration.kind === "specialized") assert.ok(option.codeGeneration.handler.trim());
    if (option.codeGeneration.kind === "runtime-method") assert.ok(option.runtimeMethod, option.id + " codegen method");
    if (option.applyMode === "operation" || Object.values(option.applyMode).includes("operation")) {
      assert.ok(option.runtimeMethod, option.id + " operation method");
    }
    for (const serialization of [option.serialization]) {
      for (const key of serialization.kind === "scalar" || serialization.kind === "string-array"
        ? [serialization.key]
        : serialization.kind === "classification-filter"
          ? [serialization.includeKey, serialization.excludeKey, serialization.clearKey]
          : serialization.kind === "focus-lens"
            ? [...Object.values(serialization.keys), serialization.clearKey]
            : serialization.kind === "clipping-volume"
              ? [serialization.key, serialization.clearKey]
            : []) {
        assert.ok(!serializationKeys.includes(key), "duplicate share key " + key);
        serializationKeys.push(key);
      }
    }
    for (const profile of Object.keys(option.defaults)) {
      assert.ok(["npm@0.6.0", "npm@0.7.1", "workspace@0.7.1"].includes(profile), option.id + " default profile " + profile);
      const entry = option.defaults[profile];
      assert.ok(["value", "omitted", "derived"].includes(entry.kind), option.id + " default kind");
      if (entry.kind === "value") assert.deepEqual(validateOptionValue(option, entry.value), [], option.id + " default value");
      if (entry.kind === "derived") {
        assert.ok(ids.includes(entry.from) || OPTION_SCHEMA.some(({ statePath }) => statePath === entry.from), option.id + " derived source");
        assert.ok(Number.isFinite(entry.factor), option.id + " derived factor");
      }
    }
  }

  for (const action of ACTION_SCHEMA) {
    for (const capability of action.requiredCapabilities) assert.ok(capabilities.has(capability), action.id + " capability " + capability);
  }
  assert.deepEqual(WORKSPACE_CURRENT_MANIFEST.supportedOptionIds, ids);
  assert.equal(new Set(NPM_0_6_MANIFEST.supportedOptionIds).size, NPM_0_6_MANIFEST.supportedOptionIds.length);
  assert.equal(new Set(NPM_0_7_1_MANIFEST.supportedOptionIds).size, NPM_0_7_1_MANIFEST.supportedOptionIds.length);
  assert.ok(NPM_0_6_MANIFEST.supportedOptionIds.every((id) => ids.includes(id)));
  assert.ok(NPM_0_6_MANIFEST.supportedOptionIds.every((id) => NPM_0_6_MANIFEST.defaults[id]));
  assert.ok(NPM_0_7_1_MANIFEST.supportedOptionIds.every((id) => NPM_0_7_1_MANIFEST.defaults[id]));
  assert.ok(ids.every((id) => WORKSPACE_CURRENT_MANIFEST.defaults[id]));
  assert.equal(new Set(NPM_0_6_MANIFEST.capabilities).size, NPM_0_6_MANIFEST.capabilities.length);
  assert.equal(new Set(NPM_0_7_1_MANIFEST.capabilities).size, NPM_0_7_1_MANIFEST.capabilities.length);
  assert.equal(new Set(WORKSPACE_CURRENT_MANIFEST.capabilities).size, WORKSPACE_CURRENT_MANIFEST.capabilities.length);
  assert.ok(!NPM_0_6_MANIFEST.supportedOptionIds.includes("coordinates.verticalTransform"));
  assert.ok(!NPM_0_6_MANIFEST.supportedOptionIds.includes("style.dimension"));
  assert.ok(!NPM_0_6_MANIFEST.supportedOptionIds.includes("style.dimensionFilter"));
  assert.ok(!NPM_0_6_CAPABILITIES.includes("style.numeric-dimension"));
  assert.ok(!NPM_0_6_MANIFEST.capabilities.includes("vertical.gtx-grid"));
  assert.ok(!NPM_0_6_MANIFEST.capabilities.includes("cesium.terrain-alignment"));
  assert.ok(NPM_0_7_1_MANIFEST.capabilities.includes("cesium.terrain-alignment"));
  assert.ok(NPM_0_7_1_MANIFEST.capabilities.includes("vertical.gtx-grid"));
  assert.ok(PLAYGROUND_0_7_1_RUNTIME_CAPABILITIES.includes("vertical.gtx-grid"));
  assert.ok(NPM_0_7_1_CAPABILITIES.includes("cesium.attribute-loading"));
  assert.ok(NPM_0_7_1_CAPABILITIES.includes("cesium.point-fields"));
  assert.ok(NPM_0_7_1_CAPABILITIES.includes("cache.coordinate-layout"));
  assert.ok(NPM_0_7_1_CAPABILITIES.includes("cache.source-coordinate-retention"));
  assert.ok(WORKSPACE_CURRENT_MANIFEST.supportedOptionIds.includes("coordinates.verticalTransform"));
  assert.ok(WORKSPACE_CURRENT_MANIFEST.supportedOptionIds.includes("style.dimension"));
  assert.ok(WORKSPACE_CURRENT_MANIFEST.supportedOptionIds.includes("style.dimensionFilter"));
  assert.ok(WORKSPACE_CURRENT_CAPABILITIES.includes("style.numeric-dimension"));
  assert.ok(WORKSPACE_CURRENT_MANIFEST.capabilities.includes("vertical.gtx-grid"));
  for (const id of [
    "attributes.attributeLoading",
    "attributes.pointFields",
    "cache.coordinateCacheLayout",
    "cache.retainSourceCoordinatesForQueries",
  ]) {
    assert.ok(NPM_0_7_1_MANIFEST.supportedOptionIds.includes(id), id + " is present in npm 0.7.1");
    assert.ok(!NPM_0_6_MANIFEST.supportedOptionIds.includes(id), id + " is absent from npm 0.6.0");
    assert.ok(WORKSPACE_CURRENT_MANIFEST.supportedOptionIds.includes(id), id + " is present in the workspace");
  }
  assert.ok(NPM_0_6_MANIFEST.supportedOptionIds.includes("streaming.maxConcurrentNodeLoads"));
  assert.ok(NPM_0_6_MANIFEST.unsupportedOptionIdsByRenderer.cesium?.includes("streaming.maxConcurrentNodeLoads"));
  assert.ok(NPM_0_7_1_MANIFEST.supportedOptionIds.includes("streaming.maxConcurrentNodeLoads"));
});

test("public release and workspace profiles resolve only known package versions", () => {
  assert.equal(isKnownManifest(NPM_0_6_MANIFEST), true);
  assert.equal(isKnownManifest(NPM_0_7_1_MANIFEST), true);
  assert.equal(isKnownManifest(WORKSPACE_CURRENT_MANIFEST), true);
  assert.equal(getAdapterManifest("npm", "0.6.0"), NPM_0_6_MANIFEST);
  assert.equal(getAdapterManifest("npm", "0.7.1"), NPM_0_7_1_MANIFEST);
  assert.equal(
    getAdapterManifest("workspace", "0.7.1"),
    WORKSPACE_CURRENT_MANIFEST,
  );
  assert.equal(getAdapterManifest("workspace", "0.6.0"), undefined);
  assert.equal(getAdapterManifest("npm", "0.6.1"), undefined);
  assert.equal(getAdapterManifest("candidate", "0.6.0"), undefined);
  assert.equal(
    isKnownManifest({ ...NPM_0_6_MANIFEST, version: "99.0.0" }),
    false,
  );
});

test("package profiles match the actual pinned and workspace package versions", () => {
  const playground = JSON.parse(
    readFileSync(new URL("../../../playground/package.json", import.meta.url), "utf8"),
  );
  const workspace = JSON.parse(
    readFileSync(new URL("../../../../packages/package.json", import.meta.url), "utf8"),
  );
  const playgroundLock = JSON.parse(
    readFileSync(new URL("../../../playground/package-lock.json", import.meta.url), "utf8"),
  );
  const devViewerLock = JSON.parse(
    readFileSync(new URL("../../../dev-viewer/package-lock.json", import.meta.url), "utf8"),
  );

  assert.equal(
    playground.devDependencies["@frillab/copc-adapter"],
    NPM_0_7_1_MANIFEST.version,
  );
  assert.equal(workspace.version, WORKSPACE_CURRENT_MANIFEST.version);
  assert.equal(
    playgroundLock.packages["node_modules/@frillab/copc-adapter"].version,
    NPM_0_7_1_MANIFEST.version,
  );
  assert.match(
    playgroundLock.packages["node_modules/@frillab/copc-adapter"].resolved,
    /^https:\/\/registry\.npmjs\.org\//u,
  );
  assert.equal(devViewerLock.packages["../../packages"].version, WORKSPACE_CURRENT_MANIFEST.version);
  assert.equal(
    devViewerLock.packages["node_modules/@frillab/copc-adapter"].resolved,
    "../../packages",
  );
  assert.equal(devViewerLock.packages["node_modules/@frillab/copc-adapter"].link, true);
  for (const id of NPM_0_7_1_MANIFEST.supportedOptionIds) {
    assert.ok(NPM_0_7_1_MANIFEST.defaults[id], "missing npm default manifest entry for " + id);
  }
});

test("opacity and Cesium clipping support follows the verified package and renderer profiles", () => {
  const opacity = getOptionDefinition("rendering.opacity");
  const clipping = getOptionDefinition("filtering.cesiumClippingVolume");
  assert.ok(opacity.packageUnavailableMessage);
  assert.ok(clipping.packageUnavailableMessage);
  assert.ok(clipping.rendererUnavailableMessage);
  assert.ok(NPM_0_7_1_MANIFEST.supportedOptionIds.includes(opacity.id));
  assert.ok(NPM_0_7_1_MANIFEST.supportedOptionIds.includes(clipping.id));
  assert.ok(NPM_0_7_1_MANIFEST.capabilities.includes("renderer.layer-opacity"));
  assert.ok(NPM_0_7_1_MANIFEST.capabilities.includes("cesium.clipping-volume"));
  assert.ok(!NPM_0_6_MANIFEST.supportedOptionIds.includes(opacity.id));
  assert.ok(!NPM_0_6_MANIFEST.supportedOptionIds.includes(clipping.id));
  assert.ok(!NPM_0_6_MANIFEST.capabilities.includes("renderer.layer-opacity"));
  assert.ok(!NPM_0_6_MANIFEST.capabilities.includes("cesium.clipping-volume"));

  const npm071 = {
    manifest: NPM_0_7_1_MANIFEST,
    runtimeCapabilities: NPM_0_7_1_CAPABILITIES,
  };
  assert.ok(getSupportedOptions({ ...npm071, renderer: "cesium" }).some(({ id }) => id === opacity.id));
  assert.ok(getSupportedOptions({ ...npm071, renderer: "three" }).some(({ id }) => id === opacity.id));
  assert.ok(getSupportedOptions({ ...npm071, renderer: "cesium" }).some(({ id }) => id === clipping.id));
  assert.ok(!getSupportedOptions({ ...npm071, renderer: "three" }).some(({ id }) => id === clipping.id));

  const workspace = {
    manifest: WORKSPACE_CURRENT_MANIFEST,
    runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
  };
  assert.ok(getSupportedOptions({ ...workspace, renderer: "cesium" }).some(({ id }) => id === opacity.id));
  assert.ok(getSupportedOptions({ ...workspace, renderer: "three" }).some(({ id }) => id === opacity.id));
  assert.ok(getSupportedOptions({ ...workspace, renderer: "cesium" }).some(({ id }) => id === clipping.id));
  assert.ok(!getSupportedOptions({ ...workspace, renderer: "three" }).some(({ id }) => id === clipping.id));
});

test("capability projection filters renderer, release support, runtime capabilities, and conditions", () => {
  const threeOptions = getAvailableOptions({
    ...cesiumContext,
    renderer: "three",
  });
  assert.ok(threeOptions.some(({ id }) => id === "interaction.pickingThreshold"));
  assert.ok(!threeOptions.some(({ id }) => id === "style.classificationFilter"));
  assert.ok(
    getSupportedOptions({ ...cesiumContext, renderer: "three" }).some(
      ({ id }) => id === "streaming.maxConcurrentNodeLoads",
    ),
  );
  assert.ok(
    !getSupportedOptions(cesiumContext).some(
      ({ id }) => id === "streaming.maxConcurrentNodeLoads",
    ),
    "npm 0.6.0 Cesium declarations do not expose maxConcurrentNodeLoads",
  );
  assert.ok(
    getSupportedOptions({
      manifest: NPM_0_7_1_MANIFEST,
      renderer: "cesium",
    }).some(({ id }) => id === "streaming.maxConcurrentNodeLoads"),
    "npm 0.7.1 exposes maxConcurrentNodeLoads for Cesium",
  );
  assert.ok(
    !getSupportedOptions(cesiumContext).some(
      ({ id }) => id === "coordinates.verticalTransform",
    ),
  );
  assert.ok(!getAvailableChoices(getOptionDefinition("rendering.colorMode"), cesiumContext)
    .some(({ value }) => value === "dimension"));
  assert.ok(!getSupportedOptions(cesiumContext).some(({ id }) => id === "style.dimension"));
  assert.ok(!getSupportedOptions(cesiumContext).some(({ id }) => id === "style.dimensionFilter"));
  const workspaceDimensionChoices = getAvailableChoices(
    getOptionDefinition("rendering.colorMode"),
    { manifest: WORKSPACE_CURRENT_MANIFEST, renderer: "cesium" },
  );
  assert.ok(workspaceDimensionChoices.some(({ value }) => value === "dimension"));
  assert.ok(getSupportedOptions({
    manifest: WORKSPACE_CURRENT_MANIFEST,
    renderer: "three",
  }).some(({ id }) => id === "style.dimension"));
  assert.ok(!getSupportedOptions({
    manifest: WORKSPACE_CURRENT_MANIFEST,
    renderer: "three",
  }).some(({ id }) => id === "style.dimensionFilter"));
  assert.ok(
    getSupportedOptions({
      manifest: WORKSPACE_CURRENT_MANIFEST,
      renderer: "cesium",
    }).some(({ id }) => id === "coordinates.verticalTransform"),
  );

  const unsupportedRelease = {
    ...NPM_0_6_MANIFEST,
    supportedOptionIds: NPM_0_6_MANIFEST.supportedOptionIds.filter(
      (id) => id !== "streaming.predictivePrefetch",
    ),
  };
  assert.ok(
    !getAvailableOptions({
      manifest: unsupportedRelease,
      renderer: "cesium",
    }).some(({ id }) => id === "streaming.predictivePrefetch"),
  );
  const rustContext = {
    ...cesiumContext,
    values: {
      "adapter.backend": "rust",
      "attributes.extraDimensions": ["leg_id"],
    },
  };
  assert.ok(
    getSupportedOptions(rustContext).some(
      ({ id }) => id === "attributes.extraDimensions",
    ),
    "backend selection affects availability, not package support",
  );
  assert.ok(
    !getAvailableOptions({
      ...rustContext,
    }).some(({ id }) => id === "attributes.extraDimensions"),
  );
  assert.ok(
    !isOptionAvailable(
      getOptionDefinition("attributes.extraDimensions"),
      rustContext,
    ),
  );
  assert.ok(
    !getAvailableOptions({
      ...cesiumContext,
      runtimeCapabilities: [],
    }).some(({ id }) => id === "style.classificationFilter"),
  );
  const pointSizeMode = getOptionDefinition("rendering.pointSizeMode");
  assert.deepEqual(
    getAvailableChoices(pointSizeMode, {
      ...cesiumContext,
      runtimeCapabilities: [],
    }).map(({ value }) => value),
    ["fixed"],
  );
  assert.deepEqual(
    getAvailableChoices(
      getOptionDefinition("rendering.cesiumPointRenderer"),
      { ...cesiumContext, runtimeCapabilities: [] },
    ).map(({ value }) => value),
    ["point-primitive"],
  );
  assert.deepEqual(
    getAvailableChoices(
      getOptionDefinition("adapter.backend"),
      { ...cesiumContext, runtimeCapabilities: [] },
    ).map(({ value }) => value),
    ["copc-js"],
  );

  const fixed = getAvailableOptions({
    ...cesiumContext,
    values: { "rendering.pointSizeMode": "fixed" },
  });
  const attenuated = getAvailableOptions({
    ...cesiumContext,
    values: { "rendering.pointSizeMode": "attenuated" },
  });
  assert.ok(!fixed.some(({ id }) => id === "rendering.minPointSize"));
  assert.ok(attenuated.some(({ id }) => id === "rendering.minPointSize"));

  assert.deepEqual(
    getAvailableActions(cesiumContext).map(({ id }) => id),
    ["source.probe", "source.load"],
  );
  assert.deepEqual(
    getAvailableActions({ manifest: NPM_0_7_1_MANIFEST, renderer: "cesium" }).map(({ id }) => id),
    ["source.probe", "source.load", "coordinates.terrainAlignment"],
  );
  assert.deepEqual(
    getAvailableActions({
      manifest: WORKSPACE_CURRENT_MANIFEST,
      renderer: "cesium",
    }).map(({ id }) => id),
    ["source.probe", "source.load", "coordinates.terrainAlignment"],
  );
  assert.deepEqual(
    getAvailableActions({ ...cesiumContext, renderer: "three" }).map(
      ({ id }) => id,
    ),
    ["source.probe", "source.load"],
  );
  assert.deepEqual(
    getAvailableActions({ manifest: NPM_0_7_1_MANIFEST, renderer: "three" }).map(({ id }) => id),
    ["source.probe", "source.load", "coordinates.terrainAlignment"],
  );
});

test("attribute and cache controls follow exact package, renderer, and loading dependencies", () => {
  const npm071Cesium = {
    manifest: NPM_0_7_1_MANIFEST,
    renderer: "cesium",
    runtimeCapabilities: NPM_0_7_1_CAPABILITIES,
  };
  const requiredFields = getAvailableOptions({
    ...npm071Cesium,
    values: { "attributes.attributeLoading": "required" },
  });
  assert.ok(requiredFields.some(({ id }) => id === "attributes.attributeLoading"));
  assert.ok(requiredFields.some(({ id }) => id === "attributes.pointFields"));
  assert.ok(requiredFields.some(({ id }) => id === "cache.coordinateCacheLayout"));
  assert.ok(requiredFields.some(({ id }) => id === "cache.retainSourceCoordinatesForQueries"));

  const allFields = getAvailableOptions({ ...npm071Cesium, values: {} });
  assert.ok(allFields.some(({ id }) => id === "attributes.attributeLoading"));
  assert.ok(!allFields.some(({ id }) => id === "attributes.pointFields"));
  assert.ok(!getSupportedOptions(cesiumContext).some(({ id }) => id === "attributes.attributeLoading"));

  const three = getSupportedOptions({ ...npm071Cesium, renderer: "three" });
  assert.ok(!three.some(({ id }) => id === "attributes.attributeLoading"));
  assert.ok(!three.some(({ id }) => id === "attributes.pointFields"));
  assert.ok(three.some(({ id }) => id === "cache.coordinateCacheLayout"));
  assert.ok(three.some(({ id }) => id === "cache.retainSourceCoordinatesForQueries"));

  const pointFields = getOptionDefinition("attributes.pointFields");
  assert.match(validateOptionValue(pointFields, ["intensity", "not-a-standard-field"]).join(" "), /only: intensity, classification, rgb/u);
});

test("attribute and cache policy values round-trip through safe share state", () => {
  const context = {
    manifest: NPM_0_7_1_MANIFEST,
    renderer: "cesium",
    runtimeCapabilities: NPM_0_7_1_CAPABILITIES,
  };
  const values = {
    "renderer.engine": "cesium",
    "adapter.backend": "copc-js",
    "rendering.colorMode": "rgb",
    "attributes.attributeLoading": "required",
    "attributes.pointFields": ["intensity", "classification"],
    "cache.coordinateCacheLayout": "E",
    "cache.retainSourceCoordinatesForQueries": true,
  };
  const query = serializeSchemaValues(values, context);
  assert.equal(query.get("attributeLoading"), "required");
  assert.deepEqual(JSON.parse(query.get("pointFields")), ["intensity", "classification"]);
  assert.equal(query.get("coordinateCacheLayout"), "E");
  assert.equal(query.get("retainSourceCoordinatesForQueries"), "true");
  const restored = deserializeSchemaValues(query, context);
  for (const id of Object.keys(values)) assert.deepEqual(restored.values[id], values[id], id);
});

test("versioned defaults preserve verified values and delegate derived behavior to the adapter", () => {
  const expectedDefaults = {
    "adapter.backend": "copc-js",
    "rendering.colorMode": "fixed",
    "rendering.pointSize": 3,
    "rendering.cesiumPointRenderer": "point-primitive",
    "rendering.pointSizeMode": "fixed",
    "rendering.minPointSize": 1,
    "rendering.maxPointSize": 12,
    "coordinates.heightOffsetMeters": 0,
    "performance.maxRenderedPoints": 250_000,
    "cache.maxPointCacheBytes": 256 * 1024 * 1024,
    "streaming.maxNodes": 24,
    "streaming.maxDepth": 6,
    "streaming.maxScreenSpaceError": 8,
    "streaming.maxRenderDistanceMeters": 12_000,
    "streaming.maxConcurrentNodeLoads": 4,
    "streaming.refinementAlgorithm": "foveated",
    "streaming.motionLookahead": true,
    "streaming.predictivePrefetch": false,
    "source.rangeValidation": "head-fallback",
    "source.maxRangeBytes": 64 * 1024 * 1024,
    "source.maxConcurrentRangeRequests": 4,
    "interaction.pickingThreshold": 1,
  };
  for (const [id, expected] of Object.entries(expectedDefaults)) {
    assert.equal(resolveOptionDefault(id, NPM_0_6_MANIFEST), expected, id);
  }
  assert.equal(
    getOptionDefault("streaming.screenSpaceErrorHysteresis", NPM_0_6_MANIFEST)?.kind,
    "omitted",
  );
  assert.equal(
    resolveOptionDefault("streaming.screenSpaceErrorHysteresis", NPM_0_6_MANIFEST),
    undefined,
  );
  assert.equal(
    getOptionDefault("style.classificationFilter", NPM_0_6_MANIFEST)?.kind,
    "omitted",
  );
  assert.equal(
    resolveOptionDefault("style.classificationFilter", NPM_0_6_MANIFEST),
    undefined,
  );
  assert.equal(
    validateOptionValue(
      getOptionDefinition("style.classificationFilter"),
      null,
    ).length,
    0,
  );
  assert.deepEqual(
    validateOptionValue(
      getOptionDefinition("style.classificationFilter"),
      undefined,
    ),
    [],
  );
  const explicitNullDefaultManifest = {
    ...NPM_0_6_MANIFEST,
    defaults: {
      ...NPM_0_6_MANIFEST.defaults,
      "style.classificationFilter": { kind: "value", value: null },
    },
  };
  assert.equal(
    resolveOptionDefault(
      "style.classificationFilter",
      explicitNullDefaultManifest,
    ),
    null,
  );

  const derivedManifest = {
    ...NPM_0_6_MANIFEST,
    defaults: {
      ...NPM_0_6_MANIFEST.defaults,
      "streaming.screenSpaceErrorHysteresis": {
        kind: "derived",
        from: "streaming.maxScreenSpaceError",
        operation: "multiply",
        factor: 0.125,
      },
    },
  };
  assert.equal(
    resolveOptionDefault(
      "streaming.screenSpaceErrorHysteresis",
      derivedManifest,
      new Set(),
      OPTION_SCHEMA,
      { "streaming.maxScreenSpaceError": 80 },
    ),
    10,
  );
  assert.equal(
    resolveOptionDefault(
      "streaming.screenSpaceErrorHysteresis",
      derivedManifest,
      new Set(),
      OPTION_SCHEMA,
      { "streaming.maxScreenSpaceError": undefined },
    ),
    1,
    "an explicit undefined source uses the adapter's effective default",
  );
});

test("nested public paths and constructor/runtime application are explicit", () => {
  const maxDepth = getOptionDefinition("streaming.maxDepth");
  assert.equal(maxDepth.statePath, "streaming.maxDepth");
  assert.equal(maxDepth.apiPath, "streaming.maxDepth");
  assert.equal(
    getOptionApplyMode(
      getOptionDefinition("rendering.colorMode"),
      "cesium",
    ),
    "runtime",
  );
  assert.equal(
    getOptionApplyMode(
      getOptionDefinition("rendering.colorMode"),
      "three",
    ),
    "constructor",
  );
  assert.deepEqual(
    getOptionDefinition("style.classificationFilter").codeGeneration,
    {
      kind: "runtime-method",
      property: "classificationFilter",
    },
  );
  assert.equal(
    getOptionDefinition("style.classificationFilter").runtimeMethod,
    "setStyle",
  );
});

test("schema validation handles numeric constraints, enums, arrays, and cross-field bounds", () => {
  const pointSize = getOptionDefinition("rendering.pointSize");
  assert.deepEqual(validateOptionValue(pointSize, 2.5), []);
  assert.match(validateOptionValue(pointSize, Number.POSITIVE_INFINITY)[0], /finite/);
  assert.match(validateOptionValue(pointSize, 0)[0], /greater than 0/);

  const colorMode = getOptionDefinition("rendering.colorMode");
  assert.match(validateOptionValue(colorMode, "not-a-mode")[0], /fixed, rgb/);

  const classification = getOptionDefinition("style.classificationFilter");
  assert.deepEqual(
    validateOptionValue(classification, { include: [], exclude: [2, 255] }),
    [],
  );
  assert.match(
    validateOptionValue(classification, { include: [256] })[0],
    /integers from 0 to 255/,
  );
  const extraDimensions = getOptionDefinition("attributes.extraDimensions");
  assert.deepEqual(validateOptionValue(extraDimensions, ["leg_id", "CE"]), []);
  assert.deepEqual(validateOptionValue(extraDimensions, "*"), []);
  assert.match(validateOptionValue(extraDimensions, [""])[0], /non-empty/);

  const errors = validateSchemaValues(
    {
      "source.url": "https://example.test/cloud.copc.laz",
      "renderer.engine": "cesium",
      "rendering.pointSizeMode": "attenuated",
      "rendering.minPointSize": 20,
      "rendering.maxPointSize": 12,
    },
    cesiumContext,
  );
  assert.ok(errors.some((error) => /Minimum Point Size must not exceed Maximum Point Size/.test(error)));

  const unavailableChoiceErrors = validateSchemaValues(
    {
      "source.url": "https://example.test/cloud.copc.laz",
      "renderer.engine": "cesium",
      "rendering.pointSizeMode": "attenuated",
    },
    { ...cesiumContext, runtimeCapabilities: [] },
  );
  assert.ok(
    unavailableChoiceErrors.some((error) =>
      /Point Size Mode choice attenuated is unavailable/.test(error),
    ),
  );

  const defaultBoundErrors = validateSchemaValues(
    {
      "source.url": "https://example.test/cloud.copc.laz",
      "renderer.engine": "cesium",
      "rendering.pointSizeMode": "attenuated",
      "rendering.maxPointSize": 0.5,
    },
    cesiumContext,
  );
  assert.ok(
    defaultBoundErrors.some((error) =>
      /Minimum Point Size must not exceed Maximum Point Size/.test(error),
    ),
  );
});

test("numeric dimension styles and filters validate exact metadata and normalized ramps", () => {
  const numericDimensions = [
    {
      name: "Intensity", kind: "intensity", styleable: true, decoded: true,
      defaultRange: { min: 0, max: 65_535 }, units: "raw LAS intensity (unitless)",
    },
    {
      name: "height", kind: "extra", type: "float", length: 4, noData: -9999,
      styleable: true, decoded: false, defaultRange: { min: 0, max: 1 },
      units: "source values (unit not declared)",
    },
    {
      name: "record_id", kind: "extra", type: "unsigned", length: 8,
      styleable: false, unsupportedReason: "64-bit integer fields are preserved as BigInt.",
      decoded: false, defaultRange: { min: 0, max: 1 },
      units: "source values (unit not declared)",
    },
  ];
  const context = {
    manifest: WORKSPACE_CURRENT_MANIFEST,
    renderer: "cesium",
    values: { "rendering.colorMode": "dimension" },
    numericDimensions,
  };
  const style = {
    name: "height",
    range: { min: -5, max: 40 },
    palette: [
      { position: 0, color: { red: 0, green: 0.2, blue: 1, alpha: 0.5 } },
      { position: 1, color: { red: 1, green: 0.1, blue: 0, alpha: 1 } },
    ],
    missingValue: -9999,
  };
  const styleOption = getOptionDefinition("style.dimension");
  const filterOption = getOptionDefinition("style.dimensionFilter");
  assert.deepEqual(validateOptionValue(styleOption, style, {}, context), []);
  assert.deepEqual(validateOptionValue(filterOption, { name: "height", min: 0, max: 20 }, {}, context), []);
  assert.match(validateOptionValue(styleOption, { ...style, name: "not-in-metadata" }, {}, context)[0], /unavailable/u);
  assert.match(validateOptionValue(styleOption, { ...style, name: "record_id" }, {}, context)[0], /BigInt/u);
  assert.match(validateOptionValue(styleOption, {
    ...style,
    palette: [style.palette[0], { ...style.palette[1], color: { ...style.palette[1].color, alpha: 1.1 } }],
  }, {}, context)[0], /normalized values/u);
  assert.match(validateOptionValue(filterOption, { name: "height", min: 20, max: 10 }, {}, context)[0], /minimum must not exceed maximum/u);
  assert.ok(validateSchemaValues({ "rendering.colorMode": "dimension" }, context)
    .some((error) => /Numeric Dimension Ramp is required/u.test(error)));

  const retainedFieldStyle = { ...style, name: "previous-source-field" };
  const currentSourceContext = {
    manifest: WORKSPACE_CURRENT_MANIFEST,
    renderer: "cesium",
    numericDimensions: [numericDimensions[0]],
  };
  const inactiveRampValues = {
    "adapter.backend": "rust",
    "rendering.colorMode": "rgb",
    "style.dimension": retainedFieldStyle,
  };
  const inactiveRampErrors = validateSchemaValues(
    inactiveRampValues,
    currentSourceContext,
    OPTION_SCHEMA,
    {},
    { requireRequired: false },
  );
  assert.ok(
    !inactiveRampErrors.some((error) => /previous-source-field is unavailable/u.test(error)),
    "a retained inactive ramp should not block a different backend or source configuration",
  );

  const activeRampErrors = validateSchemaValues(
    { ...inactiveRampValues, "rendering.colorMode": "dimension" },
    currentSourceContext,
    OPTION_SCHEMA,
    {},
    { requireRequired: false },
  );
  assert.ok(
    activeRampErrors.some((error) => /previous-source-field is unavailable/u.test(error)),
    "an active ramp must still match numeric metadata for the current source and backend",
  );
});

test("opacity and ECEF clipping values validate without clamping", () => {
  const opacity = getOptionDefinition("rendering.opacity");
  assert.deepEqual(validateOptionValue(opacity, 0), []);
  assert.deepEqual(validateOptionValue(opacity, 0.45), []);
  assert.deepEqual(validateOptionValue(opacity, 1), []);
  assert.match(validateOptionValue(opacity, -0.01)[0], /at least 0/);
  assert.match(validateOptionValue(opacity, 1.01)[0], /at most 1/);
  assert.match(validateOptionValue(opacity, Number.NaN)[0], /finite/);

  const clipping = getOptionDefinition("filtering.cesiumClippingVolume");
  const box = {
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: [-10, -20, -30],
    maximum: [10, 20, 30],
  };
  const plane = {
    type: "planes",
    coordinateSystem: "wgs84-ecef-meters",
    planes: [{ normal: [0, 0, 1], point: [0, 0, 0] }],
  };
  assert.deepEqual(validateOptionValue(clipping, box), []);
  assert.deepEqual(validateOptionValue(clipping, plane), []);
  assert.match(validateOptionValue(clipping, { ...box, minimum: [11, 0, 0] })[0], /valid WGS 84 ECEF/);
  assert.match(validateOptionValue(clipping, { ...box, coordinateSystem: "wgs84-lla-degrees" })[0], /valid WGS 84 ECEF/);
  assert.match(validateOptionValue(clipping, { ...box, maximum: [Infinity, 0, 0] })[0], /valid WGS 84 ECEF/);
  assert.match(validateOptionValue(clipping, { ...plane, planes: [{ normal: [0, 0, 0], point: [0, 0, 0] }] })[0], /nonzero normals/);
  assert.match(validateOptionValue(clipping, { ...plane, planes: [] })[0], /1–6 plane/);
  assert.match(validateOptionValue(clipping, { ...plane, planes: Array.from({ length: 7 }, () => plane.planes[0]) })[0], /1–6 plane/);
});

test("an injected schema option is discoverable, validated, serialized, and carries codegen metadata", () => {
  const fixture = {
    id: "test.sampleCount",
    label: "Sample Count",
    description: "Test-only integer option.",
    section: "streaming",
    statePath: "streaming.sampleCount",
    apiPath: "streaming.sampleCount",
    valueType: "integer",
    control: "number",
    validation: {
      kind: "number",
      finite: true,
      minimum: 1,
    },
    optional: true,
    renderers: ["cesium"],
    stability: "stable",
    applyMode: "constructor",
    codeGeneration: { kind: "constructor-option" },
    serialization: { kind: "scalar", key: "sampleCount" },
    defaults: {
      "npm@0.6.0": { kind: "value", value: 4 },
    },
  };
  const schema = [...OPTION_SCHEMA, fixture];
  const manifest = {
    ...NPM_0_6_MANIFEST,
    supportedOptionIds: [...NPM_0_6_MANIFEST.supportedOptionIds, fixture.id],
    defaults: {
      ...NPM_0_6_MANIFEST.defaults,
      [fixture.id]: { kind: "value", value: 4 },
    },
  };
  const context = { manifest, renderer: "cesium" };
  const added = getAvailableOptions(context, schema).find(({ id }) => id === fixture.id);
  assert.equal(added.control, "number");
  assert.deepEqual(added.codeGeneration, { kind: "constructor-option" });
  assert.equal(getSupportedOptions(context, schema).some(({ id }) => id === fixture.id), true);
  assert.deepEqual(validateOptionValue(added, 8), []);
  assert.match(validateOptionValue(added, 0)[0], /at least 1/);

  const state = {
    "source.url": "https://example.test/cloud.copc.laz",
    [fixture.id]: 8,
  };
  assert.deepEqual(validateSchemaValues(state, context, schema), []);
  const params = serializeSchemaValues(state, context, schema);
  assert.equal(params.get("sampleCount"), "8");
  const restored = deserializeSchemaValues(params, context, {}, schema);
  assert.equal(restored.values[fixture.id], 8);
  assert.deepEqual(restored.warnings, []);
});

test("schema serialization round-trips active values without sharing source credentials", () => {
  const values = {
    "source.url": "https://user:secret@example.test/cloud.copc.laz?token=secret",
    "renderer.engine": "cesium",
    "adapter.backend": "rust",
    "rendering.colorMode": "rgb",
    "rendering.pointSize": 4.5,
    "rendering.pointSizeMode": "attenuated",
    "rendering.minPointSize": 1.5,
    "rendering.maxPointSize": 18,
    "style.classificationFilter": { include: [], exclude: [7] },
    "streaming.maxDepth": 9,
    "streaming.refinementFocus": {
      type: "screen-circle",
      center: { x: 0.25, y: 0.75 },
      radius: 0.3,
      detailBias: 1.5,
    },
  };
  const params = serializeSchemaValues(values, cesiumContext);
  assert.equal(params.has("source"), false);
  assert.equal(params.has("url"), false);
  assert.equal(params.toString().includes("secret"), false);
  assert.equal(params.get("classificationInclude"), "");
  assert.equal(params.has("extraDimensions"), false);
  assert.equal(params.get("focusX"), "0.25");
  assert.throws(
    () => serializeSchemaValues(
      { ...values, "attributes.extraDimensions": ["leg_id"] },
      cesiumContext,
    ),
    /unavailable and cannot be shared/,
  );

  const restored = deserializeSchemaValues(params, cesiumContext, values);
  assert.deepEqual(restored.values["style.classificationFilter"], {
    include: [],
    exclude: [7],
  });
  assert.deepEqual(restored.values["streaming.refinementFocus"], {
    type: "screen-circle",
    center: { x: 0.25, y: 0.75 },
    radius: 0.3,
    detailBias: 1.5,
  });
  assert.deepEqual(restored.warnings, []);
  const partialFocus = deserializeSchemaValues(
    new URLSearchParams("focusX=0.5"),
    cesiumContext,
  );
  assert.ok(
    partialFocus.warnings.some((warning) => /Focus Lens/.test(warning)),
  );
});

test("opacity and ECEF clipping serialize, round-trip, and clear through shared configuration", () => {
  const context = {
    manifest: WORKSPACE_CURRENT_MANIFEST,
    renderer: "cesium",
    runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
  };
  const box = {
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: [-1_000, -2_000, -3_000],
    maximum: [1_000, 2_000, 3_000],
  };
  const values = {
    "renderer.engine": "cesium",
    "rendering.opacity": 0.37,
    "filtering.cesiumClippingVolume": box,
  };
  const params = serializeSchemaValues(values, context);
  assert.equal(params.get("opacity"), "0.37");
  assert.deepEqual(JSON.parse(params.get("clippingVolume")), box);
  const restored = deserializeSchemaValues(params, context, values);
  assert.equal(restored.values["rendering.opacity"], 0.37);
  assert.deepEqual(restored.values["filtering.cesiumClippingVolume"], box);
  assert.deepEqual(restored.warnings, []);

  const cleared = serializeSchemaValues({
    "renderer.engine": "cesium",
    "rendering.opacity": undefined,
    "filtering.cesiumClippingVolume": undefined,
  }, context);
  assert.equal(cleared.get("clippingClear"), "true");
  assert.equal(cleared.has("clippingVolume"), false);
  const clearResult = deserializeSchemaValues(cleared, context, {
    "renderer.engine": "cesium",
    "rendering.opacity": 0.37,
    "filtering.cesiumClippingVolume": box,
  });
  assert.equal(clearResult.values["filtering.cesiumClippingVolume"], undefined);
});

test("nullable classification and explicit undefined focus clearing round-trip distinctly", () => {
  const state = {
    "style.classificationFilter": null,
    "streaming.refinementFocus": undefined,
  };
  const params = serializeSchemaValues(state, cesiumContext);
  assert.equal(params.get("classificationClear"), "true");
  assert.equal(params.get("focusClear"), "true");
  assert.equal(params.has("classificationInclude"), false);
  assert.equal(params.has("focusX"), false);
  const restored = deserializeSchemaValues(params, cesiumContext);
  assert.equal(restored.values["style.classificationFilter"], null);
  assert.equal(Object.hasOwn(restored.values, "streaming.refinementFocus"), true);
  assert.equal(restored.values["streaming.refinementFocus"], undefined);
  assert.deepEqual(restored.warnings, []);
  assert.throws(
    () => serializeSchemaValues({ "rendering.pointSize": null }, cesiumContext),
    /cannot be null/,
  );
});

test("numeric dimension ramps use bounded JSON share state", () => {
  const workspaceContext = {
    manifest: WORKSPACE_CURRENT_MANIFEST,
    renderer: "cesium",
  };
  const style = {
    name: "height",
    range: { min: -3, max: 42 },
    palette: [
      { position: 0, color: { red: 0, green: 0.2, blue: 1, alpha: 0.8 } },
      { position: 1, color: { red: 1, green: 0.1, blue: 0, alpha: 0.9 } },
    ],
    missingValue: -9999,
  };
  const filter = { name: "height", min: 2, max: 10, missingValue: -9999 };
  const values = {
    "rendering.colorMode": "dimension",
    "style.dimension": style,
    "style.dimensionFilter": filter,
    "attributes.extraDimensions": ["height"],
  };
  const params = serializeSchemaValues(values, workspaceContext);
  assert.ok(params.get("dimension").length < MAX_SCHEMA_SHARE_PARAMETER_LENGTH);
  const restored = deserializeSchemaValues(params, workspaceContext);
  assert.deepEqual(restored.values["style.dimension"], style);
  assert.deepEqual(restored.values["style.dimensionFilter"], filter);
  assert.deepEqual(restored.values["attributes.extraDimensions"], ["height"]);
  assert.deepEqual(restored.warnings, []);

  const manyStops = Array.from({ length: 64 }, (_, index) => ({
    position: index / 63,
    color: { red: 0.1, green: 0.2, blue: 0.3, alpha: 0.9 },
  }));
  assert.throws(
    () => serializeSchemaValues({
      "rendering.colorMode": "dimension",
      "style.dimension": { ...style, palette: manyStops },
    }, workspaceContext),
    /bounded share-state size/u,
  );
  const malformed = deserializeSchemaValues(
    new URLSearchParams("dimension=%7Bmalformed"),
    workspaceContext,
  );
  assert.ok(malformed.warnings.some((warning) => /Malformed Numeric Dimension Ramp JSON/u.test(warning)));
});

test("npm 0.6.0 never shares the workspace-only numeric dimension API", () => {
  assert.throws(() => serializeSchemaValues({
    "rendering.colorMode": "dimension",
    "style.dimension": {
      name: "Height",
      range: { min: 0, max: 1 },
    },
  }, cesiumContext), /unsupported|unavailable/u);
  const restored = deserializeSchemaValues(
    new URLSearchParams("colorMode=dimension&dimension=%7B%22name%22%3A%22Height%22%7D"),
    cesiumContext,
  );
  assert.equal(restored.values["rendering.colorMode"], "fixed");
  assert.equal(restored.values["style.dimension"], undefined);
  assert.ok(restored.warnings.some((warning) => /Dimension/i.test(warning)));
});

test("conditional support and visibility do not leak incompatible values", () => {
  const extraDimensionValues = {
    "source.url": "https://example.test/cloud.copc.laz",
    "renderer.engine": "cesium",
    "adapter.backend": "copc-js",
    "attributes.extraDimensions": ["leg_id", "CE"],
  };
  const extraDimensionParams = serializeSchemaValues(
    extraDimensionValues,
    cesiumContext,
  );
  assert.equal(extraDimensionParams.get("extraDimensions"), '["leg_id","CE"]');
  assert.deepEqual(
    deserializeSchemaValues(extraDimensionParams, cesiumContext)
      .values["attributes.extraDimensions"],
    ["leg_id", "CE"],
  );
  const unsupportedDimensions = deserializeSchemaValues(
    new URLSearchParams("extraDimensions=%5B%22leg_id%22%5D&backend=rust"),
    cesiumContext,
  );
  assert.equal(
    unsupportedDimensions.values["attributes.extraDimensions"],
    undefined,
  );
  assert.ok(
    unsupportedDimensions.warnings.some((warning) =>
      /Extra Dimensions is unavailable under the selected configuration/.test(warning),
    ),
  );

  const hiddenPointSize = deserializeSchemaValues(
    new URLSearchParams("maxPointSize=20&pointSizeMode=fixed&minPointSize=2"),
    cesiumContext,
  );
  assert.equal(hiddenPointSize.values["rendering.pointSizeMode"], "fixed");
  assert.equal(hiddenPointSize.values["rendering.minPointSize"], 1);
  assert.equal(hiddenPointSize.values["rendering.maxPointSize"], 12);
  assert.ok(hiddenPointSize.warnings.some((warning) => /inactive/.test(warning)));
  assert.equal(
    serializeSchemaValues(hiddenPointSize.values, cesiumContext).has("minPointSize"),
    false,
  );

  const omittedBackend = {
    "adapter.backend": undefined,
    "attributes.extraDimensions": ["leg_id"],
  };
  assert.equal(
    isOptionAvailable(
      getOptionDefinition("attributes.extraDimensions"),
      { ...cesiumContext, values: omittedBackend },
    ),
    true,
    "an omitted backend resolves to its package default for availability",
  );
  assert.equal(
    serializeSchemaValues(omittedBackend, cesiumContext).get("extraDimensions"),
    '["leg_id"]',
  );

  const omittedPointSizeMode = serializeSchemaValues(
    {
      "rendering.pointSizeMode": undefined,
      "rendering.minPointSize": 2,
      "rendering.maxPointSize": 8,
    },
    cesiumContext,
  );
  assert.equal(omittedPointSizeMode.has("minPointSize"), false);
  assert.equal(omittedPointSizeMode.has("maxPointSize"), false);
});

test("derived hysteresis remains omitted against effective defaults, overrides, and round trips", () => {
  const noOverrides = deserializeSchemaValues(new URLSearchParams(), cesiumContext);
  assert.equal(noOverrides.values["streaming.maxScreenSpaceError"], 8);
  assert.equal(Object.hasOwn(noOverrides.values, "streaming.screenSpaceErrorHysteresis"), false);

  const thresholdOnly = deserializeSchemaValues(
    new URLSearchParams("maxScreenSpaceError=80"),
    cesiumContext,
  );
  assert.equal(thresholdOnly.values["streaming.maxScreenSpaceError"], 80);
  assert.equal(Object.hasOwn(thresholdOnly.values, "streaming.screenSpaceErrorHysteresis"), false);

  const both = deserializeSchemaValues(
    new URLSearchParams("maxScreenSpaceError=80&screenSpaceErrorHysteresis=10"),
    cesiumContext,
  );
  assert.equal(both.values["streaming.screenSpaceErrorHysteresis"], 10);

  const invalidThreshold = deserializeSchemaValues(
    new URLSearchParams("maxScreenSpaceError=Infinity"),
    cesiumContext,
  );
  assert.equal(invalidThreshold.values["streaming.maxScreenSpaceError"], 8);
  assert.equal(Object.hasOwn(invalidThreshold.values, "streaming.screenSpaceErrorHysteresis"), false);

  const invalidHysteresis = deserializeSchemaValues(
    new URLSearchParams("maxScreenSpaceError=80&screenSpaceErrorHysteresis=-1"),
    cesiumContext,
  );
  assert.equal(invalidHysteresis.values["streaming.maxScreenSpaceError"], 80);
  assert.equal(Object.hasOwn(invalidHysteresis.values, "streaming.screenSpaceErrorHysteresis"), false);

  const baseOverride = deserializeSchemaValues(
    new URLSearchParams(),
    cesiumContext,
    { "streaming.maxScreenSpaceError": 40 },
  );
  assert.equal(baseOverride.values["streaming.maxScreenSpaceError"], 40);
  assert.equal(Object.hasOwn(baseOverride.values, "streaming.screenSpaceErrorHysteresis"), false);
  const explicitUndefined = deserializeSchemaValues(
    new URLSearchParams(),
    cesiumContext,
    {
      "streaming.maxScreenSpaceError": 40,
      "streaming.screenSpaceErrorHysteresis": undefined,
    },
  );
  assert.equal(Object.hasOwn(explicitUndefined.values, "streaming.screenSpaceErrorHysteresis"), true);
  assert.equal(explicitUndefined.values["streaming.screenSpaceErrorHysteresis"], undefined);

  const serialized = serializeSchemaValues(thresholdOnly.values, cesiumContext);
  const roundTrip = deserializeSchemaValues(serialized, cesiumContext);
  assert.equal(roundTrip.values["streaming.maxScreenSpaceError"], 80);
  assert.equal(Object.hasOwn(roundTrip.values, "streaming.screenSpaceErrorHysteresis"), false);

  const derivedManifest = {
    ...NPM_0_6_MANIFEST,
    defaults: {
      ...NPM_0_6_MANIFEST.defaults,
      "streaming.screenSpaceErrorHysteresis": {
        kind: "derived",
        from: "streaming.maxScreenSpaceError",
        operation: "multiply",
        factor: 0.125,
      },
    },
  };
  const derivedContext = { ...cesiumContext, manifest: derivedManifest };
  const derivedQuery = deserializeSchemaValues(
    new URLSearchParams("maxScreenSpaceError=80"),
    derivedContext,
  );
  assert.equal(derivedQuery.values["streaming.screenSpaceErrorHysteresis"], 10);

  const derivedBase = deserializeSchemaValues(
    new URLSearchParams(),
    derivedContext,
    { "streaming.maxScreenSpaceError": 40 },
  );
  assert.equal(derivedBase.values["streaming.screenSpaceErrorHysteresis"], 5);

  const explicitHysteresis = deserializeSchemaValues(
    new URLSearchParams("maxScreenSpaceError=80&screenSpaceErrorHysteresis=7"),
    derivedContext,
  );
  assert.equal(explicitHysteresis.values["streaming.screenSpaceErrorHysteresis"], 7);
});

test("deserialization validates cross-field limits and falls back to caller or package defaults", () => {
  const invalidQuery = deserializeSchemaValues(
    new URLSearchParams("pointSizeMode=attenuated&minPointSize=20&maxPointSize=12"),
    cesiumContext,
  );
  assert.equal(invalidQuery.values["rendering.minPointSize"], 1);
  assert.equal(invalidQuery.values["rendering.maxPointSize"], 12);
  assert.ok(invalidQuery.warnings.some((warning) => /Inconsistent Minimum Point Size/.test(warning)));
  assert.deepEqual(getSchemaConstraintViolations(invalidQuery.values, cesiumContext), []);

  const base = deserializeSchemaValues(
    new URLSearchParams("pointSizeMode=attenuated&minPointSize=20"),
    cesiumContext,
    { "rendering.maxPointSize": 18 },
  );
  assert.equal(base.values["rendering.minPointSize"], 1);
  assert.equal(base.values["rendering.maxPointSize"], 18);
  assert.ok(base.warnings.some((warning) => /Inconsistent Minimum Point Size/.test(warning)));

  const invalidCallerBase = deserializeSchemaValues(
    new URLSearchParams(),
    cesiumContext,
    {
      "rendering.pointSizeMode": "attenuated",
      "rendering.minPointSize": 20,
      "rendering.maxPointSize": 12,
    },
  );
  assert.equal(invalidCallerBase.values["rendering.minPointSize"], 1);
  assert.equal(invalidCallerBase.values["rendering.maxPointSize"], 12);
  assert.ok(invalidCallerBase.warnings.some((warning) => /Inconsistent base values/.test(warning)));

  const omittedBoundUsesEffectiveDefault = validateSchemaValues(
    {
      "rendering.pointSizeMode": "attenuated",
      "rendering.minPointSize": undefined,
      "rendering.maxPointSize": 0.5,
    },
    cesiumContext,
  );
  assert.ok(
    omittedBoundUsesEffectiveDefault.some((warning) =>
      /Minimum Point Size must not exceed Maximum Point Size/.test(warning),
    ),
    "undefined delegates to the adapter minimum of one pixel for cross-field checks",
  );
});

test("renderer and release changes fail closed and remove stale renderer-specific state", () => {
  const changedRenderer = deserializeSchemaValues(
    new URLSearchParams("renderer=three&pickingThreshold=2&classificationInclude=2"),
    cesiumContext,
    { "style.classificationFilter": { include: [6] } },
  );
  assert.equal(changedRenderer.values["renderer.engine"], "three");
  assert.equal(changedRenderer.values["interaction.pickingThreshold"], 2);
  assert.equal(changedRenderer.values["style.classificationFilter"], undefined);
  assert.ok(changedRenderer.warnings.some((warning) => /Classification Filter is unsupported/.test(warning)));

  const workspaceCesium = deserializeSchemaValues(
    new URLSearchParams("verticalGrid=secret-path"),
    { manifest: WORKSPACE_CURRENT_MANIFEST, renderer: "cesium" },
    { "coordinates.verticalTransform": { gridId: "unverified" } },
  );
  assert.equal(workspaceCesium.values["coordinates.verticalTransform"], undefined);
  assert.ok(workspaceCesium.warnings.some((warning) => /Vertical Grid base value/.test(warning)));
  assert.equal(getAdapterManifest("npm", "99.0.0"), undefined);
});

test("URL state rejects malformed, repeated, oversized, unknown, and unsupported values", () => {
  const repeated = deserializeSchemaValues(
    new URLSearchParams("maxDepth=2&maxDepth=3"),
    cesiumContext,
  );
  assert.equal(repeated.values["streaming.maxDepth"], 6);
  assert.ok(repeated.warnings.some((warning) => /Repeated/.test(warning)));

  const malformed = deserializeSchemaValues(
    new URLSearchParams("maxDepth=NaN&colorMode=not-a-mode&unknownOption=7"),
    cesiumContext,
  );
  assert.equal(malformed.values["streaming.maxDepth"], 6);
  assert.equal(malformed.values["rendering.colorMode"], "fixed");
  assert.ok(malformed.warnings.some((warning) => /Invalid Maximum LoD Depth/.test(warning)));
  assert.ok(malformed.warnings.some((warning) => /Unsupported share-state field unknownOption/.test(warning)));

  const oversized = deserializeSchemaValues(
    new URLSearchParams("maxDepth=2&unknown=" + "x".repeat(MAX_SCHEMA_SHARE_QUERY_LENGTH)),
    cesiumContext,
  );
  assert.equal(oversized.values["streaming.maxDepth"], 6);
  assert.ok(oversized.warnings.some((warning) => /exceeds the 8192-character limit/.test(warning)));

  assert.throws(
    () => serializeSchemaValues({ "attributes.extraDimensions": Array.from({ length: 128 }, () => "x".repeat(128)) }, {
      manifest: NPM_0_6_MANIFEST,
      renderer: "three",
    }),
    /8192-character limit/,
  );
  assert.throws(
    () => serializeSchemaValues({ "rendering.colorMode": "not-a-mode" }, cesiumContext),
    /Cannot share invalid configuration/,
  );
  assert.throws(
    () => serializeSchemaValues({ "adapter.backend": "rust" }, { ...cesiumContext, runtimeCapabilities: [] }),
    /unavailable in the active runtime/,
  );
});

test("File, Blob, and vertical-grid resources never enter share state", () => {
  const fakeBlob = {
    name: "/Users/alice/private.copc.laz",
    size: 32,
    slice() { return {}; },
  };
  const opaqueGrid = {
    gridId: "private-grid",
    path: "/Users/alice/private.gtx",
    sha256: "private-hash",
  };
  const params = serializeSchemaValues(
    {
      "source.url": fakeBlob,
      "coordinates.verticalTransform": opaqueGrid,
      "streaming.maxDepth": 3,
    },
    { manifest: WORKSPACE_CURRENT_MANIFEST, renderer: "cesium" },
  );
  assert.equal(params.toString(), "maxDepth=3");
  assert.equal(params.toString().includes("private"), false);

  const verticalGrid = getOptionDefinition("coordinates.verticalTransform");
  assert.match(validateOptionValue(verticalGrid, opaqueGrid)[0], /loaded and verified/);
  assert.deepEqual(
    validateOptionValue(verticalGrid, opaqueGrid, {
      isLoadedVerticalGrid: (candidate) => candidate === opaqueGrid,
    }),
    [],
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getAdapterManifest,
  getAvailableActions,
  getAvailableChoices,
  getAvailableOptions,
  getOptionApplyMode,
  getOptionDefault,
  getOptionDefinition,
  getSupportedOptions,
  NPM_0_6_MANIFEST,
  OPTION_SCHEMA,
  resolveOptionDefault,
  serializeSchemaValues,
  deserializeSchemaValues,
  validateOptionValue,
  validateSchemaValues,
  WORKSPACE_CURRENT_MANIFEST,
} from "../index.ts";

const cesiumContext = {
  manifest: NPM_0_6_MANIFEST,
  renderer: "cesium",
};

test("schema IDs are unique and all definitions declare a section, control, and code form", () => {
  const ids = OPTION_SCHEMA.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);

  for (const option of OPTION_SCHEMA) {
    assert.ok(option.section, option.id);
    assert.ok(option.control, option.id);
    assert.ok(option.valueType, option.id);
    assert.ok(option.stability, option.id);
    assert.ok(option.codeGeneration.kind, option.id);
    assert.ok(option.serialization.kind, option.id);
  }

  assert.deepEqual(
    NPM_0_6_MANIFEST.supportedOptionIds.filter(
      (id) => !OPTION_SCHEMA.some((option) => option.id === id),
    ),
    [],
  );
});

test("public release and workspace profiles resolve only known package versions", () => {
  assert.equal(getAdapterManifest("npm", "0.6.0"), NPM_0_6_MANIFEST);
  assert.equal(
    getAdapterManifest("workspace", "0.6.0"),
    WORKSPACE_CURRENT_MANIFEST,
  );
  assert.equal(getAdapterManifest("npm", "0.6.1"), undefined);
  assert.equal(getAdapterManifest("workspace", "0.7.0"), undefined);
});

test("package profiles match the actual pinned and workspace package versions", () => {
  const playground = JSON.parse(
    readFileSync(new URL("../../../playground/package.json", import.meta.url), "utf8"),
  );
  const workspace = JSON.parse(
    readFileSync(new URL("../../../../packages/package.json", import.meta.url), "utf8"),
  );

  assert.equal(
    playground.devDependencies["@frillab/copc-adapter"],
    NPM_0_6_MANIFEST.version,
  );
  assert.equal(workspace.version, WORKSPACE_CURRENT_MANIFEST.version);
  for (const id of NPM_0_6_MANIFEST.supportedOptionIds) {
    assert.ok(NPM_0_6_MANIFEST.defaults[id], "missing npm default manifest entry for " + id);
  }
});

test("capability projection filters renderer, release support, runtime capabilities, and conditions", () => {
  const threeOptions = getAvailableOptions({
    ...cesiumContext,
    renderer: "three",
  });
  assert.ok(threeOptions.some(({ id }) => id === "interaction.pickingThreshold"));
  assert.ok(!threeOptions.some(({ id }) => id === "style.classificationFilter"));

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
  assert.ok(
    !getAvailableOptions({
      ...cesiumContext,
      runtimeCapabilities: [],
    }).some(({ id }) => id === "style.classificationFilter"),
  );
  assert.ok(
    !getAvailableOptions({
      ...cesiumContext,
      values: {
        "adapter.backend": "rust",
        "attributes.extraDimensions": ["leg_id"],
      },
    }).some(({ id }) => id === "attributes.extraDimensions"),
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
    ["source.probe", "source.load", "coordinates.terrainAlignment"],
  );
  assert.deepEqual(
    getAvailableActions({ ...cesiumContext, renderer: "three" }).map(
      ({ id }) => id,
    ),
    ["source.probe", "source.load"],
  );
});

test("versioned defaults preserve documented values, omission, and derived values", () => {
  assert.equal(resolveOptionDefault("rendering.pointSize", NPM_0_6_MANIFEST), 3);
  assert.equal(
    resolveOptionDefault("streaming.screenSpaceErrorHysteresis", NPM_0_6_MANIFEST),
    1,
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

test("schema projection exposes a new ordinary option's control and code-generation metadata", () => {
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
    defaults: {},
  };
  const manifest = {
    ...NPM_0_6_MANIFEST,
    supportedOptionIds: [...NPM_0_6_MANIFEST.supportedOptionIds, fixture.id],
  };
  const projected = getSupportedOptions(
    { manifest, renderer: "cesium" },
    [...OPTION_SCHEMA, fixture],
  );
  const added = projected.find(({ id }) => id === fixture.id);
  assert.equal(added.control, "number");
  assert.deepEqual(added.codeGeneration, { kind: "constructor-option" });
});

test("schema serialization round-trips safe values without serializing source URLs", () => {
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
  assert.equal(params.get("classificationInclude"), "");
  assert.equal(params.has("extraDimensions"), false);
  assert.equal(params.get("focusX"), "0.25");
  assert.equal(
    serializeSchemaValues(
      { ...values, "attributes.extraDimensions": ["leg_id"] },
      cesiumContext,
    ).has("extraDimensions"),
    false,
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
    new URLSearchParams("backend=rust&extraDimensions=%5B%22leg_id%22%5D"),
    cesiumContext,
  );
  assert.equal(
    unsupportedDimensions.values["attributes.extraDimensions"],
    undefined,
  );
  assert.ok(
    unsupportedDimensions.warnings.some((warning) =>
      /Extra Dimensions is unavailable/.test(warning),
    ),
  );
});

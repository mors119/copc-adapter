import test from "node:test";
import assert from "node:assert/strict";
import {
  generateIntegrationCodeFromPlan,
  generateWorkbenchIntegrationCode,
  isPotentiallySensitiveSource,
} from "../integrationCode.ts";
import {
  NPM_0_6_CAPABILITIES,
  NPM_0_6_MANIFEST,
  OPTION_SCHEMA,
  WORKSPACE_CURRENT_CAPABILITIES,
  WORKSPACE_CURRENT_MANIFEST,
  deserializeSchemaValues,
  getSupportedOptions,
  serializeSchemaValues,
  validateSchemaValues,
} from "../../schema/index.ts";

function generate(overrides = {}) {
  return generateWorkbenchIntegrationCode({
    renderer: "cesium",
    values: {
      renderer: "cesium",
      backend: "copc-js",
      colorMode: "elevation",
      pointSize: 3,
      maxRenderedPoints: 250_000,
      maxPointCacheBytes: 256 * 1024 * 1024,
      maxNodes: 24,
      maxDepth: 6,
      maxScreenSpaceError: 8,
      maxRenderDistanceMeters: 12_000,
      refinementAlgorithm: "foveated",
    },
    source: "https://example.test/area.copc.laz",
    manifest: NPM_0_6_MANIFEST,
    runtimeCapabilities: NPM_0_6_CAPABILITIES,
    adapterVersion: "0.6.0",
    packageOriginLabel: "verified npm release",
    ...overrides,
  });
}

test("generates nested constructor settings and renderer runtime operations from schema metadata", () => {
  const { code } = generate({
    values: {
      renderer: "cesium",
      backend: "copc-js",
      colorMode: "elevation",
      maxDepth: 9,
      maxScreenSpaceError: 6,
      maxRenderDistanceMeters: 20_000,
      refinementAlgorithm: "screen-projection",
      schemaOptionValues: {
        "source.rangeValidation": "strict",
        "streaming.motionLookahead": false,
        "streaming.predictivePrefetch": true,
        "style.classificationFilter": { include: [2, 6] },
        "streaming.refinementFocus": {
          type: "screen-circle",
          center: { x: 0.4, y: 0.6 },
          radius: 0.2,
          detailBias: 1.5,
        },
      },
    },
  });

  assert.match(code, /streaming: \{/u);
  assert.match(code, /maxDepth: 9/u);
  assert.match(code, /maxScreenSpaceError: 6/u);
  assert.match(code, /maxRenderDistanceMeters: 20000/u);
  assert.match(code, /refinementAlgorithm: 'screen-projection'/u);
  assert.match(code, /rangeValidation: 'strict'/u);
  assert.match(code, /motionLookahead: false/u);
  assert.match(code, /predictivePrefetch: true/u);
  assert.match(code, /layer\.setStyle\(\{ colorMode: 'elevation', classificationFilter: \{ include: \[2, 6\] \} \}\);/u);
  assert.match(code, /layer\.setRefinementFocus\(/u);
  const constructor = code.slice(code.indexOf("const options"), code.indexOf("const layer"));
  assert.doesNotMatch(constructor, /classificationFilter/u);
});

test("uses manifest defaults for minimal and explicit code without materializing omitted settings", () => {
  const config = {
    renderer: "cesium",
    backend: "copc-js",
    colorMode: "fixed",
    pointSize: 3,
    maxRenderedPoints: 250_000,
    maxPointCacheBytes: 256 * 1024 * 1024,
    maxNodes: 24,
    maxDepth: 6,
    maxScreenSpaceError: 8,
    maxRenderDistanceMeters: 12_000,
    refinementAlgorithm: "foveated",
  };
  const minimal = generate({ values: config }).code;
  assert.doesNotMatch(minimal, /backend:|pointSize:|maxPointCacheBytes:|maxNodes:|maxDepth:|maxScreenSpaceError:/u);

  const explicit = generate({ values: config, mode: "explicit" }).code;
  assert.match(explicit, /backend: 'copc-js'/u);
  assert.match(explicit, /pointSize: 3/u);
  assert.match(explicit, /maxPointCacheBytes: 268435456/u);
  assert.match(explicit, /maxNodes: 24/u);
  assert.match(explicit, /maxDepth: 6/u);
  assert.match(explicit, /layer\.setStyle\(\{ colorMode: 'fixed' \}\);/u);
  assert.doesNotMatch(explicit, /screenSpaceErrorHysteresis/u);
});

test("does not emit Cesium runtime styling as a constructor option", () => {
  const { code } = generate({ values: { renderer: "cesium", colorMode: "rgb" } });
  const constructor = code.slice(code.indexOf("const options"), code.indexOf("const layer"));
  assert.doesNotMatch(constructor, /colorMode/u);
  assert.match(code, /layer\.setStyle\(\{ colorMode: 'rgb' \}\);/u);
});

test("emits the public backend and Cesium renderer specialized handlers", () => {
  const extraDimensions = generate({
    values: {
      renderer: "cesium",
      backend: "copc-js",
      schemaOptionValues: { "attributes.extraDimensions": ["mission_id", "returnNumber"] },
    },
  }).code;
  assert.match(extraDimensions, /import \{ CopcCesiumLayer, CopcJsBackend \}/u);
  assert.match(extraDimensions, /backend: new CopcJsBackend\(\{ extraDimensions: \['mission_id', 'returnNumber'\]\s\}\)/u);

  const batchedRenderer = generate({
    values: {
      renderer: "cesium",
      schemaOptionValues: { "rendering.cesiumPointRenderer": "batched-geometry" },
    },
  }).code;
  assert.match(batchedRenderer, /BatchedGeometryPointRenderer/u);
  assert.match(batchedRenderer, /renderer: new BatchedGeometryPointRenderer\(\)/u);
});

test("rejects settings unsupported by the selected package renderer", () => {
  assert.throws(
    () => generate({
      values: {
        renderer: "cesium",
        schemaOptionValues: { "streaming.maxConcurrentNodeLoads": 7 },
      },
    }),
    /unavailable|unsupported/u,
  );

  assert.throws(
    () => generate({
      values: {
        renderer: "cesium",
        schemaOptionValues: { "coordinates.verticalTransform": {} },
      },
    }),
    /capabilit|unsupported|available/u,
  );
});

test("redacts sensitive sources unless exact-source inclusion is explicit", () => {
  const source = "https://user:password@example.test/area.copc.laz?token=secret#fragment";
  const redacted = generate({ source, includeExactSource: false });
  assert.doesNotMatch(redacted.code, /password|token=secret|fragment/u);
  assert.match(redacted.code, /https:\/\/example\.com\/data\.copc\.laz/u);
  assert.match(redacted.warnings.join(" "), /placeholder/u);

  const exact = generate({ source, includeExactSource: true });
  assert.match(exact.code, /token=secret/u);
  assert.equal(isPotentiallySensitiveSource(source), true);
  assert.equal(isPotentiallySensitiveSource("/samples/area.copc.laz"), true);
});

test("represents local Files with an input control and never emits file metadata", () => {
  const localFile = new File(["private fixture"], "private-area.copc.laz");
  const { code } = generate({
    source: localFile,
    values: { renderer: "cesium", source: localFile },
  });
  assert.match(code, /copc-file-input/u);
  assert.match(code, /url: sourceFile/u);
  assert.doesNotMatch(code, /private-area|private fixture/u);
});

test("fails closed when a supplied adapter version has no matching verified profile", () => {
  assert.throws(
    () => generate({ adapterVersion: "0.6.1" }),
    /does not match the verified npm manifest/u,
  );
  assert.throws(
    () => generate({
      manifest: WORKSPACE_CURRENT_MANIFEST,
      runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
      packageOriginLabel: "workspace",
      adapterVersion: "0.7.0",
    }),
    /does not match the verified workspace manifest/u,
  );
});

test("a synthetic schema extension is discovered, validated, serialized, and generated without production registry edits", () => {
  const option = {
    id: "streaming.syntheticQueueLimit",
    label: "Synthetic Queue Limit",
    description: "Fixture-only option proving schema extension contracts.",
    section: "streaming",
    statePath: "streaming.syntheticQueueLimit",
    apiPath: "streaming.syntheticQueueLimit",
    valueType: "integer",
    control: "number",
    validation: { kind: "number", finite: true, minimum: 1 },
    optional: true,
    renderers: ["cesium", "three"],
    stability: "stable",
    applyMode: "constructor",
    codeGeneration: { kind: "constructor-option" },
    serialization: { kind: "scalar", key: "syntheticQueueLimit" },
    defaults: {
      "npm@0.6.0": { kind: "value", value: 12 },
      "workspace@0.6.0": { kind: "value", value: 12 },
    },
  };
  const schema = [...OPTION_SCHEMA, option];
  const manifest = {
    ...NPM_0_6_MANIFEST,
    supportedOptionIds: [...NPM_0_6_MANIFEST.supportedOptionIds, option.id],
    defaults: { ...NPM_0_6_MANIFEST.defaults, [option.id]: option.defaults["npm@0.6.0"] },
  };
  const context = { manifest, renderer: "cesium", runtimeCapabilities: NPM_0_6_CAPABILITIES };
  const values = {
    "renderer.engine": "cesium",
    "adapter.backend": "copc-js",
    "source.url": "https://example.test/area.copc.laz",
    "streaming.syntheticQueueLimit": 20,
  };

  assert.ok(getSupportedOptions(context, schema).some(({ id }) => id === option.id));
  assert.deepEqual(validateSchemaValues(values, context, schema), []);
  const query = serializeSchemaValues(values, context, schema);
  assert.equal(query.get("syntheticQueueLimit"), "20");
  const restored = deserializeSchemaValues(query, context, {}, schema);
  assert.equal(restored.values[option.id], 20);

  const plan = {
    renderer: "cesium",
    manifest,
    values,
    constructorOptions: {
      url: values["source.url"],
      backend: "copc-js",
      streaming: { syntheticQueueLimit: 20 },
    },
    hostOptions: {},
    specializedOptions: [],
    runtimeOperations: [],
    changedOptionIds: [option.id],
    requiresLayerReplacement: true,
  };
  const generated = generateIntegrationCodeFromPlan({
    plan,
    values,
    sourceExpression: "sourceUrl",
    sourceSetup: ["const sourceUrl = 'https://example.test/area.copc.laz';"],
    packageOriginLabel: "synthetic test manifest",
    adapterVersion: "0.6.0",
    schema,
  }).code;
  assert.match(generated, /syntheticQueueLimit: 20/u);
});

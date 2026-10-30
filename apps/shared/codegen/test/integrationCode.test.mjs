import test from "node:test";
import assert from "node:assert/strict";
import {
  generateAppliedWorkbenchIntegrationCode,
  generateIntegrationCodeFromPlan,
  generateWorkbenchIntegrationCode,
  isPotentiallySensitiveSource,
} from "../integrationCode.ts";
import {
  canCopyIntegrationCode,
  preserveLastSuccessfulIntegrationCode,
} from "../IntegrationCodePanel.ts";
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

function generateWorkspace(overrides = {}) {
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
    manifest: WORKSPACE_CURRENT_MANIFEST,
    runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
    adapterVersion: "0.7.1",
    packageOriginLabel: "workspace package",
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
  assert.match(code, /layer\.setStyle\(\{ classificationFilter: \{ include: \[2, 6\] \}, colorMode: 'elevation' \}\);/u);
  assert.match(code, /layer\.setRefinementFocus\(/u);
  const constructor = code.slice(code.indexOf("const options"), code.indexOf("const layer"));
  assert.doesNotMatch(constructor, /classificationFilter/u);
});

test("emits the same code for equivalent applied values regardless of object key order", () => {
  const values = {
    renderer: "cesium",
    backend: "copc-js",
    schemaOptionValues: {
      "style.classificationFilter": { include: [2, 6], exclude: [7] },
    },
  };
  const reorderedValues = {
    renderer: "cesium",
    backend: "copc-js",
    schemaOptionValues: {
      "style.classificationFilter": { exclude: [7], include: [2, 6] },
    },
  };

  assert.equal(generate({ values }).code, generate({ values: reorderedValues }).code);
});

test("generates from the committed applied snapshot and reports pending edits", () => {
  const state = {
    pending: {
      "renderer.engine": "three",
      "source.url": "https://pending.example.test/private.copc.laz?token=not-applied",
    },
    applied: {
      "renderer.engine": "cesium",
      "source.url": "https://example.test/applied.copc.laz",
      "adapter.backend": "copc-js",
      "rendering.colorMode": "classification",
      "style.classificationFilter": { include: [4] },
    },
    pendingRevision: 8,
    appliedRevision: 7,
  };
  const result = generateAppliedWorkbenchIntegrationCode({
    state,
    manifest: NPM_0_6_MANIFEST,
    runtimeCapabilities: NPM_0_6_CAPABILITIES,
    adapterVersion: "0.6.0",
    packageOriginLabel: "verified npm release",
    appliedAt: 1_800_000_000_000,
  });

  assert.equal(result.appliedRevision, 7);
  assert.equal(result.pendingChanges, true);
  assert.equal(result.appliedAt, 1_800_000_000_000);
  assert.match(result.code, /@frillab\/copc-adapter\/cesium/u);
  assert.match(result.code, /applied\.copc\.laz/u);
  assert.match(result.code, /layer\.setStyle\(\{ classificationFilter: \{ include: \[4\] \}, colorMode: 'classification' \}\);/u);
  assert.doesNotMatch(result.code, /three\/|pending\.example|not-applied/u);

  const resetState = {
    ...state,
    pending: { ...state.applied },
    pendingRevision: 9,
  };
  const reset = generateAppliedWorkbenchIntegrationCode({
    state: resetState,
    manifest: NPM_0_6_MANIFEST,
    runtimeCapabilities: NPM_0_6_CAPABILITIES,
    adapterVersion: "0.6.0",
    packageOriginLabel: "verified npm release",
  });
  assert.equal(reset.pendingChanges, false);
});

test("requires an applied snapshot before generating reproducible code", () => {
  assert.throws(
    () => generateAppliedWorkbenchIntegrationCode({
      state: { pending: {}, pendingRevision: 1 },
      manifest: NPM_0_6_MANIFEST,
      runtimeCapabilities: NPM_0_6_CAPABILITIES,
      adapterVersion: "0.6.0",
      packageOriginLabel: "verified npm release",
    }),
    /successfully applied/u,
  );
});

test("includes Terrain estimate and approval code only for an explicitly requested supported Cesium workspace", () => {
  const options = {
    renderer: "cesium",
    values: {
      renderer: "cesium",
      backend: "copc-js",
      schemaOptionValues: { "coordinates.heightOffsetMeters": 8 },
    },
    source: "https://example.test/area.copc.laz",
    manifest: WORKSPACE_CURRENT_MANIFEST,
    runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
    adapterVersion: WORKSPACE_CURRENT_MANIFEST.version,
    packageOriginLabel: "current local workspace source; unpublished",
    includeTerrainAlignmentRecipe: true,
    approvedTerrainAlignment: {
      residualMeters: 3.25,
      finalHeightOffsetMeters: 8,
    },
  };
  const generated = generateWorkbenchIntegrationCode(options);

  assert.match(generated.code, /estimateAndApproveTerrainPlacement/u);
  assert.match(generated.code, /groundConfirmed/u);
  assert.match(generated.code, /window\.confirm/u);
  assert.match(generated.code, /residual of 3\.25 m; the final heightOffsetMeters is 8 m/u);
  assert.match(generated.code, /not a geoid or vertical-datum conversion/u);

  const defaultOffset = generateWorkbenchIntegrationCode({
    ...options,
    values: { renderer: "cesium" },
    includeTerrainAlignmentRecipe: false,
    approvedTerrainAlignment: { residualMeters: 0, finalHeightOffsetMeters: 0 },
  });
  assert.match(defaultOffset.code, /final heightOffsetMeters is 0 m/u);

  assert.throws(
    () => generate({ includeTerrainAlignmentRecipe: true }),
    /do not support Terrain alignment/u,
  );
  assert.throws(
    () => generateWorkbenchIntegrationCode({
      ...options,
      approvedTerrainAlignment: { residualMeters: 3.25, finalHeightOffsetMeters: 9 },
    }),
    /must match a supported applied height offset/u,
  );
  assert.throws(
    () => generateWorkbenchIntegrationCode({ ...options, renderer: "three" }),
    /do not support Terrain alignment/u,
  );
});

test("keeps the last successful copied snippet visible when generation fails", () => {
  const previous = {
    code: "const layer = new CopcCesiumLayer(options);",
    source: "https://example.test/applied.copc.laz",
    installCommand: "npm install @frillab/copc-adapter@0.6.0",
    appliedStatus: { revision: 4, pendingChanges: false, appliedAt: 1000 },
  };
  const failed = preserveLastSuccessfulIntegrationCode(previous, {
    code: "",
    warnings: ["The new configuration is unsupported."],
  });

  assert.equal(failed.code, previous.code);
  assert.equal(failed.source, previous.source);
  assert.equal(failed.installCommand, previous.installCommand);
  assert.equal(failed.appliedStatus.revision, previous.appliedStatus.revision);
  assert.equal(failed.appliedStatus.pendingChanges, previous.appliedStatus.pendingChanges);
  assert.equal(failed.appliedStatus.appliedAt, previous.appliedStatus.appliedAt);
  assert.equal(failed.appliedStatus.codeOutOfDate, true);
  assert.match(failed.warnings.join(" "), /previous successful snippet is unchanged/u);
  assert.match(failed.warnings.join(" "), /unsupported/u);
});

test("blocks copying a retained snippet with an exact sensitive source after consent is withdrawn", () => {
  const previous = {
    code: "const sourceUrl = 'https://example.test/data.copc.laz?token=secret';",
    source: "https://example.test/data.copc.laz?token=secret",
    sensitiveSourceIncluded: true,
  };
  const retained = preserveLastSuccessfulIntegrationCode(previous, {
    code: "",
    warnings: ["The new renderer configuration is unsupported."],
  });

  assert.equal(retained.sensitiveSourceIncluded, true);
  assert.equal(canCopyIntegrationCode(retained, false), false);
  assert.equal(canCopyIntegrationCode(retained, true), true);
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

  const allExtraDimensions = generate({
    values: {
      renderer: "cesium",
      backend: "copc-js",
      schemaOptionValues: { "attributes.extraDimensions": "*" },
    },
  }).code;
  assert.match(allExtraDimensions, /backend: new CopcJsBackend\(\{ extraDimensions: '\*'\s\}\)/u);

  const batchedRenderer = generate({
    values: {
      renderer: "cesium",
      schemaOptionValues: { "rendering.cesiumPointRenderer": "batched-geometry" },
    },
  }).code;
  assert.match(batchedRenderer, /BatchedGeometryPointRenderer/u);
  assert.match(batchedRenderer, /renderer: new BatchedGeometryPointRenderer\(\)/u);
});

test("generates Cesium numeric ramps as runtime styles and Three.js ramps as constructor options", () => {
  const dimension = {
    name: "canopy_height",
    range: { min: 0, max: 42 },
    palette: [
      { position: 0, color: { red: 0, green: 0.2, blue: 1, alpha: 0.9 } },
      { position: 1, color: { red: 1, green: 0.1, blue: 0, alpha: 0.9 } },
    ],
    missingValue: -9999,
  };
  const filter = { name: "canopy_height", min: 2, max: 20, missingValue: -9999 };
  const cesiumCode = generateWorkspace({
    values: {
      renderer: "cesium",
      backend: "copc-js",
      colorMode: "dimension",
      schemaOptionValues: {
        "style.dimension": dimension,
        "style.dimensionFilter": filter,
        "attributes.extraDimensions": ["canopy_height"],
      },
    },
  }).code;
  assert.match(cesiumCode, /new CopcJsBackend\(\{ extraDimensions: \['canopy_height'\]\s\}\)/u);
  assert.match(cesiumCode, /layer\.setStyle\(\{ colorMode: 'dimension', dimension: \{/u);
  assert.match(cesiumCode, /dimensionFilter: \{ max: 20, min: 2, missingValue: -9999, name: 'canopy_height' \}/u);
  const cesiumConstructor = cesiumCode.slice(cesiumCode.indexOf("const options"), cesiumCode.indexOf("const layer"));
  assert.doesNotMatch(cesiumConstructor, /dimension:/u);

  const threeCode = generateWorkspace({
    renderer: "three",
    values: {
      renderer: "three",
      backend: "copc-js",
      colorMode: "dimension",
      schemaOptionValues: {
        "style.dimension": dimension,
        "attributes.extraDimensions": ["canopy_height"],
      },
    },
  }).code;
  assert.match(threeCode, /colorMode: 'dimension'/u);
  assert.match(threeCode, /dimension: \{\s+missingValue: -9999,\s+name: 'canopy_height'/u);
  assert.doesNotMatch(threeCode, /dimensionFilter/u);
  assert.doesNotMatch(threeCode, /layer\.setStyle/u);
});

test("the published npm 0.6.0 profile rejects numeric dimension code", () => {
  assert.throws(
    () => generate({ values: { renderer: "cesium", colorMode: "dimension" } }),
    /unavailable|unsupported/u,
  );
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

test("fails closed for applied values that have no registered copy-code mapping", () => {
  assert.throws(
    () => generate({
      values: {
        renderer: "cesium",
        schemaOptionValues: { "style.opacity": 0.5 },
      },
    }),
    /unregistered option style\.opacity/u,
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

test("warns when a validated host-owned GTX resource needs application setup", () => {
  const gridResource = new (class LoadedGrid {
    internalGridBytes = new Uint8Array([1, 2, 3]);
    sampleHeight() { return 12.5; }
  })();
  const generated = generateWorkbenchIntegrationCode({
    renderer: "cesium",
    values: {
      renderer: "cesium",
      "coordinates.verticalTransform": gridResource,
    },
    manifest: WORKSPACE_CURRENT_MANIFEST,
    runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
    adapterVersion: WORKSPACE_CURRENT_MANIFEST.version,
    packageOriginLabel: "current local workspace source; unpublished",
    hostValidators: {
      isLoadedVerticalGrid: (value) => value === gridResource,
    },
  });

  assert.match(generated.warnings.join(" "), /host-owned/u);
  assert.match(generated.warnings.join(" "), /GtxGeoidGrid/u);
  assert.doesNotMatch(generated.code, /internalGridBytes|sampleHeight|verticalTransform/u);
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
      adapterVersion: "0.7.2",
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
      "workspace@0.7.1": { kind: "value", value: 12 },
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

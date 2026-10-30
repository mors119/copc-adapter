import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateWorkbenchIntegrationCode,
} from "../integrationCode.ts";
import {
  NPM_0_6_CAPABILITIES,
  NPM_0_6_MANIFEST,
  OPTION_SCHEMA,
  WORKSPACE_CURRENT_CAPABILITIES,
  WORKSPACE_CURRENT_MANIFEST,
  getSupportedOptions,
} from "../../schema/index.ts";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const consumerRoot = process.env.COPC_ADAPTER_CONSUMER_ROOT ?? process.cwd();
const consumerPackage = (() => {
  try {
    return JSON.parse(readFileSync(join(consumerRoot, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
})();
const packageSpec = consumerPackage?.devDependencies?.["@frillab/copc-adapter"];
const packedCandidateProfile = process.env.COPC_ADAPTER_CONSUMER_ORIGIN === "packed-candidate";
const consumerProfile = packedCandidateProfile
  ? {
      manifest: WORKSPACE_CURRENT_MANIFEST,
      capabilities: WORKSPACE_CURRENT_CAPABILITIES,
      originLabel: "verified packed-candidate consumer fixture",
    }
  : packageSpec === "0.6.0"
  ? {
      manifest: NPM_0_6_MANIFEST,
      capabilities: NPM_0_6_CAPABILITIES,
      originLabel: "verified npm consumer fixture",
    }
  : typeof packageSpec === "string" && packageSpec.startsWith("file:")
    ? {
        manifest: WORKSPACE_CURRENT_MANIFEST,
        capabilities: WORKSPACE_CURRENT_CAPABILITIES,
        originLabel: "current workspace consumer fixture",
      }
    : undefined;

function generate(renderer, values, additionalOptions = {}) {
  assert.ok(consumerProfile, "the test must run from a supported adapter consumer app");
  return generateWorkbenchIntegrationCode({
    renderer,
    values: {
      renderer,
      backend: "copc-js",
      source: "https://example.test/consumer-fixture.copc.laz",
      ...values,
    },
    manifest: consumerProfile.manifest,
    runtimeCapabilities: consumerProfile.capabilities,
    adapterVersion: consumerProfile.manifest.version,
    packageOriginLabel: consumerProfile.originLabel,
    ...additionalOptions,
  });
}

test("generated Cesium and Three snippets typecheck against the exact consumer package", {
  skip: !consumerProfile,
}, async () => {
  if (packedCandidateProfile) {
    const installedPackage = JSON.parse(
      readFileSync(join(consumerRoot, "node_modules/@frillab/copc-adapter/package.json"), "utf8"),
    );
    assert.equal(installedPackage.version, WORKSPACE_CURRENT_MANIFEST.version);
  }
  const cesiumOptionValues = {
    "attributes.extraDimensions": ["scanAngle"],
    "rendering.colorMode": "intensity",
    "rendering.pointSize": 4,
    "rendering.cesiumPointRenderer": "batched-geometry",
    "rendering.pointSizeMode": "attenuated",
    "rendering.minPointSize": 2,
    "rendering.maxPointSize": 18,
    "style.classificationFilter": { include: [2, 6] },
    "coordinates.heightOffsetMeters": 1.25,
    "performance.maxRenderedPoints": 400_000,
    "cache.maxPointCacheBytes": 128 * 1024 * 1024,
    "streaming.maxNodes": 32,
    "streaming.maxDepth": 7,
    "streaming.maxScreenSpaceError": 6,
    "streaming.screenSpaceErrorHysteresis": 0.8,
    "streaming.maxRenderDistanceMeters": 20_000,
    "streaming.refinementAlgorithm": "screen-projection",
    "streaming.motionLookahead": false,
    "streaming.predictivePrefetch": true,
    "streaming.refinementFocus": {
      type: "screen-circle",
      center: { x: 0.4, y: 0.6 },
      radius: 0.2,
      detailBias: 1.5,
    },
    "source.rangeValidation": "strict",
    "source.maxRangeBytes": 2 * 1024 * 1024,
    "source.maxConcurrentRangeRequests": 3,
  };
  const dimensionStyle = {
    name: "scanAngle",
    range: { min: -90, max: 90 },
    palette: [
      { position: 0, color: { red: 0, green: 0.2, blue: 1, alpha: 0.9 } },
      { position: 1, color: { red: 1, green: 0.1, blue: 0, alpha: 0.9 } },
    ],
  };
  const threeOptionValues = {
    "attributes.extraDimensions": "*",
    "rendering.colorMode": "elevation",
    "rendering.pointSize": 5,
    "coordinates.heightOffsetMeters": 2.5,
    "performance.maxRenderedPoints": 350_000,
    "cache.maxPointCacheBytes": 96 * 1024 * 1024,
    "streaming.maxNodes": 30,
    "streaming.maxDepth": 9,
    "streaming.maxScreenSpaceError": 5,
    "streaming.screenSpaceErrorHysteresis": 0.5,
    "streaming.maxRenderDistanceMeters": 24_000,
    "streaming.maxConcurrentNodeLoads": 3,
    "streaming.refinementAlgorithm": "foveated",
    "streaming.motionLookahead": true,
    "streaming.predictivePrefetch": true,
    "source.rangeValidation": "strict",
    "source.maxRangeBytes": 4 * 1024 * 1024,
    "source.maxConcurrentRangeRequests": 2,
    "interaction.pickingThreshold": 1.5,
  };
  const assertSupportedOptionsCovered = (renderer, values) => {
    const supportedIds = getSupportedOptions({
      manifest: consumerProfile.manifest,
      renderer,
      runtimeCapabilities: consumerProfile.capabilities,
    }, OPTION_SCHEMA).map(({ id }) => id);
    const missing = supportedIds.filter((id) =>
      id !== "source.url" && id !== "renderer.engine" &&
      id !== "coordinates.verticalTransform" && values[id] === undefined
    );
    assert.deepEqual(missing, [], `${renderer} supported schema options need a fixture`);
  };
  const cesiumMatrixValues = {
    "adapter.backend": "copc-js",
    ...cesiumOptionValues,
    ...(consumerProfile.manifest.origin === "workspace"
      ? {
          "streaming.maxConcurrentNodeLoads": 3,
          "rendering.colorMode": "dimension",
          "style.dimension": dimensionStyle,
          "style.dimensionFilter": { name: "scanAngle", min: -20, max: 30 },
        }
      : {}),
  };
  assertSupportedOptionsCovered("cesium", cesiumMatrixValues);
  assertSupportedOptionsCovered("three", {
    "adapter.backend": "copc-js",
    ...threeOptionValues,
    ...(consumerProfile.manifest.origin === "workspace"
      ? { "rendering.colorMode": "dimension", "style.dimension": dimensionStyle }
      : {}),
  });

  const cesium = generate("cesium", {
    colorMode: "intensity",
    pointSize: 4,
    maxDepth: 7,
    schemaOptionValues: {
      "attributes.extraDimensions": ["scanAngle"],
      "rendering.cesiumPointRenderer": "batched-geometry",
      "style.classificationFilter": { include: [2, 6] },
      "streaming.refinementFocus": {
        type: "screen-circle",
        center: { x: 0.4, y: 0.6 },
        radius: 0.2,
        detailBias: 1.5,
      },
    },
  });
  const three = generate("three", {
    colorMode: "elevation",
    pointSize: 5,
    maxDepth: 9,
    schemaOptionValues: {
      "attributes.extraDimensions": "*",
    },
  });
  const cesiumMatrix = generate("cesium", {
    backend: "copc-js",
    schemaOptionValues: cesiumMatrixValues,
  });
  const threeMatrix = generate("three", {
    backend: "copc-js",
    schemaOptionValues: {
      ...threeOptionValues,
      ...(consumerProfile.manifest.origin === "workspace"
        ? { "rendering.colorMode": "dimension", "style.dimension": dimensionStyle }
        : {}),
    },
  });
  const workspaceVerticalGrid = consumerProfile.manifest.origin === "workspace"
    ? { gridId: "validated-test-grid" }
    : undefined;
  const verticalGridOptions = workspaceVerticalGrid === undefined
    ? undefined
    : {
        hostValidators: {
          isLoadedVerticalGrid: (candidate) => candidate === workspaceVerticalGrid,
        },
      };
  const cesiumGrid = workspaceVerticalGrid === undefined
    ? undefined
    : generate("cesium", {
        schemaOptionValues: { "coordinates.verticalTransform": workspaceVerticalGrid },
      }, verticalGridOptions);
  const threeGrid = workspaceVerticalGrid === undefined
    ? undefined
    : generate("three", {
        schemaOptionValues: { "coordinates.verticalTransform": workspaceVerticalGrid },
      }, verticalGridOptions);
  const terrainAlignmentRecipe = consumerProfile.manifest.origin === "workspace"
    ? generate("cesium", {}, { includeTerrainAlignmentRecipe: true })
    : undefined;
  if (consumerProfile.manifest.origin === "npm") {
    assert.throws(
      () => generate("cesium", {}, { includeTerrainAlignmentRecipe: true }),
      /do not support Terrain alignment/u,
    );
  }
  if (cesiumGrid && threeGrid) {
    assert.match(cesiumGrid.warnings.join(" "), /verified GTX grid/u);
    assert.match(threeGrid.warnings.join(" "), /verified GTX grid/u);
    assert.doesNotMatch(cesiumGrid.code, /verticalTransform|gridId|validated-test-grid/u);
    assert.doesNotMatch(threeGrid.code, /verticalTransform|gridId|validated-test-grid/u);
  }

  assert.match(cesium.code, /layer\.setStyle\(\{ classificationFilter: \{ include: \[2, 6\] \}, colorMode: 'intensity' \}\);/u);
  assert.match(cesium.code, /layer\.setRefinementFocus\(/u);
  assert.match(cesium.code, /function destroyExample\(\): void/u);
  assert.match(three.code, /new CopcThreeLayer\(options\)/u);
  assert.match(three.code, /controls\.removeEventListener\('change', updateLayer\)/u);
  assert.match(three.code, /cancelAnimationFrame\(animationFrame\)/u);
  assert.doesNotMatch(three.code, /layer\.setStyle\(/u);
  if (consumerProfile.manifest.origin === "workspace") {
    assert.match(cesiumMatrix.code, /layer\.setStyle\(\{ classificationFilter: \{ include: \[2, 6\] \}, colorMode: 'dimension', dimension: \{/u);
    assert.match(cesiumMatrix.code, /dimensionFilter: \{ max: 30, min: -20, name: 'scanAngle' \}/u);
  } else {
    assert.match(cesiumMatrix.code, /layer\.setStyle\(\{ classificationFilter: \{ include: \[2, 6\] \}, colorMode: 'intensity' \}\);/u);
  }
  assert.match(cesiumMatrix.code, /layer\.setRefinementFocus\(/u);
  assert.match(cesiumMatrix.code, /heightOffsetMeters: 1\.25/u);
  assert.match(cesiumMatrix.code, /maxConcurrentRangeRequests: 3/u);
  assert.match(threeMatrix.code, /pickingThreshold: 1\.5/u);
  assert.match(threeMatrix.code, /maxConcurrentNodeLoads: 3/u);
  assert.doesNotMatch(threeMatrix.code, /layer\.setStyle\(/u);

  const nodeModules = join(consumerRoot, "node_modules");
  const temporaryDirectory = await mkdtemp(join(nodeModules, ".codegen-consumer-"));
  const cesiumFile = join(temporaryDirectory, "cesium-consumer.ts");
  const threeFile = join(temporaryDirectory, "three-consumer.ts");
  const configFile = join(temporaryDirectory, "tsconfig.json");
  const consumerConfig = join(consumerRoot, "tsconfig.json");
  const compiler = join(nodeModules, "typescript", "bin", "tsc");

  try {
    await Promise.all([
      writeFile(cesiumFile, cesium.code),
      writeFile(threeFile, three.code),
      writeFile(join(temporaryDirectory, "cesium-options-matrix.ts"), cesiumMatrix.code),
      writeFile(join(temporaryDirectory, "three-options-matrix.ts"), threeMatrix.code),
      ...(cesiumGrid && threeGrid
        ? [
            writeFile(join(temporaryDirectory, "cesium-vertical-grid.ts"), cesiumGrid.code),
            writeFile(join(temporaryDirectory, "three-vertical-grid.ts"), threeGrid.code),
          ]
        : []),
      ...(terrainAlignmentRecipe
        ? [writeFile(join(temporaryDirectory, "cesium-terrain-alignment-recipe.ts"), terrainAlignmentRecipe.code)]
        : []),
      writeFile(configFile, JSON.stringify({
        extends: consumerConfig,
        include: [
          join(temporaryDirectory, "*.ts"),
          join(repositoryRoot, "packages", "core", "types", "node-modules.d.ts"),
        ],
      }, null, 2)),
    ]);
    const result = spawnSync(process.execPath, [compiler, "--noEmit", "--project", configFile], {
      cwd: consumerRoot,
      encoding: "utf8",
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

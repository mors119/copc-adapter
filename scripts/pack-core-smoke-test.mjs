import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageDirectory = path.resolve(repositoryDirectory, "packages/adapter");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: options.stdio ?? "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}\n${stderr}`,
          ),
        );
      }
    });
  });
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "copc-adapter-core-packed-consumer-"),
);
const packageOutputDirectory = path.join(temporaryDirectory, "package");
const consumerDirectory = path.join(temporaryDirectory, "consumer");

try {
  await Promise.all([
    mkdir(packageOutputDirectory),
    mkdir(consumerDirectory),
  ]);
  let packagePath;
  let packageSize;
  let packedEntries;
  if (process.argv[2]) {
    packagePath = path.resolve(process.argv[2]);
    if (!existsSync(packagePath)) {
      throw new Error(`Supplied adapter tarball does not exist: ${packagePath}`);
    }
    const archive = await run("tar", ["-tzf", packagePath]);
    packedEntries = new Set(archive.stdout.trim().split("\n").filter(Boolean));
    packageSize = (await stat(packagePath)).size;
    console.log(`Using supplied adapter tarball: ${path.basename(packagePath)}`);
  } else {
    console.log("Building the library package...");
    await run(npmCommand, ["run", "build:library"], {
      cwd: packageDirectory,
      stdio: "inherit",
    });

    const packed = await run(
      npmCommand,
      [
        "pack",
        "--ignore-scripts",
        "--pack-destination",
        packageOutputDirectory,
        "--json",
      ],
      { cwd: packageDirectory },
    );
    const packInfo = JSON.parse(packed.stdout)[0];
    packagePath = path.join(packageOutputDirectory, packInfo.filename);
    packageSize = packInfo.size;
    packedEntries = new Set(
      packInfo.files.map(({ path: file }) => `package/${file}`),
    );
  }

  if (!packedEntries.has("package/dist/core.js")) {
    throw new Error("Packed adapter is missing the Core ESM entrypoint");
  }
  if (!packedEntries.has("package/dist/core.d.ts")) {
    throw new Error("Packed adapter is missing the Core declaration entrypoint");
  }

  await writeFile(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify(
      {
        name: "copc-adapter-core-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc --noEmit --project tsconfig.json",
          "typecheck:bundler": "tsc --noEmit --project tsconfig.bundler.json",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(consumerDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["core-consumer.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(consumerDirectory, "tsconfig.bundler.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["core-consumer.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(consumerDirectory, "core-consumer.ts"),
    `import { createCopcContext, createCopcPointFieldSelection, HierarchyLoader } from "@frillab/copc-adapter/core";
import type { CopcConservativeBoundsResult, CopcConservativeNodeSource, CopcPreparedNodeData, CoordinateTransformPlan } from "@frillab/copc-adapter/core";

const fields = createCopcPointFieldSelection(["position", "rgb"]);
async function consume(file: File): Promise<CopcPreparedNodeData | undefined> {
  const source = await createCopcContext(file);
  const nodeSource: CopcConservativeNodeSource = source;
  const hierarchy = new HierarchyLoader(nodeSource, nodeSource.getMetadata().cube);
  const root = await hierarchy.loadRoot();
  const node = root.nodes[0];
  if (!node) return undefined;
  const conservativeBounds: CopcConservativeBoundsResult = nodeSource.getConservativeNodeEcefBounds(node.key);
  if (conservativeBounds.status === "supported") {
    void conservativeBounds.boundsEcef.coordinateSystem;
    void conservativeBounds.encoderErrorPaddingRequired;
  } else {
    void conservativeBounds.reasonCode;
  }
  const result = await source.loadPreparedNodeData(node, fields);
  const plan: CoordinateTransformPlan = result.transformPlan;
  void plan.identity.key;
  source.close();
  return result;
}
void consume;
`,
  );
  await writeFile(
    path.join(consumerDirectory, "core-consumer.mjs"),
    `import assert from "node:assert/strict";
import * as core from "@frillab/copc-adapter/core";
const resolvedCore = import.meta.resolve("@frillab/copc-adapter/core");
if (!resolvedCore.endsWith("/dist/core.js")) {
  throw new Error("Core package export resolved to an unexpected path: " + resolvedCore);
}
for (const name of ["createCopcContext", "createCopcPointFieldSelection", "HierarchyLoader", "getPreparedEcefBounds"]) {
  if (!(name in core)) throw new Error("Missing Core export: " + name);
}
if (typeof core.CopcContext.prototype.getConservativeNodeEcefBounds !== "function") {
  throw new Error("Missing CopcNodeSource conservative bounds method");
}

const bounds = { minX: -123.5, minY: 44, minZ: 10, maxX: -123, maxY: 44.5, maxZ: 90 };
const metadata = {
  pointCount: 1,
  wkt: 'COMPD_CS["WGS 84 + ellipsoidal height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AXIS["Longitude",EAST],AXIS["Latitude",NORTH],AUTHORITY["EPSG","4326"]],VERT_CS["WGS 84 ellipsoidal height",VERT_DATUM["WGS 84 ellipsoid",2002],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Ellipsoidal height",UP]]]',
  bounds,
  cube: bounds,
  scale: { x: 0.01, y: 0.01, z: 0.01 },
  offset: { x: 0, y: 0, z: 0 },
  crsWktProvenance: { selected: "vlr", available: ["vlr"], conflicting: false },
};
const rootNode = {
  key: "0-0-0-0", level: 0, x: 0, y: 0, z: 0,
  pointCount: 0, pointDataOffset: 0, pointDataLength: 0,
};
const childNode = {
  key: "1-0-0-0", level: 1, x: 0, y: 0, z: 0,
  pointCount: 1, pointDataOffset: 1, pointDataLength: 12,
};
const backend = {
  async open() {
    return {
      source: "memory://packed-conservative-bounds",
      getMetadata: () => metadata,
      getRootHierarchyPage: () => ({ key: "0-0-0-0", pageOffset: 0, pageLength: 1 }),
      async loadHierarchyPage(page) {
        if (page.key === "0-0-0-0") {
          return { nodes: [rootNode], pages: [{ key: "1-0-0-0", pageOffset: 1, pageLength: 1 }] };
        }
        return { nodes: [childNode], pages: [] };
      },
      async loadPointDataView() {
        throw new Error("the consumer fixture uses decoded point buffers");
      },
      async loadPointDataBuffer() {
        return { pointCount: 1, coordinates: new Float64Array([-123.4, 44.1, 40]) };
      },
      destroy() {},
    };
  },
};

const source = await core.createCopcContext("memory://packed-consumer", backend);
try {
  const hierarchy = new core.HierarchyLoader(source, source.getMetadata().cube);
  const tree = await hierarchy.query(
    { bounds: { ...source.getMetadata().cube, coordinateSystem: "copc-source" }, maxLevel: 1 },
    { maxPages: 8 },
  );
  assert.ok(tree.nodes.some((node) => node.level === 1), "consumer traversed beyond the root cell");
  const node = tree.nodes.find((candidate) => candidate.key === "1-0-0-0");
  assert.ok(node, "the selected hierarchy contains the child node");
  const conservative = source.getConservativeNodeEcefBounds(node.key);
  assert.equal(conservative.status, "supported");
  assert.equal(conservative.nodeKey, node.key);
  assert.equal(conservative.sourceIdentity, source.source);
  assert.equal(conservative.sourceGeneration, source.sourceGeneration);
  assert.equal(conservative.transformGeneration, source.transformGeneration);
  assert.equal(conservative.transformPlanIdentity, source.transformPlan.identity.key);

  const prepared = await source.loadPreparedNodeData(
    node,
    core.createCopcPointFieldSelection(["position"]),
  );
  assert.equal(prepared.sourceIdentity, source.source);
  assert.equal(prepared.sourceGeneration, source.sourceGeneration);
  assert.equal(prepared.transformGeneration, source.transformGeneration);
  assert.equal(prepared.transformPlan.identity.key, conservative.transformPlanIdentity);
  const coordinates = prepared.pointData.world.coordinates;
  for (let index = 0; index < coordinates.length; index += 3) {
    assert.ok(coordinates[index] >= conservative.boundsEcef.minX && coordinates[index] <= conservative.boundsEcef.maxX);
    assert.ok(coordinates[index + 1] >= conservative.boundsEcef.minY && coordinates[index + 1] <= conservative.boundsEcef.maxY);
    assert.ok(coordinates[index + 2] >= conservative.boundsEcef.minZ && coordinates[index + 2] <= conservative.boundsEcef.maxZ);
  }
  console.log("packed consumer: node " + node.key + " conservative bounds supported and contain prepared point data");
} finally {
  source.close();
}
`,
  );

  console.log("Installing the tarball in a renderer-free consumer...");
  await run(
    npmCommand,
    ["install", "--no-audit", "--no-fund", packagePath, "typescript@~7.0.2"],
    { cwd: consumerDirectory, stdio: "inherit" },
  );
  for (const renderer of ["cesium", "three"]) {
    if (
      existsSync(path.join(consumerDirectory, "node_modules", renderer))
    ) {
      throw new Error(`Renderer-free consumer unexpectedly installed ${renderer}`);
    }
  }
  const installedPackageDirectory = path.join(
    consumerDirectory,
    "node_modules",
    "@frillab/copc-adapter",
  );
  const coreDeclaration = await readFile(
    path.join(installedPackageDirectory, "dist/core.d.ts"),
    "utf8",
  );
  if (
    !coreDeclaration.includes(
      'from "./core/copc/context/createCopcContext.js"',
    ) ||
    !coreDeclaration.includes('from "./core/copc/range/index.js"')
  ) {
    throw new Error(
      "Packed Core declarations do not use Node ESM-resolvable file specifiers",
    );
  }
  await run(
    process.execPath,
    [
      path.join(packageDirectory, "scripts/fix-declaration-specifiers.mjs"),
      "--check",
      path.join(installedPackageDirectory, "dist"),
    ],
    { cwd: repositoryDirectory, stdio: "inherit" },
  );
  await run(process.execPath, ["core-consumer.mjs"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  await run(npmCommand, ["run", "typecheck"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  await run(npmCommand, ["run", "typecheck:bundler"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  console.log(
    `Renderer-free Core ESM, NodeNext, and Bundler consumers passed (${packageSize} packed bytes).`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageDirectory = path.resolve(repositoryDirectory, "packages");
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
  const packagePath = path.join(packageOutputDirectory, packInfo.filename);
  if (!packInfo.files.some(({ path: file }) => file === "dist/core.js")) {
    throw new Error("Packed adapter is missing the Core ESM entrypoint");
  }
  if (!packInfo.files.some(({ path: file }) => file === "dist/core.d.ts")) {
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
        scripts: { typecheck: "tsc --noEmit" },
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
          skipLibCheck: true,
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
import type { CopcNodeSource, CopcPreparedNodeData, CoordinateTransformPlan } from "@frillab/copc-adapter/core";

const fields = createCopcPointFieldSelection(["position", "rgb"]);
async function consume(file: File): Promise<CopcPreparedNodeData | undefined> {
  const source = await createCopcContext(file);
  const nodeSource: CopcNodeSource = source;
  const hierarchy = new HierarchyLoader(nodeSource, nodeSource.getMetadata().cube);
  const root = await hierarchy.loadRoot();
  const node = root.nodes[0];
  if (!node) return undefined;
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
    `import * as core from "@frillab/copc-adapter/core";
for (const name of ["createCopcContext", "createCopcPointFieldSelection", "HierarchyLoader", "getPreparedEcefBounds"]) {
  if (!(name in core)) throw new Error("Missing Core export: " + name);
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
  await run(process.execPath, ["core-consumer.mjs"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  await run(npmCommand, ["run", "typecheck"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  console.log(
    `Renderer-free Core ESM and TypeScript consumer passed (${packInfo.size} packed bytes).`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

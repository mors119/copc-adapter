import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const adapterDirectory = path.join(repositoryDirectory, "packages/adapter");
const require = createRequire(path.join(adapterDirectory, "package.json"));
const lazPerfEntry = require.resolve("laz-perf");
let lazPerfDirectory = path.dirname(lazPerfEntry);

while (true) {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(lazPerfDirectory, "package.json"), "utf8"),
    );
    if (manifest.name === "laz-perf") break;
  } catch {}

  const parent = path.dirname(lazPerfDirectory);
  if (parent === lazPerfDirectory) {
    throw new Error("Could not locate the installed laz-perf package root.");
  }
  lazPerfDirectory = parent;
}

const source = path.join(lazPerfDirectory, "lib/web/laz-perf.wasm");
const adapterDestination = path.join(
  adapterDirectory,
  "core/wasm/laz-perf.wasm",
);
const destinations = [adapterDestination];
if (process.argv.includes("--viewer")) {
  destinations.push(
    path.join(repositoryDirectory, "apps/dev-viewer/public/laz-perf.wasm"),
  );
}

await Promise.all(
  destinations.map(async (destination) => {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }),
);

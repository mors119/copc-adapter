import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cesium from "vite-plugin-cesium";
import { findUnexpectedAdapterModules } from "./scripts/bundle-provenance.mjs";
import { classifyAdapterSource } from "./scripts/package-provenance.mjs";

export const PLAYGROUND_BASE = "/copc-adapter/playground/";
const appDirectory = path.dirname(fileURLToPath(import.meta.url));

const installedAdapter = JSON.parse(
  readFileSync(
    new URL(
      "./node_modules/@frillab/copc-adapter/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { name?: string; version?: string };
let adapterSource = "Unknown package origin";
try {
  const lock = JSON.parse(
    readFileSync(
      new URL("./node_modules/.package-lock.json", import.meta.url),
      "utf8",
    ),
  ) as {
    packages?: Record<string, { resolved?: string }>;
  };
  const installedEntry =
    lock.packages?.["node_modules/@frillab/copc-adapter"];
  adapterSource = classifyAdapterSource(installedEntry, installedAdapter.version);
} catch {
  // Leave the origin unknown so the public build check can fail closed.
}

function assertAdapterBundleResolution() {
  return {
    name: "assert-installed-adapter-package-resolution",
    apply: "build" as const,
    generateBundle(this: { getModuleIds(): IterableIterator<string> }) {
      const packageRoot = pathForPackage(
        "./node_modules/@frillab/copc-adapter",
      );
      const unexpectedModules = findUnexpectedAdapterModules(
        this.getModuleIds(),
        {
          adapterPackageRoot: packageRoot,
          repositoryPackageRoot: pathForPackage("../../packages"),
          candidateArtifactsRoot: pathForPackage("../../.ci-artifacts"),
        },
      );
      if (unexpectedModules.length > 0) {
        this.error(
          `Playground bundle includes adapter implementation outside the installed npm release: ${unexpectedModules.slice(0, 5).join(", ")}`,
        );
      }

      const packagePrefix = `${packageRoot}/`;
      const adapterModules = [...this.getModuleIds()].filter((moduleId) =>
        moduleId.replaceAll("\\", "/").startsWith(packagePrefix),
      );
      const adapterEntrypoints = new Set(
        adapterModules.map((moduleId) =>
          moduleId.replaceAll("\\", "/").slice(packagePrefix.length),
        ),
      );
      for (const entrypoint of ["dist/cesium.js", "dist/three.js"]) {
        if (!adapterEntrypoints.has(entrypoint)) {
          this.error(
            `Playground bundle did not resolve ${entrypoint} from the installed npm adapter package.`,
          );
        }
      }
      if (adapterSource !== "npm release") {
        this.error(
          `Public Playground build requires an npm release; found ${adapterSource}.`,
        );
      }
    },
  };
}

function pathForPackage(relativePath: string): string {
  return path.resolve(appDirectory, relativePath).replaceAll("\\", "/");
}

export default defineConfig({
  base: PLAYGROUND_BASE,
  plugins: [cesium({ rebuildCesium: true }), assertAdapterBundleResolution()],
  define: {
    __ADAPTER_VERSION__: JSON.stringify(installedAdapter.version ?? "unknown"),
    __ADAPTER_SOURCE__: JSON.stringify(adapterSource),
  },
  build: {
    assetsInlineLimit: 0,
  },
});

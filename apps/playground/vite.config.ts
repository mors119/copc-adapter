import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import cesium from "vite-plugin-cesium";

export const PLAYGROUND_BASE = "/copc-adapter/playground/";

const installedAdapter = JSON.parse(
  readFileSync(
    new URL(
      "./node_modules/@frillab/copc-adapter/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { name?: string; version?: string };
let adapterSource = "Installed package";
try {
  const lock = JSON.parse(
    readFileSync(
      new URL("./node_modules/.package-lock.json", import.meta.url),
      "utf8",
    ),
  ) as {
    packages?: Record<string, { resolved?: string }>;
  };
  const resolved =
    lock.packages?.["node_modules/@frillab/copc-adapter"]?.resolved;
  if (resolved?.startsWith("file:")) adapterSource = "Local package tarball";
  else if (resolved?.includes("registry.npmjs.org"))
    adapterSource = "npm Registry";
} catch {
  // An incomplete install still reports its actual package version above.
}

export default defineConfig({
  base: PLAYGROUND_BASE,
  plugins: [cesium({ rebuildCesium: true })],
  define: {
    __ADAPTER_VERSION__: JSON.stringify(installedAdapter.version ?? "unknown"),
    __ADAPTER_SOURCE__: JSON.stringify(adapterSource),
  },
  build: {
    assetsInlineLimit: 0,
  },
});

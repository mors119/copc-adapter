import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(appDirectory, "../..");
const packageSourceDirectory = path.resolve(repositoryDirectory, "packages");
const isolatedCesiumPackageDirectory = process.env.COPC_TEST_CESIUM_PACKAGE_DIR;
const adapterPackage = JSON.parse(
  fs.readFileSync(path.join(packageSourceDirectory, "package.json"), "utf8"),
) as {
  version?: string;
};

function serveLocalSampleRange(
  request: any,
  response: any,
  next: () => void,
): void {
  if (!request.url?.startsWith("/samples/") || !request.headers.range) {
    next();
    return;
  }

  const filename = path.basename(
    new URL(request.url, "http://localhost").pathname,
  );
  // Keep the downloaded sample outside the app and package output. The
  // public copy still wins for hosts that explicitly stage one there,
  // while local development and CI can use `download-samples` directly.
  const publicFilePath = path.resolve(
    appDirectory,
    "public/samples",
    filename,
  );
  const localFilePath = path.resolve(
    repositoryDirectory,
    "samples/local",
    filename,
  );
  const filePath = fs.existsSync(publicFilePath)
    ? publicFilePath
    : localFilePath;
  if (!fs.existsSync(filePath)) {
    next();
    return;
  }

  const fileSize = fs.statSync(filePath).size;
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
  if (!match) {
    response.statusCode = 416;
    response.end();
    return;
  }

  const start = Number(match[1]);
  const end = Math.min(
    match[2] ? Number(match[2]) : fileSize - 1,
    fileSize - 1,
  );
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end
  ) {
    response.statusCode = 416;
    response.end();
    return;
  }

  response.statusCode = 206;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  response.setHeader("Content-Length", end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(response);
}

function localSampleRangeMiddleware() {
  const useRangeMiddleware = (server: {
    middlewares: { use: (handler: Function) => void };
  }): void => {
    server.middlewares.use(serveLocalSampleRange);
  };

  return {
    name: "local-sample-range-requests",
    configureServer: useRangeMiddleware,
    configurePreviewServer: useRangeMiddleware,
  };
}

export default defineConfig({
  define: {
    __COPC_ADAPTER_VERSION__: JSON.stringify(
      adapterPackage.version ?? "unknown",
    ),
  },
  plugins: [
    localSampleRangeMiddleware(),
    cesium(
      isolatedCesiumPackageDirectory
        ? {
            cesiumBuildRootPath: path.join(
              isolatedCesiumPackageDirectory,
              "Build",
            ),
            cesiumBuildPath: path.join(
              isolatedCesiumPackageDirectory,
              "Build/Cesium",
            ),
          }
        : {},
    ),
  ],
  resolve: {
    alias: [
      ...(isolatedCesiumPackageDirectory
        ? [
            {
              find: /^cesium$/,
              replacement: path.join(
                isolatedCesiumPackageDirectory,
                "Source/Cesium.js",
              ),
            },
          ]
        : []),
      {
        find: /^@frillab\/copc-adapter$/,
        replacement: path.resolve(packageSourceDirectory, "index.ts"),
      },
      {
        find: /^@frillab\/copc-adapter\/cesium$/,
        replacement: path.resolve(packageSourceDirectory, "cesium.ts"),
      },
      {
        find: /^@frillab\/copc-adapter\/three$/,
        replacement: path.resolve(packageSourceDirectory, "three.ts"),
      },
      {
        find: /^laz-perf$/,
        replacement: path.resolve(
          packageSourceDirectory,
          "core/wasm/lazPerf.ts",
        ),
      },
    ],
  },
  server: {
    fs: { allow: [repositoryDirectory] },
  },
});

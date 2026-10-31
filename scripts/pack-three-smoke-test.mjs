import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPackedCandidateInstall } from "./lib/packed-candidate-provenance.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "..");
const packageDirectory = path.resolve(repositoryDirectory, "packages");
const consumerTemplateDirectory = path.resolve(
  repositoryDirectory,
  "tests/environments/three-vite",
);
const packageOutputDirectory = await mkdtemp(
  path.join(os.tmpdir(), "copc-adapter-three-pack-"),
);
const consumerDirectory = await mkdtemp(
  path.join(os.tmpdir(), "copc-adapter-three-consumer-"),
);
let consumerHttpServer;
let consumerBrowser;

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, ...options.env },
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})\n${stderr}`,
        ),
      );
    });
  });
}

function assertIncluded(entries, entry) {
  if (!entries.has(entry)) {
    throw new Error(`Packed adapter is missing ${entry}`);
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

try {
  let packagePath;
  if (process.argv[2]) {
    packagePath = path.resolve(process.argv[2]);
    if (!existsSync(packagePath)) {
      throw new Error(
        `Supplied adapter tarball does not exist: ${packagePath}`,
      );
    }
    console.log(
      `Using supplied adapter tarball: ${path.basename(packagePath)}`,
    );
  } else {
    console.log("Building the library package with the Three entrypoint...");
    await run(npmCommand(), ["run", "build:library"], {
      cwd: packageDirectory,
      stdio: "inherit",
    });

    console.log("Packing the Three-enabled library artifact...");
    await run(
      npmCommand(),
      [
        "pack",
        "--ignore-scripts",
        "--pack-destination",
        packageOutputDirectory,
      ],
      { cwd: packageDirectory },
    );
    const packedFilenames = (await readdir(packageOutputDirectory)).filter(
      (entry) => entry.endsWith(".tgz"),
    );
    if (packedFilenames.length !== 1) {
      throw new Error(
        `Expected npm pack to produce one adapter tarball, found ${packedFilenames.length}`,
      );
    }
    packagePath = path.resolve(packageOutputDirectory, packedFilenames[0]);
  }

  const tarResult = await run("tar", ["-tzf", packagePath]);
  const entries = new Set(tarResult.stdout.trim().split("\n").filter(Boolean));
  for (const requiredEntry of [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/cesium.js",
    "package/dist/cesium.d.ts",
    "package/dist/three.js",
    "package/dist/three.d.ts",
    "package/dist/copc_adapter_wasm.wasm",
    "package/dist/laz-perf.wasm",
    "package/dist/copcAdapterWasmAsset.js",
    "package/dist/lazPerfAsset.js",
    "package/dist/rustCopcWorkerFactory.js",
  ]) {
    assertIncluded(entries, requiredEntry);
  }
  if ([...entries].some((entry) => entry.startsWith("package/dist/assets/"))) {
    throw new Error(
      "Packed adapter contains an external Rust decode worker chunk",
    );
  }
  if ([...entries].some((entry) => /\.copc\.laz$/iu.test(entry))) {
    throw new Error("Packed adapter contains a COPC sample dataset");
  }

  await cp(consumerTemplateDirectory, consumerDirectory, { recursive: true });
  console.log("Installing the packed artifact in a clean Three.js consumer...");
  await run(npmCommand(), ["install", "--no-audit", "--no-fund"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  await run(
    npmCommand(),
    ["install", "--no-save", "--no-audit", "--no-fund", packagePath],
    { cwd: consumerDirectory, stdio: "inherit" },
  );

  const installedPackageDirectory = path.resolve(
    consumerDirectory,
    "node_modules/@frillab/copc-adapter",
  );
  const installedPackage = JSON.parse(
    await readFile(
      path.resolve(installedPackageDirectory, "package.json"),
      "utf8",
    ),
  );
  const candidateManifest = JSON.parse(
    (
      await run("tar", ["-xOzf", packagePath, "package/package.json"])
    ).stdout,
  );
  const installedLock = JSON.parse(
    await readFile(
      path.resolve(consumerDirectory, "node_modules/.package-lock.json"),
      "utf8",
    ),
  );
  console.log(
    `${assertPackedCandidateInstall({
      candidatePath: packagePath,
      candidateManifest,
      installedManifest: installedPackage,
      installedLock,
    })} verified in the isolated Three.js consumer.`,
  );
  if (!installedPackage.exports?.["."]) {
    throw new Error("Clean consumer package is missing the root export");
  }
  if (!installedPackage.exports?.["./cesium"]) {
    throw new Error("Clean consumer package is missing the ./cesium export");
  }
  if (!installedPackage.exports?.["./three"]) {
    throw new Error("Clean consumer package is missing the ./three export");
  }
  if (!installedPackage.peerDependenciesMeta?.cesium?.optional) {
    throw new Error(
      "Cesium peer must be optional for the subpath package boundary",
    );
  }
  if (!installedPackage.peerDependenciesMeta?.three?.optional) {
    throw new Error(
      "Three.js peer must be optional at the combined package boundary",
    );
  }
  if (existsSync(path.resolve(consumerDirectory, "node_modules/cesium"))) {
    throw new Error("Three-only consumer unexpectedly installed Cesium");
  }

  const samplePath = path.resolve(
    repositoryDirectory,
    "samples/local/autzen.copc.laz",
  );
  const sampleInfo = await stat(samplePath).catch(() => undefined);
  if (!sampleInfo || sampleInfo.size !== 81_123_042) {
    throw new Error(
      "Packed Three browser validation requires the verified Autzen fixture; run npm run setup first.",
    );
  }
  const publicSamplePath = path.resolve(
    consumerDirectory,
    "public/samples/autzen.copc.laz",
  );
  await mkdir(path.dirname(publicSamplePath), { recursive: true });
  await cp(samplePath, publicSamplePath);

  console.log("Building the clean Three.js/Vite consumer...");
  await run(npmCommand(), ["run", "build"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  console.log("Typechecking the packed Three.js consumer API examples...");
  await run(npmCommand(), ["run", "typecheck"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  console.log("Checking the packed Three declarations with strict NodeNext...");
  await run(npmCommand(), ["run", "typecheck:nodenext"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const resolved = import.meta.resolve("@frillab/copc-adapter/three");
if (!resolved.endsWith("/dist/three.js")) {
  throw new Error("Three package export resolved to an unexpected path: " + resolved);
}`,
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  );
  const consumerAssetEntries = await readdir(
    path.resolve(consumerDirectory, "dist/assets"),
  );
  if (
    !consumerAssetEntries.some(
      (entry) =>
        entry.startsWith("copc_adapter_wasm-") && entry.endsWith(".wasm"),
    )
  ) {
    throw new Error(
      "Three consumer production build did not emit the Rust WASM asset",
    );
  }
  if (
    !consumerAssetEntries.some(
      (entry) => entry.startsWith("laz-perf-") && entry.endsWith(".wasm"),
    )
  ) {
    throw new Error(
      "Three consumer production build did not emit the LAZ runtime asset",
    );
  }

  const consumerJavaScript = await Promise.all(
    (await listFiles(path.resolve(consumerDirectory, "dist")))
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(file, "utf8")),
  );
  if (consumerJavaScript.some((source) => /cesium/iu.test(source))) {
    throw new Error("Three consumer bundle contains a Cesium module reference");
  }

  console.log("Running the packed Three consumer in headless Chromium...");
  const distDirectory = path.resolve(consumerDirectory, "dist");
  const sampleRequestSummary = {
    requests: 0,
    rangedRequests: 0,
    unrangedGetRequests: 0,
    requestedBytes: 0,
    statuses: {},
  };
  consumerHttpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/samples/autzen.copc.laz") {
        sampleRequestSummary.requests += 1;
        const range = request.headers.range;
        if (request.method === "GET" && typeof range !== "string") {
          sampleRequestSummary.unrangedGetRequests += 1;
          response.writeHead(416, { "Accept-Ranges": "bytes" }).end();
          return;
        }
        if (typeof range === "string") {
          const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
          if (!match) {
            response.writeHead(416, { "Accept-Ranges": "bytes" }).end();
            return;
          }
          const fileSize = sampleInfo.size;
          const start = Number(match[1]);
          const end = match[2]
            ? Math.min(Number(match[2]), fileSize - 1)
            : fileSize - 1;
          if (start >= fileSize || end < start) {
            response
              .writeHead(416, {
                "Accept-Ranges": "bytes",
                "Content-Range": "bytes */" + fileSize,
              })
              .end();
            return;
          }
          const length = end - start + 1;
          sampleRequestSummary.rangedRequests += 1;
          sampleRequestSummary.requestedBytes += length;
          sampleRequestSummary.statuses[206] =
            (sampleRequestSummary.statuses[206] ?? 0) + 1;
          response.writeHead(206, {
            "Accept-Ranges": "bytes",
            "Content-Length": length,
            "Content-Range": "bytes " + start + "-" + end + "/" + fileSize,
            "Content-Type": "application/octet-stream",
          });
          createReadStream(publicSamplePath, { start, end }).pipe(response);
          return;
        }
        response.writeHead(200, {
          "Accept-Ranges": "bytes",
          "Content-Length": sampleInfo.size,
          "Content-Type": "application/octet-stream",
        });
        response.end();
        return;
      }

      const pathname = decodeURIComponent(url.pathname);
      const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
      const filePath = path.resolve(distDirectory, relativePath);
      if (
        filePath !== distDirectory &&
        !filePath.startsWith(distDirectory + path.sep)
      ) {
        response.writeHead(403).end();
        return;
      }
      const fileInfo = await stat(filePath).catch(() => undefined);
      if (!fileInfo?.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const extension = path.extname(filePath).toLowerCase();
      const contentType =
        extension === ".html"
          ? "text/html; charset=utf-8"
          : extension === ".js" || extension === ".mjs"
            ? "text/javascript; charset=utf-8"
            : extension === ".css"
              ? "text/css; charset=utf-8"
              : extension === ".wasm"
                ? "application/wasm"
                : extension === ".svg"
                  ? "image/svg+xml"
                  : "application/octet-stream";
      response.writeHead(200, {
        "Content-Length": fileInfo.size,
        "Content-Type": contentType,
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500).end();
      console.error(
        "Packed Three test server failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
  await new Promise((resolve, reject) => {
    consumerHttpServer.once("error", reject);
    consumerHttpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = consumerHttpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Packed Three test server did not expose a TCP port");
  }
  const playwrightModule = pathToFileURL(
    path.resolve(
      repositoryDirectory,
      "apps/dev-viewer/node_modules/playwright/index.mjs",
    ),
  ).href;
  const { chromium } = await import(playwrightModule);
  consumerBrowser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=swiftshader"],
  });
  const page = await consumerBrowser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("http://127.0.0.1:" + address.port + "/", {
    waitUntil: "load",
  });
  await page.evaluate(() => window.__PACKED_THREE_CONSUMER__?.start());
  await page.waitForFunction(
    () => {
      const consumer = window.__PACKED_THREE_CONSUMER__;
      if (!consumer) return false;
      const snapshot = consumer.getState().snapshot;
      const worker = snapshot.worker;
      return (
        snapshot.renderedPointCount > 0 &&
        snapshot.selectedNodeKeys.every((key) =>
          snapshot.renderedNodeKeys.includes(key),
        ) &&
        (!worker || (worker.activeCount === 0 && worker.queuedCount === 0))
      );
    },
    undefined,
    { timeout: 180_000 },
  );
  const browserState = await page.evaluate(() =>
    window.__PACKED_THREE_CONSUMER__?.getState(),
  );
  if (
    !browserState ||
    browserState.snapshot.backend !== "rust" ||
    browserState.snapshot.renderedPointCount > 250_000 ||
    browserState.pointObjectCount === 0 ||
    browserState.positionBufferBytes === 0 ||
    browserState.errors.length > 0
  ) {
    throw new Error(
      "Packed Three consumer did not render bounded points cleanly: " +
        JSON.stringify(browserState),
    );
  }
  const picked = await page.evaluate(() =>
    window.__PACKED_THREE_CONSUMER__?.pickVisiblePoint(),
  );
  if (
    !picked ||
    !Number.isSafeInteger(picked.inspection.pointIndex) ||
    typeof picked.inspection.nodeKey !== "string" ||
    !Number.isFinite(picked.inspection.longitude) ||
    !Number.isFinite(picked.inspection.latitude) ||
    !Number.isFinite(picked.inspection.height) ||
    picked.inspection.source !== undefined ||
    picked.inspection.world?.coordinateSystem !== "wgs84-ecef-meters"
  ) {
    throw new Error(
      "Packed Three consumer did not resolve a compact-E browser pick: " +
        JSON.stringify(picked),
    );
  }
  const destroyed = await page.evaluate(() =>
    window.__PACKED_THREE_CONSUMER__?.destroyLayer(),
  );
  if (
    !destroyed ||
    destroyed.snapshot.lifecycle !== "destroyed" ||
    destroyed.snapshot.renderedPointCount !== 0 ||
    destroyed.sceneChildCount !== 1 ||
    !destroyed.applicationObjectPreserved ||
    destroyed.applicationMaterialDisposed ||
    !destroyed.rendererCanvasConnected ||
    destroyed.rendererContextLost ||
    destroyed.errors.length > 0 ||
    pageErrors.length > 0 ||
    sampleRequestSummary.rangedRequests === 0 ||
    sampleRequestSummary.unrangedGetRequests > 0
  ) {
    throw new Error(
      "Packed Three consumer browser lifecycle validation failed: " +
        JSON.stringify({
          destroyed,
          pageErrors,
          sampleRequestSummary,
        }),
    );
  }
  console.log(
    JSON.stringify(
      {
        conclusion:
          "PASS: packed Rust/E Three consumer rendered, picked, and destroyed in Chromium",
        package: installedPackage.version,
        backend: browserState.snapshot.backend,
        threeVersion: await page.evaluate(
          () => window.__PACKED_THREE_CONSUMER__?.threeVersion,
        ),
        renderedPointCount: browserState.snapshot.renderedPointCount,
        renderedNodeCount: browserState.snapshot.renderedNodeKeys.length,
        positionBufferBytes: browserState.positionBufferBytes,
        picked: {
          nodeKey: picked.inspection.nodeKey,
          pointIndex: picked.inspection.pointIndex,
          finiteHeight: Number.isFinite(picked.inspection.height),
          sourceCoordinatesOmittedForE: picked.inspection.source === undefined,
        },
        afterDestroy: {
          lifecycle: destroyed.snapshot.lifecycle,
          renderedPointCount: destroyed.snapshot.renderedPointCount,
          applicationObjectPreserved: destroyed.applicationObjectPreserved,
          applicationMaterialDisposed: destroyed.applicationMaterialDisposed,
          rendererCanvasConnected: destroyed.rendererCanvasConnected,
          rendererContextLost: destroyed.rendererContextLost,
        },
        sourceRequests: sampleRequestSummary,
        browser: consumerBrowser.version(),
        webgl: await page.evaluate(() => {
          const context = document.querySelector("canvas")?.getContext("webgl2");
          const debug = context?.getExtension("WEBGL_debug_renderer_info");
          return context && debug
            ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            : "unavailable";
        }),
      },
      null,
      2,
    ),
  );
  await page.close();
  await consumerBrowser.close();
  consumerBrowser = undefined;
  await new Promise((resolve) => consumerHttpServer.close(resolve));
  consumerHttpServer = undefined;
  console.log(
    `Packed Three consumer validation passed: ${path.basename(packagePath)}`,
  );
} finally {
  if (consumerBrowser) await consumerBrowser.close();
  if (consumerHttpServer) {
    await new Promise((resolve) => consumerHttpServer.close(resolve));
  }
  await rm(packageOutputDirectory, { recursive: true, force: true });
  await rm(consumerDirectory, { recursive: true, force: true });
}

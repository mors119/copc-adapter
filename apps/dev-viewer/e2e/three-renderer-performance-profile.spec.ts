import { expect, test } from "./ci-diagnostic-fixtures";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type {
  ThreeLifecycleFixture,
  ThreeLifecycleState,
} from "./fixtures/three-lifecycle-fixture";

const POINT_BUDGET = 250_000;
const CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const SOURCE = "/samples/autzen.copc.laz";
const CAMERA_PATH = [
  { label: "near", position: [0, -350, 133] },
  { label: "far", position: [0, -5_000, 1_900] },
  { label: "oblique-east", position: [1_100, -900, 342] },
  { label: "reverse-west", position: [-1_100, -900, 342] },
  { label: "near-return", position: [0, -350, 133] },
] as const;
const BACKEND_ORDER = ["rust", "copc-js", "copc-js", "rust"] as const;

type ProfileMetrics = {
  frames: number[];
  lastFrame?: number;
  uploads: Array<{ method: string; bytes: number; durationMs: number }>;
  longTasks: Array<{ durationMs: number; startTime: number }>;
};

declare global {
  interface Window {
    __COPC_THREE_PROFILE_METRICS__?: ProfileMetrics;
    __COPC_THREE_LIFECYCLE__?: ThreeLifecycleFixture;
  }
}

function summarize(values: number[]): {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ??
    0;
  return {
    count: values.length,
    min: sorted[0] ?? 0,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) ?? 0,
  };
}

async function getState(
  page: import("@playwright/test").Page,
): Promise<ThreeLifecycleState> {
  return page.evaluate(() => {
    if (!window.__COPC_THREE_LIFECYCLE__) {
      throw new Error("Three.js lifecycle fixture is unavailable");
    }
    return window.__COPC_THREE_LIFECYCLE__.getState();
  });
}

async function waitForUsefulPoints(
  page: import("@playwright/test").Page,
  startedAt: number,
): Promise<number> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await getState(page);
    if (
      current.snapshot.renderedPointCount > 0 &&
      current.snapshot.selectedNodeKeys.some((key) =>
        current.snapshot.renderedNodeKeys.includes(key),
      )
    ) {
      return page.evaluate((start) => performance.now() - start, startedAt);
    }
    if (current.errors.length > 0) {
      throw new Error(`Three.js load failed: ${current.errors.join("; ")}`);
    }
    await page.waitForTimeout(100);
  }
  throw new Error("Timed out waiting for useful Three.js points");
}

async function waitForIdle(
  page: import("@playwright/test").Page,
): Promise<ThreeLifecycleState> {
  const deadline = Date.now() + 120_000;
  let stableSamples = 0;
  let previous = await getState(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const current = await getState(page);
    const workersIdle =
      !current.snapshot.worker ||
      (current.snapshot.worker.activeCount === 0 &&
        current.snapshot.worker.queuedCount === 0);
    const selectionRendered = current.snapshot.selectedNodeKeys.every((key) =>
      current.snapshot.renderedNodeKeys.includes(key),
    );
    if (current.errors.length > 0) {
      throw new Error(`Three.js load failed: ${current.errors.join("; ")}`);
    }
    if (
      workersIdle &&
      selectionRendered &&
      current.snapshot.transition.activeReplacementGroupCount === 0 &&
      current.snapshot.streamingUpdateCount ===
        previous.snapshot.streamingUpdateCount
    ) {
      stableSamples += 1;
      if (stableSamples >= 3) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }
  throw new Error("Three.js camera view did not settle");
}

test("records a matched browser profile for the Three.js COPC renderer", async ({
  page,
  context,
  browser,
}, testInfo) => {
  test.skip(
    process.env.COPC_RUN_THREE_PROFILE !== "1",
    "Opt-in matched Three.js renderer profile; run npm run benchmark:three-renderer --prefix apps/dev-viewer",
  );
  test.setTimeout(30 * 60_000);

  await context.addInitScript(() => {
    const metrics: ProfileMetrics = {
      frames: [],
      uploads: [],
      longTasks: [],
    };
    window.__COPC_THREE_PROFILE_METRICS__ = metrics;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      nativeRequestAnimationFrame((timestamp) => {
        if (metrics.lastFrame !== undefined) {
          metrics.frames.push(timestamp - metrics.lastFrame);
        }
        metrics.lastFrame = timestamp;
        callback(timestamp);
      });

    const bufferByteLength = (value: unknown): number => {
      if (typeof value === "number") return value;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof ArrayBuffer) return value.byteLength;
      return 0;
    };
    for (const contextType of [
      window.WebGLRenderingContext,
      window.WebGL2RenderingContext,
    ]) {
      if (!contextType) continue;
      const prototype = contextType.prototype as unknown as Record<
        string,
        ((...args: unknown[]) => unknown) | undefined
      >;
      for (const method of ["bufferData", "bufferSubData"]) {
        const original = prototype[method];
        if (!original) continue;
        prototype[method] = function (...args: unknown[]) {
          const startedAt = performance.now();
          const result = Reflect.apply(original, this, args);
          metrics.uploads.push({
            method,
            bytes: bufferByteLength(args[1]),
            durationMs: performance.now() - startedAt,
          });
          return result;
        };
      }
    }

    if (typeof PerformanceObserver !== "undefined") {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            metrics.longTasks.push({
              durationMs: entry.duration,
              startTime: entry.startTime,
            });
          }
        }).observe({ type: "longtask", buffered: true });
      } catch {
        // Long Task observation is optional in browser configurations that do
        // not expose the entry type.
      }
    }
  });

  const repositoryDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
  }).trim();
  const npmVersion = execFileSync("npm", ["--version"], {
    encoding: "utf8",
  }).trim();
  const runs: Array<Record<string, unknown>> = [];

  for (const [runIndex, backend] of BACKEND_ORDER.entries()) {
    const runPage = runIndex === 0 ? page : await context.newPage();
    const cdp = await context.newCDPSession(runPage);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

    const ranges: Array<{
      range: string;
      bytes: number;
      status?: number;
      contentRange?: string;
    }> = [];
    const rangeByRequest = new Map<
      import("@playwright/test").Request,
      (typeof ranges)[number]
    >();
    runPage.on("request", (request) => {
      if (!new URL(request.url()).pathname.endsWith(".copc.laz")) return;
      const range = request.headers().range ?? "";
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      const observation = {
        range,
        bytes: match ? Number(match[2]) - Number(match[1]) + 1 : 0,
      };
      ranges.push(observation);
      rangeByRequest.set(request, observation);
    });
    runPage.on("response", (response) => {
      const observation = rangeByRequest.get(response.request());
      if (!observation) return;
      observation.status = response.status();
      observation.contentRange = response.headers()["content-range"];
    });

    await runPage.goto(
      `/e2e/fixtures/three-lifecycle-fixture.html?source=${encodeURIComponent(SOURCE)}&backend=${backend}`,
    );
    await runPage.evaluate(() =>
      window.__COPC_THREE_LIFECYCLE__!.createLayer(),
    );
    const metadataLoadStartedAt = await runPage.evaluate(() =>
      performance.now(),
    );
    await runPage.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.load());
    const metadataLoadMs = await runPage.evaluate(
      (startedAt) => performance.now() - startedAt,
      metadataLoadStartedAt,
    );
    await runPage.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.attach());

    const poses: Array<Record<string, unknown>> = [];
    for (const pose of CAMERA_PATH) {
      const before = await getState(runPage);
      const marks = await runPage.evaluate(() => ({
        frameIndex: window.__COPC_THREE_PROFILE_METRICS__!.frames.length,
        uploadIndex: window.__COPC_THREE_PROFILE_METRICS__!.uploads.length,
        longTaskIndex: window.__COPC_THREE_PROFILE_METRICS__!.longTasks.length,
      }));
      const rangeIndex = ranges.length;
      const [x, y, z] = pose.position;
      await runPage.evaluate(
        (position) =>
          window.__COPC_THREE_LIFECYCLE__!.setCameraPosition({
            x: position[0],
            y: position[1],
            z: position[2],
          }),
        [x, y, z],
      );
      const updateStartedAt = await runPage.evaluate(() => performance.now());
      await runPage.evaluate(() => {
        void window.__COPC_THREE_LIFECYCLE__!.update();
      });
      const timeToFirstPointsMs = await waitForUsefulPoints(
        runPage,
        updateStartedAt,
      );
      const settled = await waitForIdle(runPage);
      const captured = await runPage.evaluate((indexes) => {
        const metrics = window.__COPC_THREE_PROFILE_METRICS__!;
        return {
          frames: metrics.frames.slice(indexes.frameIndex),
          uploads: metrics.uploads.slice(indexes.uploadIndex),
          longTasks: metrics.longTasks.slice(indexes.longTaskIndex),
        };
      }, marks);
      const stageDelta = Object.fromEntries(
        Object.keys(settled.snapshot.renderer).map((key) => [
          key,
          settled.snapshot.renderer[
            key as keyof typeof settled.snapshot.renderer
          ] -
            before.snapshot.renderer[
              key as keyof typeof before.snapshot.renderer
            ],
        ]),
      );
      const poseRanges = ranges.slice(rangeIndex);
      poses.push({
        label: pose.label,
        cameraPosition: pose.position,
        timeToFirstPointsMs,
        timeToSettledMs: await runPage.evaluate(
          (startedAt) => performance.now() - startedAt,
          updateStartedAt,
        ),
        selectedNodes: settled.snapshot.selectedNodeKeys.length,
        renderedNodes: settled.snapshot.renderedNodeKeys.length,
        renderedPoints: settled.snapshot.renderedPointCount,
        pointCacheBytes: settled.snapshot.pointCache.currentCacheBytes,
        worker: settled.snapshot.worker,
        rendererStageDeltaMs: stageDelta,
        rendererInfo: settled.rendererInfo,
        pointObjectCount: settled.pointObjectCount,
        uniqueMaterialCount: settled.uniqueMaterialCount,
        positionBufferBytes: settled.positionBufferBytes,
        colorBufferBytes: settled.colorBufferBytes,
        frameIntervalMs: summarize(captured.frames),
        webglBufferCalls: captured.uploads.length,
        webglBufferBytesSubmitted: captured.uploads.reduce(
          (sum, upload) => sum + upload.bytes,
          0,
        ),
        webglBufferCallDurationMs: summarize(
          captured.uploads.map((upload) => upload.durationMs),
        ),
        longTasks: {
          count: captured.longTasks.length,
          totalDurationMs: captured.longTasks.reduce(
            (sum, entry) => sum + entry.durationMs,
            0,
          ),
          maxDurationMs: Math.max(
            0,
            ...captured.longTasks.map((entry) => entry.durationMs),
          ),
        },
        rangeRequests: poseRanges.length,
        rangeBytesRequested: poseRanges.reduce(
          (sum, request) => sum + request.bytes,
          0,
        ),
      });
    }

    const finalState = await getState(runPage);
    const environment = await runPage.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const gl =
        canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
      if (!gl) return { webgl: { available: false } };
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      const webgl = {
        available: true,
        version: gl.getParameter(gl.VERSION),
        vendor: gl.getParameter(
          debugInfo?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR,
        ),
        renderer: gl.getParameter(
          debugInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER,
        ),
        disjointTimerQueryAvailable: Boolean(
          gl.getExtension("EXT_disjoint_timer_query_webgl2"),
        ),
      };
      return {
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        hardwareConcurrency: navigator.hardwareConcurrency,
        webgl,
      };
    });
    const runtimeMetrics = await runPage.evaluate(() => {
      const metrics = window.__COPC_THREE_PROFILE_METRICS__!;
      return {
        frameCount: metrics.frames.length,
        uploads: metrics.uploads,
        longTasks: metrics.longTasks,
      };
    });
    const sourceBytes = Math.max(
      0,
      ...ranges.map((request) => {
        const match = /^bytes \d+-\d+\/(\d+)$/.exec(
          request.contentRange ?? "",
        );
        return match ? Number(match[1]) : 0;
      }),
    );
    const statusCounts = ranges.reduce<Record<string, number>>(
      (counts, request) => {
        const status = String(request.status ?? "no-response");
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      },
      {},
    );

    runs.push({
      runIndex,
      backend,
      metadataLoadMs,
      environment: {
        ...environment,
        three: await runPage.evaluate(
          () => window.__COPC_THREE_LIFECYCLE__!.threeVersion,
        ),
      },
      source: {
        url: SOURCE,
        localSameOrigin: true,
        sourceBytes,
        pointBudget: POINT_BUDGET,
        decodedCacheBudgetBytes: CACHE_BUDGET_BYTES,
        maxConcurrentRangeRequests: 4,
        maxConcurrentNodeLoads:
          finalState.snapshot.performance.maxConcurrentNodeLoads,
        browserHttpCacheDisabled: true,
        requests: ranges.length,
        statusCounts,
        rangeBytesRequested: ranges.reduce(
          (sum, request) => sum + request.bytes,
          0,
        ),
      },
      poses,
      final: {
        renderedPoints: finalState.snapshot.renderedPointCount,
        renderedNodeCount: finalState.snapshot.renderedNodeKeys.length,
        pointCache: finalState.snapshot.pointCache,
        rendererInfo: finalState.rendererInfo,
        pointObjectCount: finalState.pointObjectCount,
        uniqueMaterialCount: finalState.uniqueMaterialCount,
        positionBufferBytes: finalState.positionBufferBytes,
        colorBufferBytes: finalState.colorBufferBytes,
        errors: finalState.errors,
      },
      totals: {
        frameCallbacks: runtimeMetrics.frameCount,
        webglBufferCalls: runtimeMetrics.uploads.length,
        webglBufferBytesSubmitted: runtimeMetrics.uploads.reduce(
          (sum, upload) => sum + upload.bytes,
          0,
        ),
        longTaskCount: runtimeMetrics.longTasks.length,
        longestLongTaskMs: Math.max(
          0,
          ...runtimeMetrics.longTasks.map((entry) => entry.durationMs),
        ),
      },
    });

    expect(statusCounts).not.toHaveProperty("no-response");
    expect(Object.keys(statusCounts).every((status) => status === "206")).toBe(
      true,
    );
    expect(finalState.snapshot.backend).toBe(backend);
    expect(finalState.snapshot.renderedPointCount).toBeGreaterThan(0);
    expect(finalState.snapshot.renderedPointCount).toBeLessThanOrEqual(
      POINT_BUDGET,
    );
    expect(finalState.errors).toEqual([]);
    await runPage.evaluate(() =>
      window.__COPC_THREE_LIFECYCLE__!.disposeViewer(),
    );
    if (runPage !== page) await runPage.close();
  }

  const summary = {
    measuredAt: new Date().toISOString(),
    gitSha,
    runtime: {
      node: process.version,
      npm: npmVersion,
      platform: process.platform,
      architecture: process.arch,
      os: os.release(),
      cpuModel: os.cpus()[0]?.model,
      browser: browser.version(),
    },
    backendOrder: BACKEND_ORDER,
    cameraPath: CAMERA_PATH,
    methodology: {
      repetitionsPerBackend: 2,
      order: "Rust / copc-js / copc-js / Rust",
      timing: "performance.now(), with three 250 ms idle samples before settled-view time is recorded",
      frameTiming: "requestAnimationFrame callback intervals during each camera update",
      uploadTiming: "CPU duration and bytes of WebGL bufferData/bufferSubData calls; GPU transfer completion is not measured by this profile",
      gpuMemory: "Not directly measured; renderer.info and live typed-array byte lengths are reported",
      inputResponsiveness: "Not measured; this fixture applies scripted camera poses without UI controls",
      mode: process.env.COPC_BENCHMARK_HARDWARE === "1" ? "hardware requested; verify WebGL renderer string" : "Playwright default SwiftShader mode; verify WebGL renderer string",
    },
    budgets: {
      pointBudget: POINT_BUDGET,
      decodedCacheBudgetBytes: CACHE_BUDGET_BYTES,
      maxConcurrentRangeRequests: 4,
      nodeLimits: { maxNodes: 32, maxDepth: 6 },
      maxScreenSpaceError: 8,
      maxRenderDistanceMeters: 20_000,
    },
    runs,
    playwrightTest: testInfo.title,
  };
  const outputPath = path.resolve(
    process.env.COPC_THREE_PROFILE_OUTPUT ??
      path.join(
        os.tmpdir(),
        "copc-adapter-validation",
        "three-renderer-profile.json",
      ),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        conclusion: "Baseline only; no renderer optimization has been adopted.",
        gitSha,
        runtime: summary.runtime,
        backendOrder: BACKEND_ORDER,
        pointCountsByPose: runs[0].poses.map((pose) => ({
          label: pose.label,
          renderedPoints: pose.renderedPoints,
        })),
        outputPath,
      },
      null,
      2,
    ),
  );
});

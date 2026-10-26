import { expect, test } from "./ci-diagnostic-fixtures";
import type { Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { performance as nodePerformance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

type Point = {
  nodeKey: string;
  pointIndex: number;
  longitude: number;
  latitude: number;
  height: number;
  source?: { x: number; y: number; z: number };
  world?: { x: number; y: number; z: number };
  backend: string;
};

type GridWorkerTracker = {
  snapshot(): {
    created: number;
    terminated: number;
    active: number;
    readyDurationsMs: number[];
  };
};

type VerticalGridIntegration = {
  createGrid(
    metres: number,
    outsideCoverage?: boolean,
    sourceVerticalCrs?: string,
    shape?: { width: number; height: number },
  ): Promise<string>;
  getGridInfo(id: string): {
    width: number;
    height: number;
    encodedByteLength: number;
    decodedByteLength: number;
    loadDurationMs: number;
  };
  releaseGrid(id: string): void;
  createLayer(options: {
    id: string;
    source: string;
    backend?: "copc-js" | "rust";
    gridId?: string;
    heightOffsetMeters?: number;
    workers?: boolean;
  }): Promise<{ error?: string; code?: string }>;
  getState(id: string): {
    snapshot: {
      lifecycle: string;
      backend: string;
      renderedPointCount: number;
      renderedNodeKeys: string[];
      selectedNodeKeys: string[];
      streamingUpdateCount: number;
      pointCache: { hits: number; misses: number; currentCacheBytes: number };
      rangeRequests: { requested: number; completed: number; failed: number; active: number };
      worker?: {
        workerCount: number;
        activeCount: number;
        queuedCount: number;
        completedCount: number;
        cancelledCount: number;
        peakQueuedCount: number;
      };
      transition: { activeReplacementGroupCount: number };
      performance?: {
        candidatesBeforeCulling: number;
        frustumCulledCount: number;
        loadedNodeCount?: number;
        loadedPointCount?: number;
        pointPreparationDurationMs?: number;
        crsTransformDurationMs?: number;
        rendererPreparationDurationMs?: number;
        updateDurationMs?: number;
        longestMainThreadBlockingSectionMs?: number;
      };
    };
    camera: {
      longitude: number;
      latitude: number;
      height: number;
      pitch: number;
      heading: number;
      position: { x: number; y: number; z: number };
      direction: { x: number; y: number; z: number };
    };
    cameraEvents: {
      changedCount: number;
      moveEndCount: number;
      postRenderFrameCount: number;
      lastChangedAtMs?: number;
      lastMoveEndAtMs?: number;
    };
    selectedPoint?: Point;
    boundingSphere?: { x: number; y: number; z: number; radius: number };
    errors: string[];
    ownerIds: string[];
    timings?: { firstVisibleMs?: number; elapsedMs: number };
  };
  getScreenPoint(id: string): { x: number; y: number } | undefined;
  setRefinementFocus(id: string, enabled: boolean): void;
  getLastCanvasClick(): { clientX: number; clientY: number; offsetX: number; offsetY: number } | undefined;
  setShow(id: string, show: boolean): void;
  zoomTo(id: string): Promise<boolean>;
  setCamera(
    longitude: number,
    latitude: number,
    altitude: number,
    pitchRadians?: number,
  ): void;
  reload(id: string): Promise<void>;
  destroyLayer(id: string): void;
  missingGridError(): Promise<string | undefined>;
  cancelWorkerQueue(source: string): Promise<{
    supported: boolean;
    workerCount?: number;
    submittedCount?: number;
    cancelledCount?: number;
    peakQueuedCount?: number;
  }>;
  compareBackends(
    source: string,
    gridId: string,
    workers?: boolean,
  ): Promise<{
    pointCount: number;
    comparedPoints: number;
    maxHeightDifferenceMeters: number;
    maxEcefDifferenceMeters: number;
    sourceCoordinatesEqual: boolean;
    worker?: { workerCount: number; completedCount: number };
  }>;
  expectedWorld(point: Point): { x: number; y: number; z: number };
  dispose(): void;
};

declare global {
  interface Window {
    __VERTICAL_GRID_INTEGRATION__?: VerticalGridIntegration;
    __VERTICAL_GRID_WORKERS__?: GridWorkerTracker;
    __VERTICAL_GRID_BENCHMARK_METRICS__?: {
      snapshot(): { longTaskCount: number; longTaskDurationMs: number; maxFrameGapMs: number };
    };
  }
}

let syntheticCopc: Buffer | undefined;
const browserErrorsByPage = new WeakMap<Page, string[]>();

function asSyntheticWgs84Fixture(source: Buffer): Buffer {
  const copy = Buffer.from(source);
  const headerSize = copy.readUInt16LE(94);
  const variableLengthRecordCount = copy.readUInt32LE(100);
  let cursor = headerSize;
  let patched = false;
  for (let index = 0; index < variableLengthRecordCount; index += 1) {
    const userId = copy.toString("ascii", cursor + 2, cursor + 18).replace(/\0.*$/u, "");
    const recordId = copy.readUInt16LE(cursor + 18);
    const recordLength = copy.readUInt16LE(cursor + 20);
    const dataOffset = cursor + 54;
    if (userId === "LASF_Projection" && recordId === 2112) {
      const wkt = copy
        .toString("utf8", dataOffset, dataOffset + recordLength)
        .replace(/\0.*$/u, "");
      const fixtureWkt = wkt
        .replaceAll("NAD83", "WGS 84")
        .replaceAll("North_American_Datum_1983", "WGS_1984")
        .replaceAll("GRS 1980", "WGS 84")
        .replaceAll("298.257222101", "298.257223563")
        .replaceAll('AUTHORITY["EPSG","7019"]', 'AUTHORITY["EPSG","7030"]')
        .replaceAll('AUTHORITY["EPSG","6269"]', 'AUTHORITY["EPSG","6326"]')
        .replaceAll('AUTHORITY["EPSG","4269"]', 'AUTHORITY["EPSG","4326"]')
        .replace(',AUTHORITY["EPSG","2992"]', "");
      if (fixtureWkt.length > recordLength) {
        throw new Error("Synthetic WGS 84 WKT does not fit the COPC VLR");
      }
      copy.fill(0, dataOffset, dataOffset + recordLength);
      copy.write(fixtureWkt, dataOffset, "utf8");
      patched = true;
      break;
    }
    cursor += 54 + recordLength;
  }
  if (!patched) throw new Error("COPC fixture has no projection WKT VLR");
  return copy;
}

async function getSyntheticCopc(): Promise<Buffer> {
  if (syntheticCopc) return syntheticCopc;
  const path = fileURLToPath(
    new URL("../../../samples/local/autzen.copc.laz", import.meta.url),
  );
  try {
    syntheticCopc = asSyntheticWgs84Fixture(await readFile(path));
  } catch (error) {
    throw new Error(
      `The Autzen integration sample is missing; run npm run download-samples -- autzen (${String(error)})`,
    );
  }
  return syntheticCopc;
}

async function installSyntheticCopcRoute(page: Page): Promise<void> {
  const data = await getSyntheticCopc();
  await page.route("**/vertical-grid-source.copc.laz*", async (route) => {
    const request = route.request();
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      ETag: '"vertical-grid-synthetic-fixture"',
    };
    if (request.method() === "HEAD") {
      await route.fulfill({
        status: 200,
        headers: { ...headers, "Content-Length": String(data.length) },
      });
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers().range ?? "");
    if (!range) {
      await route.fulfill({
        status: 200,
        headers: { ...headers, "Content-Length": String(data.length) },
        body: data,
      });
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
    if (!Number.isSafeInteger(start) || start > end || start >= data.length) {
      await route.fulfill({ status: 416, headers });
      return;
    }
    await route.fulfill({
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${data.length}`,
      },
      body: data.subarray(start, end + 1),
    });
  });
}

async function gotoFixture(page: Page): Promise<void> {
  const browserErrors: string[] = [];
  browserErrorsByPage.set(page, browserErrors);
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
    console.error("vertical-grid pageerror:", error);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
      console.error("vertical-grid browser console:", message.text());
    }
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const active = new Set<Worker>();
    const readyDurationsMs: number[] = [];
    let created = 0;
    let terminated = 0;
    window.Worker = new Proxy(NativeWorker, {
      construct(target, argumentsList, newTarget) {
        const worker = Reflect.construct(target, argumentsList, newTarget);
        const startedAt = performance.now();
        worker.addEventListener("message", (event: MessageEvent) => {
          if (
            event.data !== null &&
            typeof event.data === "object" &&
            "type" in event.data &&
            event.data.type === "ready"
          ) {
            readyDurationsMs.push(performance.now() - startedAt);
          }
        });
        const nativeTerminate = worker.terminate.bind(worker);
        let didTerminate = false;
        Object.defineProperty(worker, "terminate", {
          configurable: true,
          value() {
            if (!didTerminate) {
              didTerminate = true;
              active.delete(worker);
              terminated += 1;
            }
            return nativeTerminate();
          },
        });
        active.add(worker);
        created += 1;
        return worker;
      },
    });
    window.__VERTICAL_GRID_WORKERS__ = {
      snapshot: () => ({
        created,
        terminated,
        active: active.size,
        readyDurationsMs: [...readyDurationsMs],
      }),
    };
  });
  await installSyntheticCopcRoute(page);
  await page.goto("/e2e/fixtures/vertical-grid-integration.html");
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(window.__VERTICAL_GRID_INTEGRATION__)),
    )
    .toBe(true);
}

async function layerState(page: Page, id: string) {
  return page.evaluate((layerId) => {
    if (!window.__VERTICAL_GRID_INTEGRATION__) throw new Error("Fixture missing");
    return window.__VERTICAL_GRID_INTEGRATION__.getState(layerId);
  }, id);
}

async function expectCameraMoveUpdate(
  page: Page,
  id: string,
  before: Awaited<ReturnType<typeof layerState>>,
  phase: string,
  hasCompletedSelection: (
    state: Awaited<ReturnType<typeof layerState>>,
  ) => boolean,
): Promise<void> {
  let latest: Awaited<ReturnType<typeof layerState>> | undefined;
  try {
    await expect
      .poll(async () => {
        latest = await layerState(page, id);
        return hasCompletedSelection(latest);
      })
      .toBe(true);
  } catch (error) {
    const after = latest ?? await layerState(page, id);
    const diagnostics = {
      phase,
      layerId: id,
      before,
      after,
      browserErrors: browserErrorsByPage.get(page) ?? [],
    };
    const serialized = JSON.stringify(diagnostics, null, 2);
    try {
      await test.info().attach("vertical-grid-camera-diagnostics.json", {
        body: serialized,
        contentType: "application/json",
      });
    } catch {
      // Keep the diagnostic in the assertion message if attachment is unavailable.
    }
    throw new Error(
      `Camera move did not complete the expected streaming selection (${phase}):\n${serialized}`,
      { cause: error },
    );
  }
}

async function grid(
  page: Page,
  value: number,
  outside = false,
  crs?: string,
  shape?: { width: number; height: number },
) {
  return page.evaluate(
    ({ metres, outsideCoverage, sourceVerticalCrs, gridShape }) => {
      if (!window.__VERTICAL_GRID_INTEGRATION__) throw new Error("Fixture missing");
      return window.__VERTICAL_GRID_INTEGRATION__.createGrid(
        metres,
        outsideCoverage,
        sourceVerticalCrs,
        gridShape,
      );
    },
    { metres: value, outsideCoverage: outside, sourceVerticalCrs: crs, gridShape: shape },
  );
}

async function createLayer(
  page: Page,
  id: string,
  source: string,
  options: {
    backend?: "copc-js" | "rust";
    gridId?: string;
    heightOffsetMeters?: number;
    workers?: boolean;
  } = {},
  allowStreamingError = false,
): Promise<{ error?: string; code?: string }> {
  const result = await page.evaluate(
    (optionsInPage) => {
      if (!window.__VERTICAL_GRID_INTEGRATION__) throw new Error("Fixture missing");
      return window.__VERTICAL_GRID_INTEGRATION__.createLayer(optionsInPage);
    },
    { id, source, ...options },
  );
  if (!result.error) {
    let latestState: Awaited<ReturnType<typeof layerState>> | undefined;
    try {
      await expect
        .poll(
          async () => {
            latestState = await layerState(page, id);
            return (
              latestState.snapshot.renderedPointCount > 0 ||
              latestState.errors.length > 0
            );
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    } catch (error) {
      throw new Error(
        `Cesium layer ${id} never produced rendered points or an error: ${JSON.stringify(latestState)}`,
        { cause: error },
      );
    }
    const settled = await layerState(page, id);
    if (allowStreamingError && settled.snapshot.renderedPointCount === 0) {
      expect(settled.errors.length).toBeGreaterThan(0);
      return result;
    }
    expect(
      settled.snapshot.renderedPointCount,
      `Cesium did not render points for ${id}: ${JSON.stringify(settled)}`,
    ).toBeGreaterThan(0);
    if (!allowStreamingError) {
      expect(
        settled.errors,
        `Cesium layer ${id} reported streaming errors: ${JSON.stringify(settled)}`,
      ).toEqual([]);
    }
    await expect
      .poll(async () => {
        const snapshot = (await layerState(page, id)).snapshot;
        return (
          snapshot.selectedNodeKeys.some((key) =>
            snapshot.renderedNodeKeys.includes(key),
          ) &&
          snapshot.rangeRequests.active === 0 &&
          snapshot.transition.activeReplacementGroupCount === 0 &&
          (!snapshot.worker ||
            (snapshot.worker.activeCount === 0 &&
              snapshot.worker.queuedCount === 0))
        );
      })
      .toBe(true);
  }
  return result;
}

async function pickLayerPoint(page: Page, id: string): Promise<Point> {
  const readScreenPoint = () =>
    page.evaluate((layerId) => {
      if (!window.__VERTICAL_GRID_INTEGRATION__) throw new Error("Fixture missing");
      return window.__VERTICAL_GRID_INTEGRATION__.getScreenPoint(layerId);
    }, id);
  let screenPoint: { x: number; y: number } | undefined;
  await expect
    .poll(async () => {
      screenPoint = await readScreenPoint();
      return screenPoint;
    })
    .toBeTruthy();
  expect(screenPoint).toBeTruthy();
  const canvasBounds = await page.locator("#viewer canvas").first().boundingBox();
  expect(canvasBounds).toBeTruthy();
  await page.mouse.click(
    canvasBounds!.x + screenPoint!.x,
    canvasBounds!.y + screenPoint!.y,
  );
  try {
    await expect
      .poll(async () => (await layerState(page, id)).selectedPoint, {
        timeout: 5_000,
      })
      .toBeTruthy();
  } catch (error) {
    const click = await page.evaluate(
      () => window.__VERTICAL_GRID_INTEGRATION__!.getLastCanvasClick(),
    );
    throw new Error(
      `Cesium did not select the clicked point ${JSON.stringify({ id, screenPoint, canvasBounds, click })}`,
      { cause: error },
    );
  }
  const point = (await layerState(page, id)).selectedPoint;
  expect(point).toBeTruthy();
  return point!;
}

async function screenPoint(
  page: Page,
  id: string,
): Promise<{ x: number; y: number } | undefined> {
  return page.evaluate(
    (layerId) => window.__VERTICAL_GRID_INTEGRATION__!.getScreenPoint(layerId),
    id,
  );
}

function expectNear(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function sourceUrl(name: string): string {
  return `/e2e/vertical-grid-source.copc.laz?fixture=${encodeURIComponent(name)}`;
}

function summarizeDurations(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    Math.max(1, values.length - 1);
  return {
    samples: values.length,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95NearestRank: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    standardDeviation: Math.sqrt(variance),
  };
}

function summarizeNumbers(values: number[]) {
  return summarizeDurations(values.filter(Number.isFinite));
}

async function readRuntimeHeapUsage(
  cdp: Awaited<ReturnType<import("@playwright/test").BrowserContext["newCDPSession"]>>,
): Promise<{
  usedSizeBytes?: number;
  backingStorageBytes?: number;
  totalSizeBytes?: number;
}> {
  try {
    const result = (await cdp.send("Runtime.getHeapUsage")) as {
      usedSize?: number;
      backingStorageSize?: number;
      totalSize?: number;
    };
    return {
      ...(typeof result.usedSize === "number"
        ? { usedSizeBytes: result.usedSize }
        : {}),
      ...(typeof result.backingStorageSize === "number"
        ? { backingStorageBytes: result.backingStorageSize }
        : {}),
      ...(typeof result.totalSize === "number"
        ? { totalSizeBytes: result.totalSize }
        : {}),
    };
  } catch {
    return {};
  }
}

async function waitForLayerIdle(page: Page, id: string) {
  let previousKey = "";
  let stableSamples = 0;
  let lastState: Awaited<ReturnType<typeof layerState>> | undefined;
  await expect
    .poll(
      async () => {
        const state = await layerState(page, id);
        lastState = state;
        const snapshot = state.snapshot;
        const idle =
          snapshot.renderedPointCount > 0 &&
          snapshot.rangeRequests.active === 0 &&
          snapshot.transition.activeReplacementGroupCount === 0 &&
          (!snapshot.worker ||
            (snapshot.worker.activeCount === 0 && snapshot.worker.queuedCount === 0));
        const key = `${snapshot.streamingUpdateCount}:${snapshot.renderedPointCount}:${snapshot.renderedNodeKeys.join(",")}`;
        stableSamples = idle && key === previousKey ? stableSamples + 1 : 0;
        previousKey = key;
        return stableSamples >= 3;
      },
      { timeout: 60_000, intervals: [100, 200, 500] },
    )
    .toBe(true);
  return lastState!;
}

test("measures Cesium vertical-grid streaming costs", async ({ browser }) => {
  test.skip(
    process.env.COPC_VERTICAL_GRID_BENCHMARK !== "1",
    "Run explicitly with COPC_VERTICAL_GRID_BENCHMARK=1",
  );
  test.setTimeout(600_000);

  const repetitions = Number(process.env.COPC_VERTICAL_GRID_BROWSER_SAMPLES ?? 3);
  expect(Number.isSafeInteger(repetitions) && repetitions >= 3).toBe(true);
  const browserCdp = await browser.newBrowserCDPSession();
  const results: Record<string, unknown>[] = [];
  const scenarios = [false, true] as const;

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const order = repetition % 2 === 0 ? scenarios : [...scenarios].reverse();
    for (const withGrid of order) {
      const context = await browser.newContext();
      const page = await context.newPage();
      let gridId: string | undefined;
      let cdp: Awaited<ReturnType<typeof context.newCDPSession>> | undefined;
      let rssTimer: ReturnType<typeof setInterval> | undefined;
      await page.addInitScript(() => {
        const longTasks: number[] = [];
        let maxFrameGapMs = 0;
        let previousFrame: number | undefined;
        try {
          const observer = new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) longTasks.push(entry.duration);
          });
          observer.observe({ entryTypes: ["longtask"] });
        } catch {
          // Long Task timing is optional in Chromium builds without the API.
        }
        const sampleFrame = (now: number): void => {
          if (previousFrame !== undefined) {
            maxFrameGapMs = Math.max(maxFrameGapMs, now - previousFrame);
          }
          previousFrame = now;
          requestAnimationFrame(sampleFrame);
        };
        requestAnimationFrame(sampleFrame);
        (window as Window & {
          __VERTICAL_GRID_BENCHMARK_METRICS__?: {
            snapshot(): { longTaskCount: number; longTaskDurationMs: number; maxFrameGapMs: number };
          };
        }).__VERTICAL_GRID_BENCHMARK_METRICS__ = {
          snapshot: () => ({
            longTaskCount: longTasks.length,
            longTaskDurationMs: longTasks.reduce((total, value) => total + value, 0),
            maxFrameGapMs,
          }),
        };
      });

      try {
        await gotoFixture(page);
        cdp = await context.newCDPSession(page);
        await cdp.send("Runtime.enable");
        await cdp.send("HeapProfiler.enable");
        const heapBefore = await readRuntimeHeapUsage(cdp);
        const trackerBefore = await page.evaluate(() =>
          window.__VERTICAL_GRID_WORKERS__!.snapshot(),
        );
        const browserRss = { baselineBytes: 0, peakBytes: 0 };
        const sampleBrowserRss = async (): Promise<void> => {
          try {
            const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
            const processIds = processInfo.map((process) => process.id);
            if (processIds.length === 0) return;
            const { stdout } = await execFileAsync("ps", [
              "-o",
              "rss=",
              "-p",
              processIds.join(","),
            ]);
            const current = stdout
              .trim()
              .split(/\s+/u)
              .map(Number)
              .filter(Number.isFinite)
              .reduce((total, kilobytes) => total + kilobytes * 1024, 0);
            if (browserRss.baselineBytes === 0) browserRss.baselineBytes = current;
            browserRss.peakBytes = Math.max(browserRss.peakBytes, current);
          } catch {
            // Process RSS is supplemental and may be unavailable outside macOS/Linux.
          }
        };
        await sampleBrowserRss();
        let rssSampleInFlight = false;
        rssTimer = setInterval(() => {
          if (rssSampleInFlight) return;
          rssSampleInFlight = true;
          void sampleBrowserRss().finally(() => {
            rssSampleInFlight = false;
          });
        }, 200);

        let gridInfo:
          | {
              width: number;
              height: number;
              encodedByteLength: number;
              decodedByteLength: number;
              loadDurationMs: number;
            }
          | undefined;
        if (withGrid) {
          gridId = await grid(page, 25, false, undefined, {
            width: 2048,
            height: 1024,
          });
          gridInfo = await page.evaluate((id) =>
            window.__VERTICAL_GRID_INTEGRATION__!.getGridInfo(id), gridId!,
          );
        }
        const heapAfterGrid = await readRuntimeHeapUsage(cdp);
        await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
        const heapAfterGridRetained = await readRuntimeHeapUsage(cdp);
        await sampleBrowserRss();
        const startedAt = nodePerformance.now();
        const layerId = `benchmark-${withGrid ? "grid" : "baseline"}-${repetition}`;
        const loaded = await createLayer(page, layerId, sourceUrl(layerId), {
          backend: "rust",
          ...(gridId ? { gridId } : {}),
          workers: true,
        });
        expect(loaded.error).toBeUndefined();
        const initialState = await waitForLayerIdle(page, layerId);
        const settledWallMs = nodePerformance.now() - startedAt;
        const heapAfterLoad = await readRuntimeHeapUsage(cdp);
        const browserMetrics = await page.evaluate(() =>
          window.__VERTICAL_GRID_BENCHMARK_METRICS__!.snapshot(),
        );

        const cameraStartedAt = nodePerformance.now();
        await page.evaluate(() =>
          window.__VERTICAL_GRID_INTEGRATION__!.setCamera(
            -123.06875,
            44.04034,
            800,
            -Math.PI / 3,
          ),
        );
        await page.waitForTimeout(1_500);
        const afterCamera = await layerState(page, layerId);
        const cameraWallMs = nodePerformance.now() - cameraStartedAt;

        const cacheBeforeReload = afterCamera.snapshot.pointCache;
        const rangesBeforeReload = afterCamera.snapshot.rangeRequests;
        const reloadStartedAt = nodePerformance.now();
        await page.evaluate((id) =>
          window.__VERTICAL_GRID_INTEGRATION__!.reload(id), layerId,
        );
        const reloadedState = await waitForLayerIdle(page, layerId);
        const reloadWallMs = nodePerformance.now() - reloadStartedAt;
        const heapAfterReload = await readRuntimeHeapUsage(cdp);

        await sampleBrowserRss();
        const workers = await page.evaluate(() =>
          window.__VERTICAL_GRID_WORKERS__!.snapshot(),
        );
        const stateAfterReload = reloadedState.snapshot;
        const stageMetrics = initialState.snapshot.performance;
        const workerReadyDurations = workers.readyDurationsMs.slice(
          trackerBefore.readyDurationsMs.length,
        );
        results.push({
          repetition,
          correction: withGrid ? "synthetic-grid-25m" : "disabled",
          grid: gridInfo
            ? {
                ...gridInfo,
                source: "generated 2048x1024 constant 25 m GTX; not authoritative",
              }
            : null,
          firstVisibleMs: initialState.timings?.firstVisibleMs ?? null,
          layerLoadAndSettleWallMs: settledWallMs,
          cameraMoveObservationMs: cameraWallMs,
          reloadAndSettleWallMs: reloadWallMs,
          coldGridOnlyDecodeAndIntegrityMs: gridInfo?.loadDurationMs ?? null,
          streamed: {
            renderedPointCount: initialState.snapshot.renderedPointCount,
            loadedNodeCount: stageMetrics?.loadedNodeCount,
            loadedPointCount: stageMetrics?.loadedPointCount,
            pointPreparationDurationMs: stageMetrics?.pointPreparationDurationMs,
            crsTransformDurationMs: stageMetrics?.crsTransformDurationMs,
            rendererPreparationDurationMs: stageMetrics?.rendererPreparationDurationMs,
            updateDurationMs: stageMetrics?.updateDurationMs,
            rangeRequests: initialState.snapshot.rangeRequests,
            pointCacheAtLoad: initialState.snapshot.pointCache,
            pointCacheBeforeReload: cacheBeforeReload,
            pointCacheAfterReload: stateAfterReload.pointCache,
            rangeRequestsBeforeReload: rangesBeforeReload,
            rangeRequestsAfterReload: stateAfterReload.rangeRequests,
          },
          workers: {
            created: workers.created - trackerBefore.created,
            terminated: workers.terminated - trackerBefore.terminated,
            activeAfterReload: workers.active,
            readyDurationsMs: workerReadyDurations,
          },
          pageHeap: {
            beforeGrid: heapBefore,
            afterGridImmediate: heapAfterGrid,
            afterGridRetained: heapAfterGridRetained,
            afterLoad: heapAfterLoad,
            afterReload: heapAfterReload,
            afterDestroy: null,
          },
          browserProcessRss: {
            baselineBytes: browserRss.baselineBytes || null,
            sampledPeakBytes: browserRss.peakBytes || null,
            sampledIncreaseBytes:
              browserRss.baselineBytes > 0
                ? Math.max(0, browserRss.peakBytes - browserRss.baselineBytes)
                : null,
            samplingIntervalMs: 200,
          },
          mainThread: browserMetrics,
        });

        await page.evaluate((id) => {
          window.__VERTICAL_GRID_INTEGRATION__!.destroyLayer(id);
        }, layerId);
        if (gridId) {
          await page.evaluate((id) =>
            window.__VERTICAL_GRID_INTEGRATION__!.releaseGrid(id), gridId,
          );
        }
        await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
        await page.waitForTimeout(100);
        const heapAfterDestroy = await readRuntimeHeapUsage(cdp);
        results.at(-1)!.pageHeap = {
          ...(results.at(-1)!.pageHeap as object),
          afterDestroy: heapAfterDestroy,
        };
      } finally {
        if (rssTimer) clearInterval(rssTimer);
        await cdp?.detach().catch(() => undefined);
        await context.close();
      }
    }
  }
  await browserCdp.detach();

  const byScenario = Object.fromEntries(
    scenarios.map((withGrid) => {
      const selected = results.filter(
        (result) => result.correction === (withGrid ? "synthetic-grid-25m" : "disabled"),
      );
      const metric = (key: string) =>
        summarizeDurations(selected.map((result) => Number(result[key] ?? 0)));
      const nestedNumber = (
        result: Record<string, unknown>,
        ...path: string[]
      ): number => {
        let value: unknown = result;
        for (const key of path) {
          value = (value as Record<string, unknown> | undefined)?.[key];
        }
        return typeof value === "number" && Number.isFinite(value) ? value : NaN;
      };
      const gridUsageDelta = selected
        .map((result) => {
          const before = nestedNumber(
            result,
            "pageHeap",
            "beforeGrid",
            "backingStorageBytes",
          );
          const retained = nestedNumber(
            result,
            "pageHeap",
            "afterGridRetained",
            "backingStorageBytes",
          );
          return Number.isFinite(before) && Number.isFinite(retained)
            ? retained - before
            : NaN;
        });
      const workerReady = selected.flatMap((result) => {
        const worker = result.workers as { readyDurationsMs?: number[] } | undefined;
        return worker?.readyDurationsMs ?? [];
      });
      const streamMetric = (key: string): number[] =>
        selected.map((result) => {
          const streamed = result.streamed as Record<string, unknown> | undefined;
          const value = streamed?.[key];
          return typeof value === "number" ? value : NaN;
        });
      const rssIncreases = selected.map((result) =>
        nestedNumber(result, "browserProcessRss", "sampledIncreaseBytes"),
      );
      const mainThreadMetric = (key: string): number[] =>
        selected.map((result) => {
          const mainThread = result.mainThread as Record<string, unknown> | undefined;
          const value = mainThread?.[key];
          return typeof value === "number" ? value : NaN;
        });
      return [
        withGrid ? "syntheticGrid" : "disabled",
        {
          firstVisibleMs: metric("firstVisibleMs"),
          layerLoadAndSettleWallMs: metric("layerLoadAndSettleWallMs"),
          cameraMoveObservationMs: metric("cameraMoveObservationMs"),
          reloadAndSettleWallMs: metric("reloadAndSettleWallMs"),
          coldGridOnlyDecodeAndIntegrityMs: withGrid
            ? metric("coldGridOnlyDecodeAndIntegrityMs")
            : null,
          streamingPreparationMs: {
            pointPreparation: summarizeNumbers(streamMetric("pointPreparationDurationMs")),
            verticalCrs: summarizeNumbers(streamMetric("crsTransformDurationMs")),
            rendererPreparation: summarizeNumbers(streamMetric("rendererPreparationDurationMs")),
          },
          workerReadyMs: summarizeNumbers(workerReady),
          v8BackingStorageIncreaseAfterGridBytes: withGrid
            ? summarizeNumbers(gridUsageDelta)
            : null,
          sampledBrowserProcessRssIncreaseBytes: summarizeNumbers(rssIncreases),
          mainThread: {
            observedLongTaskCount: summarizeNumbers(mainThreadMetric("longTaskCount")),
            longTaskDurationMs: summarizeNumbers(mainThreadMetric("longTaskDurationMs")),
            maximumFrameGapMs: summarizeNumbers(mainThreadMetric("maxFrameGapMs")),
          },
        },
      ];
    }),
  );
  console.log(
    "VERTICAL_GRID_BROWSER_BENCHMARK " +
      JSON.stringify(
        {
          environment: {
            userAgent: await browser.newPage().then(async (page) => {
              const userAgent = await page.evaluate(() => navigator.userAgent);
              await page.close();
              return userAgent;
            }),
            browserName: browser.browserType().name(),
            repetitions,
            dataset: "Autzen local COPC served through a deterministic HTTP Range route",
            grid: "synthetic global constant 25 m GTX, 2048x1024, 8 MiB decoded",
            workers: "Rust/WASM decode worker enabled; geoid sampling runs in shared TypeScript preparation path",
            timing: "Playwright host wall clock plus in-page first-visible; p95 nearest-rank",
            memory: "CDP page V8 heap/backing storage and sampled aggregate Chromium process RSS; worker-specific memory is not exposed by this harness",
          },
          summary: byScenario,
          runs: results.map((result) => ({
            repetition: result.repetition,
            correction: result.correction,
            grid: result.grid,
            firstVisibleMs: result.firstVisibleMs,
            layerLoadAndSettleWallMs: result.layerLoadAndSettleWallMs,
            cameraMoveObservationMs: result.cameraMoveObservationMs,
            reloadAndSettleWallMs: result.reloadAndSettleWallMs,
            streamed: result.streamed,
            workers: result.workers,
            browserProcessRss: result.browserProcessRss,
            pageHeap: result.pageHeap,
            mainThread: result.mainThread,
          })),
        },
        null,
        2,
      ),
  );
});

test("Cesium applies opt-in GTX correction once through streaming, reload, bounds and picking", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoFixture(page);
  const source = sourceUrl("positive-offset");
  const baselineLoad = await createLayer(page, "baseline", source);
  expect(baselineLoad.error).toBeUndefined();
  const baseline = await pickLayerPoint(page, "baseline");
  expect(baseline.backend).toBe("copc-js");
  expect(baseline.source).toBeTruthy();
  const usSurveyFoot = 1200 / 3937;
  expectNear(baseline.height, baseline.source!.z * usSurveyFoot, 0.01);

  const positiveGrid = await grid(page, 25);
  const correctedLoad = await createLayer(page, "corrected", source, {
    gridId: positiveGrid,
    heightOffsetMeters: 7.5,
  });
  expect(correctedLoad.error).toBeUndefined();
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("baseline", false),
  );
  const corrected = await pickLayerPoint(page, "corrected");
  expect(corrected.source).toBeTruthy();
  expectNear(
    corrected.height,
    corrected.source!.z * usSurveyFoot + 25 + 7.5,
    0.01,
  );

  const expectedWorld = await page.evaluate((point) => {
    return window.__VERTICAL_GRID_INTEGRATION__!.expectedWorld(point);
  }, corrected);
  expect(corrected.world).toBeTruthy();
  for (const axis of ["x", "y", "z"] as const) {
    expectNear(corrected.world![axis], expectedWorld[axis], 0.02);
  }
  const sphere = (await layerState(page, "corrected")).boundingSphere;
  expect(sphere).toBeTruthy();
  const sphereDistance = Math.hypot(
    corrected.world!.x - sphere!.x,
    corrected.world!.y - sphere!.y,
    corrected.world!.z - sphere!.z,
  );
  expect(sphereDistance).toBeLessThanOrEqual(sphere!.radius + 0.05);

  const zoomed = await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.zoomTo("corrected"),
  );
  expect(zoomed).toBe(true);
  const cameraMoveState = await layerState(page, "corrected");
  const beforeCameraMove = cameraMoveState.snapshot;
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setCamera(-123, 44, 18_000),
  );
  await expectCameraMoveUpdate(
    page,
    "corrected",
    cameraMoveState,
    "move-to-18km",
    (state) =>
      state.snapshot.streamingUpdateCount > beforeCameraMove.streamingUpdateCount,
  );
  const lookingAwayState = await layerState(page, "corrected");
  const beforeLookingAway = lookingAwayState.snapshot;
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setCamera(
      -123,
      44,
      18_000,
      Math.PI / 2,
    ),
  );
  await expectCameraMoveUpdate(
    page,
    "corrected",
    lookingAwayState,
    "look-away-and-frustum-cull",
    (state) =>
      state.snapshot.streamingUpdateCount > beforeLookingAway.streamingUpdateCount &&
      (state.snapshot.performance?.frustumCulledCount ?? 0) > 0,
  );
  await expect.poll(() => screenPoint(page, "corrected")).toBeUndefined();
  const cacheHitsBeforeCameraRevisit =
    (await layerState(page, "corrected")).snapshot.pointCache.hits;
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setCamera(-123, 44, 18_000),
  );
  await expect.poll(() => screenPoint(page, "corrected")).toBeTruthy();
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setCamera(-123, 44, 4_000),
  );
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setRefinementFocus("corrected", true),
  );
  await expect
    .poll(async () => (await layerState(page, "corrected")).snapshot.pointCache.hits)
    .toBeGreaterThan(cacheHitsBeforeCameraRevisit);

  const beforeReload = (await layerState(page, "corrected")).snapshot;
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.reload("corrected"),
  );
  await expect
    .poll(async () => (await layerState(page, "corrected")).snapshot.renderedPointCount)
    .toBeGreaterThan(0);
  const afterReload = await pickLayerPoint(page, "corrected");
  expectNear(
    afterReload.height,
    afterReload.source!.z * usSurveyFoot + 25 + 7.5,
    0.01,
  );
  expect((await layerState(page, "corrected")).snapshot.rangeRequests.requested).toBeGreaterThan(
    beforeReload.rangeRequests.requested,
  );

  const zeroGrid = await grid(page, 0);
  const zeroResult = await createLayer(page, "zero", sourceUrl("zero-correction"), {
    gridId: zeroGrid,
  });
  expect(zeroResult.error).toBeUndefined();
  await page.evaluate(() => {
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("corrected", false);
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("zero", true);
  });
  const zeroCorrected = await pickLayerPoint(page, "zero");
  expectNear(zeroCorrected.height, zeroCorrected.source!.z * usSurveyFoot, 0.01);

  for (const id of ["baseline", "corrected", "zero"]) {
    await page.evaluate((layerId) =>
      window.__VERTICAL_GRID_INTEGRATION__!.destroyLayer(layerId),
    id);
  }
  await page.evaluate(() => window.__VERTICAL_GRID_INTEGRATION__!.dispose());
});

test("Cesium Rust/WASM Worker and non-Worker paths match JavaScript correction", async ({ page }) => {
  test.setTimeout(300_000);
  await gotoFixture(page);
  const source = sourceUrl("backend-parity");
  const syntheticGrid = await grid(page, -15);

  expect(await createLayer(page, "js", source, { gridId: syntheticGrid })).toEqual({});
  const javascript = await pickLayerPoint(page, "js");
  expect(javascript.backend).toBe("copc-js");

  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("js", false),
  );
  expect(
    await createLayer(page, "rust-worker", source, {
      backend: "rust",
      gridId: syntheticGrid,
    }),
  ).toEqual({});
  const rustWorkerState = await layerState(page, "rust-worker");
  expect(rustWorkerState.snapshot.backend).toBe("rust");
  expect(rustWorkerState.snapshot.worker).toBeTruthy();
  expect(rustWorkerState.snapshot.worker!.completedCount).toBeGreaterThan(0);
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("rust-worker", true),
  );
  const rustWorker = await pickLayerPoint(page, "rust-worker");
  expectNear(rustWorker.height, rustWorker.source!.z * (1200 / 3937) - 15, 0.01);
  const workerParity = await page.evaluate(
    ({ url, gridId }) =>
      window.__VERTICAL_GRID_INTEGRATION__!.compareBackends(url, gridId, true),
    { url: source, gridId: syntheticGrid },
  );
  expect(workerParity.worker).toBeTruthy();
  expect(workerParity.worker!.completedCount).toBeGreaterThan(0);
  expect(workerParity.comparedPoints).toBeGreaterThan(0);
  expect(workerParity.sourceCoordinatesEqual).toBe(true);
  expect(workerParity.maxHeightDifferenceMeters).toBeLessThan(0.01);
  expect(workerParity.maxEcefDifferenceMeters).toBeLessThan(0.05);

  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("rust-worker", false),
  );
  expect(
    await createLayer(page, "rust-main", source, {
      backend: "rust",
      gridId: syntheticGrid,
      workers: false,
    }),
  ).toEqual({});
  const rustMainState = await layerState(page, "rust-main");
  expect(rustMainState.snapshot.backend).toBe("rust");
  expect(rustMainState.snapshot.worker).toBeUndefined();
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("rust-main", true),
  );
  const rustMain = await pickLayerPoint(page, "rust-main");
  expectNear(rustMain.height, rustMain.source!.z * (1200 / 3937) - 15, 0.01);
  const mainParity = await page.evaluate(
    ({ url, gridId }) =>
      window.__VERTICAL_GRID_INTEGRATION__!.compareBackends(url, gridId, false),
    { url: source, gridId: syntheticGrid },
  );
  expect(mainParity.worker).toBeUndefined();
  expect(mainParity.comparedPoints).toBeGreaterThan(0);
  expect(mainParity.sourceCoordinatesEqual).toBe(true);
  expect(mainParity.maxHeightDifferenceMeters).toBeLessThan(0.01);
  expect(mainParity.maxEcefDifferenceMeters).toBeLessThan(0.05);

  const workerCountsBefore = await page.evaluate(() =>
    window.__VERTICAL_GRID_WORKERS__!.snapshot(),
  );
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.destroyLayer("rust-worker"),
  );
  const workerCountsAfter = await page.evaluate(() =>
    window.__VERTICAL_GRID_WORKERS__!.snapshot(),
  );
  expect(workerCountsBefore.created).toBeGreaterThan(0);
  expect(workerCountsAfter.terminated).toBeGreaterThan(workerCountsBefore.terminated);
  await page.evaluate(() => window.__VERTICAL_GRID_INTEGRATION__!.dispose());
});

test("vertical grid requests fail closed and independent Cesium layers keep their own correction", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoFixture(page);
  expect(
    await page.evaluate(() =>
      window.__VERTICAL_GRID_INTEGRATION__!.missingGridError(),
    ),
  ).toBe("missing-grid");

  const mismatchedGrid = await grid(page, 12, false, "EPSG:5703");
  const mismatch = await createLayer(page, "mismatch", sourceUrl("mismatch"), {
    gridId: mismatchedGrid,
  });
  expect(mismatch.error).toContain("EPSG:6360");
  expect(mismatch.code).toBe("unsupported-crs-pair");

  const uncoveredGrid = await grid(page, 12, true);
  const outside = await createLayer(page, "outside", sourceUrl("outside"), {
    gridId: uncoveredGrid,
  }, true);
  if (outside.error) {
    expect(outside.error).toMatch(/coverage|outside/i);
  } else {
    await expect
      .poll(async () => (await layerState(page, "outside")).errors.join(" "))
      .toMatch(/coverage|outside/i);
    expect((await layerState(page, "outside")).snapshot.renderedPointCount).toBe(0);
  }

  const positive = await grid(page, 22);
  const negative = await grid(page, -9);
  expect(await createLayer(page, "layer-positive", sourceUrl("multi-positive"), {
    gridId: positive,
  })).toEqual({});
  expect(await createLayer(page, "layer-negative", sourceUrl("multi-negative"), {
    gridId: negative,
  })).toEqual({});
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("layer-negative", false),
  );
  const positivePoint = await pickLayerPoint(page, "layer-positive");
  await page.evaluate(() => {
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("layer-positive", false);
    window.__VERTICAL_GRID_INTEGRATION__!.setShow("layer-negative", true);
  });
  const negativePoint = await pickLayerPoint(page, "layer-negative");
  expectNear(
    positivePoint.height,
    positivePoint.source!.z * (1200 / 3937) + 22,
    0.01,
  );
  expectNear(
    negativePoint.height,
    negativePoint.source!.z * (1200 / 3937) - 9,
    0.01,
  );

  const replacementGrid = await grid(page, 5);
  await page.evaluate(() => {
    window.__VERTICAL_GRID_INTEGRATION__!.destroyLayer("layer-negative");
  });
  expect(await createLayer(page, "replacement", sourceUrl("replacement"), {
    gridId: replacementGrid,
  })).toEqual({});
  const replacementPoint = await pickLayerPoint(page, "replacement");
  expectNear(replacementPoint.height, replacementPoint.source!.z * (1200 / 3937) + 5, 0.01);

  const workers = await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.cancelWorkerQueue(
      "/e2e/vertical-grid-source.copc.laz?fixture=worker-cancel",
    ),
  );
  expect(workers.supported).toBe(true);
  expect(workers.peakQueuedCount).toBeGreaterThan(0);
  expect(workers.cancelledCount).toBeGreaterThan(0);

  await page.evaluate(() => window.__VERTICAL_GRID_INTEGRATION__!.dispose());
});

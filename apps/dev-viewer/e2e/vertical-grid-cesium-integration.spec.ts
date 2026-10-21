import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
  snapshot(): { created: number; terminated: number; active: number };
};

type VerticalGridIntegration = {
  createGrid(
    metres: number,
    outsideCoverage?: boolean,
    sourceVerticalCrs?: string,
  ): Promise<string>;
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
      performance?: { candidatesBeforeCulling: number; frustumCulledCount: number };
    };
    selectedPoint?: Point;
    boundingSphere?: { x: number; y: number; z: number; radius: number };
    errors: string[];
    ownerIds: string[];
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
  }
}

let syntheticCopc: Buffer | undefined;

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
  page.on("pageerror", (error) => console.error("vertical-grid pageerror:", error));
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error("vertical-grid browser console:", message.text());
    }
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const active = new Set<Worker>();
    let created = 0;
    let terminated = 0;
    window.Worker = new Proxy(NativeWorker, {
      construct(target, argumentsList, newTarget) {
        const worker = Reflect.construct(target, argumentsList, newTarget);
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
      snapshot: () => ({ created, terminated, active: active.size }),
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

async function grid(page: Page, value: number, outside = false, crs?: string) {
  return page.evaluate(
    ({ metres, outsideCoverage, sourceVerticalCrs }) => {
      if (!window.__VERTICAL_GRID_INTEGRATION__) throw new Error("Fixture missing");
      return window.__VERTICAL_GRID_INTEGRATION__.createGrid(
        metres,
        outsideCoverage,
        sourceVerticalCrs,
      );
    },
    { metres: value, outsideCoverage: outside, sourceVerticalCrs: crs },
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
    const settled = latestState!;
    if (allowStreamingError && settled.snapshot.renderedPointCount === 0) {
      expect(settled.errors.length).toBeGreaterThan(0);
      return result;
    }
    expect(
      settled.snapshot.renderedPointCount,
      `Cesium did not render points for ${id}: ${JSON.stringify(settled)}`,
    ).toBeGreaterThan(0);
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
  const beforeCameraMove = (await layerState(page, "corrected")).snapshot;
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setCamera(-123, 44, 18_000),
  );
  await expect
    .poll(async () => (await layerState(page, "corrected")).snapshot.streamingUpdateCount)
    .toBeGreaterThan(beforeCameraMove.streamingUpdateCount);
  const beforeLookingAway = (await layerState(page, "corrected")).snapshot;
  await page.evaluate(() =>
    window.__VERTICAL_GRID_INTEGRATION__!.setCamera(
      -123,
      44,
      18_000,
      Math.PI / 2,
    ),
  );
  await expect
    .poll(async () => {
      const snapshot = (await layerState(page, "corrected")).snapshot;
      return snapshot.streamingUpdateCount > beforeLookingAway.streamingUpdateCount &&
        (snapshot.performance?.frustumCulledCount ?? 0) > 0;
    })
    .toBe(true);
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

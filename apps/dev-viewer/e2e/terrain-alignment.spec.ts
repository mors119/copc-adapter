import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type SelectedPoint = {
  nodeKey: string;
  pointIndex: number;
  height: number;
  source?: { x: number; y: number; z: number };
  world?: { x: number; y: number; z: number };
};

type DevViewerApi = {
  getSnapshot():
    | {
        lifecycle: string;
        renderedPointCount: number;
        rangeRequests: { requested: number; completed: number };
        performance: {
          decodeDurationMs: number;
          pointPreparationDurationMs: number;
          pointCollectionCreationDurationMs: number;
          pointAddDurationMs: number;
        };
        worker?: { workerCount: number; completedCount: number; activeCount: number };
      }
    | undefined;
  getSelectedPoint(): SelectedPoint | undefined;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  getConfiguration(): { heightOffsetMeters: number; terrainSource: string };
};

type TerrainTestMetrics = {
  gpuUploadCalls: number;
  gpuUploadBytes: number;
  gpuUploadDurationMs: number;
};

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: DevViewerApi;
    __TERRAIN_ALIGNMENT_TEST_METRICS__?: TerrainTestMetrics;
  }
}

const sourcePath = fileURLToPath(
  new URL("../../../samples/local/autzen.copc.laz", import.meta.url),
);
let fixtureBytes: Buffer | undefined;

async function getEllipsoidalHeightFixture(): Promise<Buffer> {
  if (fixtureBytes) return fixtureBytes;
  const copy = Buffer.from(await readFile(sourcePath));
  const headerSize = copy.readUInt16LE(94);
  const vlrCount = copy.readUInt32LE(100);
  let cursor = headerSize;
  let patched = false;
  for (let index = 0; index < vlrCount; index += 1) {
    const userId = copy
      .toString("ascii", cursor + 2, cursor + 18)
      .replace(/\0.*$/u, "");
    const recordId = copy.readUInt16LE(cursor + 18);
    const recordLength = copy.readUInt16LE(cursor + 20);
    const dataOffset = cursor + 54;
    if (userId === "LASF_Projection" && recordId === 2112) {
      const sourceWkt = copy
        .toString("utf8", dataOffset, dataOffset + recordLength)
        .replace(/\0.*$/u, "");
      const fixtureWkt = sourceWkt
        .replace("NAVD88 height (ftUS)", "WGS 84 ellipsoidal height")
        .replace("North American Vertical Datum 1988", "WGS 84")
        .replace('AUTHORITY["EPSG","6360"]', 'AUTHORITY["EPSG","4979"]');
      if (fixtureWkt.length > recordLength) {
        throw new Error("Synthetic ellipsoidal WKT does not fit the COPC VLR");
      }
      copy.fill(0, dataOffset, dataOffset + recordLength);
      copy.write(fixtureWkt, dataOffset, "utf8");
      patched = true;
      break;
    }
    cursor += 54 + recordLength;
  }
  if (!patched) throw new Error("COPC fixture has no projection WKT VLR");
  fixtureBytes = copy;
  return copy;
}

async function installSourceRoute(page: Page): Promise<{
  snapshot(): { rangeRequests: number; rangeBytes: number };
}> {
  const data = await getEllipsoidalHeightFixture();
  let rangeRequests = 0;
  let rangeBytes = 0;
  await page.route("**/terrain-alignment-fixture.copc.laz*", async (route) => {
    const baseHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      ETag: '"terrain-alignment-fixture"',
    };
    if (route.request().method() === "HEAD") {
      await route.fulfill({
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Length": String(data.length),
        },
      });
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/u.exec(
      route.request().headers().range ?? "",
    );
    if (!range) {
      await route.fulfill({
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(data.length) },
        body: data,
      });
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(
      range[2] ? Number(range[2]) : data.length - 1,
      data.length - 1,
    );
    if (!Number.isSafeInteger(start) || start > end || start >= data.length) {
      await route.fulfill({ status: 416, headers: baseHeaders });
      return;
    }
    rangeRequests += 1;
    rangeBytes += end - start + 1;
    await route.fulfill({
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${data.length}`,
      },
      body: data.subarray(start, end + 1),
    });
  });
  return { snapshot: () => ({ rangeRequests, rangeBytes }) };
}

async function openFixture(
  page: Page,
  terrainFixtureHeight?: number,
): Promise<{ snapshot(): { rangeRequests: number; rangeBytes: number } }> {
  const sourceMetrics = await installSourceRoute(page);
  await page.addInitScript(() => {
    const metrics = {
      gpuUploadCalls: 0,
      gpuUploadBytes: 0,
      gpuUploadDurationMs: 0,
    };
    window.__TERRAIN_ALIGNMENT_TEST_METRICS__ = metrics;
    const prototypes = [
      WebGLRenderingContext.prototype,
      typeof WebGL2RenderingContext === "undefined"
        ? undefined
        : WebGL2RenderingContext.prototype,
    ].filter((prototype): prototype is object => prototype !== undefined);
    for (const prototype of prototypes) {
      for (const method of ["bufferData", "bufferSubData"] as const) {
        const original = Reflect.get(prototype, method);
        if (typeof original !== "function") continue;
        Reflect.set(prototype, method, function (this: WebGLRenderingContext, ...args: unknown[]) {
          const startedAt = performance.now();
          const data = args[method === "bufferSubData" ? 2 : 1];
          const bytes = typeof data === "number"
            ? data
            : data && typeof data === "object" && "byteLength" in data
              ? Number(data.byteLength)
              : 0;
          const result = Reflect.apply(original, this, args);
          metrics.gpuUploadCalls += 1;
          metrics.gpuUploadBytes += bytes;
          metrics.gpuUploadDurationMs += performance.now() - startedAt;
          return result;
        });
      }
    }
  });
  const params = new URLSearchParams({
    source: "/terrain-alignment-fixture.copc.laz",
    cameraDistance: "1500",
    backend: "rust",
  });
  if (terrainFixtureHeight !== undefined) {
    params.set("terrainFixtureHeight", String(terrainFixtureHeight));
  }
  await page.goto(`/?${params.toString()}`);
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.renderedPointCount ?? 0))
    .toBeGreaterThan(0);
  return sourceMetrics;
}

async function pickRenderedPoint(page: Page): Promise<SelectedPoint> {
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
      ),
    )
    .toBeDefined();
  const position = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
  );
  await page.mouse.click(position!.x, position!.y);
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSelectedPoint()))
    .toBeDefined();
  return page.evaluate(() => window.__COPC_DEV_VIEWER__!.getSelectedPoint()!);
}

test("estimates and previews controlled Terrain, then applies only after approval", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sourceMetrics = await openFixture(page, 250);
  const before = await pickRenderedPoint(page);
  expect(Number.isFinite(before.source?.z)).toBe(true);

  await page.getByLabel("I confirm the selected point is ground").check();
  const estimateStartedAt = performance.now();
  await page.getByRole("button", { name: "Estimate residual" }).click();
  const preview = page.locator("#terrain-estimate-preview");
  await expect(preview).toContainText("Estimate status: ready (current)");
  const estimateLatencyMs = performance.now() - estimateStartedAt;
  await expect(preview).toContainText("ControlledTerrainProvider");
  await expect(preview).toContainText("Sampled Terrain height: 250.000 m");
  await expect(preview).toContainText("Sampling: 1 call");
  const afterPreview = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__!.getSelectedPoint()!,
  );
  expect(afterPreview.height).toBe(before.height);
  expect(afterPreview.source).toEqual(before.source);
  expect(afterPreview.world).toEqual(before.world);
  expect(await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters)).toBe(0);
  await expect(page.getByRole("button", { name: "Apply proposed correction" })).toBeEnabled();

  const rangesBeforeApply = sourceMetrics.snapshot();
  const gpuBeforeApply = await page.evaluate(() => ({
    ...window.__TERRAIN_ALIGNMENT_TEST_METRICS__!,
  }));
  const applyStartedAt = performance.now();
  await page.getByRole("button", { name: "Apply proposed correction" }).click();
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters))
    .toBeGreaterThan(0);
  const after = await pickRenderedPoint(page);
  expect(Number.isFinite(after.source?.z)).toBe(true);
  expect(after.height).toBeGreaterThan(before.height);
  expect(after.world).toBeDefined();
  expect(after.source?.z).toBeGreaterThan(400);
  expect(after.source?.z).toBeLessThan(620);
  expect(after.height).toBeCloseTo(
    after.source!.z * (1200 / 3937) +
      (await page.evaluate(
        () => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters,
      )),
    5,
  );
  const applyLatencyMs = performance.now() - applyStartedAt;
  const rangesAfterApply = sourceMetrics.snapshot();
  const runtimeMetrics = await page.evaluate(() => ({
    layer: window.__COPC_DEV_VIEWER__!.getSnapshot()!,
    gpu: window.__TERRAIN_ALIGNMENT_TEST_METRICS__!,
    sessionMountCount: document.querySelectorAll(
      "#cesium-container > .dev-session-mount",
    ).length,
  }));
  expect(rangesAfterApply.rangeRequests).toBeGreaterThan(
    rangesBeforeApply.rangeRequests,
  );
  expect(runtimeMetrics.layer.performance.decodeDurationMs).toBeGreaterThan(0);
  expect(runtimeMetrics.sessionMountCount).toBe(1);
  console.info("Controlled Terrain alignment lifecycle measurements", {
    terrainSamplerCalls: 1,
    estimateLatencyMs,
    applyLatencyMs,
    additionalCopcRangeRequests:
      rangesAfterApply.rangeRequests - rangesBeforeApply.rangeRequests,
    additionalCopcRangeBytes:
      rangesAfterApply.rangeBytes - rangesBeforeApply.rangeBytes,
    rebuiltLayerDecodeDurationMs:
      runtimeMetrics.layer.performance.decodeDurationMs,
    rebuiltLayerPointPreparationDurationMs:
      runtimeMetrics.layer.performance.pointPreparationDurationMs,
    rebuiltLayerWorker: runtimeMetrics.layer.worker,
    pointCollectionCreationDurationMs:
      runtimeMetrics.layer.performance.pointCollectionCreationDurationMs,
    pointAddDurationMs: runtimeMetrics.layer.performance.pointAddDurationMs,
    webGLBufferUploadsDuringApply: {
      calls: runtimeMetrics.gpu.gpuUploadCalls - gpuBeforeApply.gpuUploadCalls,
      bytes: runtimeMetrics.gpu.gpuUploadBytes - gpuBeforeApply.gpuUploadBytes,
      apiDurationMs:
        runtimeMetrics.gpu.gpuUploadDurationMs - gpuBeforeApply.gpuUploadDurationMs,
    },
    activeCesiumSessionMounts: runtimeMetrics.sessionMountCount,
  });
});

test("ellipsoid-only mode rejects terrain alignment without moving the selected point", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openFixture(page);
  const before = await pickRenderedPoint(page);
  await page.getByLabel("I confirm the selected point is ground").check();
  await page.getByRole("button", { name: "Estimate residual" }).click();
  const preview = page.locator("#terrain-estimate-preview");
  await expect(preview).toContainText("Estimate status: unavailable (current)");
  await expect(preview).toContainText("only the ellipsoid");
  await expect(page.getByRole("button", { name: "Apply proposed correction" })).toBeDisabled();
  const after = await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getSelectedPoint());
  expect(after?.height).toBe(before.height);
  expect(after?.source?.z).toBe(before.source?.z);
  expect(await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters)).toBe(0);
});

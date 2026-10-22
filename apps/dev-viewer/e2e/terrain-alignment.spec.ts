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

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: DevViewerApi;
  }
}

const sourcePath = fileURLToPath(
  new URL("../../../samples/local/autzen.copc.laz", import.meta.url),
);
let fixtureBytes: Buffer | undefined;

async function getAutzenFixture(): Promise<Buffer> {
  if (fixtureBytes) return fixtureBytes;
  fixtureBytes = Buffer.from(await readFile(sourcePath));
  return fixtureBytes;
}

async function installSourceRoute(page: Page): Promise<{
  snapshot(): { rangeRequests: number; rangeBytes: number };
}> {
  const data = await getAutzenFixture();
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
  ellipsoidalSourceFixture = false,
): Promise<{ snapshot(): { rangeRequests: number; rangeBytes: number } }> {
  const sourceMetrics = ellipsoidalSourceFixture
    ? { snapshot: () => ({ rangeRequests: 0, rangeBytes: 0 }) }
    : await installSourceRoute(page);
  const params = new URLSearchParams({
    source: "/terrain-alignment-fixture.copc.laz",
    cameraDistance: "1500",
    backend: "rust",
  });
  if (terrainFixtureHeight !== undefined) {
    params.set("terrainFixtureHeight", String(terrainFixtureHeight));
  }
  if (ellipsoidalSourceFixture) {
    params.set("terrainEllipsoidalFixture", "1");
  }
  await page.goto(`/?${params.toString()}`);
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.renderedPointCount ?? 0))
    .toBeGreaterThan(0);
  if (ellipsoidalSourceFixture) {
    await page.evaluate(() =>
      window.__COPC_DEBUG__?.setCameraView({
        longitudeDegrees: -122.495,
        latitudeDegrees: 44.505,
        heightMeters: 3_000,
        headingDegrees: 0,
        pitchDegrees: -90,
      }),
    );
  }
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

test("estimates, previews, and applies a WKT2 ellipsoidal fixture only after approval", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openFixture(page, 250, true);
  const before = await pickRenderedPoint(page);
  expect(before.source?.z).toBe(100);

  await page.getByLabel("I confirm the selected point is ground").check();
  const estimateStartedAt = performance.now();
  await page.getByRole("button", { name: "Estimate residual" }).click();
  const preview = page.locator("#terrain-estimate-preview");
  await expect(preview).toContainText("Estimate status: ready (current)");
  await expect(preview).toContainText("ControlledTerrainProvider");
  await expect(preview).toContainText("Current displayed COPC height: 100.000 m");
  await expect(preview).toContainText("Sampled Terrain height: 250.000 m");
  await expect(preview).toContainText("Proposed adjustment (Terrain − COPC): 150.000 m");
  await expect(preview).toContainText("Sampling: 1 call");
  const estimateLatencyMs = performance.now() - estimateStartedAt;
  const afterPreview = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__!.getSelectedPoint()!,
  );
  expect(afterPreview.height).toBe(before.height);
  expect(afterPreview.source).toEqual(before.source);
  expect(afterPreview.world).toEqual(before.world);
  expect(await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters)).toBe(0);
  await expect(page.getByRole("button", { name: "Apply proposed correction" })).toBeEnabled();

  const applyStartedAt = performance.now();
  await page.getByRole("button", { name: "Apply proposed correction" }).click();
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters))
    .toBe(150);
  const after = await pickRenderedPoint(page);
  expect(after.source).toEqual(before.source);
  expect(after.source?.z).toBe(100);
  expect(after.height).toBe(250);
  expect(after.world).not.toEqual(before.world);
  const applyLatencyMs = performance.now() - applyStartedAt;
  const appliedSnapshot = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__!.getSnapshot()!,
  );
  expect(appliedSnapshot.renderedPointCount).toBe(2);
  expect(await page.locator("#cesium-container > .dev-session-mount").count()).toBe(1);
  console.info("WKT2 ellipsoidal Terrain fixture measurements", {
    estimateLatencyMs,
    applyLatencyMs,
    rangeRequests: 0,
    decodeDurationMs: appliedSnapshot.performance.decodeDurationMs,
    worker: appliedSnapshot.worker,
  });
});

test("rejects Terrain alignment for Autzen NAVD88 without moving the selected point", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openFixture(page, 250);
  const before = await pickRenderedPoint(page);
  await page.getByLabel("I confirm the selected point is ground").check();
  await page.getByRole("button", { name: "Estimate residual" }).click();
  const preview = page.locator("#terrain-estimate-preview");
  await expect(preview).toContainText("Estimate status: uncertain (current)");
  await expect(preview).toContainText("ControlledTerrainProvider");
  await expect(preview).toContainText("Vertical reference: EPSG:6360 → unverified");
  await expect(preview).toContainText("no validated transformation to WGS 84 ellipsoidal height");
  await expect(preview).toContainText("Sampling: 0 calls");
  await expect(page.getByRole("button", { name: "Apply proposed correction" })).toBeDisabled();
  const after = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__!.getSelectedPoint()!,
  );
  expect(after.height).toBe(before.height);
  expect(after.source).toEqual(before.source);
  expect(after.world).toEqual(before.world);
  expect(await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters)).toBe(0);
});

test("ellipsoid-only mode does not sample NAVD88 heights or move the selected point", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openFixture(page);
  const before = await pickRenderedPoint(page);
  await page.getByLabel("I confirm the selected point is ground").check();
  await page.getByRole("button", { name: "Estimate residual" }).click();
  const preview = page.locator("#terrain-estimate-preview");
  await expect(preview).toContainText("Estimate status: uncertain (current)");
  await expect(preview).toContainText("Vertical reference: EPSG:6360 → unverified");
  await expect(preview).toContainText("Terrain provider: EllipsoidTerrainProvider");
  await expect(preview).toContainText("Sampling: 0 calls");
  await expect(page.getByRole("button", { name: "Apply proposed correction" })).toBeDisabled();
  const after = await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getSelectedPoint());
  expect(after?.height).toBe(before.height);
  expect(after?.source?.z).toBe(before.source?.z);
  expect(await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters)).toBe(0);
});

import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

const demoFixturesAvailable =
  existsSync(new URL("../../../samples/local/demo-wgs84.copc.laz", import.meta.url)) &&
  existsSync(new URL("../../../samples/local/demo-projected.copc.laz", import.meta.url)) &&
  existsSync(new URL("../../../samples/local/demo-projected-ellipsoidal.copc.laz", import.meta.url));
const autzenFixtureAvailable = existsSync(new URL("../../../samples/local/autzen.copc.laz", import.meta.url));
const fixtureSetupCommand = "npm --prefix apps/dev-viewer run test:e2e:tiles";

type TilesDiagnostics = {
  status: string;
  sourceCrs: string;
  boundsSupport: string;
  boundsReason: string;
  boundsStrategy: string;
  boundsCoverage: string;
  geometryBoundsStatus: string;
  metadataOnlySourceCellStatus: string;
  metadataOnlySourceCellReason: string;
  sourceToEcefStatus: string;
  verticalPlacementStatus: string;
  verticalPlacementReason: string;
  contentPointsScanned: number;
  contentPointsTotal: number;
  sourceRangeBytesObserved: number;
  peakDecodedEcefBufferBytes: number;
  scanDurationMilliseconds: number;
  hierarchyNodes: number;
  glbRequests: number;
  loadedTiles: number;
  visibleTiles: number;
  renderedPoints: number;
  resourceBytes: number;
  glbBytes: number;
  error: string;
};

type DevViewerApi = {
  getSnapshot(): unknown;
  getConfiguration(): { pipeline: string; renderer: string };
  getTilesDiagnostics(): TilesDiagnostics | undefined;
  getTilesetUrl(): string | undefined;
  getCameraState(): {
    engine: string;
    longitudeDegrees?: number;
    latitudeDegrees?: number;
    heightMeters?: number;
  } | undefined;
};

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: DevViewerApi;
  }
}

async function hasDirectSnapshot(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => Boolean(window.__COPC_DEV_VIEWER__?.getSnapshot()));
}

async function getActivePipeline(page: import("@playwright/test").Page): Promise<string | undefined> {
  return page.evaluate(() => window.__COPC_DEV_VIEWER__?.getConfiguration().pipeline);
}

async function getTilesDiagnostics(page: import("@playwright/test").Page): Promise<TilesDiagnostics | undefined> {
  return page.evaluate(() => window.__COPC_DEV_VIEWER__?.getTilesDiagnostics());
}

async function getTilesetUrl(page: import("@playwright/test").Page): Promise<string | undefined> {
  return page.evaluate(() => window.__COPC_DEV_VIEWER__?.getTilesetUrl());
}

async function getCameraState(
  page: import("@playwright/test").Page,
): Promise<Awaited<ReturnType<DevViewerApi["getCameraState"]>>> {
  return page.evaluate(() => window.__COPC_DEV_VIEWER__?.getCameraState());
}

async function getFirstGlbUrl(page: import("@playwright/test").Page, tilesetUrl: string): Promise<string> {
  const tileset = await page.evaluate(async (url) =>
    await (await fetch(url)).json() as {
      root: { content?: { uri?: string }; children?: Array<{ content?: { uri?: string }; children?: unknown[] }> };
    }, tilesetUrl,
  );
  const findContentUri = (tile: { content?: { uri?: string }; children?: unknown[] }): string | undefined => {
    if (tile.content?.uri?.endsWith(".glb")) return tile.content.uri;
    for (const child of tile.children ?? []) {
      if (typeof child !== "object" || child === null) continue;
      const uri = findContentUri(child as { content?: { uri?: string }; children?: unknown[] });
      if (uri) return uri;
    }
    return undefined;
  };
  const uri = findContentUri(tileset.root);
  if (!uri) throw new Error("The active Tileset did not contain a GLB resource URI.");
  return new URL(uri, tilesetUrl).href;
}

test("correcting an invalid pipeline query recovers without a reload", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/?pipeline=invalid");
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "error");
  await expect(page.locator("#source-status")).toContainText("Unknown rendering pipeline");
  await expect(page.locator("#load-source")).toBeDisabled();

  await page.locator("#rendering-pipeline").selectOption("direct");
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "inactive");
  await expect(page.locator("#source-status")).toContainText("Configuration ready");
  await expect(page.locator("#load-source")).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test("Direct remains the default and the Cesium 3D Tiles pipeline renders generated COPC GLBs", async ({ page }) => {
  test.skip(!demoFixturesAvailable, `Run ${fixtureSetupCommand} to generate the ignored COPC fixtures.`);
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  let activeGlbUrl: string | undefined;
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/?source=/samples/demo-wgs84.copc.laz");
  await expect(page.locator("#rendering-pipeline")).toHaveValue("direct");
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
  await expect.poll(() => hasDirectSnapshot(page)).toBe(true);

  const filteringSection = page.locator('.schema-control-section[data-section="filtering"]');
  await filteringSection.locator("summary").click();
  await page.getByRole("checkbox", { name: "Use include list" }).check();
  const classificationInclude = page.getByLabel("Include codes (0–255)");
  await classificationInclude.fill("2");
  await page.locator("#rendering-pipeline").selectOption("tiles");
  await expect(page.locator("#configuration-error")).toContainText("Classification Filter");
  await expect(page.locator("#apply-settings")).toBeDisabled();
  await expect(page.locator("#load-source")).toBeDisabled();
  await expect(filteringSection).toHaveAttribute("aria-disabled", "true");
  await expect(classificationInclude).toBeDisabled();
  await expect(
    page.getByRole("radiogroup", { name: "Color mode" }).getByRole("radio", { name: "Elevation" }),
  ).toBeDisabled();

  await page.locator("#rendering-pipeline").selectOption("direct");
  await expect(classificationInclude).toBeEnabled();
  await expect(
    page.getByRole("radiogroup", { name: "Color mode" }).getByRole("radio", { name: "Elevation" }),
  ).toBeEnabled();
  await filteringSection.locator(".schema-special-classification button.schema-action").click();
  await expect(page.locator("#configuration-error")).toBeHidden();
  await page.locator("#rendering-pipeline").selectOption("tiles");
  await expect(page.locator("#apply-settings")).toBeEnabled();
  await expect(classificationInclude).toBeDisabled();
  await page.locator("#apply-settings").click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
  await expect(page.locator("#source-status")).toContainText("3D Tiles (Experimental)");
  await expect.poll(async () => (await getTilesDiagnostics(page))?.status).toBe("ready");
  await expect(
    page.getByRole("radiogroup", { name: "Color mode" }).getByRole("radio", { name: "Elevation" }),
  ).toBeDisabled();
  await expect(classificationInclude).toBeDisabled();

  const cesium = await getTilesDiagnostics(page);
  expect(cesium).toMatchObject({
    sourceCrs: "EPSG:4326",
    boundsSupport: "supported",
    status: "ready",
    error: "",
  });
  expect(cesium!.hierarchyNodes).toBeGreaterThan(1);
  expect(cesium!.glbRequests).toBeGreaterThan(1);
  expect(cesium!.loadedTiles).toBeGreaterThan(0);
  expect(cesium!.visibleTiles).toBeGreaterThan(0);
  expect(cesium!.renderedPoints).toBeGreaterThan(0);
  expect(cesium!.resourceBytes).toBeGreaterThan(0);
  expect(cesium!.glbBytes).toBeGreaterThan(0);
  await expect(page.locator(".dev-session-mount .cesium-widget canvas")).toBeVisible();
  await page.locator("#camera-control").locator("xpath=..").locator("summary").click();

  const initialCamera = await getCameraState(page);
  expect(initialCamera?.engine).toBe("cesium");
  await page.getByRole("radiogroup", { name: "Camera presets" }).getByRole("radio", { name: "Far" }).click();
  await expect.poll(async () => {
    const camera = await getCameraState(page);
    if (
      camera?.engine !== "cesium" ||
      typeof camera.longitudeDegrees !== "number" ||
      typeof camera.latitudeDegrees !== "number" ||
      typeof initialCamera?.longitudeDegrees !== "number" ||
      typeof initialCamera.latitudeDegrees !== "number"
    ) return 0;
    return Math.hypot(
      camera.longitudeDegrees - initialCamera.longitudeDegrees,
      camera.latitudeDegrees - initialCamera.latitudeDegrees,
    );
  }).toBeGreaterThan(0.001);
  await page.getByRole("radiogroup", { name: "Camera presets" }).getByRole("radio", { name: "Overview" }).click();
  await expect.poll(async () => {
    const camera = await getCameraState(page);
    if (
      camera?.engine !== "cesium" ||
      typeof camera.longitudeDegrees !== "number" ||
      typeof camera.latitudeDegrees !== "number" ||
      typeof initialCamera?.longitudeDegrees !== "number" ||
      typeof initialCamera.latitudeDegrees !== "number"
    ) return Number.POSITIVE_INFINITY;
    return Math.hypot(
      camera.longitudeDegrees - initialCamera.longitudeDegrees,
      camera.latitudeDegrees - initialCamera.latitudeDegrees,
    );
  }).toBeLessThan(0.001);

  await page.getByRole("tab", { name: "Health" }).click();
  const tilesDiagnosticsPanel = page.locator('[data-diagnostic-section="health-tiles-pipeline"]');
  await expect(tilesDiagnosticsPanel).toContainText("EPSG:4326");
  await expect(tilesDiagnosticsPanel.locator('[data-field="tilesBounds"]')).toHaveText("supported");
  await expect.poll(async () => Number((await tilesDiagnosticsPanel.locator('[data-field="tilesVisible"]').innerText()).replaceAll(",", ""))).toBeGreaterThan(0);
  await expect.poll(async () => Number((await tilesDiagnosticsPanel.locator('[data-field="tilesRenderedPoints"]').innerText()).replaceAll(",", ""))).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);

  await page.locator("#source-selection").selectOption("custom");
  const activeTilesetUrl = await getTilesetUrl(page);
  expect(activeTilesetUrl).toBeTruthy();
  activeGlbUrl = await getFirstGlbUrl(page, activeTilesetUrl!);
  const failedSourceUrl = new URL("/samples/demo-projected.copc.laz?failed-switch=1", page.url()).href;
  const failedSourceMatcher = (url: URL): boolean => url.href === failedSourceUrl;
  const abortFailedSource = (route: import("@playwright/test").Route): Promise<void> => route.abort();
  await page.route(failedSourceMatcher, abortFailedSource);
  await page.locator("#custom-source-url").fill(failedSourceUrl);
  await page.locator("#load-source").click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "error");
  await expect(page.locator("#configuration-error")).toBeVisible();
  await page.unroute(failedSourceMatcher, abortFailedSource);
  const retainedGlbUrl = activeGlbUrl!;
  const retainedGlbStatus = await page.evaluate(async (url) =>
    (await fetch(url)).status, retainedGlbUrl,
  );
  expect(retainedGlbStatus).toBe(200);

  await page.locator("#custom-source-url").fill(
    new URL("/samples/demo-wgs84.copc.laz?source-switch=1", page.url()).href,
  );
  await page.locator("#load-source").click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
  await expect.poll(async () => (await getTilesDiagnostics(page))?.status).toBe("ready");
  expect((await getTilesDiagnostics(page))?.glbRequests).toBeGreaterThan(1);

  await page.locator("#rendering-pipeline").selectOption("direct");
  await page.locator("#apply-settings").click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
  await expect(
    page.getByRole("radiogroup", { name: "Color mode" }).getByRole("radio", { name: "Elevation" }),
  ).toBeEnabled();
  await expect.poll(() => getActivePipeline(page)).toBe("direct");
  await expect.poll(() => hasDirectSnapshot(page)).toBe(true);
  await expect(page.locator(".dev-session-mount .cesium-widget canvas")).toHaveCount(1);

  expect(pageErrors).toEqual([]);
});

test("the same Tiles pipeline works with the Three.js renderer", async ({ page }) => {
  test.skip(!demoFixturesAvailable, `Run ${fixtureSetupCommand} to generate the ignored COPC fixtures.`);
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/?source=/samples/demo-wgs84.copc.laz&pipeline=tiles&renderer=three");
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
  await expect(page.locator("#source-status")).toContainText("3D Tiles (Experimental)");
  await expect.poll(async () => (await getTilesDiagnostics(page))?.status).toBe("ready");

  const three = await getTilesDiagnostics(page);
  expect(three?.sourceCrs).toBe("EPSG:4326");
  expect(three?.boundsSupport).toBe("supported");
  expect(three!.hierarchyNodes).toBeGreaterThan(1);
  expect(three!.glbRequests).toBeGreaterThan(1);
  expect(three!.loadedTiles).toBeGreaterThan(0);
  expect(three!.visibleTiles).toBeGreaterThan(0);
  expect(three!.renderedPoints).toBeGreaterThan(0);
  await expect(page.locator(".dev-session-mount .tiles-renderer-canvas")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("unsupported projected COPC reports its conservative bounds reason before any GLB request", async ({ page }) => {
  test.skip(!demoFixturesAvailable, `Run ${fixtureSetupCommand} to generate the ignored COPC fixtures.`);
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/?source=/samples/demo-projected.copc.laz&pipeline=tiles");
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "error");
  await expect.poll(async () => (await getTilesDiagnostics(page))?.status).toBe("error");

  const projected = await getTilesDiagnostics(page);
  expect(projected).toMatchObject({
    status: "error",
    sourceCrs: "EPSG:32611",
    boundsSupport: "unsupported",
  });
  expect(projected!.boundsReason).toContain("unsupported-horizontal-crs");
  expect(projected!.glbRequests).toBe(0);
  expect(projected!.glbBytes).toBe(0);

  await page.getByRole("tab", { name: "Health" }).click();
  const tilesDiagnosticsPanel = page.locator('[data-diagnostic-section="health-tiles-pipeline"]');
  await expect(tilesDiagnosticsPanel.locator('[data-field="tilesBounds"]')).toHaveText("unsupported");
  await expect(tilesDiagnosticsPanel.locator('[data-field="tilesBoundsReason"]')).toContainText("unsupported-horizontal-crs");
  await expect(tilesDiagnosticsPanel.locator('[data-field="tilesRequested"]')).toHaveText("0");
  expect(pageErrors).toEqual([]);
});

for (const renderer of ["cesium", "three"] as const) {
  test(`projected EPSG:32611 content envelopes render through ${renderer} and disclose unverified height`, async ({ page }) => {
    test.skip(!demoFixturesAvailable, `Run ${fixtureSetupCommand} to generate the ignored COPC fixtures.`);
    test.setTimeout(240_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`/?source=/samples/demo-projected.copc.laz&renderer=${renderer}`);
    await expect(page.locator("#rendering-pipeline")).toHaveValue("direct");
    await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
    await expect.poll(() => hasDirectSnapshot(page)).toBe(true);

    await page.locator("#tiles-bounds-strategy").selectOption("decoded-content");
    await page.locator("#rendering-pipeline").selectOption("tiles");
    await page.locator("#apply-settings").click();
    await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready", { timeout: 150_000 });
    await expect.poll(async () => (await getTilesDiagnostics(page))?.status, { timeout: 150_000 }).toBe("ready");

    const diagnostics = await getTilesDiagnostics(page);
    expect(diagnostics).toMatchObject({
      status: "ready",
      sourceCrs: "EPSG:32611",
      boundsSupport: "supported",
      boundsStrategy: "decoded-content",
      boundsCoverage: "rendered-content-only",
      geometryBoundsStatus: "complete-decoded-content",
      metadataOnlySourceCellStatus: "unsupported",
      sourceToEcefStatus: "prepared-by-core",
      verticalPlacementStatus: "unverified",
      contentPointsScanned: 131_072,
      contentPointsTotal: 131_072,
      error: "",
    });
    expect(diagnostics!.boundsReason).toContain("do not cover unobserved source cells");
    expect(diagnostics!.verticalPlacementReason).toMatch(/not verified|unknown/i);
    expect(diagnostics!.hierarchyNodes).toBeGreaterThan(1);
    expect(diagnostics!.glbRequests).toBeGreaterThan(1);
    expect(diagnostics!.loadedTiles).toBeGreaterThan(0);
    expect(diagnostics!.visibleTiles).toBeGreaterThan(0);
    expect(diagnostics!.renderedPoints).toBeGreaterThan(0);
    expect(diagnostics!.glbBytes).toBeGreaterThan(0);
    expect(diagnostics!.sourceRangeBytesObserved).toBeGreaterThan(0);
    expect(diagnostics!.peakDecodedEcefBufferBytes).toBeGreaterThan(0);
    expect(diagnostics!.scanDurationMilliseconds).toBeGreaterThanOrEqual(0);
    console.log(`Projected ${renderer} decoded-content fixture: ${diagnostics!.contentPointsScanned.toLocaleString()} points, ${diagnostics!.hierarchyNodes} tileset nodes, ${diagnostics!.sourceRangeBytesObserved.toLocaleString()} observed source Range bytes, ${diagnostics!.peakDecodedEcefBufferBytes.toLocaleString()} peak returned ECEF-buffer bytes, ${diagnostics!.scanDurationMilliseconds.toFixed(1)} ms preprocessing, ${diagnostics!.glbRequests} GLB requests / ${diagnostics!.glbBytes.toLocaleString()} bytes.`);
    await expect.poll(async () => getActivePipeline(page)).toBe("tiles");
    await page.getByRole("tab", { name: "Health" }).click();
    const health = page.locator('[data-diagnostic-section="health-tiles-pipeline"]');
    await expect(health.locator('[data-field="tilesBounds"]')).toHaveText("supported");
    await expect(health.locator('[data-field="tilesBoundsStrategy"]')).toHaveText("decoded-content");
    await expect(health.locator('[data-field="tilesBoundsCoverage"]')).toHaveText("rendered-content-only");
    await expect(health.locator('[data-field="tilesMetadataOnlyBounds"]')).toContainText("unsupported");
    await expect(health.locator('[data-field="tilesMetadataOnlyBounds"]')).toContainText("unsupported-horizontal-crs");
    await expect(health.locator('[data-field="tilesVerticalPlacement"]')).toContainText("unverified");
    await expect(health.locator('[data-field="tilesContentScan"]')).toContainText("131,072/131,072 points");
    await expect(page.locator(renderer === "cesium"
      ? ".dev-session-mount .cesium-widget canvas"
      : ".dev-session-mount .tiles-renderer-canvas")).toBeVisible();

    await page.locator("#camera-control").locator("xpath=..").locator("summary").click();
    const initialCamera = await getCameraState(page);
    expect(initialCamera?.engine).toBe(renderer);
    await page.getByRole("radiogroup", { name: "Camera presets" }).getByRole("radio", { name: "Far" }).click();
    await expect.poll(async () => {
      const camera = await getCameraState(page);
      if (camera?.engine === "cesium" && initialCamera?.engine === "cesium") {
        return Math.hypot(
          (camera.longitudeDegrees ?? 0) - initialCamera.longitudeDegrees,
          (camera.latitudeDegrees ?? 0) - initialCamera.latitudeDegrees,
          (camera.heightMeters ?? 0) - initialCamera.heightMeters,
        );
      }
      if (camera?.engine === "three" && initialCamera?.engine === "three") {
        return Math.hypot(...camera.state.position.map((value, axis) => value - initialCamera.state.position[axis]!));
      }
      return 0;
    }).toBeGreaterThan(0.01);

    await page.locator("#rendering-pipeline").selectOption("direct");
    await page.locator("#apply-settings").click();
    await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
    await expect.poll(() => getActivePipeline(page)).toBe("direct");
    await expect.poll(() => hasDirectSnapshot(page)).toBe(true);
    expect(pageErrors).toEqual([]);
  });
}

test("projected EPSG:32611 with explicitly declared ellipsoidal metres reports verified vertical provenance", async ({ page }) => {
  test.skip(!demoFixturesAvailable, `Run ${fixtureSetupCommand} to generate the ignored COPC fixtures.`);
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/?source=/samples/demo-projected-ellipsoidal.copc.laz&pipeline=tiles&tilesBounds=decoded-content&renderer=three");
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
  await expect.poll(async () => (await getTilesDiagnostics(page))?.status).toBe("ready");

  const diagnostics = await getTilesDiagnostics(page);
  expect(diagnostics).toMatchObject({
    sourceCrs: "EPSG:32611",
    boundsSupport: "supported",
    boundsStrategy: "decoded-content",
    boundsCoverage: "rendered-content-only",
    geometryBoundsStatus: "complete-decoded-content",
    metadataOnlySourceCellStatus: "unsupported",
    verticalPlacementStatus: "verified",
    contentPointsScanned: 131_072,
    contentPointsTotal: 131_072,
    error: "",
  });
  expect(diagnostics!.verticalPlacementReason).toContain("explicitly declares WGS 84 ellipsoidal height");
  expect(diagnostics!.verticalPlacementReason).toContain("does not claim survey-grade accuracy");
  expect(diagnostics!.hierarchyNodes).toBeGreaterThan(1);
  expect(diagnostics!.glbRequests).toBeGreaterThan(1);
  expect(diagnostics!.visibleTiles).toBeGreaterThan(0);
  expect(diagnostics!.renderedPoints).toBeGreaterThan(0);
  await expect(page.locator(".dev-session-mount .tiles-renderer-canvas")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("bounded full Autzen decoded-content scan accounts for the complete hierarchy and on-demand GLBs", async ({ page }) => {
  test.skip(!autzenFixtureAvailable, "Run `npm run download-samples -- autzen` to download the local Autzen COPC fixture.");
  test.setTimeout(600_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("Autzen")) console.log(message.text());
  });

  await page.goto("/autzen-decoded-scan.validation.html");
  await expect.poll(async () => page.locator("#result").getAttribute("data-status"), { timeout: 540_000 })
    .toMatch(/^(complete|failure)$/);
  const summaryJson = await page.locator("#result").getAttribute("data-summary");
  expect(summaryJson, "the scan harness publishes a machine-readable final diagnostic").toBeTruthy();
  const summary = JSON.parse(summaryJson!) as {
    status?: string;
    coverage?: string;
    sourceCrs?: { identifier?: string };
    verticalDatum?: { status?: string; identifier?: string };
    verticalPlacement?: string;
    metadataOnlySourceCellStatus?: string;
    metadataOnlySourceCellReasonCode?: string;
    hierarchyNodes?: number;
    contentNodes?: number;
    points?: number;
    pointDataBytes?: number;
    ecefBytesScanned?: number;
    peakReturnedEcefBytes?: number;
    sourceRangeBytesIncludingGlbs?: number;
    sourceRangeCalls?: number;
    preprocessingMilliseconds?: number;
    endToEndMilliseconds?: number;
    glbs?: Array<{ nodeKey: string; pointCount: number; glbBytes: number }>;
  };
  expect(summary.status).toBe("complete");
  expect(summary.coverage).toBe("all-content-points-in-complete-hierarchy");
  expect(summary.sourceCrs?.identifier).toContain("EPSG:2992");
  expect(summary.verticalDatum).toMatchObject({ status: "unknown", identifier: "EPSG:6360" });
  expect(summary.verticalPlacement).toBe("unverified");
  expect(summary.metadataOnlySourceCellStatus).toBe("unsupported");
  expect(summary.metadataOnlySourceCellReasonCode).toBe("unsupported-horizontal-crs");
  expect(summary.hierarchyNodes).toBeGreaterThan(1);
  expect(summary.contentNodes).toBe(summary.hierarchyNodes);
  expect(summary.points).toBe(10_653_336);
  expect(summary.pointDataBytes).toBeGreaterThan(0);
  expect(summary.ecefBytesScanned).toBe(summary.points! * 3 * Float64Array.BYTES_PER_ELEMENT);
  expect(summary.peakReturnedEcefBytes).toBeLessThan(summary.ecefBytesScanned!);
  expect(summary.sourceRangeBytesIncludingGlbs).toBeGreaterThan(0);
  expect(summary.sourceRangeCalls).toBeGreaterThan(0);
  expect(summary.preprocessingMilliseconds).toBeGreaterThan(0);
  expect(summary.endToEndMilliseconds).toBeGreaterThanOrEqual(summary.preprocessingMilliseconds!);
  expect(summary.glbs).toHaveLength(3);
  for (const glb of summary.glbs!) {
    expect(glb.pointCount).toBeGreaterThan(0);
    expect(glb.glbBytes).toBeGreaterThan(0);
  }
  expect(pageErrors).toEqual([]);
  console.log(`Real Autzen complete content scan: ${summary.points!.toLocaleString()} points / ${summary.hierarchyNodes} hierarchy nodes / ${summary.pointDataBytes!.toLocaleString()} declared point-data bytes / ${summary.ecefBytesScanned!.toLocaleString()} ECEF bytes scanned / ${summary.peakReturnedEcefBytes!.toLocaleString()} peak ECEF bytes / ${summary.sourceRangeBytesIncludingGlbs!.toLocaleString()} source Range bytes in ${summary.sourceRangeCalls} calls / ${summary.preprocessingMilliseconds} ms preprocessing / ${summary.endToEndMilliseconds} ms end-to-end; vertical placement unverified; GLBs=${summary.glbs!.map(({ nodeKey, pointCount, glbBytes }) => `${nodeKey}:${pointCount}:${glbBytes}`).join(",")}.`);
});

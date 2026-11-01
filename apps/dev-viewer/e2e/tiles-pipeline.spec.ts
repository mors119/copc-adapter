import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

const demoFixturesAvailable =
  existsSync(new URL("../../../samples/local/demo-wgs84.copc.laz", import.meta.url)) &&
  existsSync(new URL("../../../samples/local/demo-projected.copc.laz", import.meta.url));
const fixtureSetupCommand = "npm --prefix apps/dev-viewer run test:e2e:tiles";

type TilesDiagnostics = {
  status: string;
  sourceCrs: string;
  boundsSupport: string;
  boundsReason: string;
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
  await page.locator("#custom-source-url").fill(
    new URL("/samples/demo-projected.copc.laz?failed-switch=1", page.url()).href,
  );
  await page.locator("#load-source").click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "error");
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

  await page.locator("#rendering-pipeline").selectOption("tiles");
  await page.locator("#apply-settings").click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
  await expect.poll(async () => (await getTilesDiagnostics(page))?.status).toBe("ready");
  expect((await getTilesDiagnostics(page))?.visibleTiles).toBeGreaterThan(0);

  await page.locator("#rendering-pipeline").selectOption("direct");
  await page.locator("#apply-settings").click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready");
  await expect.poll(() => getActivePipeline(page)).toBe("direct");
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

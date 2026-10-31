import { expect, test } from "@playwright/test";
import type { CopcPointInspection } from "@frillab/copc-adapter/cesium";

type TerrainHooks = {
  useTerrainAlignmentMock(): void;
  setMockSelectedPoint(point: CopcPointInspection | undefined): void;
  getMockSelectedPoint(): CopcPointInspection | undefined;
  delayNextTerrainEstimate(): void;
  failNextLoad(): void;
  getAppliedConfig(): { heightOffsetMeters: number; pointSize: number; terrainUrl: string } | undefined;
  getPendingConfig(): { heightOffsetMeters: number; pointSize: number };
  getMockLayerHeightOffsetMeters(): number | undefined;
  getMockLayerSettings(): { pointSize?: number } | undefined;
};

test("explains Three.js and ellipsoid-only Terrain limits without enabling sampling", async ({
  page,
}) => {
  await page.goto("./");
  const coordinates = page.locator('#shared-schema-controls details[data-section="coordinates"]');
  if (!(await coordinates.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await coordinates.locator("summary").click();
  }
  const renderer = page.getByRole("radiogroup", { name: "Renderer" });
  await renderer.getByRole("radio", { name: "Three.js" }).click();
  await expect(page.locator("#terrain-provider-url")).toBeDisabled();
  await expect(page.locator(".terrain-alignment-command__selection")).toContainText(
    "unavailable in Three.js mode",
  );
  await expect(page.getByRole("button", { name: "Estimate Terrain" })).toBeDisabled();

  await renderer.getByRole("radio", { name: "Cesium" }).click();
  await expect(page.locator("#terrain-provider-url")).toBeEnabled();
  await expect(page.locator(".terrain-alignment-command__provider")).toContainText(
    "WGS84 ellipsoid only",
  );
  await expect(page.getByRole("button", { name: "Estimate Terrain" })).toBeDisabled();
});

test("Terrain approval preserves pending edits and copies only the approved placement", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("./?heightOffsetMeters=0.5");
  await page.evaluate(() => {
    const hooks = (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable");
    hooks.useTerrainAlignmentMock();
  });
  await page.locator("#copc-file").setInputFiles({
    name: "terrain-alignment.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("mock COPC source"),
  });
  await expect(page.locator("#source-status")).toHaveText("Loaded terrain-alignment.copc.laz");
  await expect
    .poll(() => page.evaluate(() =>
      (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
        .__COPC_PLAYGROUND_TEST__?.getMockLayerHeightOffsetMeters(),
    ))
    .toBe(0.5);
  await page.locator("#point-size-value").fill("5");
  await page.locator("#point-size-value").dispatchEvent("change");
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getPendingConfig().pointSize,
  )).toBe(5);
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getAppliedConfig()?.pointSize,
  )).toBe(3);

  const point: CopcPointInspection = {
    ownerId: "fixture-owner",
    nodeKey: "0-0-0-0",
    level: 0,
    pointIndex: 7,
    longitude: -122.4,
    latitude: 44.1,
    height: 100,
    source: { x: 500_000, y: 4_900_000, z: 100 },
    classification: 6,
    backend: "copc-js",
  };
  await page.evaluate((selected) => {
    const hooks = (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__;
    hooks?.setMockSelectedPoint(selected);
  }, point);

  const coordinates = page.locator('#shared-schema-controls details[data-section="coordinates"]');
  if (!(await coordinates.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await coordinates.locator("summary").click();
  }
  const preview = page.locator("#terrain-alignment-preview");
  const estimateButton = page.getByRole("button", { name: "Estimate Terrain" });
  await page.evaluate((selected) => {
    const hooks = (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__;
    hooks?.setMockSelectedPoint({ ...selected, longitude: 181 });
  }, point);
  await expect(page.locator(".terrain-alignment-command__message")).toContainText(
    "invalid identity or coordinates",
  );
  await expect(estimateButton).toBeDisabled();
  await page.evaluate((selected) => {
    const hooks = (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__;
    hooks?.setMockSelectedPoint(selected);
  }, point);
  await expect(page.getByLabel("I confirm the selected point is ground")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add selected anchor" })).toBeHidden();
  await expect(page.locator(".terrain-alignment-command__provider")).toContainText(
    "supports one anchor per estimate; batch estimates are unavailable",
  );
  await expect(estimateButton).toBeDisabled();

  await page.getByLabel("I confirm the selected point is ground").check();
  await expect(estimateButton).toBeEnabled();
  await page.evaluate(() => {
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.delayNextTerrainEstimate();
  });
  await estimateButton.click();
  await page.getByRole("button", { name: "Cancel estimate" }).click();
  await expect(preview).toContainText("Estimate: cancelled");
  await expect(page.getByRole("button", { name: "Approve and apply" })).toBeDisabled();

  await estimateButton.click();
  await expect(preview).toContainText("Estimate: ready · current");
  await expect(preview).toContainText("FixtureTerrainProvider");
  await expect(preview).toContainText("Additional Terrain offset: 2.000 m");
  await expect(preview).toContainText("Existing manual heightOffsetMeters: 0.500 m");
  await expect(preview).toContainText("Proposed total heightOffsetMeters: 2.500 m");
  const adjustment = page.locator("#terrain-fine-adjustment");
  await adjustment.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "25";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(preview).toContainText("Final heightOffsetMeters after approval: 2.750 m");

  await page.locator("#include-terrain-alignment-recipe").check();
  await expect(page.locator("#integration-example")).not.toContainText(
    "Terrain placement provenance",
  );
  await expect(page.locator("#integration-example")).toContainText("heightOffsetMeters: 0.5");
  await expect
    .poll(() => page.evaluate(() =>
      (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
        .__COPC_PLAYGROUND_TEST__?.getAppliedConfig()?.heightOffsetMeters,
    ))
    .toBe(0.5);
  await expect
    .poll(() => page.evaluate(() =>
      (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
        .__COPC_PLAYGROUND_TEST__?.getMockLayerHeightOffsetMeters(),
    ))
    .toBe(0.5);
  await page.evaluate(() => {
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.failNextLoad();
  });
  await page.getByRole("button", { name: "Approve and apply" }).click();
  await expect(page.locator("#source-status")).toContainText(
    "Could not load terrain-alignment.copc.laz",
  );
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getAppliedConfig()?.heightOffsetMeters,
  )).toBe(0.5);
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getPendingConfig(),
  )).toMatchObject({ heightOffsetMeters: 2.75, pointSize: 5 });
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLayerSettings()?.pointSize,
  )).toBe(3);

  await estimateButton.click();
  await expect(preview).toContainText("Estimate: ready · current");
  await expect(preview).toContainText("Existing manual heightOffsetMeters: 0.500 m");
  await adjustment.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "25";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Approve and apply" }).click();
  await expect
    .poll(() => page.evaluate(() =>
      (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
        .__COPC_PLAYGROUND_TEST__?.getAppliedConfig()?.heightOffsetMeters,
    ))
    .toBe(2.75);
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getAppliedConfig()?.pointSize,
  )).toBe(3);
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getPendingConfig(),
  )).toMatchObject({ heightOffsetMeters: 2.75, pointSize: 5 });
  await expect
    .poll(() => page.evaluate(() =>
      (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
        .__COPC_PLAYGROUND_TEST__?.getMockLayerHeightOffsetMeters(),
    ))
    .toBe(2.75);
  await expect(page.locator("#integration-example")).toContainText(
    "Terrain placement provenance: the user explicitly approved a Cesium Terrain residual of 2 m; the final heightOffsetMeters is 2.75 m",
  );
  await expect(page.locator("#integration-example")).toContainText(
    "estimateAndApproveTerrainPlacement",
  );
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockSelectedPoint()?.source,
  )).toEqual(point.source);
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: TerrainHooks })
      .__COPC_PLAYGROUND_TEST__?.getAppliedConfig()?.terrainUrl,
  )).toBe("");
});

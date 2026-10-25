import { expect, test, type Page } from "@playwright/test";

type FunctionalState = {
  viewerReady: boolean;
  layerLoaded: boolean;
  datasetUrl: string;
  renderedPointCount: number;
  scenePointCollectionCount: number;
  selectedNodeKeys: string[];
  renderedNodeKeys: string[];
  streamingUpdateCount: number;
  cameraMoveEventCount: number;
  transition: {
    activeReplacementGroupCount: number;
    refinementReplacementCommitCount: number;
    coarseNodesRetainedForCoverageCount: number;
  };
  performance: {
    activeNodeCount: number;
    updateDurationMs: number;
    configuredPointBudget: number;
    activeRenderedPointCount: number;
    acceptedRefinementCount: number;
    visibleLevelRange?: { min: number; max: number };
  };
  pointCache: {
    cacheByteBudget: number;
    currentCacheBytes: number;
    cachedNodeCount: number;
    hits: number;
    misses: number;
  };
  hierarchy: {
    pageRequests: number;
    pageCacheHits: number;
    loadedPageCount: number;
    loadedEntryCount: number;
  };
  rangeRequests: {
    requested: number;
    active: number;
    completed: number;
    failed: number;
  };
  selectedPoint?: {
    nodeKey: string;
    pointIndex: number;
    longitude: number;
    latitude: number;
  };
  lastError?: string;
};

type CopcDebugAdapter = {
  getState(): FunctionalState;
  getStyle(): { colorMode: string };
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: CopcDebugAdapter;
  }
}

type CapturedRangeResponse = {
  requestedRange?: string;
  status: number;
  contentRange?: string;
};

async function getState(page: Page): Promise<FunctionalState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) {
      throw new Error("COPC debug adapter is unavailable");
    }
    return window.__COPC_DEBUG__.getState();
  });
}

async function moveAndSettle(
  page: Page,
  preset: "overview" | "far" | "near",
  before: FunctionalState,
): Promise<FunctionalState> {
  const label = preset[0]!.toUpperCase() + preset.slice(1);
  await page
    .getByRole("radiogroup", { name: "Camera presets" })
    .getByRole("radio", { name: label })
    .click();
  await expect
    .poll(async () => (await getState(page)).cameraMoveEventCount)
    .toBeGreaterThan(before.cameraMoveEventCount);
  await expect
    .poll(async () => (await getState(page)).streamingUpdateCount)
    .toBeGreaterThan(before.streamingUpdateCount);
  await expect
    .poll(async () => (await getState(page)).performance.updateDurationMs)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const state = await getState(page);
      return (
        state.transition.activeReplacementGroupCount === 0 &&
        state.performance.activeNodeCount === 0 &&
        state.rangeRequests.active === 0
      );
    })
    .toBe(true);
  return getState(page);
}

function hasDifferentViewState(
  first: FunctionalState,
  second: FunctionalState,
): boolean {
  return (
    JSON.stringify(first.selectedNodeKeys) !==
      JSON.stringify(second.selectedNodeKeys) ||
    JSON.stringify(first.performance.visibleLevelRange) !==
      JSON.stringify(second.performance.visibleLevelRange)
  );
}

test("validates the eight core behaviors in the default Cesium viewer", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const pageErrors: Error[] = [];
  const rangeResponses: CapturedRangeResponse[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("response", (response) => {
    const url = new URL(response.url());
    const requestedRange = response.request().headers().range;
    if (requestedRange && url.pathname.endsWith("autzen.copc.laz")) {
      rangeResponses.push({
        requestedRange,
        status: response.status(),
        contentRange: response.headers()["content-range"],
      });
    }
  });

  const renderer =
    process.env.COPC_RENDERER_VARIANT === "public-batched"
      ? "?renderer=public-batched"
      : "";
  await page.goto(`/${renderer}`);
  await page.getByRole("tab", { name: "Data" }).click();
  await page
    .locator(".dev-control-section")
    .filter({ has: page.getByText("Camera presets", { exact: true }) })
    .locator("summary")
    .click();

  const debugPanel = page.getByRole("complementary", {
    name: "COPC runtime debug panel",
  });
  const pointInspector = page.getByRole("region", {
    name: "COPC point inspector",
  });

  await test.step("1. Load and render the original COPC source", async () => {
    expect(new URL(page.url()).search).toBe(renderer);
    await expect(debugPanel).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Camera presets" }),
    ).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Color mode" }),
    ).toBeVisible();
    await expect(pointInspector).toBeVisible();
    await expect
      .poll(() => getState(page))
      .toMatchObject({
        viewerReady: true,
        layerLoaded: true,
      });
    await expect
      .poll(async () => (await getState(page)).renderedPointCount)
      .toBeGreaterThan(0);

    const state = await getState(page);
    expect(state.datasetUrl).toContain("/samples/autzen.copc.laz");
    if (!renderer) expect(state.scenePointCollectionCount).toBeGreaterThan(0);
    expect(
      await page.evaluate(() => window.__COPC_DEBUG__!.getStyle().colorMode),
    ).toBe("rgb");
  });

  await test.step("2. Receive actual HTTP 206 Range responses", async () => {
    await expect.poll(() => rangeResponses.length).toBeGreaterThan(0);
    const response = rangeResponses.find(
      (candidate) => candidate.status === 206,
    );
    expect(
      response,
      "the local COPC source should return HTTP 206",
    ).toBeDefined();
    expect(response?.contentRange).toMatch(/^bytes \d+-\d+\/\d+$/);

    const requested = /^bytes=(\d+)-(\d*)$/.exec(
      response?.requestedRange ?? "",
    );
    const returned = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response?.contentRange ?? "",
    );
    expect(requested).not.toBeNull();
    expect(returned).not.toBeNull();
    expect(Number(returned?.[1])).toBe(Number(requested?.[1]));
    if (requested?.[2]) {
      expect(Number(returned?.[2])).toBe(Number(requested[2]));
    }

    const state = await getState(page);
    expect(state.rangeRequests.requested).toBeGreaterThan(0);
    expect(state.rangeRequests.completed).toBeGreaterThan(0);
    expect(state.rangeRequests.failed).toBe(0);
  });

  let farState!: FunctionalState;
  let overviewState!: FunctionalState;
  let nearState!: FunctionalState;
  await test.step("3. Move the camera and observe hierarchy and node selection", async () => {
    const before = await getState(page);
    farState = await moveAndSettle(page, "far", before);
    expect(
      farState.selectedNodeKeys.length,
      JSON.stringify(farState),
    ).toBeGreaterThan(0);
    expect(farState.hierarchy.loadedEntryCount).toBeGreaterThan(0);
    expect(
      hasDifferentViewState(before, farState) ||
        farState.hierarchy.pageRequests > before.hierarchy.pageRequests ||
        farState.hierarchy.pageCacheHits > before.hierarchy.pageCacheHits,
    ).toBe(true);
  });

  await test.step("4. Change visible LoD between overview and near views", async () => {
    overviewState = await moveAndSettle(page, "overview", farState);
    nearState = await moveAndSettle(page, "near", overviewState);
    expect(hasDifferentViewState(overviewState, nearState)).toBe(true);
    expect(nearState.renderedPointCount).toBeGreaterThan(0);
    expect(nearState.streamingUpdateCount).toBeGreaterThan(
      overviewState.streamingUpdateCount,
    );
  });

  await test.step("5. Verify finer nodes are accepted and the transition settles", async () => {
    expect(nearState.transition.activeReplacementGroupCount).toBe(0);
    expect(nearState.performance.acceptedRefinementCount).toBeGreaterThan(
      overviewState.performance.acceptedRefinementCount,
    );
    expect(nearState.performance.visibleLevelRange?.max).toBeGreaterThan(
      overviewState.performance.visibleLevelRange?.max ?? -1,
    );
  });

  await test.step("6. Respect point and cache budgets while reusing cached nodes", async () => {
    const beforeReturn = nearState.pointCache;
    const farAgain = await moveAndSettle(page, "far", nearState);
    const returnedNear = await moveAndSettle(page, "near", farAgain);
    expect(returnedNear.performance.configuredPointBudget).toBeGreaterThan(0);
    expect(
      returnedNear.performance.activeRenderedPointCount,
    ).toBeLessThanOrEqual(returnedNear.performance.configuredPointBudget);
    expect(returnedNear.pointCache.currentCacheBytes).toBeLessThanOrEqual(
      returnedNear.pointCache.cacheByteBudget,
    );
    expect(returnedNear.pointCache.hits).toBeGreaterThan(beforeReturn.hits);
    nearState = returnedNear;
  });

  await test.step("7. Use all four visible color modes from cached data", async () => {
    const beforeStyles = await getState(page);
    const styleModes = [
      "rgb",
      "elevation",
      "intensity",
      "classification",
    ] as const;
    for (const mode of styleModes) {
      const label =
        mode === "rgb"
          ? "RGB"
          : mode === "elevation"
            ? "Elevation"
            : mode === "intensity"
              ? "Intensity"
              : "Class";
      const radio = page
        .getByRole("radiogroup", { name: "Color mode" })
        .getByRole("radio", { name: label });
      await radio.click();
      await expect(radio).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(() =>
          page.evaluate(() => window.__COPC_DEBUG__?.getStyle().colorMode),
        )
        .toBe(mode);
      const state = await getState(page);
      expect(state.layerLoaded).toBe(true);
      expect(state.renderedPointCount).toBeGreaterThan(0);
      expect(state.lastError).toBeUndefined();
    }

    const afterStyles = await getState(page);
    expect(afterStyles.rangeRequests.requested).toBe(
      beforeStyles.rangeRequests.requested,
    );
    expect(afterStyles.pointCache.misses).toBe(beforeStyles.pointCache.misses);
  });

  await test.step("8. Pick a rendered point and inspect its source attributes", async () => {
    const currentState = await getState(page);
    await moveAndSettle(page, "overview", currentState);
    await expect
      .poll(async () =>
        page.evaluate(() =>
          window.__COPC_DEBUG__?.getPickablePointScreenPosition(),
        ),
      )
      .toBeTruthy();
    const position = await page.evaluate(() =>
      window.__COPC_DEBUG__?.getPickablePointScreenPosition(),
    );
    expect(position).toBeDefined();
    const canvasBounds = await page
      .locator("#cesium-container canvas")
      .first()
      .boundingBox();
    expect(canvasBounds).not.toBeNull();
    await page.mouse.click(
      (canvasBounds?.x ?? 0) + position!.x,
      (canvasBounds?.y ?? 0) + position!.y,
    );
    await expect
      .poll(async () => (await getState(page)).selectedPoint)
      .toMatchObject({
        nodeKey: expect.any(String),
        pointIndex: expect.any(Number),
      });

    for (const field of [
      "nodeKey",
      "level",
      "pointIndex",
      "longitude",
      "latitude",
    ]) {
      await expect(
        pointInspector.locator(`[data-field="${field}"]`),
      ).not.toBeEmpty();
    }
    for (const field of [
      "height",
      "source",
      "intensity",
      "classification",
      "rgb",
    ]) {
      await expect(
        pointInspector.locator(`[data-field="${field}"]`),
      ).not.toBeEmpty();
    }
  });

  const finalState = await getState(page);
  expect(finalState.viewerReady).toBe(true);
  expect(finalState.layerLoaded).toBe(true);
  expect(finalState.lastError).toBeUndefined();
  expect(pageErrors).toEqual([]);
});

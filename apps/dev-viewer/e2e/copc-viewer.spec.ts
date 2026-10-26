import { expect, test } from "./ci-diagnostic-fixtures";
import type {
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
} from "../../../packages/index";
import { getCompletedStreamingState } from "./streaming-state";

type CopcDebugState = {
  viewerReady: boolean;
  layerLoaded: boolean;
  metadataPointCount?: number;
  renderedPointCount: number;
  scenePointCollectionCount: number;
  renderedNodeKeys: string[];
  selectedNodeKeys: string[];
  transition: {
    activeReplacementGroupCount: number;
    replacementGroupsWaitingCount: number;
    refinementReplacementCommitCount: number;
    collapseReplacementCommitCount: number;
    staleReplacementCancellationCount: number;
    coarseNodesRetainedForCoverageCount: number;
  };
  streamingUpdateCount: number;
  cameraMoveEventCount: number;
  cameraPitchDegrees: number;
  minRenderedHeight?: number;
  maxRenderedHeight?: number;
  renderedColorCount: number;
  selectedPoint?: {
    nodeKey: string;
    level: number;
    pointIndex: number;
    longitude: number;
    latitude: number;
    height: number;
    source?: { x: number; y: number; z: number };
    world?: { x: number; y: number; z: number };
    classification?: number;
    intensity?: number;
    rgb?: { red: number; green: number; blue: number };
  };
  lastError?: string;
  backend: "copc-js" | "rust" | "custom";
  performance: Record<string, number>;
  pointCache: {
    cacheByteBudget: number;
    currentCacheBytes: number;
    cachedNodeCount: number;
    hits: number;
    misses: number;
    evictionCount: number;
    bytesEvicted: number;
    largestCachedEntryBytes: number;
  };
  rangeRequests: {
    requested: number;
    active: number;
    completed: number;
    failed: number;
    abortedSuperseded: number;
    abortedLifecycle: number;
  };
  hierarchy: {
    pageRequests: number;
    pageCacheHits: number;
    hierarchyBytesFetched: number;
    loadedPageCount: number;
    loadedEntryCount: number;
  };
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
};

type CopcDebugAdapter = {
  getState(): CopcDebugState;
  getStyle(): CopcCesiumPointStyle;
  setStyle(update: CopcCesiumPointStyleUpdate): void;
  getLastError(): string | undefined;
  setCameraHeight(height: number): void;
  setCameraPitch(pitchDegrees: number): void;
  setCameraHeading(headingDegrees: number): void;
  recordError(error: unknown): void;
  runSyntheticRendererPerformanceBenchmark(): Array<Record<string, unknown>>;
  setGlobeVisible(visible: boolean): void;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: CopcDebugAdapter;
  }
}

async function getDebugState(
  page: import("@playwright/test").Page,
): Promise<CopcDebugState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) {
      throw new Error("COPC debug adapter is unavailable");
    }

    return window.__COPC_DEBUG__.getState();
  });
}

async function getCompletedDebugState(
  page: import("@playwright/test").Page,
): Promise<CopcDebugState> {
  return getCompletedStreamingState(() => getDebugState(page));
}

test("streams a COPC sample through the opt-in Rust backend in a real Cesium scene", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error);
  });

  await page.goto("/?backend=rust");

  await expect
    .poll(() => getDebugState(page))
    .toMatchObject({
      viewerReady: true,
      layerLoaded: true,
      metadataPointCount: 10653336,
      backend: "rust",
    });
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await getDebugState(page)).scenePointCollectionCount)
    .toBeGreaterThan(0);

  const debugPanel = page.getByRole("complementary", {
    name: "COPC runtime debug panel",
  });
  await page.getByRole("tab", { name: "Source" }).click();
  await expect(debugPanel).toBeVisible();
  await expect(
    debugPanel.getByText("autzen.copc.laz", { exact: true }),
  ).toBeVisible();
  await expect(
    debugPanel.locator('[data-diagnostic-value="pointCount"]'),
  ).toHaveText("10,653,336");
  await expect(page.locator("#source-status")).toContainText("Ready");
  await page.getByRole("tab", { name: "Health" }).click();
  await expect
    .poll(async () =>
      Number(
        (
          await debugPanel
            .locator('[data-diagnostic-value="renderedPointCount"]')
            .textContent()
        )?.replaceAll(",", ""),
      ),
    )
    .toBeGreaterThan(0);
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(
    debugPanel.locator('[data-diagnostic-section="data-hierarchy"]'),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.locator("[data-point-popover]")).toBeHidden();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        window.__COPC_DEBUG__?.getPickablePointScreenPosition(),
      ),
    )
    .toBeTruthy();
  const pointPosition = await page.evaluate(() =>
    window.__COPC_DEBUG__?.getPickablePointScreenPosition(),
  );
  if (!pointPosition) {
    throw new Error("No visible rendered COPC point was available for picking");
  }
  const canvasBounds = await page
    .locator("#cesium-container canvas")
    .first()
    .boundingBox();
  expect(canvasBounds).not.toBeNull();
  await page.mouse.click(
    canvasBounds!.x + pointPosition.x,
    canvasBounds!.y + pointPosition.y,
  );
  await expect
    .poll(async () => (await getDebugState(page)).selectedPoint)
    .toMatchObject({
      nodeKey: expect.any(String),
      pointIndex: expect.any(Number),
    });
  const selectedPoint = await page.evaluate(
    () => window.__COPC_DEBUG__?.getState().selectedPoint,
  );
  expect(selectedPoint?.rgb).toBeDefined();
  await expect(page.locator("[data-point-popover]")).toBeVisible();
  await expect(page.locator("[data-point-popover]")).toContainText("RGB");

  const initialState = await getCompletedDebugState(page);
  expect(initialState.renderedNodeKeys).not.toEqual([]);
  expect(initialState.selectedNodeKeys).not.toEqual([]);
  expect(initialState.streamingUpdateCount).toBeGreaterThan(0);
  expect(initialState.minRenderedHeight).toBeDefined();
  expect(initialState.maxRenderedHeight).toBeDefined();
  expect(
    initialState.maxRenderedHeight! - initialState.minRenderedHeight!,
  ).toBeGreaterThan(1);
  expect(initialState.renderedColorCount).toBeGreaterThan(1);
  expect(initialState.pointCache.cacheByteBudget).toBeGreaterThan(0);
  expect(initialState.pointCache.currentCacheBytes).toBeGreaterThan(0);

  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
  });
  await expect
    .poll(async () => (await getDebugState(page)).cameraPitchDegrees)
    .toBeCloseTo(-35, 0);

  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraHeight(100000);
  });
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(initialState.streamingUpdateCount);
  const farState = await getCompletedDebugState(page);

  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraHeight(1000);
  });
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(farState.streamingUpdateCount);
  await expect
    .poll(
      async () =>
        (await getDebugState(page)).transition.activeReplacementGroupCount,
    )
    .toBe(0);
  const nearState = await getCompletedDebugState(page);

  expect(nearState.cameraMoveEventCount).toBeGreaterThanOrEqual(2);
  expect(nearState.selectedNodeKeys).not.toEqual(farState.selectedNodeKeys);
  expect(nearState.renderedPointCount).toBeGreaterThan(0);
  expect(nearState.lastError).toBeUndefined();
  expect(pageErrors).toEqual([]);

  await page.locator("#inspector-toggle").click();
  await expect(debugPanel).toBeHidden();
  await page.keyboard.press("Shift+D");
  await expect(debugPanel).toBeVisible();
});

test("restyles and filters cached points without rereading the source", async ({
  page,
}) => {
  await page.goto("/?backend=rust");
  await page.getByRole("tab", { name: "Data" }).click();

  await expect
    .poll(() => getDebugState(page))
    .toMatchObject({
      viewerReady: true,
      layerLoaded: true,
      backend: "rust",
    });
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = window.__COPC_DEBUG__?.getState();
        return (
          state?.rangeRequests.active === 0 &&
          state.worker?.activeCount === 0 &&
          state.worker?.queuedCount === 0
        );
      }),
    )
    .toBe(true);

  const pickPosition = await page.evaluate(() =>
    window.__COPC_DEBUG__?.getPickablePointScreenPosition(),
  );
  expect(pickPosition).toBeTruthy();
  if (!pickPosition) {
    throw new Error(
      "No visible point was available to read a classification value",
    );
  }
  const canvasBounds = await page
    .locator("#cesium-container canvas")
    .first()
    .boundingBox();
  expect(canvasBounds).not.toBeNull();
  await page.mouse.click(
    canvasBounds!.x + pickPosition.x,
    canvasBounds!.y + pickPosition.y,
  );
  await expect
    .poll(async () => (await getDebugState(page)).selectedPoint)
    .toMatchObject({ classification: expect.any(Number) });

  const initial = await page.evaluate(() => window.__COPC_DEBUG__!.getState());
  const classification = initial.selectedPoint!.classification!;
  const styleModes = [
    "rgb",
    "elevation",
    "intensity",
    "classification",
  ] as const;
  for (const colorMode of styleModes) {
    await page.evaluate((mode) => {
      window.__COPC_DEBUG__?.setStyle({ colorMode: mode });
    }, colorMode);
    await expect
      .poll(async () =>
        page.evaluate(() => window.__COPC_DEBUG__?.getStyle().colorMode),
      )
      .toBe(colorMode);
  }

  await page.evaluate((selectedClassification) => {
    window.__COPC_DEBUG__?.setStyle({
      colorMode: "classification",
      classificationFilter: { include: [selectedClassification] },
    });
  }, classification);
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  const filtered = await page.evaluate(() => window.__COPC_DEBUG__!.getState());

  expect(filtered.renderedPointCount).toBeLessThan(initial.renderedPointCount);
  expect(filtered.rangeRequests.requested).toBe(
    initial.rangeRequests.requested,
  );
  expect(filtered.pointCache.misses).toBe(initial.pointCache.misses);
  expect(filtered.pointCache.currentCacheBytes).toBe(
    initial.pointCache.currentCacheBytes,
  );
  expect(
    await page.evaluate(() => window.__COPC_DEBUG__!.getStyle()),
  ).toMatchObject({
    colorMode: "classification",
    classificationFilter: { include: [classification] },
  });

  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setStyle({
      colorMode: "rgb",
      classificationFilter: null,
    });
  });
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBe(initial.renderedPointCount);
  expect(
    await page.evaluate(() => window.__COPC_DEBUG__!.getStyle()),
  ).toMatchObject({ colorMode: "rgb" });
});

test("starts the Inspector collapsed with the debugPanel query parameter", async ({
  page,
}) => {
  await page.goto("/?debugPanel=false");

  const debugPanel = page.getByRole("complementary", {
    name: "COPC runtime debug panel",
  });
  const inspectorToggle = page.locator("#inspector-toggle");
  await expect(debugPanel).toBeHidden();
  await expect(inspectorToggle).toHaveAccessibleName("Expand inspector panel");
  await inspectorToggle.click();
  await expect(debugPanel).toBeVisible();
});

test("keeps the representative Autzen Far to Near refinement progressive", async ({
  page,
}) => {
  await page.goto("/?scenario=issue61");

  await expect
    .poll(() => getDebugState(page))
    .toMatchObject({
      viewerReady: true,
      layerLoaded: true,
      backend: "rust",
    });
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);

  const initialState = await getCompletedDebugState(page);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(10000));
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(initialState.streamingUpdateCount);
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  const farState = await getCompletedDebugState(page);
  expect(farState.performance.maxScreenSpaceError).toBe(8);
  expect(farState.performance.screenSpaceErrorMin).toBeDefined();
  expect(farState.performance.screenSpaceErrorMax).toBeDefined();

  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(300));
  await expect
    .poll(async () => (await getDebugState(page)).selectedNodeKeys)
    .not.toEqual(farState.selectedNodeKeys);
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(farState.streamingUpdateCount);
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        (await getDebugState(page)).transition.activeReplacementGroupCount,
    )
    .toBe(0);
  const nearState = await getCompletedDebugState(page);
  expect(nearState.performance.visibleLevelRange.max).toBeGreaterThanOrEqual(
    farState.performance.visibleLevelRange.max,
  );
  expect(nearState.renderedPointCount).not.toBe(farState.renderedPointCount);
  expect(nearState.transition.activeReplacementGroupCount).toBe(0);
  expect(nearState.performance.acceptedRefinementCount).toBeGreaterThanOrEqual(
    farState.performance.acceptedRefinementCount,
  );
  expect(nearState.performance.acceptedRefinementCount).toBeGreaterThan(0);

  const beforeRotation = await getCompletedDebugState(page);
  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
    window.__COPC_DEBUG__?.setCameraHeading(90);
  });
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(beforeRotation.streamingUpdateCount);
  const rotatedState = await getDebugState(page);
  expect(rotatedState.renderedPointCount).toBeGreaterThan(0);
  expect(rotatedState.selectedNodeKeys).not.toEqual(nearState.selectedNodeKeys);

  await expect
    .poll(
      async () =>
        (await getDebugState(page)).transition.activeReplacementGroupCount,
    )
    .toBe(0);
  const settledRotationState = await getCompletedDebugState(page);
  const stationaryUpdateCount = settledRotationState.streamingUpdateCount;
  await page.waitForTimeout(750);
  const stationaryState = await getDebugState(page);
  expect(stationaryState.streamingUpdateCount).toBe(stationaryUpdateCount);
  expect(stationaryState.transition.activeReplacementGroupCount).toBe(0);

  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(400));
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(stationaryState.streamingUpdateCount);
  const microMotionState = await getDebugState(page);
  expect(microMotionState.renderedPointCount).toBeGreaterThan(0);

  const beforeFarAgain = await getCompletedDebugState(page);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(10000));
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(beforeFarAgain.streamingUpdateCount);
  await expect
    .poll(
      async () =>
        (await getDebugState(page)).transition.activeReplacementGroupCount,
    )
    .toBe(0);
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  const farAgainState = await getCompletedDebugState(page);
  expect(farAgainState.transition.activeReplacementGroupCount).toBe(0);
  expect(farAgainState.performance.visibleLevelRange.max).toBeLessThan(
    nearState.performance.visibleLevelRange.max,
  );
  expect(farAgainState.renderedPointCount).toBeGreaterThan(0);

  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(300));
  await expect
    .poll(async () => (await getDebugState(page)).selectedNodeKeys)
    .not.toEqual(farAgainState.selectedNodeKeys);
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(farAgainState.streamingUpdateCount);
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(nearState.renderedPointCount / 2);
  const finalState = await getDebugState(page);
  expect(finalState.lastError).toBeUndefined();
  expect(finalState.performance.selectedNodeCount).toBeGreaterThan(0);
  expect(finalState.performance.estimatedSelectedPointCount).toBeGreaterThan(0);
  expect(finalState.longestMainThreadTaskMs).toBeLessThan(60000);
});

test("keeps constrained oblique hierarchy coverage aligned with camera direction", async ({
  page,
}) => {
  await page.goto("/?scenario=issue128&backend=rust&debugPanel=false");

  await expect
    .poll(() => getDebugState(page), { timeout: 120_000 })
    .toMatchObject({
      viewerReady: true,
      layerLoaded: true,
      backend: "rust",
    });
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);

  const overview = await getCompletedDebugState(page);
  expect(overview.hierarchy?.pageRequests).toBeGreaterThan(0);

  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
    window.__COPC_DEBUG__?.setCameraHeading(90);
  });
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(overview.streamingUpdateCount);
  await expect
    .poll(
      async () =>
        (await getDebugState(page)).transition.activeReplacementGroupCount,
    )
    .toBe(0);
  const nearOblique = await getCompletedDebugState(page);

  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeading(270));
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(nearOblique.streamingUpdateCount);
  await expect
    .poll(
      async () =>
        (await getDebugState(page)).transition.activeReplacementGroupCount,
    )
    .toBe(0);
  const farOblique = await getCompletedDebugState(page);

  expect(nearOblique.renderedPointCount).toBeGreaterThan(0);
  expect(farOblique.renderedPointCount).toBeGreaterThan(0);
  expect(nearOblique.selectedNodeKeys).not.toEqual([]);
  expect(farOblique.selectedNodeKeys).not.toEqual([]);
  expect(farOblique.hierarchy?.pageRequests).toBeGreaterThanOrEqual(
    nearOblique.hierarchy?.pageRequests ?? 0,
  );
  expect(farOblique.hierarchy?.pageCacheHits).toBeGreaterThan(
    overview.hierarchy?.pageCacheHits ?? 0,
  );
  expect(farOblique.lastError).toBeUndefined();

  const stationaryHierarchyRequestCount = farOblique.hierarchy?.pageRequests;
  await page.waitForTimeout(750);
  expect((await getDebugState(page)).hierarchy?.pageRequests).toBe(
    stationaryHierarchyRequestCount,
  );

  await page.goto(
    "/?scenario=issue128&distance=12000&backend=rust&debugPanel=false",
  );
  await expect
    .poll(() => getDebugState(page), { timeout: 120_000 })
    .toMatchObject({
      viewerReady: true,
      layerLoaded: true,
      backend: "rust",
    });
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);
  const largeDistance = await getDebugState(page);
  expect(largeDistance.lastError).toBeUndefined();
  expect(largeDistance.hierarchy?.pageRequests).toBeGreaterThan(0);
});

test("uses the same constrained view hierarchy policy with copc-js", async ({
  page,
}) => {
  await page.goto("/?scenario=issue128&backend=copc-js&debugPanel=false");

  await expect
    .poll(() => getDebugState(page), { timeout: 120_000 })
    .toMatchObject({
      viewerReady: true,
      layerLoaded: true,
      backend: "copc-js",
    });
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);

  const beforeRotation = await getCompletedDebugState(page);
  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
    window.__COPC_DEBUG__?.setCameraHeading(90);
  });
  await expect
    .poll(async () => (await getDebugState(page)).streamingUpdateCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(beforeRotation.streamingUpdateCount);
  const rotated = await getDebugState(page);

  expect(rotated.renderedPointCount).toBeGreaterThan(0);
  expect(rotated.hierarchy?.pageRequests).toBeGreaterThan(0);
  expect(rotated.hierarchy?.pageCacheHits).toBeGreaterThan(
    beforeRotation.hierarchy?.pageCacheHits ?? 0,
  );
  expect(rotated.lastError).toBeUndefined();
});

test("manual height offset keeps picked points aligned with the globe shown or hidden", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto("/?backend=rust&heightOffsetMeters=25&debugPanel=false");
  await expect
    .poll(() => getDebugState(page), { timeout: 120_000 })
    .toMatchObject({
      viewerReady: true,
      layerLoaded: true,
      backend: "rust",
    });
  await expect
    .poll(async () => (await getDebugState(page)).renderedPointCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await getDebugState(page)).worker?.completedCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () =>
      page.evaluate(() =>
        window.__COPC_DEBUG__?.getPickablePointScreenPosition(),
      ),
    )
    .toBeTruthy();

  const screenPosition = await page.evaluate(() =>
    window.__COPC_DEBUG__?.getPickablePointScreenPosition(),
  );
  if (!screenPosition)
    throw new Error("No rendered COPC point was available for picking");
  const canvasBounds = await page
    .locator("#cesium-container canvas")
    .first()
    .boundingBox();
  expect(canvasBounds).not.toBeNull();
  await page.mouse.click(
    canvasBounds!.x + screenPosition.x,
    canvasBounds!.y + screenPosition.y,
  );
  await expect
    .poll(async () => (await getDebugState(page)).selectedPoint)
    .toMatchObject({
      nodeKey: expect.any(String),
      pointIndex: expect.any(Number),
    });
  const visibleState = await getCompletedDebugState(page);
  const visiblePoint = visibleState.selectedPoint;
  expect(visiblePoint?.source?.z).toBeDefined();
  expect(visiblePoint?.world).toBeDefined();
  expect(visibleState.renderedPointCount).toBeGreaterThan(0);

  await page.evaluate(() => window.__COPC_DEBUG__?.setGlobeVisible(false));
  const hiddenState = await getCompletedDebugState(page);
  expect(hiddenState.renderedPointCount).toBeGreaterThan(0);
  expect(hiddenState.selectedPoint?.height).toBe(visiblePoint?.height);
  expect(hiddenState.selectedPoint?.source?.z).toBe(visiblePoint?.source?.z);
  expect(hiddenState.selectedPoint?.world).toEqual(visiblePoint?.world);

  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setStyle({ colorMode: "elevation" });
  });
  const restyledPoint = (await getDebugState(page)).selectedPoint;
  expect(restyledPoint?.height).toBe(visiblePoint?.height);
  expect(restyledPoint?.source?.z).toBe(visiblePoint?.source?.z);
  expect(restyledPoint?.world).toEqual(visiblePoint?.world);

  await page.evaluate(() => window.__COPC_DEBUG__?.setGlobeVisible(true));
  expect((await getDebugState(page)).renderedPointCount).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

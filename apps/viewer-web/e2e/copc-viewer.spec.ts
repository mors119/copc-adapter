import { expect, test } from '@playwright/test';

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
    rgb?: { red: number; green: number; blue: number };
  };
  lastError?: string;
  backend: 'copc-js' | 'rust' | 'custom';
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
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
};

type CopcDebugAdapter = {
  getState(): CopcDebugState;
  getLastError(): string | undefined;
  setCameraHeight(height: number): void;
  setCameraPitch(pitchDegrees: number): void;
  setCameraHeading(headingDegrees: number): void;
  recordError(error: unknown): void;
  runSyntheticRendererPerformanceBenchmark(): Array<Record<string, unknown>>;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: CopcDebugAdapter;
  }
}

async function getDebugState(page: import('@playwright/test').Page): Promise<CopcDebugState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) {
      throw new Error('COPC debug adapter is unavailable');
    }

    return window.__COPC_DEBUG__.getState();
  });
}

test('streams a COPC sample through the opt-in Rust backend in a real Cesium scene', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error);
  });

  await page.goto('/?backend=rust');

  await expect.poll(() => getDebugState(page)).toMatchObject({
    viewerReady: true,
    layerLoaded: true,
    metadataPointCount: 10653336,
    backend: 'rust',
  });
  await expect.poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  await expect.poll(async () => (await getDebugState(page)).scenePointCollectionCount)
    .toBeGreaterThan(0);

  const debugPanel = page.getByRole('complementary', {
    name: 'COPC runtime debug panel',
  });
  await expect(debugPanel).toBeVisible();
  await expect(debugPanel.getByText('autzen.copc.laz', { exact: true })).toBeVisible();
  await expect(debugPanel.getByText('10,653,336', { exact: true })).toBeVisible();
  await expect(debugPanel.getByText('Ready', { exact: true })).toBeVisible();
  await expect(debugPanel.locator('details').filter({ hasText: 'Metadata' }))
    .toHaveAttribute('open', '');

  const pointInspector = page.getByRole('complementary', {
    name: 'COPC point inspector',
  });
  await expect(pointInspector).toBeVisible();
  await expect(pointInspector.getByText('Click a rendered point', { exact: true }))
    .toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEBUG__?.getPickablePointScreenPosition())).toBeTruthy();
  const pointPosition = await page.evaluate(() =>
    window.__COPC_DEBUG__?.getPickablePointScreenPosition());
  if (!pointPosition) {
    throw new Error('No visible rendered COPC point was available for picking');
  }
  await page.mouse.click(pointPosition.x, pointPosition.y);
  await expect.poll(async () => (await getDebugState(page)).selectedPoint)
    .toMatchObject({ nodeKey: expect.any(String), pointIndex: expect.any(Number) });
  const selectedPoint = await page.evaluate(() => window.__COPC_DEBUG__?.getState().selectedPoint);
  expect(selectedPoint?.rgb).toBeDefined();
  await expect(pointInspector.locator('[data-field="rgb"]')).not.toHaveText('Unavailable');

  const initialState = await getDebugState(page);
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
  await expect.poll(async () => (await getDebugState(page)).cameraPitchDegrees)
    .toBeCloseTo(-35, 0);

  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraHeight(100000);
  });
  await expect.poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(initialState.streamingUpdateCount);
  const farState = await getDebugState(page);

  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraHeight(1000);
  });
  await expect.poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(farState.streamingUpdateCount);
  await expect.poll(async () => (await getDebugState(page)).transition.activeReplacementGroupCount)
    .toBe(0);
  const nearState = await getDebugState(page);

  expect(nearState.cameraMoveEventCount).toBeGreaterThanOrEqual(2);
  expect(nearState.selectedNodeKeys).not.toEqual(farState.selectedNodeKeys);
  expect(nearState.renderedPointCount).toBeGreaterThan(0);
  expect(nearState.lastError).toBeUndefined();
  expect(pageErrors).toEqual([]);

  await debugPanel.getByRole('button', { name: 'Hide' }).click();
  await expect(debugPanel).toBeHidden();
  await page.keyboard.press('Shift+D');
  await expect(debugPanel).toBeVisible();
});

test('can disable the runtime debug panel with a query parameter', async ({ page }) => {
  await page.goto('/?debugPanel=false');

  await expect(page.getByRole('complementary', {
    name: 'COPC runtime debug panel',
  })).toHaveCount(0);
});

test('keeps the representative Autzen Far to Near refinement progressive', async ({
  page,
}) => {
  await page.goto('/?scenario=issue61');

  await expect.poll(() => getDebugState(page)).toMatchObject({
    viewerReady: true,
    layerLoaded: true,
    backend: 'rust',
  });
  await expect.poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);

  const initialState = await getDebugState(page);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(10000));
  await expect.poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(initialState.streamingUpdateCount);
  await expect.poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  const farState = await getDebugState(page);
  expect(farState.performance.maxScreenSpaceError).toBe(8);
  expect(farState.performance.screenSpaceErrorMin).toBeDefined();
  expect(farState.performance.screenSpaceErrorMax).toBeDefined();

  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(300));
  await expect.poll(async () => (await getDebugState(page)).selectedNodeKeys)
    .not.toEqual(farState.selectedNodeKeys);
  await expect.poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(farState.streamingUpdateCount);
  await expect.poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  await expect.poll(async () => (await getDebugState(page)).transition.activeReplacementGroupCount)
    .toBe(0);
  const nearState = await getDebugState(page);
  expect(nearState.performance.visibleLevelRange.max)
    .toBeGreaterThanOrEqual(farState.performance.visibleLevelRange.max);
  expect(nearState.renderedPointCount).not.toBe(farState.renderedPointCount);
  expect(nearState.transition.activeReplacementGroupCount).toBe(0);
  expect(nearState.performance.acceptedRefinementCount)
    .toBeGreaterThanOrEqual(farState.performance.acceptedRefinementCount);
  expect(nearState.performance.acceptedRefinementCount).toBeGreaterThan(0);

  const beforeRotation = await getDebugState(page);
  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
    window.__COPC_DEBUG__?.setCameraHeading(90);
  });
  await expect.poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(beforeRotation.streamingUpdateCount);
  const rotatedState = await getDebugState(page);
  expect(rotatedState.renderedPointCount).toBeGreaterThan(0);
  expect(rotatedState.selectedNodeKeys).not.toEqual(nearState.selectedNodeKeys);

  await expect.poll(async () => (await getDebugState(page)).transition.activeReplacementGroupCount)
    .toBe(0);
  const settledRotationState = await getDebugState(page);
  const stationaryUpdateCount = settledRotationState.streamingUpdateCount;
  await page.waitForTimeout(750);
  const stationaryState = await getDebugState(page);
  expect(stationaryState.streamingUpdateCount).toBe(stationaryUpdateCount);
  expect(stationaryState.transition.activeReplacementGroupCount).toBe(0);

  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(400));
  await expect.poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(stationaryState.streamingUpdateCount);
  const microMotionState = await getDebugState(page);
  expect(microMotionState.renderedPointCount).toBeGreaterThan(0);

  const beforeFarAgain = await getDebugState(page);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(10000));
  await expect.poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(beforeFarAgain.streamingUpdateCount);
  await expect.poll(async () => (await getDebugState(page)).transition.activeReplacementGroupCount)
    .toBe(0);
  await expect.poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(0);
  const farAgainState = await getDebugState(page);
  expect(farAgainState.transition.activeReplacementGroupCount).toBe(0);
  expect(farAgainState.performance.visibleLevelRange.max)
    .toBeLessThan(nearState.performance.visibleLevelRange.max);
  expect(farAgainState.renderedPointCount).toBeGreaterThan(0);

  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(300));
  await expect.poll(async () => (await getDebugState(page)).selectedNodeKeys)
    .not.toEqual(farAgainState.selectedNodeKeys);
  await expect.poll(async () => (await getDebugState(page)).streamingUpdateCount)
    .toBeGreaterThan(farAgainState.streamingUpdateCount);
  await expect.poll(async () => (await getDebugState(page)).renderedPointCount)
    .toBeGreaterThan(nearState.renderedPointCount / 2);
  const finalState = await getDebugState(page);
  expect(finalState.lastError).toBeUndefined();
  expect(finalState.performance.selectedNodeCount).toBeGreaterThan(0);
  expect(finalState.performance.estimatedSelectedPointCount).toBeGreaterThan(0);
  expect(finalState.longestMainThreadTaskMs).toBeLessThan(60000);
});

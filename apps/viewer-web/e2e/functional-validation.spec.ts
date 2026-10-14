import { expect, test, type Page } from '@playwright/test';

type FunctionalState = {
  viewerReady: boolean;
  layerLoaded: boolean;
  datasetUrl: string;
  renderedPointCount: number;
  renderedScenePointCount: number;
  scenePointCollectionCount: number;
  selectedNodeKeys: string[];
  renderedNodeKeys: string[];
  streamingUpdateCount: number;
  transition: {
    activeReplacementGroupCount: number;
    refinementReplacementCommitCount: number;
    coarseNodesRetainedForCoverageCount: number;
  };
  performance: {
    configuredPointBudget: number;
    activeRenderedPointCount: number;
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
  activeColorMode: string;
  selectedPoint?: {
    nodeKey: string;
    level: number;
    pointIndex: number;
    longitude: number;
    latitude: number;
  };
  lastError?: string;
};

type CopcDebugAdapter = {
  getState(): FunctionalState;
  setCameraPitch(pitchDegrees: number): void;
  setCameraHeading(headingDegrees: number): void;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: CopcDebugAdapter;
  }
}

type CapturedRangeResponse = {
  requestedRange: string | undefined;
  status: number;
  contentRange: string | undefined;
};

async function getState(page: Page): Promise<FunctionalState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) {
      throw new Error('COPC debug adapter is unavailable');
    }
    return window.__COPC_DEBUG__.getState();
  });
}

async function moveWithControl(page: Page, preset: 'overview' | 'far' | 'near') {
  const before = await getState(page);
  await page.getByTestId(`camera-${preset}`).click();
  await expect.poll(async () => (await getState(page)).streamingUpdateCount)
    .toBeGreaterThan(before.streamingUpdateCount);
  await expect.poll(async () => (await getState(page)).transition.activeReplacementGroupCount)
    .toBe(0);
  return getState(page);
}

function hasDifferentViewState(first: FunctionalState, second: FunctionalState): boolean {
  return JSON.stringify(first.selectedNodeKeys) !== JSON.stringify(second.selectedNodeKeys)
    || JSON.stringify(first.performance.visibleLevelRange)
      !== JSON.stringify(second.performance.visibleLevelRange);
}

test('default Cesium viewer completes the eight-step COPC functional validation', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];
  const rangeResponses: CapturedRangeResponse[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const requestRange = response.request().headers()['range'];
    if (requestRange && new URL(response.url()).pathname.endsWith('autzen.copc.laz')) {
      rangeResponses.push({
        requestedRange: requestRange,
        status: response.status(),
        contentRange: response.headers()['content-range'],
      });
    }
  });

  await page.goto('/');

  let initialState!: FunctionalState;
  await test.step('1. Direct COPC visualization', async () => {
    expect(new URL(page.url()).search).toBe('');
    const runtimePanel = page.getByRole('complementary', {
      name: 'COPC runtime debug panel',
    });
    const pointInspector = page.getByRole('complementary', {
      name: 'COPC point inspector',
    });
    await expect(runtimePanel).toBeVisible();
    await expect(runtimePanel.getByRole('region', { name: 'Validation controls' })).toBeVisible();
    await expect(runtimePanel.getByRole('region', { name: 'Core evidence' })).toBeVisible();
    await expect(pointInspector).toBeVisible();
    await expect.poll(() => getState(page)).toMatchObject({
      viewerReady: true,
      layerLoaded: true,
    });
    await expect.poll(async () => (await getState(page)).renderedScenePointCount)
      .toBeGreaterThan(0);
    initialState = await getState(page);
    expect(initialState.datasetUrl).toContain('autzen.copc.laz');
    expect(initialState.renderedPointCount).toBeGreaterThan(0);
    expect(initialState.scenePointCollectionCount).toBeGreaterThan(0);
    expect(initialState.lastError).toBeUndefined();
  });

  await test.step('2. HTTP Range partial requests', async () => {
    await expect.poll(() => rangeResponses.length).toBeGreaterThan(0);
    const response = rangeResponses.find((candidate) => candidate.status === 206);
    expect(response, 'Autzen should return HTTP 206 Partial Content').toBeDefined();
    expect(response?.contentRange).toMatch(/^bytes \d+-\d+\/\d+$/);

    const requested = /^bytes=(\d+)-(\d*)$/.exec(response?.requestedRange ?? '');
    const returned = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response?.contentRange ?? '');
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
    const runtimePanel = page.getByRole('complementary', {
      name: 'COPC runtime debug panel',
    });
    await expect(runtimePanel.locator('[data-field="rangeRequested"]'))
      .not.toHaveText('0');
    await expect(runtimePanel.locator('[data-field="rangeCompleted"]'))
      .not.toHaveText('0');
  });

  let movedState!: FunctionalState;
  await test.step('3. Camera-driven hierarchy and node selection', async () => {
    const before = await getState(page);
    await page.evaluate(() => {
      window.__COPC_DEBUG__?.setCameraPitch(-35);
      window.__COPC_DEBUG__?.setCameraHeading(90);
    });
    await expect.poll(async () => (await getState(page)).streamingUpdateCount)
      .toBeGreaterThan(before.streamingUpdateCount);
    await expect.poll(async () => (await getState(page)).transition.activeReplacementGroupCount)
      .toBe(0);
    movedState = await getState(page);
    const hierarchyChanged = movedState.hierarchy.pageRequests
        !== initialState.hierarchy.pageRequests
      || movedState.hierarchy.pageCacheHits !== initialState.hierarchy.pageCacheHits;
    expect(
      hasDifferentViewState(initialState, movedState) || hierarchyChanged,
      'camera movement should change selected nodes, visible levels, or hierarchy activity',
    ).toBe(true);
  });

  let overviewState!: FunctionalState;
  let nearState!: FunctionalState;
  await test.step('4. LoD changes between overview and close views', async () => {
    overviewState = await moveWithControl(page, 'overview');
    nearState = await moveWithControl(page, 'near');
    expect(hasDifferentViewState(overviewState, nearState), JSON.stringify({
      overviewNodes: overviewState.selectedNodeKeys,
      overviewLevels: overviewState.performance.visibleLevelRange,
      nearNodes: nearState.selectedNodeKeys,
      nearLevels: nearState.performance.visibleLevelRange,
    })).toBe(true);
    expect(nearState.streamingUpdateCount).toBeGreaterThan(overviewState.streamingUpdateCount);
    expect(nearState.renderedPointCount).toBeGreaterThan(0);
  });

  await test.step('5. Progressive coarse-to-fine transition', async () => {
    expect(
      nearState.transition.refinementReplacementCommitCount,
    ).toBeGreaterThanOrEqual(overviewState.transition.refinementReplacementCommitCount);
    expect(
      nearState.transition.refinementReplacementCommitCount
        + nearState.transition.coarseNodesRetainedForCoverageCount,
      JSON.stringify({
        overviewTransition: overviewState.transition,
        nearTransition: nearState.transition,
        overviewLevels: overviewState.performance.visibleLevelRange,
        nearLevels: nearState.performance.visibleLevelRange,
        overviewNodes: overviewState.selectedNodeKeys,
        nearNodes: nearState.selectedNodeKeys,
      }),
    ).toBeGreaterThan(0);
    expect(nearState.transition.activeReplacementGroupCount).toBe(0);
  });

  await test.step('6. Bounded point work and point-cache reuse', async () => {
    const beforeReturn = nearState.pointCache;
    await moveWithControl(page, 'far');
    const returnedNear = await moveWithControl(page, 'near');
    expect(returnedNear.performance.configuredPointBudget).toBeGreaterThan(0);
    expect(returnedNear.performance.activeRenderedPointCount)
      .toBeLessThanOrEqual(returnedNear.performance.configuredPointBudget);
    expect(returnedNear.pointCache.currentCacheBytes)
      .toBeLessThanOrEqual(returnedNear.pointCache.cacheByteBudget);
    expect(returnedNear.pointCache.hits).toBeGreaterThanOrEqual(beforeReturn.hits);
    expect(returnedNear.pointCache.hits + returnedNear.pointCache.misses)
      .toBeGreaterThan(beforeReturn.hits + beforeReturn.misses);
    nearState = returnedNear;
  });

  await test.step('7. RGB, elevation, intensity, and classification styling', async () => {
    for (const mode of ['rgb', 'elevation', 'intensity', 'classification'] as const) {
      await page.getByTestId(`style-${mode}`).click();
      await expect(page.getByTestId('active-color-mode')).toHaveText(mode);
      const state = await getState(page);
      expect(state.activeColorMode).toBe(mode);
      expect(state.viewerReady).toBe(true);
      expect(state.layerLoaded).toBe(true);
      expect(state.renderedPointCount).toBeGreaterThan(0);
      expect(state.renderedScenePointCount).toBeGreaterThan(0);
      expect(state.lastError).toBeUndefined();
    }
  });

  await test.step('8. Point picking and attribute inspection', async () => {
    const pointInspector = page.getByRole('complementary', {
      name: 'COPC point inspector',
    });
    await expect.poll(async () => page.evaluate(() =>
      window.__COPC_DEBUG__?.getPickablePointScreenPosition())).toBeTruthy();
    const position = await page.evaluate(() =>
      window.__COPC_DEBUG__?.getPickablePointScreenPosition());
    expect(position).toBeDefined();
    await page.mouse.click(position!.x, position!.y);
    await expect.poll(async () => (await getState(page)).selectedPoint)
      .toMatchObject({ nodeKey: expect.any(String), pointIndex: expect.any(Number) });
    await expect(pointInspector.getByText('Click a rendered point', { exact: true }))
      .toBeHidden();

    for (const field of ['nodeKey', 'level', 'pointIndex', 'longitude', 'latitude']) {
      const value = pointInspector.locator(`[data-field="${field}"]`);
      await expect(value).not.toBeEmpty();
      await expect(value).not.toHaveText('Unavailable');
    }
    for (const field of ['height', 'source', 'intensity', 'classification', 'rgb']) {
      const value = pointInspector.locator(`[data-field="${field}"]`);
      await expect(value).not.toBeEmpty();
    }
  });

  await test.step('final. Viewer remains healthy after the full sequence', async () => {
    const finalState = await getState(page);
    expect(finalState.viewerReady).toBe(true);
    expect(finalState.layerLoaded).toBe(true);
    expect(finalState.renderedPointCount).toBeGreaterThan(0);
    expect(finalState.renderedScenePointCount).toBeGreaterThan(0);
    expect(finalState.lastError).toBeUndefined();
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

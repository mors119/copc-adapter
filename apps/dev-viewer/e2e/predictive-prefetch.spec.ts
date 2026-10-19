import { expect, test } from '@playwright/test';
import { getCompletedStreamingState } from './streaming-state';

type PrefetchState = {
  cameraHeadingDegrees: number;
  cameraPitchDegrees: number;
  cameraMoveEventCount: number;
  streamingUpdateCount: number;
  selectedNodeKeys: string[];
  renderedNodeKeys: string[];
  transition: { activeReplacementGroupCount: number };
  performance: {
    updateDurationMs: number;
    loadedNodeCount: number;
    rangeFetchBytes: number;
    motionLive: {
      horizontalAngularVelocityDegreesPerSecond: number;
      verticalAngularVelocityDegreesPerSecond: number;
      predictedHorizontalDisplacementDegrees: number;
      predictedVerticalDisplacementDegrees: number;
      activity: number;
      state: string;
      millisecondsSinceLastAcceptedMovement?: number;
    };
  };
  pointCache: { hits: number; currentCacheBytes: number; prefetchUsefulHitCount: number };
  predictivePrefetch?: {
    enabled: boolean;
    queuedNodeCount: number;
    activeNodeCount: number;
    completedNodeCount: number;
    cancelledNodeCount: number;
    pointRangeRequestCount: number;
    pointRangeBytesRequested: number;
    hierarchyPageVisitCount: number;
    hierarchyPageRequestCount: number;
    hierarchyPageCacheHitCount: number;
    hierarchyQueryCount: number;
    usefulCacheHitCount: number;
    evictedUnusedNodeCount: number;
    maxNodesPerUpdate: number;
    maxPointsPerUpdate: number;
    maxPointRangeBytesPerUpdate: number;
    maxHierarchyPagesPerUpdate: number;
  };
  worker?: {
    workerCount: number;
    activeCount: number;
    queuedCount: number;
    peakActiveCount: number;
    peakQueuedCount: number;
  };
};

type PrefetchDebugAdapter = {
  getState(): PrefetchState;
  setCameraHeight(height: number): void;
  setCameraPitch(pitchDegrees: number): void;
  setCameraHeading(headingDegrees: number): void;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: PrefetchDebugAdapter;
  }
}

async function getState(page: import('@playwright/test').Page): Promise<PrefetchState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) throw new Error('COPC debug adapter is unavailable');
    return window.__COPC_DEBUG__.getState();
  });
}

async function turnAndMeasure(
  page: import('@playwright/test').Page,
  headingDegrees: number,
): Promise<{ latencyMs: number; state: PrefetchState }> {
  const before = await getState(page);
  const startedAt = Date.now();
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraPitch(-35));
  await page.waitForTimeout(50);
  const startingHeading = before.cameraHeadingDegrees;
  const immediate = await page.evaluate(async ({ start, target }) => {
    for (let step = 1; step <= 8; step += 1) {
      const heading = start + ((target - start) * step) / 8;
      window.__COPC_DEBUG__?.setCameraHeading(heading);
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    return window.__COPC_DEBUG__?.getState();
  }, { start: startingHeading, target: headingDegrees });
  if (!immediate) throw new Error('COPC debug adapter is unavailable');
  await expect.poll(async () => (await getState(page)).streamingUpdateCount)
    .toBeGreaterThan(before.streamingUpdateCount);
  await getCompletedStreamingState(() => getState(page));
  await expect.poll(async () => {
    const state = await getState(page);
    return state.transition.activeReplacementGroupCount === 0
      && state.selectedNodeKeys.every((key) => state.renderedNodeKeys.includes(key));
  }, { timeout: 30_000 }).toBe(true);
  return { latencyMs: Date.now() - startedAt, state: await getState(page) };
}

async function runRotationSequence(
  browser: import('@playwright/test').Browser,
  prefetch: boolean,
): Promise<Record<string, unknown>> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    const feature = prefetch ? '&prefetch=true' : '';
    await page.goto(`/?scenario=issue128&distance=12000&backend=rust&debugPanel=false${feature}`);
    await expect.poll(() => getState(page)).toMatchObject({
      predictivePrefetch: prefetch ? { enabled: true } : undefined,
    });
    await expect.poll(async () => (await getState(page)).renderedNodeKeys.length)
      .toBeGreaterThan(0);
    await getCompletedStreamingState(() => getState(page));

    const overview = await getState(page);
    await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(300));
    await expect.poll(async () => (await getState(page)).streamingUpdateCount)
      .toBeGreaterThan(overview.streamingUpdateCount);
    await getCompletedStreamingState(() => getState(page));

    const initial = await getState(page);
    const firstTurn = await turnAndMeasure(page, initial.cameraHeadingDegrees + 80);
    const secondTurn = await turnAndMeasure(page, initial.cameraHeadingDegrees + 98);
    if (prefetch) {
      await expect.poll(async () => (await getState(page)).predictivePrefetch?.completedNodeCount ?? 0, {
        timeout: 15_000,
      }).toBeGreaterThan(0);
    }
    const thirdTurn = await turnAndMeasure(page, initial.cameraHeadingDegrees + 116);
    const diagnostics = thirdTurn.state.predictivePrefetch;
    if (diagnostics) {
      expect(diagnostics.queuedNodeCount).toBeLessThanOrEqual(diagnostics.maxNodesPerUpdate);
      expect(diagnostics.pointRangeBytesRequested)
        .toBeLessThanOrEqual(diagnostics.maxPointRangeBytesPerUpdate * diagnostics.hierarchyQueryCount);
      expect(diagnostics.pointRangeRequestCount)
        .toBeLessThanOrEqual(diagnostics.maxNodesPerUpdate * diagnostics.hierarchyQueryCount);
      expect(diagnostics.completedNodeCount)
        .toBeLessThanOrEqual(diagnostics.maxNodesPerUpdate * diagnostics.hierarchyQueryCount);
      expect(diagnostics.hierarchyPageVisitCount)
        .toBeLessThanOrEqual(diagnostics.hierarchyQueryCount * diagnostics.maxHierarchyPagesPerUpdate);
    }

    return {
      prefetch,
      firstTurnLatencyMs: firstTurn.latencyMs,
      regionEntryToRenderedRefinementMs: thirdTurn.latencyMs,
      currentViewLoadedNodes: thirdTurn.state.performance.loadedNodeCount,
      currentViewRangeBytes: thirdTurn.state.performance.rangeFetchBytes,
      cacheHits: thirdTurn.state.pointCache.hits,
      cacheBytes: thirdTurn.state.pointCache.currentCacheBytes,
      usefulPrefetchCacheHits: thirdTurn.state.pointCache.prefetchUsefulHitCount,
      predictivePrefetch: diagnostics,
      worker: secondTurn.state.worker,
    };
  } finally {
    await page.close();
  }
}

test('measures bounded predictive prefetch cost and region-entry latency in Chromium', async ({ browser }) => {
  const prefetchOff = await runRotationSequence(browser, false);
  const prefetchOn = await runRotationSequence(browser, true);

  console.log(JSON.stringify({
    validation: 'controlled Cesium heading turns against the local Autzen COPC sample',
    environment: await browser.newPage().then(async (page) => {
      const environment = await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        devicePixelRatio: window.devicePixelRatio,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        hardwareConcurrency: navigator.hardwareConcurrency,
      }));
      await page.close();
      return environment;
    }),
    prefetchOff,
    prefetchOn,
  }, null, 2));
});

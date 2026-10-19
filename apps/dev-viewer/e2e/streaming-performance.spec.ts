import { expect, test } from '@playwright/test';

type DebugState = {
  layerLoaded: boolean;
  renderedPointCount: number;
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
  viewDistance?: {
    visibleFootprintMeters?: number;
    targetDistanceMeters: number;
    effectiveDistanceMeters: number;
    maxRenderDistanceMeters: number;
    overscanFactor: number;
    clampedToMaxRenderDistance: boolean;
    transition: string;
    updateCount: number;
    expansionCount: number;
    shrinkCount: number;
    hysteresisHoldCount: number;
    fallbackCount: number;
  };
  backend: string;
  performance: Record<string, number | boolean> & {
    configuredPointBudget: number;
    activeRenderedPointCount: number;
    candidateSelectedPointCount: number;
    deferredNodeCount: number;
    deferredPointCount: number;
    motionLookaheadEnabled: boolean;
    motionSampledMovementCount: number;
    motionPredictedHorizontalDisplacementDegrees: number;
    motionPredictedVerticalDisplacementDegrees: number;
  };
  pointCache: {
    cacheByteBudget: number;
    currentCacheBytes: number;
    cachedNodeCount: number;
    hits: number;
    misses: number;
    evictionCount: number;
    bytesEvicted: number;
  };
  rangeRequests: {
    requested: number;
    active: number;
    completed: number;
    failed: number;
    abortedSuperseded: number;
    abortedLifecycle: number;
  };
  worker?: {
    workerCount: number;
    activeCount: number;
    queuedCount: number;
    peakActiveCount: number;
    peakQueuedCount: number;
    submittedCount: number;
    completedCount: number;
    cancelledCount: number;
    failedCount: number;
  };
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
  lastError?: string;
};

type DebugAdapter = {
  getState(): DebugState;
  setCameraHeight(height: number): void;
  setCameraPitch(pitchDegrees: number): void;
  setCameraHeading(headingDegrees: number): void;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: DebugAdapter;
  }
}

async function getState(page: import('@playwright/test').Page): Promise<DebugState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) throw new Error('COPC debug adapter is unavailable');
    return window.__COPC_DEBUG__.getState();
  });
}

async function waitForViewChange(
  page: import('@playwright/test').Page,
  previous: DebugState,
): Promise<void> {
  const previousNodeKeys = [...previous.selectedNodeKeys].sort().join('\0');
  await expect.poll(async () => {
    const current = await getState(page);
    return current.streamingUpdateCount > previous.streamingUpdateCount
      || [...current.selectedNodeKeys].sort().join('\0') !== previousNodeKeys;
  }, { timeout: 120_000 }).toBe(true);
}

async function loadScenario(
  page: import('@playwright/test').Page,
  query: string,
): Promise<void> {
  const source = process.env.COPC_VALIDATION_SOURCE;
  const sourceQuery = source ? `&source=${encodeURIComponent(source)}` : '';
  await page.goto(`/?scenario=issue68&backend=rust&debugPanel=false${sourceQuery}&${query}`);
  await expect.poll(() => getState(page), { timeout: 120_000 }).toMatchObject({
    layerLoaded: true,
    backend: 'rust',
  });
  await expect.poll(async () => (await getState(page)).renderedPointCount, {
    timeout: 120_000,
  }).toBeGreaterThan(0);
}

async function waitForIdle(page: import('@playwright/test').Page): Promise<DebugState> {
  let stableSamples = 0;
  let previous = await getState(page);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(150);
    const current = await getState(page);
    const workerIdle = !current.worker
      || (current.worker.activeCount === 0 && current.worker.queuedCount === 0);
    if (workerIdle
      && current.rangeRequests.active === 0
      && current.transition.activeReplacementGroupCount === 0
      && current.streamingUpdateCount === previous.streamingUpdateCount) {
      stableSamples += 1;
      if (stableSamples >= 2) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }

  return previous;
}

async function sampleFrames(
  page: import('@playwright/test').Page,
  durationMs = 1200,
): Promise<{ frameCount: number; medianFrameMs: number; p95FrameMs: number; maxFrameMs: number }> {
  const intervals = await page.evaluate(async (duration) => {
    const values: number[] = [];
    let previous = performance.now();
    const end = previous + duration;
    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        values.push(now - previous);
        previous = now;
        if (now >= end) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return values;
  }, durationMs);
  const sorted = intervals.slice(5).sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * fraction),
  )] ?? 0;
  return {
    frameCount: intervals.length,
    medianFrameMs: at(0.5),
    p95FrameMs: at(0.95),
    maxFrameMs: at(1),
  };
}

function summarize(state: DebugState): Record<string, unknown> {
  return {
    renderedPointCount: state.renderedPointCount,
    selectedNodeKeys: state.selectedNodeKeys,
    selectedNodeCount: state.selectedNodeKeys.length,
    streamingUpdateCount: state.streamingUpdateCount,
    viewDistance: state.viewDistance,
    transition: state.transition,
    performance: state.performance,
    pointCache: state.pointCache,
    rangeRequests: state.rangeRequests,
    worker: state.worker,
    longestMainThreadTaskMs: state.longestMainThreadTaskMs,
    cesiumFrameDurationMs: state.cesiumFrameDurationMs,
    lastError: state.lastError,
  };
}

test.describe.configure({ mode: 'serial' });

test('records the Autzen Far/Near, rotation, and stale-work streaming gate', async ({ page }) => {
  const motionLookaheadEnabled = process.env.COPC_MOTION_LOOKAHEAD !== 'false';
  let delayRangeResponses = false;
  let delayedRangeRequestCount = 0;
  let releaseDelayedRangeResponses: () => void = () => {};
  const delayedRangeResponses = new Promise<void>((resolve) => {
    releaseDelayedRangeResponses = resolve;
  });
  await page.route('**/*.copc.laz*', async (route) => {
    if (delayRangeResponses && route.request().headers().range) {
      const state = await getState(page);
      if (state.performance.activeNodeCount > 0 && delayedRangeRequestCount === 0) {
        delayedRangeRequestCount += 1;
        await delayedRangeResponses;
      }
    }
    await route.continue();
  });
  await loadScenario(
    page,
    `budget=250000&motionLookahead=${motionLookaheadEnabled ? 'true' : 'false'}`,
  );
  const transitions: Record<string, unknown>[] = [];

  const move = async (label: string, height: number): Promise<DebugState> => {
    const before = await getState(page);
    const previousDistanceUpdateCount = before.viewDistance?.updateCount ?? 0;
    const startedAt = Date.now();
    await page.evaluate((nextHeight) => window.__COPC_DEBUG__?.setCameraHeight(nextHeight), height);
    await waitForViewChange(page, before);
    await expect.poll(async () => (await getState(page)).viewDistance?.updateCount ?? 0)
      .toBeGreaterThan(previousDistanceUpdateCount);
    const firstVisibleMs = Date.now() - startedAt;
    const state = await waitForIdle(page);
    transitions.push({
      label,
      height,
      firstVisibleMs,
      state: summarize(state),
      frames: await sampleFrames(page),
    });
    return state;
  };

  const far = await move('far', 100_000);
  const near = await move('near', 1_000);
  const farAgain = await move('far-again', 100_000);
  const nearAgain = await move('near-again', 1_000);

  expect(far.viewDistance?.effectiveDistanceMeters).toBeLessThanOrEqual(20_000);
  expect(near.viewDistance?.effectiveDistanceMeters)
    .toBeLessThan(far.viewDistance?.effectiveDistanceMeters ?? 0);

  const beforeRotation = await getState(page);
  const previousRotationDistanceUpdateCount = beforeRotation.viewDistance?.updateCount ?? 0;
  const previousMotionSampledMovementCount =
    beforeRotation.performance.motionSampledMovementCount;
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraPitch(-35));
  // Keep the two explicit orientation changes in separate camera samples.
  // Setting both synchronously can collapse them into one frame on a loaded CI
  // runner and leave the motion estimator with no measurable time interval.
  await page.waitForTimeout(25);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeading(90));
  if (motionLookaheadEnabled) {
    await expect.poll(async () => {
      return (await getState(page)).performance.motionSampledMovementCount;
    }, { timeout: 10_000 }).toBeGreaterThan(previousMotionSampledMovementCount);
  } else {
    await expect.poll(async () => {
      return (await getState(page)).performance.motionSampledMovementCount;
    }, { timeout: 10_000 }).toBe(previousMotionSampledMovementCount);
  }
  const rotationMotionSample = await getState(page);
  await waitForViewChange(page, beforeRotation);
  await expect.poll(async () => (await getState(page)).viewDistance?.updateCount ?? 0)
    .toBeGreaterThan(previousRotationDistanceUpdateCount);
  const rotating = await getState(page);
  expect(rotating.performance.motionLookaheadEnabled).toBe(motionLookaheadEnabled);
  const rotated = await waitForIdle(page);
  await expect.poll(async () => {
    const performance = (await getState(page)).performance;
    return performance.motionPredictedHorizontalDisplacementDegrees === 0
      && performance.motionPredictedVerticalDisplacementDegrees === 0;
  }, { timeout: 10_000 }).toBe(true);
  // The one-shot timer can fire before or after the rotation update drains.
  if (motionLookaheadEnabled) {
    // Allow its 100 ms coalescing window, then ensure the stationary selection
    // and any replacement work have finished.
    await page.waitForTimeout(150);
    await waitForIdle(page);
  }
  const settledMotion = await getState(page);
  const settledMotionSummary = summarize(settledMotion);
  await page.waitForTimeout(400);
  const stableMotion = await getState(page);
  expect(stableMotion.streamingUpdateCount).toBe(settledMotion.streamingUpdateCount);
  expect(stableMotion.rangeRequests.requested).toBe(settledMotion.rangeRequests.requested);
  expect(stableMotion.performance.rangeFetchBytes)
    .toBe(settledMotion.performance.rangeFetchBytes);
  expect(stableMotion.worker?.submittedCount).toBe(settledMotion.worker?.submittedCount);
  expect(stableMotion.worker?.activeCount).toBe(0);
  expect(stableMotion.worker?.queuedCount).toBe(0);
  expect(stableMotion.pointCache.misses).toBe(settledMotion.pointCache.misses);
  transitions.push({
    label: 'rotate-under-load-and-stationary-decay',
    state: summarize(rotating),
    motionSample: summarize(rotationMotionSample),
    settled: summarize(rotated),
    settledMotion: settledMotionSummary,
    stableMotion: summarize(stableMotion),
    frames: await sampleFrames(page),
  });

  // Delay point ranges after the hierarchy query has started its node loads.
  // This leaves hierarchy page reads reusable while holding a real point read.
  delayRangeResponses = true;
  const beforeDelayedView = await getState(page);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeading(270));
  await waitForViewChange(page, beforeDelayedView);
  await expect.poll(async () => {
    const state = await getState(page);
    return delayedRangeRequestCount > 0
      && state.performance.activeNodeCount > 0
      && state.rangeRequests.active > 0;
  }, { timeout: 30_000 }).toBe(true);
  const beforeSupersede = await getState(page);
  try {
    await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(100_000));
    await expect.poll(async () => (await getState(page)).rangeRequests.abortedSuperseded, {
      timeout: 30_000,
    }).toBeGreaterThan(beforeSupersede.rangeRequests.abortedSuperseded);
  } finally {
    releaseDelayedRangeResponses();
  }
  await expect.poll(async () => (await getState(page)).selectedNodeKeys.length, {
    timeout: 120_000,
  }).toBe(0);
  const staleWork = await waitForIdle(page);
  transitions.push({
    label: 'slow-range-superseded-by-far-view',
    delayedRangeRequestCount,
    state: summarize(staleWork),
  });

  console.log(JSON.stringify({
    scenario: 'issue-68-autzen-streaming-gate',
    configuration: {
      backend: 'rust',
      colorMode: 'elevation',
      motionLookahead: motionLookaheadEnabled,
      maxNodes: 32,
      maxDepth: 6,
      maxScreenSpaceError: 8,
      maxRenderDistanceMeters: 20_000,
      maxRenderedPoints: 250_000,
    },
    transitions,
  }, null, 2));

  expect(far.lastError).toBeUndefined();
  expect(near.lastError).toBeUndefined();
  expect(farAgain.lastError).toBeUndefined();
  expect(nearAgain.lastError).toBeUndefined();
  expect(rotated.lastError).toBeUndefined();
  expect(staleWork.lastError).toBeUndefined();
  expect(staleWork.renderedPointCount).toBeLessThanOrEqual(250_000);
  expect(staleWork.performance.activeRenderedPointCount).toBeLessThanOrEqual(250_000);
  expect(staleWork.transition.activeReplacementGroupCount).toBe(0);
  expect(staleWork.worker).toBeDefined();
  expect(staleWork.worker!.activeCount).toBeLessThanOrEqual(staleWork.worker!.workerCount);
  expect(staleWork.worker!.queuedCount).toBe(0);
  expect(staleWork.rangeRequests.requested).toBe(
    staleWork.rangeRequests.completed
      + staleWork.rangeRequests.failed
      + staleWork.rangeRequests.abortedSuperseded
      + staleWork.rangeRequests.abortedLifecycle,
  );
  expect(staleWork.rangeRequests.active).toBe(0);
  expect(delayedRangeRequestCount).toBeGreaterThan(0);
  expect(staleWork.rangeRequests.abortedSuperseded).toBeGreaterThan(
    beforeSupersede.rangeRequests.abortedSuperseded,
  );
});

test('records monotonic low/high rendered-point budgets', async ({ browser }) => {
  const loadBudget = async (budget: number): Promise<{ page: import('@playwright/test').Page; state: DebugState }> => {
    const page = await browser.newPage();
    await loadScenario(page, `budget=${budget}`);
    return { page, state: await waitForIdle(page) };
  };

  const low = await loadBudget(100_000);
  const high = await loadBudget(500_000);
  const lowState = low.state;
  const highState = await waitForIdle(high.page);
  console.log(JSON.stringify({
    scenario: 'issue-68-budget-scaling',
    low: summarize(lowState),
    high: summarize(highState),
  }, null, 2));

  expect(lowState.renderedPointCount).toBeLessThanOrEqual(100_000);
  expect(lowState.performance.activeRenderedPointCount).toBeLessThanOrEqual(100_000);
  expect(highState.renderedPointCount).toBeLessThanOrEqual(500_000);
  expect(highState.performance.activeRenderedPointCount).toBeLessThanOrEqual(500_000);
  expect(highState.renderedPointCount).toBeGreaterThan(lowState.renderedPointCount);
  expect(lowState.lastError).toBeUndefined();
  expect(highState.lastError).toBeUndefined();
  await low.page.close();
  await high.page.close();
});

test('records decoded CPU cache pressure separately from rendered workload', async ({ page }) => {
  await loadScenario(page, 'budget=250000&cacheBytes=1048576&motionLookahead=false');
  await expect.poll(async () => (await getState(page)).streamingUpdateCount, {
    timeout: 120_000,
  }).toBeGreaterThan(0);
  await waitForIdle(page);

  const moveAndWait = async (height: number): Promise<void> => {
    const before = await getState(page);
    await page.evaluate((nextHeight) => {
      window.__COPC_DEBUG__?.setCameraHeight(nextHeight);
    }, height);
    await expect.poll(async () => (await getState(page)).streamingUpdateCount, {
      timeout: 120_000,
    }).toBeGreaterThan(before.streamingUpdateCount);
    await waitForIdle(page);
  };

  await moveAndWait(1_000);
  await moveAndWait(100_000);
  const state = await waitForIdle(page);
  console.log(JSON.stringify({
    scenario: 'issue-68-cache-pressure',
    configuration: {
      maxRenderedPoints: 250_000,
      maxPointCacheBytes: 1_048_576,
      motionLookahead: false,
    },
    state: summarize(state),
  }, null, 2));

  expect(state.pointCache.cacheByteBudget).toBe(1_048_576);
  expect(state.pointCache.currentCacheBytes).toBeGreaterThanOrEqual(0);
  expect(state.pointCache.evictionCount).toBeGreaterThan(0);
  expect(state.pointCache.bytesEvicted).toBeGreaterThan(0);
  expect(state.renderedPointCount).toBeLessThanOrEqual(250_000);
  expect(state.lastError).toBeUndefined();
});

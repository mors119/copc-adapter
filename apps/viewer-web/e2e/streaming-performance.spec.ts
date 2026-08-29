import { expect, test } from '@playwright/test';

type DebugState = {
  layerLoaded: boolean;
  renderedPointCount: number;
  selectedNodeKeys: string[];
  streamingUpdateCount: number;
  backend: string;
  performance: Record<string, number> & {
    configuredPointBudget: number;
    activeRenderedPointCount: number;
    candidateSelectedPointCount: number;
    deferredNodeCount: number;
    deferredPointCount: number;
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

async function loadScenario(
  page: import('@playwright/test').Page,
  query: string,
): Promise<void> {
  await page.goto(`/?scenario=issue68&backend=rust&debugPanel=false&${query}`);
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
    if (workerIdle && current.streamingUpdateCount === previous.streamingUpdateCount) {
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
    selectedNodeCount: state.selectedNodeKeys.length,
    streamingUpdateCount: state.streamingUpdateCount,
    performance: state.performance,
    pointCache: state.pointCache,
    worker: state.worker,
    longestMainThreadTaskMs: state.longestMainThreadTaskMs,
    cesiumFrameDurationMs: state.cesiumFrameDurationMs,
    lastError: state.lastError,
  };
}

test.describe.configure({ mode: 'serial' });

test('records the Autzen Far/Near, rotation, and stale-work streaming gate', async ({ page }) => {
  await loadScenario(page, 'budget=250000');
  const transitions: Record<string, unknown>[] = [];

  const move = async (label: string, height: number): Promise<DebugState> => {
    const before = await getState(page);
    const startedAt = Date.now();
    await page.evaluate((nextHeight) => window.__COPC_DEBUG__?.setCameraHeight(nextHeight), height);
    await expect.poll(async () => (await getState(page)).streamingUpdateCount, {
      timeout: 120_000,
    }).toBeGreaterThan(before.streamingUpdateCount);
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

  const beforeRotation = await getState(page);
  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
    window.__COPC_DEBUG__?.setCameraHeading(90);
  });
  await expect.poll(async () => (await getState(page)).streamingUpdateCount, {
    timeout: 120_000,
  }).toBeGreaterThan(beforeRotation.streamingUpdateCount);
  const rotated = await waitForIdle(page);
  transitions.push({ label: 'rotate-under-load', state: summarize(rotated), frames: await sampleFrames(page) });

  // A rapid replacement must leave the latest generation in charge and must
  // not create a late render burst above the active workload budget.
  await page.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraHeight(100_000);
    window.__COPC_DEBUG__?.setCameraHeight(1_000);
  });
  await page.waitForTimeout(2_000);
  const staleWork = await waitForIdle(page);
  transitions.push({ label: 'rapid-near-far-near', state: summarize(staleWork) });

  console.log(JSON.stringify({
    scenario: 'issue-68-autzen-streaming-gate',
    configuration: {
      backend: 'rust',
      colorMode: 'elevation',
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
  expect(staleWork.worker).toBeDefined();
  expect(staleWork.worker!.activeCount).toBeLessThanOrEqual(staleWork.worker!.workerCount);
  expect(staleWork.worker!.queuedCount).toBe(0);
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
  await loadScenario(page, 'budget=250000&cacheBytes=1048576');
  await waitForIdle(page);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(1_000));
  await page.waitForTimeout(1_500);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(100_000));
  await page.waitForTimeout(1_500);
  const state = await waitForIdle(page);
  console.log(JSON.stringify({
    scenario: 'issue-68-cache-pressure',
    configuration: { maxRenderedPoints: 250_000, maxPointCacheBytes: 1_048_576 },
    state: summarize(state),
  }, null, 2));

  expect(state.pointCache.cacheByteBudget).toBe(1_048_576);
  expect(state.pointCache.currentCacheBytes).toBeGreaterThanOrEqual(0);
  expect(state.pointCache.evictionCount).toBeGreaterThan(0);
  expect(state.pointCache.bytesEvicted).toBeGreaterThan(0);
  expect(state.renderedPointCount).toBeLessThanOrEqual(250_000);
  expect(state.lastError).toBeUndefined();
});

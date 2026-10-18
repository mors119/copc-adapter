import { expect, test } from '@playwright/test';
import { getCompletedStreamingState } from './streaming-state';

type BenchmarkState = {
  renderedPointCount: number;
  renderedNodeKeys: string[];
  streamingUpdateCount: number;
  performance: Record<string, number>;
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
  lastError?: string;
};

type BenchmarkDebugAdapter = {
  getState(): BenchmarkState;
  setCameraHeight(height: number): void;
  setCameraHeading(headingDegrees: number): void;
  runSyntheticRendererPerformanceBenchmark(): Array<Record<string, unknown>>;
  setStyle(update: {
    colorMode?: 'fixed' | 'rgb' | 'elevation' | 'intensity' | 'classification';
    classificationFilter?: { include?: number[] } | null;
  }): void;
  probePublicBatchPick(): { picked: boolean; pickedNodeKey?: string; pointIndex?: number };
  setPublicBatchVisibility(show: boolean): void;
  clearPublicBatchNodes(): number;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: BenchmarkDebugAdapter;
  }
}

async function getState(page: import('@playwright/test').Page): Promise<BenchmarkState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) {
      throw new Error('COPC debug adapter is unavailable');
    }
    return window.__COPC_DEBUG__.getState();
  });
}

async function sampleFrames(
  page: import('@playwright/test').Page,
  durationMs = 2000,
): Promise<{ frameCount: number; medianFrameMs: number; p95FrameMs: number; maxFrameMs: number }> {
  const intervals = await page.evaluate(async (duration) => {
    const values: number[] = [];
    let previous = performance.now();
    const end = previous + duration;

    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        values.push(now - previous);
        previous = now;
        if (now >= end) {
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
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

async function sampleCameraTransition(
  page: import('@playwright/test').Page,
  height: number,
): Promise<{ state: BenchmarkState; frames: { frameCount: number; medianFrameMs: number; p95FrameMs: number; maxFrameMs: number } }> {
  const before = await getCompletedStreamingState(() => getState(page));
  const frames = await page.evaluate(async (nextHeight) => {
    window.__COPC_DEBUG__?.setCameraHeight(nextHeight);
    const values: number[] = [];
    let previous = performance.now();
    const end = previous + 2500;

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
  }, height);
  await expect.poll(async () => (await getState(page)).streamingUpdateCount)
    .toBeGreaterThan(before.streamingUpdateCount);
  const sorted = frames.slice(5).sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * fraction),
  )] ?? 0;

  return {
    state: await getCompletedStreamingState(() => getState(page)),
    frames: {
      frameCount: frames.length,
      medianFrameMs: at(0.5),
      p95FrameMs: at(0.95),
      maxFrameMs: at(1),
    },
  };
}

test('prints repeatable synthetic and Autzen renderer performance evidence', async ({ page }) => {
  const renderer = process.env.COPC_RENDERER_VARIANT === 'public-batched'
    ? '&renderer=public-batched'
    : '';
  await page.goto(`/?scenario=issue61&debugPanel=false${renderer}`);
  await expect.poll(() => getState(page)).toMatchObject({ renderedPointCount: expect.any(Number) });
  await expect.poll(async () => (await getState(page)).renderedPointCount).toBeGreaterThan(0);

  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    devicePixelRatio: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    hardwareConcurrency: navigator.hardwareConcurrency,
  }));
  const synthetic = await page.evaluate(() =>
    window.__COPC_DEBUG__?.runSyntheticRendererPerformanceBenchmark() ?? []);
  const initialFrames = await sampleFrames(page);
  const scenarios: Array<Record<string, unknown>> = [];

  for (const [label, height] of [['far', 100_000], ['near', 1_000]] as const) {
    const transition = await sampleCameraTransition(page, height);
    scenarios.push({
      label,
      state: transition.state,
      frames: transition.frames,
    });
  }

  const rendererEvidence = scenarios.map((scenario) => {
    const state = scenario.state as BenchmarkState;
    const performance = state.performance;
    const frames = scenario.frames as { frameCount: number; medianFrameMs: number; p95FrameMs: number; maxFrameMs: number };
    return {
      camera: scenario.label,
      selectedNodeCount: performance.selectedNodeCount,
      renderedNodeCount: state.renderedNodeKeys.length,
      estimatedSelectedPoints: performance.estimatedSelectedPointCount,
      loadedPoints: performance.loadedPointCount,
      renderedPoints: state.renderedPointCount,
      rangeFetchBytes: performance.rangeFetchBytes,
      rangeFetchMs: performance.rangeFetchDurationMs,
      decodeMs: performance.decodeDurationMs,
      pointPreparationMs: performance.pointPreparationDurationMs,
      crsTransformMs: performance.crsTransformDurationMs,
      coordinateConversionMs: performance.worldToCartesianDurationMs,
      styleMs: performance.pointStylePreparationDurationMs,
      collectionCreationMs: performance.pointCollectionCreationDurationMs,
      pointAddMs: performance.pointAddDurationMs,
      rendererPreparationMs: performance.rendererPreparationDurationMs,
      longestMainThreadTaskMs: state.longestMainThreadTaskMs,
      cesiumFrameDurationMs: state.cesiumFrameDurationMs,
      frames,
    };
  });
  console.log(JSON.stringify({
    renderer: process.env.COPC_RENDERER_VARIANT ?? 'point-primitive',
    environment,
    synthetic: {
      renderer: 'point-primitive',
      result: synthetic.find((row) => row.pointCount === 100_000),
    },
    initialFrames,
    rendererEvidence,
  }, null, 2));
  if (renderer) {
    const styleModes = ['fixed', 'rgb', 'elevation', 'intensity', 'classification'] as const;
    for (const colorMode of styleModes) {
      await page.evaluate((mode) => {
        window.__COPC_DEBUG__?.setStyle({ colorMode: mode });
      }, colorMode);
      await expect.poll(async () => (await getState(page)).lastError).toBeUndefined();
    }
    const unfilteredPointCount = (await getState(page)).renderedPointCount;
    await page.evaluate(() => {
      window.__COPC_DEBUG__?.setStyle({ classificationFilter: { include: [2] } });
    });
    await expect.poll(async () => (await getState(page)).renderedPointCount)
      .toBeLessThan(unfilteredPointCount);
    await page.evaluate(() => {
      window.__COPC_DEBUG__?.setStyle({ classificationFilter: null });
    });
    await expect.poll(async () => (await getState(page)).renderedPointCount)
      .toBe(unfilteredPointCount);
    await page.screenshot({ path: 'test-results/public-batched-autzen.png' });
    const pickProbe = await page.evaluate(() => window.__COPC_DEBUG__?.probePublicBatchPick());
    console.log(JSON.stringify({ publicBatchedPickProbe: pickProbe }, null, 2));
    expect(pickProbe).toMatchObject({ picked: true, pickedNodeKey: expect.any(String) });
    expect(pickProbe?.pointIndex).toBeUndefined();
    await page.evaluate(() => window.__COPC_DEBUG__?.setPublicBatchVisibility(false));
    expect(await page.evaluate(() => window.__COPC_DEBUG__?.probePublicBatchPick()))
      .toMatchObject({ picked: false });
    await page.evaluate(() => window.__COPC_DEBUG__?.setPublicBatchVisibility(true));
    expect(await page.evaluate(() => window.__COPC_DEBUG__?.clearPublicBatchNodes())).toBe(0);
  }
  expect(synthetic.length).toBe(3);
  expect(synthetic[2].pointCount).toBe(100_000);
  expect(scenarios.every((scenario) => scenario.state)).toBe(true);
});

test('keeps low/high rendered-point budgets bounded and reprioritises on rotation', async ({
  browser,
}) => {
  const loadBudgetedState = async (budget: number) => {
    const page = await browser.newPage();
    const renderer = process.env.COPC_RENDERER_VARIANT === 'public-batched'
      ? '&renderer=public-batched'
      : '';
    await page.goto(`/?scenario=issue59&budget=${budget}&debugPanel=false${renderer}`);
    await expect.poll(async () => (await getState(page)).renderedPointCount)
      .toBeGreaterThan(0);
    await expect.poll(async () => (await getState(page)).performance.configuredPointBudget)
      .toBe(budget);
    return page;
  };

  const lowPage = await loadBudgetedState(100_000);
  const lowState = await getCompletedStreamingState(() => getState(lowPage));
  expect(lowState.renderedPointCount).toBeLessThanOrEqual(100_000);
  expect(lowState.performance.activeRenderedPointCount).toBeLessThanOrEqual(100_000);

  const highPage = await loadBudgetedState(500_000);
  await expect.poll(async () => (await getState(highPage)).renderedPointCount, {
    timeout: 60_000,
  }).toBeGreaterThan(lowState.renderedPointCount);
  const highState = await getCompletedStreamingState(() => getState(highPage));
  expect(highState.renderedPointCount).toBeLessThanOrEqual(500_000);
  expect(highState.performance.activeRenderedPointCount).toBeLessThanOrEqual(500_000);
  expect(highState.renderedPointCount).toBeGreaterThan(lowState.renderedPointCount);

  await highPage.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
    window.__COPC_DEBUG__?.setCameraHeading(90);
  });
  await expect.poll(async () => (await getState(highPage)).streamingUpdateCount)
    .toBeGreaterThan(highState.streamingUpdateCount);
  const rotatedState = await getCompletedStreamingState(() => getState(highPage));
  expect(rotatedState.renderedPointCount).toBeLessThanOrEqual(500_000);
  expect(rotatedState.selectedNodeKeys).not.toEqual(highState.selectedNodeKeys);
  expect(rotatedState.lastError).toBeUndefined();

  await lowPage.close();
  await highPage.close();
});

import { expect, test } from '@playwright/test';

type BenchmarkState = {
  renderedPointCount: number;
  streamingUpdateCount: number;
  performance: Record<string, number>;
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
};

type BenchmarkDebugAdapter = {
  getState(): BenchmarkState;
  setCameraHeight(height: number): void;
  setCameraHeading(headingDegrees: number): void;
  runSyntheticRendererPerformanceBenchmark(): Array<Record<string, unknown>>;
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
  const before = await getState(page);
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
    state: await getState(page),
    frames: {
      frameCount: frames.length,
      medianFrameMs: at(0.5),
      p95FrameMs: at(0.95),
      maxFrameMs: at(1),
    },
  };
}

test('prints repeatable synthetic and Autzen renderer performance evidence', async ({ page }) => {
  await page.goto('/?scenario=issue61&debugPanel=false');
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

  console.log(JSON.stringify({ environment, synthetic, initialFrames, scenarios }, null, 2));
  expect(synthetic.length).toBe(3);
  expect(synthetic[2].pointCount).toBe(100_000);
  expect(scenarios.every((scenario) => scenario.state)).toBe(true);
});

test('keeps low/high rendered-point budgets bounded and reprioritises on rotation', async ({
  browser,
}) => {
  const loadBudgetedState = async (budget: number) => {
    const page = await browser.newPage();
    await page.goto(`/?scenario=issue59&budget=${budget}&debugPanel=false`);
    await expect.poll(async () => (await getState(page)).renderedPointCount)
      .toBeGreaterThan(0);
    await expect.poll(async () => (await getState(page)).performance.configuredPointBudget)
      .toBe(budget);
    return page;
  };

  const lowPage = await loadBudgetedState(100_000);
  const lowState = await getState(lowPage);
  expect(lowState.renderedPointCount).toBeLessThanOrEqual(100_000);
  expect(lowState.performance.activeRenderedPointCount).toBeLessThanOrEqual(100_000);

  const highPage = await loadBudgetedState(500_000);
  await expect.poll(async () => (await getState(highPage)).renderedPointCount, {
    timeout: 60_000,
  }).toBeGreaterThan(lowState.renderedPointCount);
  const highState = await getState(highPage);
  expect(highState.renderedPointCount).toBeLessThanOrEqual(500_000);
  expect(highState.performance.activeRenderedPointCount).toBeLessThanOrEqual(500_000);
  expect(highState.renderedPointCount).toBeGreaterThan(lowState.renderedPointCount);

  await highPage.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
    window.__COPC_DEBUG__?.setCameraHeading(90);
  });
  await expect.poll(async () => (await getState(highPage)).streamingUpdateCount)
    .toBeGreaterThan(highState.streamingUpdateCount);
  const rotatedState = await getState(highPage);
  expect(rotatedState.renderedPointCount).toBeLessThanOrEqual(500_000);
  expect(rotatedState.selectedNodeKeys).not.toEqual(highState.selectedNodeKeys);
  expect(rotatedState.lastError).toBeUndefined();

  await lowPage.close();
  await highPage.close();
});

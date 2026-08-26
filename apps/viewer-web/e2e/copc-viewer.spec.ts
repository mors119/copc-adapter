import { expect, test } from '@playwright/test';

type CopcDebugState = {
  viewerReady: boolean;
  layerLoaded: boolean;
  metadataPointCount?: number;
  renderedPointCount: number;
  scenePointCollectionCount: number;
  renderedNodeKeys: string[];
  selectedNodeKeys: string[];
  streamingUpdateCount: number;
  cameraMoveEventCount: number;
  cameraPitchDegrees: number;
  minRenderedHeight?: number;
  maxRenderedHeight?: number;
  renderedColorCount: number;
  lastError?: string;
};

type CopcDebugAdapter = {
  getState(): CopcDebugState;
  getLastError(): string | undefined;
  setCameraHeight(height: number): void;
  setCameraPitch(pitchDegrees: number): void;
  recordError(error: unknown): void;
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

test('streams a COPC sample into a real Cesium scene and updates after camera movement', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error);
  });

  await page.goto('/');

  await expect.poll(() => getDebugState(page)).toMatchObject({
    viewerReady: true,
    layerLoaded: true,
    metadataPointCount: 10653336,
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

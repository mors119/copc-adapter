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
  lastError?: string;
};

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

  const initialState = await getDebugState(page);
  expect(initialState.renderedNodeKeys).not.toEqual([]);
  expect(initialState.selectedNodeKeys).not.toEqual([]);
  expect(initialState.streamingUpdateCount).toBeGreaterThan(0);

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
});

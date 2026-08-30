import { expect, test } from '@playwright/test';

async function state(page) {
  return page.evaluate(() => window.__PACKED_CONSUMER__.getState());
}

async function loadRustPage(page, query = '?backend=rust&mode=rgb') {
  const pageErrors = [];
  const consoleErrors = [];
  const requestUrls = [];
  const copcResponses = [];
  const assetResponses = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('request', (request) => requestUrls.push(request.url()));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('autzen.copc.laz')) {
      copcResponses.push({
        url,
        status: response.status(),
        requestRange: response.request().headers().range,
        contentRange: response.headers()['content-range'],
        contentLength: Number(response.headers()['content-length'] ?? 0),
      });
    }
    if (url.includes('copc_wasm') || url.includes('laz-perf') || url.includes('rustCopcDecodeWorker')) {
      assetResponses.push({
        url,
        status: response.status(),
        contentType: response.headers()['content-type'],
      });
    }
  });

  await page.goto(`/${query}`);
  await expect.poll(() => state(page)).toMatchObject({
    viewerCreatedByConsumer: true,
    viewerAlive: true,
    layerAttachedToCallerViewer: true,
    lifecycle: 'ready',
    backend: 'rust',
    metadata: { pointCount: 10653336 },
  });
  await expect.poll(async () => (await state(page)).renderedPointCount).toBeGreaterThan(0);
  await expect.poll(async () => {
    const current = await state(page);
    return (current.maxRenderedHeight ?? 0) - (current.minRenderedHeight ?? 0);
  }).toBeGreaterThan(1);
  await expect.poll(async () => (await state(page)).hierarchy?.pageRequests ?? 0)
    .toBeGreaterThan(0);

  return { pageErrors, consoleErrors, requestUrls, copcResponses, assetResponses };
}

test('validates the packed Rust backend in an external Vite consumer', async ({ page }) => {
  const {
    pageErrors,
    consoleErrors,
    requestUrls,
    copcResponses,
    assetResponses,
  } = await loadRustPage(page);
  const initial = await state(page);

  expect(initial.metadata.bounds.minX).toBeCloseTo(635577.79, 2);
  expect(initial.metadata.bounds.maxZ).toBeCloseTo(615.26, 2);
  expect(initial.metadata.scale).toEqual({ x: 0.01, y: 0.01, z: 0.01 });
  expect(initial.metadata.wkt).toContain('NAD83 / Oregon GIC Lambert');
  expect(initial.firstPosition.longitude).toBeGreaterThan(-124);
  expect(initial.firstPosition.longitude).toBeLessThan(-122);
  expect(initial.firstPosition.latitude).toBeGreaterThan(43);
  expect(initial.firstPosition.latitude).toBeLessThan(45);
  expect(initial.maxRenderedHeight - initial.minRenderedHeight).toBeGreaterThan(1);
  expect(initial.renderedColorCount).toBeGreaterThan(1);
  expect(initial.hierarchy.pageRequests).toBeGreaterThan(0);
  expect(initial.hierarchy.hierarchyBytesFetched).toBeGreaterThan(0);
  expect(initial.hierarchy.hierarchyBytesFetched).toBeLessThan(81123042);

  const attributes = await page.evaluate(() => window.__PACKED_CONSUMER__.probeRustAttributes());
  expect(attributes.availableFields).toEqual(['classification', 'intensity', 'position', 'rgb']);
  expect(attributes.pointCount).toBeGreaterThan(0);
  expect(Object.keys(attributes.sample)).toEqual([
    'x', 'y', 'z', 'intensity', 'classification', 'red', 'green', 'blue',
  ]);

  await page.evaluate(() => window.__PACKED_CONSUMER__.setCameraHeight(100000));
  await expect.poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(initial.streamingUpdateCount);
  const far = await state(page);
  await page.evaluate(() => window.__PACKED_CONSUMER__.setCameraHeight(1000));
  await expect.poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(far.streamingUpdateCount);
  const near = await state(page);
  expect(near.selectedNodeKeys).not.toEqual(far.selectedNodeKeys);
  expect(near.hierarchy.pageRequests).toBeGreaterThanOrEqual(initial.hierarchy.pageRequests);
  expect(near.lastError).toBeUndefined();

  const fixedPosition = near.cameraPosition;
  await page.evaluate(() => window.__PACKED_CONSUMER__.setCameraOrientation(0, -45));
  await expect.poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(near.streamingUpdateCount);
  const beforeRotation = await state(page);
  await page.evaluate(() => window.__PACKED_CONSUMER__.setCameraOrientation(180, -45));
  await expect.poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(beforeRotation.streamingUpdateCount);
  const rotated = await state(page);
  expect(rotated.cameraPosition.longitude).toBeCloseTo(fixedPosition.longitude, 8);
  expect(rotated.cameraPosition.latitude).toBeCloseTo(fixedPosition.latitude, 8);
  expect(rotated.cameraPosition.height).toBeCloseTo(fixedPosition.height, 4);
  expect(rotated.performance.cameraDirection).not.toEqual(beforeRotation.performance.cameraDirection);
  expect(rotated.performance.candidatesBeforeCulling).toBeGreaterThan(0);
  expect(rotated.performance.frustumCulledCount).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  expect(copcResponses.length).toBeGreaterThan(0);
  expect(copcResponses.every((response) => response.status === 206)).toBe(true);
  expect(copcResponses.every((response) => /^bytes=\d+-\d+$/.test(response.requestRange))).toBe(true);
  expect(copcResponses.every((response) => response.contentRange?.startsWith('bytes '))).toBe(true);
  expect(copcResponses.reduce((total, response) => total + response.contentLength, 0))
    .toBeLessThan(81123042);
  expect(copcResponses.some((response) => response.requestRange === 'bytes=0-374')).toBe(true);
  expect(assetResponses.some((response) => response.url.includes('copc_wasm') && response.status === 200))
    .toBe(true);
  const copcWasmResponses = assetResponses.filter((response) => /copc_wasm[^/]*\.wasm(?:$|\?)/i.test(response.url));
  expect(copcWasmResponses.length).toBeGreaterThan(0);
  expect(copcWasmResponses.every((response) => response.status === 200)).toBe(true);
  expect(copcWasmResponses.every((response) => !response.url.includes('/.vite/deps/'))).toBe(true);
  expect(initial.worker?.completedCount).toBeGreaterThan(0);
  expect(assetResponses.some((response) => response.url.includes('laz-perf'))).toBe(false);
  expect(requestUrls.some((url) => /\/public\/|\/target\/|copc-adapter\/feature-/i.test(url))).toBe(false);
});

test('keeps elevation styling and the copc-js backend available to consumers', async ({ page }) => {
  const rust = await loadRustPage(page, '?backend=rust&mode=elevation');
  await expect.poll(async () => (await state(page)).colorMode).toBe('elevation');
  const elevation = await state(page);
  expect(elevation.renderedColorCount).toBeGreaterThan(1);
  expect(elevation.lastError).toBeUndefined();
  expect(rust.assetResponses.some((response) => response.url.includes('copc_wasm'))).toBe(true);

  const jsPageErrors = [];
  const jsConsoleErrors = [];
  page.on('pageerror', (error) => jsPageErrors.push(error));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      jsConsoleErrors.push(message.text());
    }
  });
  await page.goto('/?backend=copc-js&mode=rgb');
  await expect.poll(() => state(page)).toMatchObject({
    lifecycle: 'ready',
    backend: 'copc-js',
    metadata: { pointCount: 10653336 },
  });
  await expect.poll(async () => (await state(page)).renderedPointCount).toBeGreaterThan(0);
  const jsState = await state(page);
  expect(jsState.lastError).toBeUndefined();
  expect(jsState.viewerCreatedByConsumer).toBe(true);
  expect(jsPageErrors).toEqual([]);
  expect(jsConsoleErrors).toEqual([]);
  expect(rust.assetResponses.some((response) => response.url.includes('laz-perf') && response.status === 200))
    .toBe(true);
});

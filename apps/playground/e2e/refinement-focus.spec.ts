import { expect, test } from '@playwright/test';

type PlaygroundTestHooks = {
  useCameraResetLayerMock(): void;
  getMockLoadCount(): number;
  getMockLayerCreateCount(): number;
  getMockRefinementAlgorithm(): string | undefined;
  getMockFocusUpdateCount(): number;
  getMockRefinementFocus(): {
    type: 'screen-circle';
    center: { x: number; y: number };
    radius: number;
    detailBias: number;
  } | undefined;
  getSnapshot(): {
    refinementAlgorithm?: string;
    refinementFocusEnabled?: boolean;
    focusCandidateCount?: number;
    focusInfluencedRefinementCount?: number;
    selectedNodeKeys?: readonly string[];
  } | undefined;
  getCameraView(): {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
  };
  setCameraView(view: {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
  }): void;
  getCameraInputsEnabled(): boolean | undefined;
};

async function useMockLayer(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const hooks = (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error('Playground test hooks are unavailable');
    hooks.useCameraResetLayerMock();
  });
}

async function loadFile(page: import('@playwright/test').Page, name = 'focus-test.copc.laz'): Promise<void> {
  await page.locator('#copc-file').setInputFiles({
    name,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test source'),
  });
  await expect(page.locator('#source-status')).toHaveText(`Loaded ${name}`);
}

test('algorithm selection applies the actual constructor option and survives URL/code generation', async ({ page }) => {
  await page.goto('./');
  await useMockLayer(page);
  await loadFile(page, 'algorithm.copc.laz');

  const initialCreates = await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLayerCreateCount() ?? 0);
  await page.locator('#refinement-algorithm').selectOption('screen-projection');
  await expect(page.locator('#source-status')).toHaveText('Loaded algorithm.copc.laz');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementAlgorithm())).toBe('screen-projection');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLayerCreateCount())).toBe(initialCreates + 1);
  await expect(page.locator('#integration-example')).toContainText("refinementAlgorithm: 'screen-projection'");
  await expect(page).toHaveURL(/refinementAlgorithm=screen-projection/);

  await page.locator('#refinement-algorithm').selectOption('foveated');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementAlgorithm())).toBe('foveated');
  await expect(page).toHaveURL(/refinementAlgorithm=foveated/);
});

test('focus modes update the active Cesium layer without recreating it', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('./');
  await useMockLayer(page);
  await loadFile(page);
  const initialLoads = await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLoadCount() ?? 0);
  const initialCreates = await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLayerCreateCount() ?? 0);

  await page.locator('#focus-mode').selectOption('center-boost');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus())).toMatchObject({
    type: 'screen-circle',
    center: { x: 0.5, y: 0.5 },
  });
  const updateCountBeforeGuide = await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockFocusUpdateCount() ?? 0);
  await page.locator('#focus-show-guide').uncheck();
  await expect(page.locator('#focus-guide')).toBeHidden();
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockFocusUpdateCount())).toBe(updateCountBeforeGuide);

  await page.locator('#focus-radius').evaluate((element: HTMLInputElement) => {
    element.value = '26';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#focus-bias').evaluate((element: HTMLInputElement) => {
    element.value = '2';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.radius)).toBe(0.26);

  await page.locator('#focus-enabled').uncheck();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus())).toBeUndefined();
  await page.locator('#focus-enabled').check();
  await page.locator('#focus-mode').selectOption('follow-pointer');

  const canvasBounds = await page.locator('#cesium-container canvas').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
  await page.locator('#cesium-container canvas').evaluate((canvas, bounds) => {
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: bounds.left + bounds.width * 0.73,
      clientY: bounds.top + bounds.height * 0.31,
    }));
  }, canvasBounds);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x)).toBeCloseTo(0.73, 2);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.y)).toBeCloseTo(0.31, 2);
  await page.locator('#cesium-container canvas').evaluate((canvas, bounds) => {
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: bounds.left + bounds.width * 0.22,
      clientY: bounds.top + bounds.height * 0.72,
    }));
    canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
  }, canvasBounds);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x)).toBeCloseTo(0.22, 2);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.y)).toBeCloseTo(0.72, 2);
  await expect(page).toHaveURL(/focusMode=follow-pointer/);
  await expect(page).toHaveURL(/focusX=0.5000/);

  await page.locator('#focus-mode').selectOption('pinned');
  await page.locator('#focus-show-guide').check();
  await expect(page.locator('#focus-guide')).toBeVisible();
  await page.locator('#focus-x').fill('0.61');
  await page.locator('#focus-x').dispatchEvent('change');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x)).toBe(0.61);

  const previousLoads = await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLoadCount() ?? 0);
  const handle = page.locator('#focus-guide .focus-guide-handle');
  await handle.scrollIntoViewIfNeeded();
  const handleBounds = await handle.boundingBox();
  if (!handleBounds) throw new Error('Focus handle is not visible.');
  const handlePoint = { x: handleBounds.x + handleBounds.width / 2, y: handleBounds.y + handleBounds.height / 2 };
  const pointerTarget = await page.evaluate((point) => {
    const target = document.elementFromPoint(point.x, point.y);
    const handleElement = document.querySelector<HTMLElement>('#focus-guide-handle');
    return {
      targetTag: target?.tagName,
      targetId: target?.id,
      targetClass: target?.className,
      handlePointerEvents: handleElement ? getComputedStyle(handleElement).pointerEvents : undefined,
      handleHidden: handleElement?.closest('#focus-guide')?.hasAttribute('hidden'),
    };
  }, handlePoint);
  expect(pointerTarget).toMatchObject({ targetTag: 'BUTTON', targetId: 'focus-guide-handle', handlePointerEvents: 'auto', handleHidden: false });
  await page.mouse.move(handlePoint.x, handlePoint.y);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getCameraInputsEnabled())).toBe(false);
  await page.mouse.move(handlePoint.x + 140, handlePoint.y + 25);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getCameraInputsEnabled())).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x)).toBeGreaterThan(0.75);
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLoadCount())).toBe(previousLoads);

  await page.locator('#focus-guide-handle').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x)).toBeGreaterThan(0.75);

  await page.locator('#focus-mode').selectOption('auto-center');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus())).toBeUndefined();
  await expect(page).toHaveURL(/refinementAlgorithm=foveated/);
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLoadCount())).toBe(initialLoads);
  expect(await page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockLayerCreateCount())).toBe(initialCreates);
});

test('URL focus settings restore the guide, radius, bias, and public API snippet', async ({ page }) => {
  await page.goto('./?refinementAlgorithm=screen-projection&focusMode=pinned&focusEnabled=true&showFocusGuide=false&focusX=0.7&focusY=0.3&focusRadius=0.22&focusBias=1.8');
  await useMockLayer(page);
  await loadFile(page, 'shared-focus.copc.laz');

  await expect(page.locator('#refinement-algorithm')).toHaveValue('screen-projection');
  await expect(page.locator('#focus-mode')).toHaveValue('pinned');
  await expect(page.locator('#focus-enabled')).toBeChecked();
  await expect(page.locator('#focus-show-guide')).not.toBeChecked();
  await expect(page.locator('#focus-radius')).toHaveValue('22');
  await expect(page.locator('#focus-bias')).toHaveValue('1.8');
  await expect(page.locator('#integration-example')).toContainText("refinementAlgorithm: 'screen-projection'");
  await expect(page.locator('#integration-example')).toContainText('layer.setRefinementFocus');
  await expect(page.locator('#integration-example')).toContainText('x: 0.7000, y: 0.3000');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus())).toMatchObject({
    center: { x: 0.7, y: 0.3 },
    radius: 0.22,
    detailBias: 1.8,
  });

  await page.reload();
  await expect(page.locator('#refinement-algorithm')).toHaveValue('screen-projection');
  await expect(page.locator('#focus-mode')).toHaveValue('pinned');
  await expect(page.locator('#focus-radius')).toHaveValue('22');
});

test('unknown algorithm query values are reported instead of silently accepted', async ({ page }) => {
  await page.goto('./?refinementAlgorithm=unknown-next-algorithm');
  await expect(page.locator('#refinement-algorithm')).toHaveValue('foveated');
  await expect(page.locator('#focus-config-warning')).toContainText('Unknown refinement algorithm');
});

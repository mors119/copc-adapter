import { expect, test } from '@playwright/test';

type DevViewerApi = {
  getSnapshot(): {
    lifecycle: string;
    renderedPointCount: number;
    backend: string;
  } | undefined;
  getSelectedPoint(): {
    pointIndex: number;
    longitude: number;
    latitude: number;
  } | undefined;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  getConfiguration(): {
    renderer: string;
    backend: string;
    colorMode: string;
    pointSize: number;
    maxNodes: number;
    maxRenderedPoints: number;
    maxDepth: number;
    maxScreenSpaceError: number;
    cameraRenderDistance: number;
    maxRenderDistance: number;
  };
};

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: DevViewerApi;
  }
}

test('switches renderer and backend, applies controls, and inspects a Three point', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const rendererGroup = page.getByRole('radiogroup', { name: 'Renderer' });
  const backendGroup = page.getByRole('radiogroup', { name: 'Backend' });
  await expect(rendererGroup).toBeVisible();
  await expect(backendGroup).toBeVisible();
  await expect(page.locator('#source-status')).toContainText('Ready');
  await expect(page.getByRole('radiogroup', { name: 'Camera presets' })).toHaveCount(1);
  await expect(page.getByRole('radiogroup', { name: 'Point color mode' })).toHaveCount(1);
  await expect(page.locator('.dev-stream-hud')).toHaveCount(0);

  const threeRenderer = rendererGroup.getByRole('radio', { name: 'Three.js' });
  await threeRenderer.click();
  await page.keyboard.press('ArrowRight');
  await expect(rendererGroup.getByRole('radio', { name: 'Cesium' })).toHaveAttribute('aria-checked', 'true');
  await threeRenderer.click();

  const diagnostics = page.getByRole('complementary', { name: 'COPC runtime debug panel' });
  await diagnostics.getByText('Advanced internal debug information', { exact: true }).click();
  await diagnostics.getByText('Metadata', { exact: true }).click();
  await expect(diagnostics.locator('[data-field="bounds"]')).toBeVisible();

  const pointSize = page.getByRole('slider', { name: 'Point size' });
  await pointSize.focus();
  await pointSize.press('ArrowRight');
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().pointSize)).toBe(3.5);
  await expect(page.locator('#source-status')).toHaveAttribute('data-status', 'ready');

  await rendererGroup.getByRole('radio', { name: 'Three.js' }).click();
  await expect(page.locator('#cesium-container canvas[aria-label="Interactive Three.js COPC point cloud"]'))
    .toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getSnapshot()?.renderedPointCount ?? 0))
    .toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle)).toBe('ready');

  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition())).toBeTruthy();
  const canvas = page.locator('#cesium-container canvas[aria-label="Interactive Three.js COPC point cloud"]');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const position = await page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition());
  await page.mouse.click((bounds?.x ?? 0) + (position?.x ?? 0), (bounds?.y ?? 0) + (position?.y ?? 0));
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getSelectedPoint())).toMatchObject({
      pointIndex: expect.any(Number),
      longitude: expect.any(Number),
      latitude: expect.any(Number),
    });
  await expect(page.getByRole('region', { name: 'COPC point inspector' })
    .locator('[data-field="pointIndex"]')).not.toBeEmpty();

  await page.getByRole('radiogroup', { name: 'Point color mode' })
    .getByRole('radio', { name: 'Elevation' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().colorMode)).toBe('elevation');
  await expect(page.locator('#source-status')).toContainText('Ready');

  await backendGroup.getByRole('radio', { name: 'Rust / WASM' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getSnapshot()?.backend)).toBe('rust');
  await expect(page.locator('#source-status')).toContainText('Ready');

  await rendererGroup.getByRole('radio', { name: 'Cesium' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle)).toBe('ready');
  await expect(page.locator('#cesium-container canvas')).toBeVisible();

  await page.setViewportSize({ width: 768, height: 720 });
  const panelLayout = await page.evaluate(() => {
    const controls = document.querySelector('#controls-panel')!.getBoundingClientRect();
    const inspector = document.querySelector('#inspector-panel')!.getBoundingClientRect();
    const canvas = document.querySelector('#cesium-container')!.getBoundingClientRect();
    return {
      controlsRight: controls.right,
      inspectorLeft: inspector.left,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(panelLayout.controlsRight).toBeLessThan(panelLayout.inspectorLeft);
  expect(panelLayout.canvasWidth).toBe(768);
  expect(panelLayout.canvasHeight).toBe(720);
  expect(panelLayout.documentWidth).toBeLessThanOrEqual(768);
});

test('collapses the controls and Inspector independently and keeps the canvas full-screen', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/?debugPanel=0');

  const controls = page.locator('#controls-panel');
  const inspector = page.locator('#inspector-panel');
  const controlsToggle = page.locator('#controls-toggle');
  const inspectorToggle = page.locator('#inspector-toggle');

  await expect(controls).toBeVisible();
  await expect(inspector).toBeHidden();
  await expect(inspectorToggle).toHaveAccessibleName('Expand inspector panel');
  await expect(inspectorToggle).toBeVisible();
  await inspectorToggle.click();
  await expect(inspector).toBeVisible();

  await controlsToggle.click();
  await expect(controls).toBeHidden();
  await expect(inspector).toBeVisible();
  await inspectorToggle.click();
  await expect(inspector).toBeHidden();
  await expect(controlsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false');

  await controlsToggle.focus();
  await controlsToggle.press('Enter');
  await expect(controls).toBeVisible();
  await expect(controls.locator('.dev-control-section').first()).toHaveAttribute('open', '');
  await expect(inspector).toBeHidden();
  await inspectorToggle.focus();
  await inspectorToggle.press('Space');
  await expect(inspector).toBeVisible();

  const canvas = await page.locator('#cesium-container').boundingBox();
  expect(canvas).toMatchObject({ x: 0, y: 0, width: 1024, height: 768 });
});

test('applies advanced streaming inputs and keeps mobile controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debugPanel=0');
  const panel = page.getByRole('complementary', { name: 'Viewer controls' });
  await expect(panel).toBeVisible();
  const inspectorToggle = page.locator('#inspector-toggle');
  await expect(inspectorToggle).toHaveAccessibleName('Expand inspector panel');
  await expect(inspectorToggle).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Point size' })).toHaveAttribute('min', '1');
  await expect(page.getByRole('slider', { name: 'Max selected nodes' })).toHaveAttribute('max', '64');
  await expect(page.getByRole('slider', { name: 'Max rendered points' })).toHaveAttribute('max', '1000000');

  const advanced = page.locator('.dev-advanced-settings');
  await advanced.locator('summary').click();
  await advanced.locator('#max-depth').fill('5');
  await advanced.locator('#max-sse').fill('10');
  await advanced.locator('#camera-render-distance').fill('4000');
  await advanced.locator('#max-render-distance').fill('9000');
  await advanced.getByRole('button', { name: 'Apply advanced settings' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration())).toMatchObject({
    maxDepth: 5,
    maxScreenSpaceError: 10,
    cameraRenderDistance: 4000,
    maxRenderDistance: 9000,
  });
  await expect(page.locator('#source-status')).toHaveAttribute('data-status', 'ready');
  await expect(page.locator('#cesium-container')).toBeVisible();
  await page.locator('#controls-toggle').click();
  await inspectorToggle.click();
  await expect(page.getByRole('complementary', { name: 'COPC runtime debug panel' })).toBeVisible();
  expect(await inspectorToggle.boundingBox()).not.toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});

test('keeps an opened local file distinct from the local Autzen preset', async ({ page }) => {
  const autzenFixtureRanges: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/samples/autzen.copc.laz') && request.headers().range) {
      autzenFixtureRanges.push(request.url());
    }
  });

  await page.goto('/?debugPanel=0');
  const source = page.locator('#source-selection');
  await page.locator('#local-source-file').setInputFiles({
    name: 'opened-by-user.copc.laz',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('invalid local COPC'),
  });
  await expect(source).toHaveValue('local-file');
  await expect(source.locator('option:checked')).toHaveText('Local file · opened-by-user.copc.laz');

  await source.selectOption('local-autzen');
  await page.getByRole('button', { name: 'Probe and load source' }).click();
  await expect.poll(() => autzenFixtureRanges.length, { timeout: 30_000 }).toBeGreaterThan(0);
});

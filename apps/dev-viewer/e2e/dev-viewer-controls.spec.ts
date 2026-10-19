import { expect, test } from '@playwright/test';

type DevViewerApi = {
  getSnapshot(): {
    lifecycle: string;
    renderedPointCount: number;
    backend: string;
    selectedNodeKeys: string[];
    renderedNodeKeys: string[];
    performance: {
      refinementAlgorithm: string;
      configuredPointBudget: number;
      activeRenderedPointCount: number;
      visibleLevelRange?: { min: number; max: number };
    };
    rangeRequests: { active: number };
    transition?: { activeReplacementGroupCount: number };
  } | undefined;
  getSelectedPoint(): {
    pointIndex: number;
    longitude: number;
    latitude: number;
  } | undefined;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  getConfiguration(): {
    renderer: string;
    cesiumRenderer: string;
    backend: string;
    source: string;
    refinementAlgorithm: string;
    rangeValidation: string;
    colorMode: string;
    pointSize: number;
    maxNodes: number;
    maxRenderedPoints: number;
    maxDepth: number;
    maxScreenSpaceError: number;
    cameraRenderDistance: number;
    maxRenderDistance: number;
    cameraPreset: string;
  };
  getPendingConfiguration(): {
    renderer: string;
    refinementAlgorithm: string;
    rangeValidation: string;
    pointSize: number;
  };
};

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: DevViewerApi;
    __COPC_DEBUG__?: {
      getState(): {
        cameraMoveEventCount: number;
        viewDistance?: { effectiveDistanceMeters: number };
        performance: { activeNodeCount: number };
      };
    };
    __devViewerDebugIntervalCount?: () => number;
  }
}

test('switches renderer and backend, applies controls, and inspects a Three point', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const rendererGroup = page.getByRole('radiogroup', { name: 'Rendering engine' });
  const backendGroup = page.getByRole('radiogroup', { name: 'Backend' });
  await expect(rendererGroup).toBeVisible();
  await expect(backendGroup).toBeVisible();
  await expect(page.locator('#source-status')).toContainText('Ready');
  await expect(page.getByRole('radiogroup', { name: 'Camera presets' })).toHaveCount(1);
  await expect(page.getByRole('radiogroup', { name: 'Point color mode' })).toHaveCount(1);
  const refinementGroup = page.getByRole('radiogroup', { name: 'Refinement Algorithm' });
  const rangeValidationGroup = page.getByRole('radiogroup', { name: 'HTTP Range Validation' });
  await expect(refinementGroup.getByRole('radio', { name: 'Foveated' }))
    .toHaveAttribute('aria-checked', 'true');
  await expect(rangeValidationGroup.getByRole('radio', { name: 'HEAD Fallback' }))
    .toHaveAttribute('aria-checked', 'true');
  const cesiumRendererGroup = page.getByRole('radiogroup', { name: 'Cesium point renderer' });
  await expect(page.locator('#cesium-point-renderer-group')).toBeVisible();
  await expect(cesiumRendererGroup.getByRole('radio', { name: 'PointPrimitive' }))
    .toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.dev-stream-hud')).toHaveCount(0);

  await refinementGroup.getByRole('radio', { name: 'Screen Projection' }).click();
  await rangeValidationGroup.getByRole('radio', { name: 'Strict' }).click();
  await cesiumRendererGroup.getByRole('radio', { name: 'Batched Geometry' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().refinementAlgorithm)).toBe('foveated');
  await page.getByRole('button', { name: 'Apply Settings' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().refinementAlgorithm))
    .toBe('screen-projection');
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().rangeValidation)).toBe('strict');
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().cesiumRenderer)).toBe('batched-geometry');
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getSnapshot()?.performance.refinementAlgorithm))
    .toBe('screen-projection');
  await page.getByText('Source diagnostics', { exact: true }).click();
  await expect(page.locator('[data-field="configuredRangeValidation"]')).toHaveText('strict');
  await expect(page.locator('[data-field="sourceProbeValidationLevel"]')).toHaveText('strict');

  const threeRenderer = rendererGroup.getByRole('radio', { name: 'Three.js' });
  await threeRenderer.click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getPendingConfiguration().renderer)).toBe('three');
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().renderer)).toBe('cesium');
  await page.getByRole('button', { name: 'Apply Settings' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().renderer)).toBe('three');
  await rendererGroup.getByRole('radio', { name: 'Cesium' }).click();
  await page.getByRole('button', { name: 'Apply Settings' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().renderer)).toBe('cesium');
  const diagnostics = page.getByRole('complementary', { name: 'COPC runtime debug panel' });
  await diagnostics.getByText('Advanced internal debug information', { exact: true }).click();
  await diagnostics.getByText('Metadata', { exact: true }).click();
  await expect(diagnostics.locator('[data-field="bounds"]')).toBeVisible();

  const pointSize = page.getByRole('slider', { name: 'Point size' });
  await pointSize.focus();
  await pointSize.press('ArrowRight');
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getPendingConfiguration().pointSize)).toBe(3.5);
  await page.getByRole('button', { name: 'Apply Settings' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().pointSize)).toBe(3.5);
  await expect(page.locator('#source-status')).toHaveAttribute('data-status', 'ready');

  await rendererGroup.getByRole('radio', { name: 'Three.js' }).click();
  await page.getByRole('button', { name: 'Apply Settings' }).click();
  await expect(page.locator('#cesium-point-renderer-group')).toBeHidden();
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
  await page.getByRole('button', { name: 'Apply Settings' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().colorMode)).toBe('elevation');
  await expect(page.locator('#source-status')).toContainText('Ready');

  await backendGroup.getByRole('radio', { name: 'Rust / WASM' }).click();
  await page.getByRole('button', { name: 'Apply Settings' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getSnapshot()?.backend)).toBe('rust');
  await expect(page.locator('#source-status')).toContainText('Ready');

  await rendererGroup.getByRole('radio', { name: 'Cesium' }).click();
  await page.getByRole('button', { name: 'Apply Settings' }).click();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getConfiguration().renderer)).toBe('cesium');
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
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const activeDebugIntervals = new Set<number>();
    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const id = originalSetInterval(handler, timeout, ...args);
      if (timeout === 250) activeDebugIntervals.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (typeof id === 'number') activeDebugIntervals.delete(id);
      originalClearInterval(id);
    }) as typeof window.clearInterval;
    window.__devViewerDebugIntervalCount = () => activeDebugIntervals.size;
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/?debugPanel=0');
  await expect(page.locator('#source-status')).toContainText('Ready');

  const controls = page.locator('#controls-panel');
  const inspector = page.locator('#inspector-panel');
  const controlsToggle = page.locator('#controls-toggle');
  const inspectorToggle = page.locator('#inspector-toggle');

  await expect(controls).toBeVisible();
  await expect(inspector).toBeHidden();
  await expect(inspectorToggle).toHaveAccessibleName('Expand inspector panel');
  await expect(inspectorToggle).toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    window.__devViewerDebugIntervalCount?.())).toBe(0);
  await inspectorToggle.click();
  await expect(inspector).toBeVisible();
  await expect(controls).toBeVisible();
  await expect(page.locator('#cesium-container canvas').first()).toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    window.__devViewerDebugIntervalCount?.())).toBe(1);
  await test.info().attach('workbench-panels-expanded.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  const version = page.locator('#package-version');
  await expect(version).toHaveText(/^v\d+\.\d+\.\d+ · workspace package$/);
  const versionLayout = await version.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    position: getComputedStyle(element).position,
    canvasHeight: document.querySelector('#cesium-container')!.getBoundingClientRect().height,
  }));
  expect(versionLayout.height).toBeLessThan(16);
  expect(versionLayout.position).toBe('fixed');
  expect(versionLayout.canvasHeight).toBe(768);

  await page.locator('#inspector-content').evaluate((content) => {
    content.querySelectorAll<HTMLDetailsElement>('.copc-debug-panel__section').forEach((section) => {
      section.open = true;
    });
  });
  const diagnosticsScroll = await page.locator('#inspector-content').evaluate((content) => {
    const layout = {
      clientHeight: content.clientHeight,
      scrollHeight: content.scrollHeight,
      overflowY: getComputedStyle(content).overflowY,
    };
    content.scrollTop = content.scrollHeight;
    return { ...layout, scrollTop: content.scrollTop };
  });
  expect(diagnosticsScroll.overflowY).toBe('auto');
  expect(diagnosticsScroll.scrollHeight).toBeGreaterThan(diagnosticsScroll.clientHeight);
  expect(diagnosticsScroll.scrollTop).toBeGreaterThan(0);
  await page.locator('#inspector-content').evaluate((content) => {
    content.querySelectorAll<HTMLDetailsElement>('.copc-debug-panel__section').forEach((section) => {
      section.open = false;
    });
    content.scrollTop = 0;
  });

  await controlsToggle.click();
  await expect(controls).toBeHidden();
  await expect(inspector).toBeVisible();
  await controlsToggle.click();
  await expect(controls).toBeVisible();
  await inspectorToggle.click();
  await expect(inspector).toBeHidden();
  await expect.poll(async () => page.evaluate(() =>
    window.__devViewerDebugIntervalCount?.())).toBe(0);
  await expect(controls).toBeVisible();
  await inspectorToggle.click();
  await expect(inspector).toBeVisible();
  await controlsToggle.click();
  await expect(controls).toBeHidden();
  await expect(inspector).toBeVisible();
  await inspectorToggle.click();
  await expect(inspector).toBeHidden();
  await expect(controlsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false');
  await test.info().attach('workbench-panels-collapsed.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle)).toBe('ready');
  const cameraBeforeDrag = await page.evaluate(() =>
    window.__COPC_DEBUG__!.getState().cameraMoveEventCount);
  const canvasBounds = await page.locator('#cesium-container canvas').first().boundingBox();
  expect(canvasBounds).not.toBeNull();
  const dragX = (canvasBounds?.x ?? 0) + (canvasBounds?.width ?? 0) / 2;
  const dragY = (canvasBounds?.y ?? 0) + (canvasBounds?.height ?? 0) / 2;
  const canvasReceivesInput = await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('#cesium-container canvas') !== null,
  { x: dragX, y: dragY });
  expect(canvasReceivesInput).toBe(true);
  await page.mouse.move(dragX, dragY);
  await page.mouse.click(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX + 32, dragY + 18, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEBUG__!.getState().cameraMoveEventCount))
    .toBeGreaterThan(cameraBeforeDrag);

  await controlsToggle.focus();
  await controlsToggle.press('Enter');
  await expect(controls).toBeVisible();
  await expect(controls.locator('.dev-control-section').first()).toHaveAttribute('open', '');
  await expect(inspector).toBeHidden();
  await inspectorToggle.focus();
  await inspectorToggle.press('Space');
  await expect(inspector).toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    window.__devViewerDebugIntervalCount?.())).toBe(1);

  const canvas = await page.locator('#cesium-container').boundingBox();
  expect(canvas).toMatchObject({ x: 0, y: 0, width: 1024, height: 768 });
});

test('compares both refinement algorithms at Overview, Far, and Near without changing workbench settings', async ({ page }) => {
  test.setTimeout(360_000);
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto('/?debugPanel=0');
  await expect(page.locator('#source-status')).toContainText('Ready');

  const readState = () => page.evaluate(() => ({
    config: window.__COPC_DEV_VIEWER__!.getConfiguration(),
    snapshot: window.__COPC_DEV_VIEWER__!.getSnapshot(),
    cameraDistance: window.__COPC_DEBUG__!.getState().viewDistance?.effectiveDistanceMeters,
    activeNodeCount: window.__COPC_DEBUG__!.getState().performance.activeNodeCount,
  }));
  await expect.poll(async () => (await readState()).snapshot?.lifecycle).toBe('ready');
  const initial = await readState();
  expect(initial.config.refinementAlgorithm).toBe('foveated');
  const invariantSettings = {
    renderer: initial.config.renderer,
    cesiumRenderer: initial.config.cesiumRenderer,
    backend: initial.config.backend,
    source: initial.config.source,
    colorMode: initial.config.colorMode,
    pointSize: initial.config.pointSize,
    maxNodes: initial.config.maxNodes,
    maxRenderedPoints: initial.config.maxRenderedPoints,
    maxScreenSpaceError: initial.config.maxScreenSpaceError,
    maxRenderDistance: initial.config.maxRenderDistance,
  };
  const comparison: Array<Record<string, unknown>> = [];
  const algorithms = ['foveated', 'screen-projection', 'foveated'] as const;
  const presets = [
    { value: 'overview', label: 'Overview' },
    { value: 'far', label: 'Far' },
    { value: 'near', label: 'Near' },
  ] as const;

  for (const algorithm of algorithms) {
    if ((await readState()).config.refinementAlgorithm !== algorithm) {
      await page.getByRole('radiogroup', { name: 'Refinement Algorithm' })
        .getByRole('radio', {
          name: algorithm === 'foveated' ? 'Foveated' : 'Screen Projection',
        }).click();
      const distanceBeforeApply = (await readState()).cameraDistance;
      await page.getByRole('button', { name: 'Apply Settings' }).click();
      await expect.poll(async () => (await readState()).config.refinementAlgorithm)
        .toBe(algorithm);
      await expect(page.locator('#source-status')).toContainText('Ready');
      await expect.poll(async () => (await readState()).snapshot?.performance.refinementAlgorithm)
        .toBe(algorithm);
      const distanceAfterApply = (await readState()).cameraDistance;
      if (distanceBeforeApply !== undefined && distanceAfterApply !== undefined) {
        expect(Math.abs(distanceAfterApply - distanceBeforeApply))
          .toBeLessThanOrEqual(Math.max(1, distanceBeforeApply * 0.02));
      }
      await expect(page.locator('#cesium-container .dev-session-mount')).toHaveCount(1);
    }

    for (const preset of presets) {
      const cameraEventsBefore = await page.evaluate(() =>
        window.__COPC_DEBUG__!.getState().cameraMoveEventCount);
      await page.getByRole('radiogroup', { name: 'Camera presets' })
        .getByRole('radio', { name: preset.label }).click();
      await expect.poll(async () => page.evaluate(() =>
        window.__COPC_DEBUG__!.getState().cameraMoveEventCount))
        .toBeGreaterThan(cameraEventsBefore);
      await expect(page.locator('#apply-settings')).toBeDisabled();
      await expect.poll(async () => {
        const current = await readState();
        return current.snapshot?.transition?.activeReplacementGroupCount === 0
          && current.activeNodeCount === 0
          && current.snapshot?.rangeRequests.active === 0;
      }, { timeout: 60_000 }).toBe(true);

      const current = await readState();
      const snapshot = current.snapshot!;
      expect(snapshot.performance.refinementAlgorithm).toBe(algorithm);
      expect(snapshot.renderedPointCount).toBeGreaterThan(0);
      expect(snapshot.selectedNodeKeys.length).toBeGreaterThan(0);
      expect(snapshot.selectedNodeKeys.length).toBeLessThanOrEqual(current.config.maxNodes);
      expect(snapshot.performance.activeRenderedPointCount)
        .toBeLessThanOrEqual(snapshot.performance.configuredPointBudget);
      expect(current.config).toMatchObject({ ...invariantSettings, refinementAlgorithm: algorithm });
      expect(current.config.source).toMatch(/\/samples\/autzen\.copc\.laz$/);
      comparison.push({
        algorithm,
        cameraPreset: preset.value,
        selectedNodes: snapshot.selectedNodeKeys.length,
        renderedNodes: snapshot.renderedNodeKeys.length,
        renderedPoints: snapshot.renderedPointCount,
        visibleLevels: snapshot.performance.visibleLevelRange,
        pointBudget: snapshot.performance.configuredPointBudget,
        cameraDistanceMeters: current.cameraDistance,
      });
    }
  }

  await test.info().attach('refinement-comparison.json', {
    body: JSON.stringify(comparison, null, 2),
    contentType: 'application/json',
  });
  expect(pageErrors).toEqual([]);
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
  await page.getByRole('button', { name: 'Apply Settings' }).click();
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
  await page.getByRole('button', { name: 'Load selected source' }).click();
  await expect.poll(() => autzenFixtureRanges.length, { timeout: 30_000 }).toBeGreaterThan(0);
});

test('rejects an unsupported custom URL and keeps the active source loaded', async ({ page }) => {
  await page.goto('/?debugPanel=0');
  await expect(page.locator('#source-status')).toContainText('Ready');
  const previous = await page.evaluate(() =>
    window.__COPC_DEV_VIEWER__!.getConfiguration());

  await page.locator('#source-selection').selectOption('custom');
  await page.locator('#custom-source-url').fill('ftp://invalid.example/data.copc.laz');
  await page.getByRole('button', { name: 'Load selected source' }).click();

  await expect(page.locator('#configuration-error'))
    .toContainText('Enter a valid HTTP or HTTPS COPC URL');
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__!.getSnapshot()?.lifecycle)).toBe('ready');
  await expect(page.locator('#cesium-container .dev-session-mount')).toHaveCount(1);
  expect(await page.evaluate(() =>
    window.__COPC_DEV_VIEWER__!.getConfiguration())).toEqual(previous);
});

test('explicitly reloads the current source without leaving duplicate viewer mounts', async ({ page }) => {
  await page.goto('/?debugPanel=0');
  await expect(page.locator('#source-status')).toContainText('Ready');
  const previous = await page.evaluate(() =>
    window.__COPC_DEV_VIEWER__!.getConfiguration());

  await page.getByRole('button', { name: 'Reload current source' }).click();
  await expect(page.locator('#source-status')).toContainText('Ready');
  await expect.poll(async () => page.evaluate(() =>
    window.__COPC_DEV_VIEWER__!.getSnapshot()?.lifecycle)).toBe('ready');
  await expect(page.locator('#cesium-container .dev-session-mount')).toHaveCount(1);
  expect(await page.evaluate(() =>
    window.__COPC_DEV_VIEWER__!.getConfiguration())).toEqual(previous);
});

test('shows actionable errors for unknown URL-driven refinement values', async ({ page }) => {
  await page.goto('/?debugPanel=0&refinementAlgorithm=not-a-policy');
  const error = page.locator('#configuration-error');
  await expect(error).toContainText('Unknown refinement algorithm');
  await expect(error).toContainText('foveated');
  await expect(page.locator('#load-source')).toBeDisabled();
  await expect(page.locator('#apply-settings')).toBeDisabled();

  await page.getByRole('radiogroup', { name: 'Refinement Algorithm' })
    .getByRole('radio', { name: 'Screen Projection' }).click();
  await expect(error).toBeHidden();
  await expect(page.locator('#apply-settings')).toBeEnabled();
});

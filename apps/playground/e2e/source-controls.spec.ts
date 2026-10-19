import { expect, test } from '@playwright/test';

const sourceUrl = 'https://data.pointcloud.org/autzen/autzen-classified.copc.laz';

function makeCopcProbeBody(): Buffer {
  const bytes = Buffer.alloc(1024);
  bytes.write('LASF', 0, 'ascii');
  bytes.writeUInt16LE(375, 94);
  bytes.writeUInt32LE(589, 96);
  bytes.writeUInt32LE(1, 100);
  bytes.write('copc', 377, 'ascii');
  bytes.writeUInt16LE(1, 393);
  bytes.writeUInt16LE(160, 395);
  return bytes;
}

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range',
  'access-control-expose-headers': 'Content-Range, Content-Length',
};

test('a local source selected during a remote probe supersedes the pending probe', async ({ page }) => {
  let releaseProbe!: () => void;
  let probeStarted!: () => void;
  const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  const probeStartedPromise = new Promise<void>((resolve) => { probeStarted = resolve; });
  let remoteLayerRequests = 0;
  let probeRequestSeen = false;

  await page.route('https://data.pointcloud.org/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (request.headers().range === 'bytes=0-1023' && !probeRequestSeen) {
      probeRequestSeen = true;
      probeStarted();
      await probeGate;
      await route.fulfill({
        status: 206,
        headers: {
          ...corsHeaders,
          'content-range': 'bytes 0-1023/8192',
          'content-length': '1024',
        },
        body: makeCopcProbeBody(),
      });
      return;
    }
    remoteLayerRequests += 1;
    await route.fulfill({ status: 500, headers: corsHeaders, body: 'stale source request' });
  });

  try {
    await page.goto('./');
    await page.getByRole('button', { name: 'Probe and load source' }).click();
    await probeStartedPromise;
    await page.evaluate(() => {
      const status = document.querySelector('#source-status');
      if (!status) throw new Error('Source status element is missing');
      (window as Window & { __localLoadCount?: number }).__localLoadCount = 0;
      new MutationObserver(() => {
        if (status.textContent?.includes('Loading local.copc.laz')) {
          (window as Window & { __localLoadCount?: number }).__localLoadCount! += 1;
        }
      }).observe(status, { childList: true, characterData: true, subtree: true });
    });
    await page.locator('#copc-file').setInputFiles({
      name: 'local.copc.laz',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('invalid local COPC'),
    });
    await expect.poll(() => page.evaluate(() => (window as Window & { __localLoadCount?: number }).__localLoadCount ?? 0)).toBeGreaterThan(0);
    await expect(page.locator('#source-status')).not.toHaveText('Loading local.copc.laz…');
    releaseProbe();
    await page.waitForTimeout(150);
    expect(remoteLayerRequests).toBe(0);
  } finally {
    releaseProbe();
  }
});

test('the same local file can be selected again after loading another source', async ({ page }) => {
  let remoteLayerRequests = 0;
  let probeRequestSeen = false;
  await page.route('https://data.pointcloud.org/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (request.headers().range === 'bytes=0-1023' && !probeRequestSeen) {
      probeRequestSeen = true;
      await route.fulfill({
        status: 206,
        headers: {
          ...corsHeaders,
          'content-range': 'bytes 0-1023/8192',
          'content-length': '1024',
        },
        body: makeCopcProbeBody(),
      });
      return;
    }
    remoteLayerRequests += 1;
    await route.fulfill({ status: 500, headers: corsHeaders, body: 'fixture ends after its header' });
  });

  await page.goto('./');
  await page.evaluate(() => {
    const status = document.querySelector('#source-status');
    if (!status) throw new Error('Source status element is missing');
    (window as Window & { __localLoadCount?: number }).__localLoadCount = 0;
    new MutationObserver(() => {
      if (status.textContent?.includes('Loading repeat.copc.laz')) {
        (window as Window & { __localLoadCount?: number }).__localLoadCount! += 1;
      }
    }).observe(status, { childList: true, characterData: true, subtree: true });
  });
  const file = {
    name: 'repeat.copc.laz',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('invalid local COPC'),
  };
  await page.locator('#copc-file').setInputFiles(file);
  await expect.poll(() => page.evaluate(() => (window as Window & { __localLoadCount?: number }).__localLoadCount ?? 0)).toBeGreaterThan(0);
  await expect(page.locator('#source-status')).not.toContainText('Loading repeat.copc.laz');

  await page.getByRole('button', { name: 'Probe and load source' }).click();
  await expect.poll(() => remoteLayerRequests).toBeGreaterThan(0);

  await page.evaluate(() => {
    const status = document.querySelector('#source-status');
    if (!status) throw new Error('Source status element is missing');
    (window as Window & { __localLoadCount?: number }).__localLoadCount = 0;
    new MutationObserver(() => {
      if (status.textContent?.includes('Loading repeat.copc.laz')) {
        (window as Window & { __localLoadCount?: number }).__localLoadCount! += 1;
      }
    }).observe(status, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#copc-file').setInputFiles(file);
  await expect.poll(() => page.evaluate(() => (window as Window & { __localLoadCount?: number }).__localLoadCount ?? 0)).toBeGreaterThan(0);
});

test('point-size changes restore the current camera pose after layer reload', async ({ page }) => {
  await page.goto('./');
  const testCamera = {
    longitude: -116.1234,
    latitude: 38.1234,
    height: 1234.5,
    heading: 123,
    pitch: -48,
    roll: 3,
  };
  await page.evaluate(() => {
    const hooks = (window as Window & {
      __COPC_PLAYGROUND_TEST__?: {
        useCameraResetLayerMock(): void;
        setCameraView(view: PlaygroundCameraView): void;
      };
    }).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error('Playground test hooks are unavailable');
    hooks.useCameraResetLayerMock();
  });
  await page.locator('#copc-file').setInputFiles({
    name: 'camera-test.copc.laz',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test source'),
  });
  await expect(page.locator('#source-status')).toHaveText('Loaded camera-test.copc.laz');
  await page.evaluate((camera) => {
    (window as Window & {
      __COPC_PLAYGROUND_TEST__?: { setCameraView(view: PlaygroundCameraView): void };
    }).__COPC_PLAYGROUND_TEST__?.setCameraView(camera);
  }, testCamera);

  const initialLoads = await page.evaluate(() => (window as Window & {
    __COPC_PLAYGROUND_TEST__?: { getMockLoadCount(): number };
  }).__COPC_PLAYGROUND_TEST__?.getMockLoadCount());
  await page.evaluate(() => {
    const slider = document.querySelector<HTMLInputElement>('#point-size');
    if (!slider) throw new Error('Point-size slider is missing');
    slider.value = '7';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __COPC_PLAYGROUND_TEST__?: { getMockLoadCount(): number };
  }).__COPC_PLAYGROUND_TEST__?.getMockLoadCount())).toBe(initialLoads);
  await page.locator('#point-size').dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __COPC_PLAYGROUND_TEST__?: { getMockLoadCount(): number };
  }).__COPC_PLAYGROUND_TEST__?.getMockLoadCount())).toBe((initialLoads ?? 0) + 1);

  const restored = await page.evaluate(() => (window as Window & {
    __COPC_PLAYGROUND_TEST__?: { getCameraView(): PlaygroundCameraView };
  }).__COPC_PLAYGROUND_TEST__?.getCameraView());
  expect(restored?.longitude).toBeCloseTo(testCamera.longitude, 5);
  expect(restored?.latitude).toBeCloseTo(testCamera.latitude, 5);
  expect(restored?.height).toBeCloseTo(testCamera.height, 2);
  expect(restored?.heading).toBeCloseTo(testCamera.heading, 5);
  expect(restored?.pitch).toBeCloseTo(testCamera.pitch, 5);
  expect(restored?.roll).toBeCloseTo(testCamera.roll, 5);
});

test('a source selection change disposes an in-flight layer load', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    const hooks = (window as Window & {
      __COPC_PLAYGROUND_TEST__?: {
        useCameraResetLayerMock(): void;
        delayNextLoad(): void;
        getMockDestroyCount(): number;
      };
    }).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error('Playground test hooks are unavailable');
    hooks.useCameraResetLayerMock();
    hooks.delayNextLoad();
  });
  await page.locator('#copc-file').setInputFiles({
    name: 'pending.copc.laz',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test source'),
  });
  await expect(page.locator('#source-status')).toHaveText('Loading pending.copc.laz…');
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __COPC_PLAYGROUND_TEST__?: { getMockLoadCount(): number };
  }).__COPC_PLAYGROUND_TEST__?.getMockLoadCount())).toBe(1);
  await page.locator('#remote-source').selectOption('chicago');
  await expect(page.locator('#source-status')).toHaveText('Source selection changed. Choose a source and load it.');
  const destroyCount = await page.evaluate(() => (window as Window & {
    __COPC_PLAYGROUND_TEST__?: { getMockDestroyCount(): number };
  }).__COPC_PLAYGROUND_TEST__?.getMockDestroyCount());
  expect(destroyCount).toBe(1);
});

test('camera movement during a layer reload is preserved', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    const hooks = (window as Window & {
      __COPC_PLAYGROUND_TEST__?: {
        useCameraResetLayerMock(): void;
        delayNextLoad(): void;
        releaseDelayedLoad(): void;
        setCameraView(view: PlaygroundCameraView): void;
        getCameraView(): PlaygroundCameraView;
      };
    }).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error('Playground test hooks are unavailable');
    hooks.useCameraResetLayerMock();
  });
  await page.locator('#copc-file').setInputFiles({
    name: 'camera-during-load.copc.laz',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test source'),
  });
  await expect(page.locator('#source-status')).toHaveText('Loaded camera-during-load.copc.laz');
  const userCamera = {
    longitude: -104.9876,
    latitude: 39.7654,
    height: 9876.5,
    heading: 91,
    pitch: -52,
    roll: 0,
  };
  await page.evaluate(() => {
    const hooks = (window as Window & { __COPC_PLAYGROUND_TEST__?: { delayNextLoad(): void } }).__COPC_PLAYGROUND_TEST__;
    hooks?.delayNextLoad();
  });
  await page.locator('#point-size').evaluate((element: HTMLInputElement) => {
    element.value = '8';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#source-status')).toHaveText('Loading camera-during-load.copc.laz…');
  await page.locator('#cesium-container').dispatchEvent('pointerdown');
  await page.evaluate((camera) => {
    const hooks = (window as Window & {
      __COPC_PLAYGROUND_TEST__?: { setCameraView(view: PlaygroundCameraView): void };
    }).__COPC_PLAYGROUND_TEST__;
    hooks?.setCameraView(camera);
  }, userCamera);
  await page.evaluate(() => {
    const hooks = (window as Window & { __COPC_PLAYGROUND_TEST__?: { releaseDelayedLoad(): void } }).__COPC_PLAYGROUND_TEST__;
    hooks?.releaseDelayedLoad();
  });
  await expect(page.locator('#source-status')).toHaveText('Loaded camera-during-load.copc.laz');
  const actual = await page.evaluate(() => (window as Window & {
    __COPC_PLAYGROUND_TEST__?: { getCameraView(): PlaygroundCameraView };
  }).__COPC_PLAYGROUND_TEST__?.getCameraView());
  const zoomCount = await page.evaluate(() => (window as Window & {
    __COPC_PLAYGROUND_TEST__?: { getMockZoomCount(): number };
  }).__COPC_PLAYGROUND_TEST__?.getMockZoomCount());
  expect(zoomCount).toBe(1);
  expect(actual?.longitude).toBeCloseTo(userCamera.longitude, 5);
  expect(actual?.latitude).toBeCloseTo(userCamera.latitude, 5);
  expect(actual?.height).toBeCloseTo(userCamera.height, 2);
  expect(actual?.heading).toBeCloseTo(userCamera.heading, 5);
  expect(actual?.pitch).toBeCloseTo(userCamera.pitch, 5);
});

test('renderer, backend, and color controls expose keyboard-accessible applied choices', async ({ page }) => {
  await page.goto('./');
  const renderer = page.getByRole('radiogroup', { name: 'Renderer' });
  const cesium = renderer.getByRole('radio', { name: 'Cesium' });
  const three = renderer.getByRole('radio', { name: 'Three.js' });
  await expect(cesium).toHaveAttribute('aria-checked', 'true');
  await cesium.focus();
  await page.keyboard.press('ArrowRight');
  await expect(three).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#viewer-heading')).toHaveText('Three.js');
  await expect(page.locator('#integration-example')).toContainText('CopcThreeLayer');

  const backend = page.getByRole('radiogroup', { name: 'COPC backend' });
  await expect(backend.getByRole('radio', { name: 'JavaScript' })).toHaveAttribute('aria-checked', 'true');
  await backend.getByRole('radio', { name: 'Rust / WASM' }).click();
  await expect(backend.getByRole('radio', { name: 'Rust / WASM' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#integration-example')).toContainText("backend: 'rust'");

  const colors = page.getByRole('radiogroup', { name: 'Color mode' });
  await expect(colors.getByRole('radio', { name: 'RGB' })).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Point size' })).toHaveValue('3');
});

test('responsive layout keeps the viewport visible and supports disclosures', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('./');
  let layout = await page.evaluate(() => ({
    viewportWidth: document.querySelector('#cesium-container')?.getBoundingClientRect().width ?? 0,
    viewportBottom: document.querySelector('.viewer-frame')?.getBoundingClientRect().bottom ?? 0,
    documentWidth: document.documentElement.scrollWidth,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
  }));
  expect(layout.viewportWidth).toBeGreaterThan(300);
  expect(layout.viewportBottom).toBeLessThanOrEqual(layout.windowHeight);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.windowWidth);

  await page.setViewportSize({ width: 390, height: 844 });
  layout = await page.evaluate(() => ({
    viewportWidth: document.querySelector('#cesium-container')?.getBoundingClientRect().width ?? 0,
    viewportBottom: document.querySelector('.viewer-frame')?.getBoundingClientRect().bottom ?? 0,
    documentWidth: document.documentElement.scrollWidth,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
  }));
  expect(layout.viewportWidth).toBeGreaterThan(300);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.windowWidth);
  await page.getByText('About supported sources').click();
  await expect(page.locator('.source-help')).toHaveAttribute('open', '');
});

test('custom URL input rejects malformed addresses before making a request', async ({ page }) => {
  await page.goto('./');
  await page.locator('#remote-source').selectOption('custom');
  await page.locator('#custom-url').fill('not a url');
  await page.getByRole('button', { name: 'Probe and load URL' }).click();
  await expect(page.locator('#source-probe')).toHaveText('Enter a valid absolute HTTP or HTTPS URL.');
  await expect(page.locator('#source-status')).toHaveText('Waiting for a source');
});

for (const renderer of ['Cesium', 'Three.js'] as const) {
  test(`${renderer} streams and inspects points from the public Autzen COPC`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('./');
    if (renderer === 'Three.js') {
      await page.getByRole('radio', { name: 'Three.js' }).click();
    }
    await page.getByRole('button', { name: 'Probe and load source' }).click();
    await expect(page.locator('#source-status')).toHaveText('Loaded Autzen Stadium', { timeout: 120_000 });
    await expect(page.locator('#diagnostic-range')).toHaveText('Supported');
    await expect(page.locator('#diagnostic-validation')).toHaveText('Strict response validation');
    await expect.poll(async () => Number((await page.locator('#diagnostic-points').textContent())?.replaceAll(',', '')),
      { timeout: 60_000 }).toBeGreaterThan(0);

    const pickPosition = () => page.evaluate(() => (window as Window & {
      __COPC_PLAYGROUND_TEST__?: { getPickablePointScreenPosition(): { x: number; y: number } | undefined };
    }).__COPC_PLAYGROUND_TEST__?.getPickablePointScreenPosition());
    await expect.poll(pickPosition, { timeout: 30_000 }).toBeTruthy();
    const point = await pickPosition();
    if (!point) throw new Error('No pickable streamed point was found in the viewport.');
    const canvasBox = await page.locator('#cesium-container canvas').boundingBox();
    if (!canvasBox) throw new Error('The renderer canvas has no visible bounds.');
    await page.mouse.click(canvasBox.x + point.x, canvasBox.y + point.y);
    await expect(page.locator('#point-attributes')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#point-attributes')).toContainText('Height');

    if (renderer === 'Cesium') {
      const obliqueCamera = await page.evaluate(() => {
        const hooks = (window as Window & {
          __COPC_PLAYGROUND_TEST__?: PlaygroundFocusTestHooks;
        }).__COPC_PLAYGROUND_TEST__;
        if (!hooks) throw new Error('Playground test hooks are unavailable');
        return { ...hooks.getCameraView(), pitch: -45 };
      });
      await page.evaluate((camera) => {
        (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundFocusTestHooks })
          .__COPC_PLAYGROUND_TEST__?.setCameraView(camera);
      }, obliqueCamera);

      await page.locator('#focus-mode').selectOption('center-boost');
      await page.locator('#focus-radius').evaluate((element: HTMLInputElement) => {
        element.value = '15';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.locator('#focus-bias').evaluate((element: HTMLInputElement) => {
        element.value = '2';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await expect.poll(() => page.evaluate(() =>
        (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundFocusTestHooks })
          .__COPC_PLAYGROUND_TEST__?.getSnapshot()?.refinementFocusEnabled)).toBe(true);
      await expect(page.locator('#diagnostic-algorithm')).toHaveText('Foveated');

      const checkGuideMapping = async (): Promise<void> => {
        await expect.poll(() => page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('#cesium-container canvas');
          const guide = document.querySelector<HTMLElement>('#focus-guide');
          if (!canvas || !guide) throw new Error('The Cesium canvas or focus guide is missing.');
          const canvasRect = canvas.getBoundingClientRect();
          const guideRect = guide.getBoundingClientRect();
          return guideRect.width - 0.3 * Math.min(canvasRect.width, canvasRect.height);
        })).toBeCloseTo(0, 0);
        const centers = await page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('#cesium-container canvas')!;
          const guide = document.querySelector<HTMLElement>('#focus-guide')!;
          const canvasRect = canvas.getBoundingClientRect();
          const guideRect = guide.getBoundingClientRect();
          return {
            x: (guideRect.left + guideRect.width / 2) - (canvasRect.left + canvasRect.width / 2),
            y: (guideRect.top + guideRect.height / 2) - (canvasRect.top + canvasRect.height / 2),
          };
        });
        expect(centers.x).toBeCloseTo(0, 0);
        expect(centers.y).toBeCloseTo(0, 0);
      };
      await checkGuideMapping();
      await page.setViewportSize({ width: 390, height: 844 });
      await checkGuideMapping();

      const centerSelection = await page.evaluate(() =>
        (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundFocusTestHooks })
          .__COPC_PLAYGROUND_TEST__?.getSnapshot());
      const cameraBeforeMovement = await page.evaluate(() =>
        (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundFocusTestHooks })
          .__COPC_PLAYGROUND_TEST__?.getCameraView());
      await page.locator('#focus-mode').selectOption('pinned');
      await page.locator('#focus-x').fill('0.76');
      await page.locator('#focus-x').dispatchEvent('change');
      await page.locator('#focus-y').fill('0.38');
      await page.locator('#focus-y').dispatchEvent('change');
      await expect.poll(() => page.evaluate(() => {
        const snapshot = (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundFocusTestHooks })
          .__COPC_PLAYGROUND_TEST__?.getSnapshot();
        return JSON.stringify({
          candidates: snapshot?.focusCandidateCount,
          weightMin: snapshot?.focusWeightMin,
          weightMax: snapshot?.focusWeightMax,
          influenced: snapshot?.focusInfluencedRefinementCount,
        });
      })).not.toBe(JSON.stringify({
        candidates: centerSelection?.focusCandidateCount,
        weightMin: centerSelection?.focusWeightMin,
        weightMax: centerSelection?.focusWeightMax,
        influenced: centerSelection?.focusInfluencedRefinementCount,
      }));

      const cameraAfterMovement = await page.evaluate(() =>
        (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundFocusTestHooks })
          .__COPC_PLAYGROUND_TEST__?.getCameraView());
      expect(cameraAfterMovement?.longitude).toBeCloseTo(cameraBeforeMovement?.longitude ?? 0, 5);
      expect(cameraAfterMovement?.latitude).toBeCloseTo(cameraBeforeMovement?.latitude ?? 0, 5);
      expect(cameraAfterMovement?.height).toBeCloseTo(cameraBeforeMovement?.height ?? 0, 1);
      expect(cameraAfterMovement?.pitch).toBeCloseTo(-45, 2);

      await page.locator('#focus-mode').selectOption('auto-center');
      await expect.poll(() => page.evaluate(() =>
        (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundFocusTestHooks })
          .__COPC_PLAYGROUND_TEST__?.getSnapshot()?.refinementFocusEnabled)).toBe(false);
    }
  });
}

test('the optional Rust/WASM backend streams the public Autzen COPC', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('./');
  await page.getByRole('radio', { name: 'Rust / WASM' }).click();
  await page.getByRole('button', { name: 'Probe and load source' }).click();
  await expect(page.locator('#source-status')).toHaveText('Loaded Autzen Stadium', { timeout: 120_000 });
  await expect.poll(async () => Number((await page.locator('#diagnostic-points').textContent())?.replaceAll(',', '')),
    { timeout: 60_000 }).toBeGreaterThan(0);
});

type PlaygroundCameraView = {
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
};

type PlaygroundFocusTestHooks = {
  getCameraView(): PlaygroundCameraView;
  setCameraView(view: PlaygroundCameraView): void;
  getSnapshot(): {
    refinementAlgorithm?: string;
    refinementFocusEnabled?: boolean;
    focusCandidateCount?: number;
    focusWeightMin?: number;
    focusWeightMax?: number;
    focusInfluencedRefinementCount?: number;
    selectedNodeKeys?: readonly string[];
  } | undefined;
};

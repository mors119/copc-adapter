import { expect, test } from "@playwright/test";

type DevViewerApi = {
  getSnapshot():
    | {
        lifecycle: string;
        renderedPointCount: number;
        backend: string;
        selectedNodeKeys: string[];
        renderedNodeKeys: string[];
        performance: {
          refinementAlgorithm: string;
          motionLive: { enabled: boolean };
          configuredPointBudget: number;
          activeRenderedPointCount: number;
          visibleLevelRange?: { min: number; max: number };
        };
        rangeRequests: { active: number };
        transition?: { activeReplacementGroupCount: number };
      }
    | undefined;
  getSelectedPoint():
    | {
        pointIndex: number;
        longitude: number;
        latitude: number;
      }
    | undefined;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  getConfiguration(): {
    renderer: string;
    cesiumRenderer: string;
    backend: string;
    source: string;
    refinementAlgorithm: string;
    motionLookahead: boolean;
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
    motionLookahead: boolean;
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
        cameraBasis: {
          position: { x: number; y: number; z: number };
          direction: { x: number; y: number; z: number };
          right: { x: number; y: number; z: number };
          up: { x: number; y: number; z: number };
        };
        viewDistance?: { effectiveDistanceMeters: number };
        performance: {
          activeNodeCount: number;
          motionLive: { acceptedMovementSampleCount: number };
        };
      };
    };
    __devViewerDebugIntervalCount?: () => number;
  }
}

test("switches renderer and backend, applies controls, and inspects a Three point", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page
    .locator(".dev-control-section")
    .filter({ has: page.getByText("Camera presets", { exact: true }) })
    .locator("summary")
    .click();
  const rendererGroup = page.getByRole("radiogroup", {
    name: "Renderer",
    exact: true,
  });
  const backendGroup = page.getByRole("radiogroup", { name: "COPC backend" });
  await expect(rendererGroup).toBeVisible();
  await expect(backendGroup).toBeVisible();
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect(
    page.getByRole("radiogroup", { name: "Camera presets" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("radiogroup", { name: "Color mode" }),
  ).toHaveCount(1);
  await page.locator('.schema-control-section[data-section="streaming"] summary').click();
  await page.locator('.schema-control-section[data-section="lod"] summary').click();
  const refinementGroup = page.getByRole("radiogroup", {
    name: "Refinement Algorithm",
  });
  const motionLookaheadGroup = page.getByRole("radiogroup", {
    name: "Motion Lookahead",
  });
  const rangeValidationGroup = page.getByRole("radiogroup", {
    name: "HTTP Range Validation",
  });
  await expect(
    refinementGroup.getByRole("radio", { name: "Foveated" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    motionLookaheadGroup.getByRole("radio", { name: "On" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    rangeValidationGroup.getByRole("radio", { name: "HEAD Fallback" }),
  ).toHaveAttribute("aria-checked", "true");
  const cesiumRendererGroup = page.getByRole("radiogroup", {
    name: "Cesium point renderer",
  });
  await expect(page.locator("#cesium-point-renderer-group")).toBeVisible();
  await expect(
    cesiumRendererGroup.getByRole("radio", { name: "Point Primitives" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".dev-stream-hud")).toHaveCount(0);

  await refinementGroup
    .getByRole("radio", { name: "Screen Projection" })
    .click();
  const cameraBasisBeforeApply = await page.evaluate(
    () => window.__COPC_DEBUG__!.getState().cameraBasis,
  );
  await motionLookaheadGroup.getByRole("radio", { name: "Off" }).click();
  await rangeValidationGroup.getByRole("radio", { name: "Strict" }).click();
  await cesiumRendererGroup
    .getByRole("radio", { name: "Batched Geometry" })
    .click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__COPC_DEV_VIEWER__?.getConfiguration().refinementAlgorithm,
      ),
    )
    .toBe("foveated");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__COPC_DEV_VIEWER__?.getPendingConfiguration().motionLookahead,
      ),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__COPC_DEV_VIEWER__?.getConfiguration().refinementAlgorithm,
      ),
    )
    .toBe("screen-projection");
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getConfiguration().motionLookahead,
      ),
    )
    .toBe(false);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__COPC_DEV_VIEWER__?.getSnapshot()?.performance.motionLive
            .enabled,
      ),
    )
    .toBe(false);
  await expect
    .poll(async () =>
      page.evaluate(
        ({ before }) => {
          const current = window.__COPC_DEBUG__!.getState().cameraBasis;
          return (["position", "direction", "right", "up"] as const).every(
            (axis) =>
              Math.hypot(
                current[axis].x - before[axis].x,
                current[axis].y - before[axis].y,
                current[axis].z - before[axis].z,
              ) < 1e-5,
          );
        },
        { before: cameraBasisBeforeApply },
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getConfiguration().rangeValidation,
      ),
    )
    .toBe("strict");
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getConfiguration().cesiumRenderer,
      ),
    )
    .toBe("batched-geometry");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__COPC_DEV_VIEWER__?.getSnapshot()?.performance
            .refinementAlgorithm,
      ),
    )
    .toBe("screen-projection");
  await page.getByRole("tab", { name: "Source" }).click();
  await page
    .locator(
      '#workbench-panel-source [data-diagnostic-section="source-probe"] summary',
    )
    .click();
  await expect(
    page.locator(
      '#workbench-panel-source [data-field="configuredRangeValidation"]',
    ),
  ).toHaveText("strict");
  await expect(
    page.locator(
      '#workbench-panel-source [data-field="sourceProbeValidationLevel"]',
    ),
  ).toHaveText("strict");

  const threeRenderer = rendererGroup.getByRole("radio", { name: "Three.js" });
  const pointSize = page.getByRole("slider", { name: "Point size" });
  await pointSize.focus();
  await pointSize.press("ArrowRight");
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getPendingConfiguration().pointSize,
      ),
    )
    .toBe(3.5);
  await threeRenderer.click();
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getPendingConfiguration().renderer,
      ),
    )
    .toBe("three");
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getConfiguration().renderer,
      ),
    )
    .toBe("cesium");
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getConfiguration().renderer,
      ),
    )
    .toBe("three");
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getConfiguration().pointSize,
      ),
    )
    .toBe(3.5);
  await expect(
    page.locator(
      '#workbench-panel-source [data-diagnostic-value="bounds"]',
    ),
  ).toBeVisible();
  await expect(page.locator("#source-status")).toHaveAttribute(
    "data-status",
    "ready",
  );

  await expect(page.locator("#cesium-point-renderer-group")).toBeHidden();
  await expect(
    page.locator(
      '#cesium-container canvas[aria-label="Interactive Three.js COPC point cloud"]',
    ),
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__COPC_DEV_VIEWER__?.getSnapshot()?.renderedPointCount ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle),
    )
    .toBe("ready");

  await expect
    .poll(async () =>
      page.evaluate(() =>
        window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
      ),
    )
    .toBeTruthy();
  const canvas = page.locator(
    '#cesium-container canvas[aria-label="Interactive Three.js COPC point cloud"]',
  );
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const position = await page.evaluate(() =>
    window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
  );
  await page.mouse.click(
    (bounds?.x ?? 0) + (position?.x ?? 0),
    (bounds?.y ?? 0) + (position?.y ?? 0),
  );
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSelectedPoint()),
    )
    .toMatchObject({
      pointIndex: expect.any(Number),
      longitude: expect.any(Number),
      latitude: expect.any(Number),
    });
  const pointPopover = page.locator("[data-point-popover]");
  await expect(pointPopover).toBeVisible();
  await expect(pointPopover).toContainText("WGS84 ellipsoidal height (m)");
  await expect(page.locator("[data-point-highlight]")).toBeVisible();
  await expect(page.locator("[data-point-inspector]")).toHaveCount(0);
  const threeHighlight = page.locator("[data-point-highlight]");
  const threeMarkerBeforeMove = await threeHighlight.boundingBox();
  const threeCanvasBounds = await canvas.boundingBox();
  if (!threeMarkerBeforeMove || !threeCanvasBounds)
    throw new Error("The selected Three.js point is missing its screen bounds.");
  const dragStart = {
    x: threeCanvasBounds.x + threeCanvasBounds.width * 0.8,
    y: threeCanvasBounds.y + threeCanvasBounds.height * 0.6,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 55, dragStart.y + 24, { steps: 5 });
  await page.mouse.up();
  await expect(pointPopover).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await threeHighlight.boundingBox();
      return bounds ? [Math.round(bounds.x), Math.round(bounds.y)] : null;
    })
    .not.toEqual([
      Math.round(threeMarkerBeforeMove.x),
      Math.round(threeMarkerBeforeMove.y),
    ]);
  await expect(pointPopover).toBeVisible();
  await pointPopover.getByText("More point data").click();
  await expect(pointPopover).toContainText("Point index");
  await page.keyboard.press("Escape");
  await expect(pointPopover).toBeHidden();

  await page
    .getByRole("radiogroup", { name: "Color mode" })
    .getByRole("radio", { name: "Elevation" })
    .click();
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getConfiguration().colorMode,
      ),
    )
    .toBe("elevation");
  await expect(page.locator("#source-status")).toContainText("Ready");

  await backendGroup.getByRole("radio", { name: "Rust / WASM" }).click();
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.backend),
    )
    .toBe("rust");
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getSnapshot()?.renderedPointCount ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle),
    )
    .toBe("ready");

  const selectedCanvas = page.locator(
    '#cesium-container canvas[aria-label="Interactive Three.js COPC point cloud"]',
  );
  const selectedCanvasBounds = await selectedCanvas.boundingBox();
  let nextPickPosition: { x: number; y: number } | undefined;
  await expect
    .poll(async () => {
      nextPickPosition = await page.evaluate(() =>
        window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
      );
      return nextPickPosition;
    })
    .toBeTruthy();
  if (!selectedCanvasBounds || !nextPickPosition)
    throw new Error(
      "No pickable Three.js point is available after backend reload.",
    );
  await page.mouse.click(
    selectedCanvasBounds.x + nextPickPosition.x,
    selectedCanvasBounds.y + nextPickPosition.y,
  );
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSelectedPoint()),
    )
    .toMatchObject({ pointIndex: expect.any(Number) });
  await expect(pointPopover).toBeVisible();

  await rendererGroup.getByRole("radio", { name: "Cesium" }).click();
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getConfiguration().renderer,
      ),
    )
    .toBe("cesium");
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle),
    )
    .toBe("ready");
  await expect(page.locator("#cesium-container canvas")).toBeVisible();
  await expect(pointPopover).toBeHidden();
  await expect(page.locator("[data-point-highlight]")).toBeHidden();

  await page.setViewportSize({ width: 768, height: 720 });
  const panelLayout = await page.evaluate(() => {
    const controls = document
      .querySelector("#controls-panel")!
      .getBoundingClientRect();
    const inspector = document
      .querySelector("#inspector-panel")!
      .getBoundingClientRect();
    const canvas = document
      .querySelector("#cesium-container")!
      .getBoundingClientRect();
    const viewport = document
      .querySelector("#viewport-panel")!
      .getBoundingClientRect();
    return {
      controlsRight: controls.right,
      viewportLeft: viewport.left,
      inspectorTop: inspector.top,
      viewportBottom: viewport.bottom,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(panelLayout.controlsRight).toBeLessThanOrEqual(panelLayout.viewportLeft + 1);
  expect(panelLayout.inspectorTop).toBeGreaterThanOrEqual(panelLayout.viewportBottom - 1);
  expect(panelLayout.canvasWidth).toBeGreaterThan(0);
  expect(panelLayout.canvasWidth).toBeLessThan(768);
  expect(panelLayout.canvasHeight).toBeGreaterThan(0);
  expect(panelLayout.canvasHeight).toBeLessThan(720);
  expect(panelLayout.documentWidth).toBeLessThanOrEqual(768);
});

test.describe("touch point inspection", () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

  test("opens the shared popover for a touched Three.js point", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?renderer=three&debugPanel=0");
    await expect(page.locator("#source-status")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 60_000 },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
        ),
      )
      .toBeTruthy();

    const canvas = page.locator(
      '#cesium-container canvas[aria-label="Interactive Three.js COPC point cloud"]',
    );
    const canvasBounds = await canvas.boundingBox();
    const point = await page.evaluate(
      () => window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
    );
    if (!canvasBounds || !point)
      throw new Error("No touch-pickable point is visible in the viewport.");
    await page.touchscreen.tap(canvasBounds.x + point.x, canvasBounds.y + point.y);

    await expect
      .poll(() =>
        page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSelectedPoint()),
      )
      .toMatchObject({ pointIndex: expect.any(Number) });
    await expect(page.locator("[data-point-popover]")).toBeVisible();
    await expect(page.locator("[data-point-highlight]")).toBeVisible();
  });
});

test("collapses the controls and Inspector independently while preserving the viewport", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const activeDebugIntervals = new Set<number>();
    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);
    window.setInterval = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: any[]
    ) => {
      const id = originalSetInterval(handler, timeout, ...args);
      if (timeout === 250) activeDebugIntervals.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (typeof id === "number") activeDebugIntervals.delete(id);
      originalClearInterval(id);
    }) as typeof window.clearInterval;
    window.__devViewerDebugIntervalCount = () => activeDebugIntervals.size;
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/?debugPanel=0");
  await expect(page.locator("#source-status")).toContainText("Ready");

  const controls = page.locator("#controls-panel");
  const inspector = page.locator("#inspector-panel");
  const controlsToggle = page.locator("#controls-toggle");
  const inspectorToggle = page.locator("#inspector-toggle");

  await expect(controls).toBeVisible();
  await expect(inspector).toBeHidden();
  await expect(inspectorToggle).toHaveAccessibleName("Expand inspector panel");
  await expect(inspectorToggle).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__devViewerDebugIntervalCount?.()),
    )
    .toBe(0);
  await inspectorToggle.click();
  await expect(inspector).toBeVisible();
  await expect(controls).toBeVisible();
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.locator("#cesium-container canvas").first()).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__devViewerDebugIntervalCount?.()),
    )
    .toBe(1);
  await test.info().attach("workbench-panels-expanded.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  const version = page.locator("#package-version");
  await expect(version).toHaveText(/^local \d+\.\d+\.\d+ \/ Dev Viewer$/);
  const versionLayout = await version.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    position: getComputedStyle(element).position,
    canvasHeight: document
      .querySelector("#cesium-container")!
      .getBoundingClientRect().height,
  }));
  expect(versionLayout.height).toBeLessThan(16);
  expect(versionLayout.position).toBe("static");
  expect(versionLayout.canvasHeight).toBeGreaterThan(0);
  expect(versionLayout.canvasHeight).toBeLessThan(768);

  await page.locator("#inspector-content").evaluate((content) => {
    content
      .querySelectorAll<HTMLDetailsElement>(".copc-debug-panel__section")
      .forEach((section) => {
        section.open = true;
      });
  });
  const diagnosticsScroll = await page
    .locator("#inspector-content")
    .evaluate((content) => {
      const layout = {
        clientHeight: content.clientHeight,
        scrollHeight: content.scrollHeight,
        overflowY: getComputedStyle(content).overflowY,
      };
      content.scrollTop = content.scrollHeight;
      return { ...layout, scrollTop: content.scrollTop };
    });
  expect(diagnosticsScroll.overflowY).toBe("auto");
  expect(diagnosticsScroll.scrollHeight).toBeGreaterThan(
    diagnosticsScroll.clientHeight,
  );
  expect(diagnosticsScroll.scrollTop).toBeGreaterThan(0);
  await page.locator("#inspector-content").evaluate((content) => {
    content
      .querySelectorAll<HTMLDetailsElement>(".copc-debug-panel__section")
      .forEach((section) => {
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
  await expect
    .poll(async () =>
      page.evaluate(() => window.__devViewerDebugIntervalCount?.()),
    )
    .toBe(0);
  await expect(controls).toBeVisible();
  await inspectorToggle.click();
  await expect(inspector).toBeVisible();
  await controlsToggle.click();
  await expect(controls).toBeHidden();
  await expect(inspector).toBeVisible();
  await inspectorToggle.click();
  await expect(inspector).toBeHidden();
  await expect(controlsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(inspectorToggle).toHaveAttribute("aria-expanded", "false");
  await test.info().attach("workbench-panels-collapsed.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle),
    )
    .toBe("ready");
  const beforeDrag = await page.evaluate(() => {
    const state = window.__COPC_DEBUG__!.getState();
    return {
      cameraMoveEventCount: state.cameraMoveEventCount,
      motionSampleCount:
        state.performance.motionLive.acceptedMovementSampleCount,
      direction: state.cameraBasis.direction,
      position: state.cameraBasis.position,
    };
  });
  const canvasBounds = await page
    .locator("#cesium-container canvas")
    .first()
    .boundingBox();
  expect(canvasBounds).not.toBeNull();
  const dragX = (canvasBounds?.x ?? 0) + (canvasBounds?.width ?? 0) / 2;
  const dragY = (canvasBounds?.y ?? 0) + (canvasBounds?.height ?? 0) / 2;
  const canvasReceivesInput = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest("#cesium-container canvas") !==
      null,
    { x: dragX, y: dragY },
  );
  expect(canvasReceivesInput).toBe(true);
  await page.mouse.move(dragX, dragY);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(dragX + 128, dragY + 96, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__COPC_DEBUG__!.getState().cameraMoveEventCount,
      ),
    )
    .toBeGreaterThan(beforeDrag.cameraMoveEventCount);
  const afterDrag = await page.evaluate(() =>
    window.__COPC_DEBUG__!.getState(),
  );
  const dragDirectionDot = Math.max(
    -1,
    Math.min(
      1,
      beforeDrag.direction.x * afterDrag.cameraBasis.direction.x +
        beforeDrag.direction.y * afterDrag.cameraBasis.direction.y +
        beforeDrag.direction.z * afterDrag.cameraBasis.direction.z,
    ),
  );
  const dragOrientationDeltaDegrees =
    (Math.acos(dragDirectionDot) * 180) / Math.PI;
  const dragTranslationMeters = Math.hypot(
    beforeDrag.position.x - afterDrag.cameraBasis.position.x,
    beforeDrag.position.y - afterDrag.cameraBasis.position.y,
    beforeDrag.position.z - afterDrag.cameraBasis.position.z,
  );
  expect(dragTranslationMeters).toBeGreaterThan(1);
  if (dragOrientationDeltaDegrees >= 0.05) {
    expect(
      afterDrag.performance.motionLive.acceptedMovementSampleCount,
    ).toBeGreaterThan(beforeDrag.motionSampleCount);
  } else {
    expect(afterDrag.performance.motionLive.acceptedMovementSampleCount).toBe(
      beforeDrag.motionSampleCount,
    );
  }

  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__COPC_DEBUG__!.getState()))
          .performance.motionLive.state,
      {
        timeout: 5_000,
      },
    )
    .toBe("stationary");
  const beforeWheel = await page.evaluate(() =>
    window.__COPC_DEBUG__!.getState(),
  );
  await page.mouse.move(dragX, dragY);
  await page.mouse.wheel(0, 120);
  await expect
    .poll(async () =>
      page.evaluate(
        ({ previousPosition }) => {
          const current =
            window.__COPC_DEBUG__!.getState().cameraBasis.position;
          return Math.hypot(
            current.x - previousPosition.x,
            current.y - previousPosition.y,
            current.z - previousPosition.z,
          );
        },
        { previousPosition: beforeWheel.cameraBasis.position },
      ),
    )
    .toBeGreaterThan(1);
  const afterWheel = await page.evaluate(() =>
    window.__COPC_DEBUG__!.getState(),
  );
  const directionDot = Math.max(
    -1,
    Math.min(
      1,
      beforeWheel.cameraBasis.direction.x * afterWheel.cameraBasis.direction.x +
        beforeWheel.cameraBasis.direction.y *
          afterWheel.cameraBasis.direction.y +
        beforeWheel.cameraBasis.direction.z *
          afterWheel.cameraBasis.direction.z,
    ),
  );
  const orientationDeltaDegrees = (Math.acos(directionDot) * 180) / Math.PI;
  if (orientationDeltaDegrees < 0.05) {
    expect(afterWheel.performance.motionLive.acceptedMovementSampleCount).toBe(
      beforeWheel.performance.motionLive.acceptedMovementSampleCount,
    );
  }

  await controlsToggle.focus();
  await controlsToggle.press("Enter");
  await expect(controls).toBeVisible();
  await expect(
    controls.locator(".dev-control-section").first(),
  ).toHaveAttribute("open", "");
  await expect(inspector).toBeHidden();
  await inspectorToggle.focus();
  await inspectorToggle.press("Space");
  await expect(inspector).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__devViewerDebugIntervalCount?.()),
    )
    .toBe(1);

  const canvas = await page.locator("#cesium-container").boundingBox();
  const viewport = await page.locator("#viewport-panel").boundingBox();
  expect(canvas).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(canvas).toMatchObject(viewport!);
});

test("compares both refinement algorithms at Overview, Far, and Near without changing workbench settings", async ({
  page,
}) => {
  test.setTimeout(360_000);
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/?debugPanel=0");
  await expect(page.locator("#source-status")).toContainText("Ready");
  await page
    .locator('.schema-control-section[data-section="lod"] summary')
    .click();
  await page
    .locator(".dev-control-section")
    .filter({ has: page.getByText("Camera presets", { exact: true }) })
    .locator("summary")
    .click();

  const readState = () =>
    page.evaluate(() => ({
      config: window.__COPC_DEV_VIEWER__!.getConfiguration(),
      snapshot: window.__COPC_DEV_VIEWER__!.getSnapshot(),
      cameraDistance:
        window.__COPC_DEBUG__!.getState().viewDistance?.effectiveDistanceMeters,
      activeNodeCount:
        window.__COPC_DEBUG__!.getState().performance.activeNodeCount,
    }));
  await expect
    .poll(async () => (await readState()).snapshot?.lifecycle)
    .toBe("ready");
  const initial = await readState();
  expect(initial.config.refinementAlgorithm).toBe("foveated");
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
  const cameraPresetGroup = page.getByRole("radiogroup", {
    name: "Camera presets",
  });
  const selectedCameraPreset = await cameraPresetGroup
    .getByRole("radio", { checked: true })
    .textContent();
  const setupPreset = selectedCameraPreset?.trim() === "Far" ? "Near" : "Far";
  const cameraEventsBeforeSetup = await page.evaluate(
    () => window.__COPC_DEBUG__!.getState().cameraMoveEventCount,
  );
  await cameraPresetGroup.getByRole("radio", { name: setupPreset }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__COPC_DEBUG__!.getState().cameraMoveEventCount),
    )
    .toBeGreaterThan(cameraEventsBeforeSetup);
  await expect
    .poll(async () => {
      const current = await readState();
      return (
        current.snapshot?.transition?.activeReplacementGroupCount === 0 &&
        current.activeNodeCount === 0 &&
        current.snapshot?.rangeRequests.active === 0
      );
    })
    .toBe(true);
  const comparison: Array<Record<string, unknown>> = [];
  const algorithms = ["foveated", "screen-projection", "foveated"] as const;
  const presets = [
    { value: "overview", label: "Overview" },
    { value: "far", label: "Far" },
    { value: "near", label: "Near" },
  ] as const;

  for (const algorithm of algorithms) {
    if ((await readState()).config.refinementAlgorithm !== algorithm) {
      await page
        .getByRole("radiogroup", { name: "Refinement Algorithm" })
        .getByRole("radio", {
          name: algorithm === "foveated" ? "Foveated" : "Screen Projection",
        })
        .click();
      const distanceBeforeApply = (await readState()).cameraDistance;
      await page.getByRole("button", { name: "Apply Settings" }).click();
      await expect
        .poll(async () => (await readState()).config.refinementAlgorithm)
        .toBe(algorithm);
      await expect(page.locator("#source-status")).toContainText("Ready");
      await expect
        .poll(
          async () =>
            (await readState()).snapshot?.performance.refinementAlgorithm,
        )
        .toBe(algorithm);
      const distanceAfterApply = (await readState()).cameraDistance;
      if (
        distanceBeforeApply !== undefined &&
        distanceAfterApply !== undefined
      ) {
        expect(
          Math.abs(distanceAfterApply - distanceBeforeApply),
        ).toBeLessThanOrEqual(Math.max(1, distanceBeforeApply * 0.02));
      }
      await expect(
        page.locator("#cesium-container .dev-session-mount"),
      ).toHaveCount(1);
    }

    for (const preset of presets) {
      const cameraEventsBefore = await page.evaluate(
        () => window.__COPC_DEBUG__!.getState().cameraMoveEventCount,
      );
      await cameraPresetGroup.getByRole("radio", { name: preset.label }).click();
      await expect
        .poll(async () =>
          page.evaluate(
            () => window.__COPC_DEBUG__!.getState().cameraMoveEventCount,
          ),
        )
        .toBeGreaterThan(cameraEventsBefore);
      await expect(page.locator("#apply-settings")).toBeDisabled();
      await expect
        .poll(
          async () => {
            const current = await readState();
            return (
              current.snapshot?.transition?.activeReplacementGroupCount === 0 &&
              current.activeNodeCount === 0 &&
              current.snapshot?.rangeRequests.active === 0
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);

      const current = await readState();
      const snapshot = current.snapshot!;
      expect(snapshot.performance.refinementAlgorithm).toBe(algorithm);
      expect(snapshot.renderedPointCount).toBeGreaterThan(0);
      expect(snapshot.selectedNodeKeys.length).toBeGreaterThan(0);
      expect(snapshot.selectedNodeKeys.length).toBeLessThanOrEqual(
        current.config.maxNodes,
      );
      expect(snapshot.performance.activeRenderedPointCount).toBeLessThanOrEqual(
        snapshot.performance.configuredPointBudget,
      );
      expect(current.config).toMatchObject({
        ...invariantSettings,
        refinementAlgorithm: algorithm,
      });
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

  await test.info().attach("refinement-comparison.json", {
    body: JSON.stringify(comparison, null, 2),
    contentType: "application/json",
  });
  expect(pageErrors).toEqual([]);
});

test("applies advanced streaming inputs and keeps mobile controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?debugPanel=0");
  const panel = page.getByRole("complementary", { name: "Configuration" });
  await expect(panel).toBeVisible();
  const inspectorToggle = page.locator("#inspector-toggle");
  await expect(inspectorToggle).toHaveAccessibleName("Expand inspector panel");
  await expect(inspectorToggle).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "Point size" }),
  ).toHaveAttribute("min", "1");
  const streamingSection = page.locator('.schema-control-section[data-section="streaming"]');
  await streamingSection.locator("summary").click();
  const performanceSection = page.locator('.schema-control-section[data-section="performance"]');
  await performanceSection.locator("summary").click();
  await expect(
    page.getByRole("slider", { name: "Max selected nodes" }),
  ).toHaveAttribute("max", "64");
  await expect(
    page.getByRole("slider", { name: "Max rendered points" }),
  ).toHaveAttribute("max", "1000000");

  const lodSection = page.locator('.schema-control-section[data-section="lod"]');
  await lodSection.locator("summary").click();
  await lodSection.locator("#max-depth-value").fill("5");
  await lodSection.locator("#max-sse-value").fill("10");
  await page
    .locator(".dev-control-section")
    .filter({ has: page.getByText("Camera presets", { exact: true }) })
    .locator("summary")
    .click();
  await page.locator("#camera-render-distance").fill("4000");
  await streamingSection.locator("#max-distance-value").fill("9000");
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__?.getConfiguration()),
    )
    .toMatchObject({
      maxDepth: 5,
      maxScreenSpaceError: 10,
      cameraRenderDistance: 4000,
      maxRenderDistance: 9000,
    });
  await expect(page.locator("#source-status")).toHaveAttribute(
    "data-status",
    "ready",
  );
  await expect(page.locator("#cesium-container")).toBeVisible();
  await page.locator("#controls-toggle").click();
  await inspectorToggle.click();
  await expect(
    page.getByRole("complementary", { name: "COPC runtime debug panel" }),
  ).toBeVisible();
  expect(await inspectorToggle.boundingBox()).not.toBeNull();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("keeps an opened local file distinct from the local Autzen preset", async ({
  page,
}) => {
  const autzenFixtureRanges: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/samples/autzen.copc.laz") &&
      request.headers().range
    ) {
      autzenFixtureRanges.push(request.url());
    }
  });

  await page.goto("/?debugPanel=0");
  const source = page.locator("#source-selection");
  await page.locator("#local-source-file").setInputFiles({
    name: "opened-by-user.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("invalid local COPC"),
  });
  await expect(source).toHaveValue("local-file");
  await expect(source.locator("option:checked")).toHaveText(
    "Local file · opened-by-user.copc.laz",
  );

  await source.selectOption("local-autzen");
  await page.getByRole("button", { name: "Load selected source" }).click();
  await expect
    .poll(() => autzenFixtureRanges.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
});

test("rejects an unsupported custom URL and keeps the active source loaded", async ({
  page,
}) => {
  await page.goto("/?debugPanel=0");
  await expect(page.locator("#source-status")).toContainText("Ready");
  const previous = await page.evaluate(() =>
    window.__COPC_DEV_VIEWER__!.getConfiguration(),
  );

  await page.locator("#source-selection").selectOption("custom");
  await page
    .locator("#custom-source-url")
    .fill("ftp://invalid.example/data.copc.laz");
  await page.getByRole("button", { name: "Load selected source" }).click();

  await expect(page.locator("#configuration-error")).toContainText(
    "Enter a valid HTTP or HTTPS COPC URL",
  );
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__!.getSnapshot()?.lifecycle),
    )
    .toBe("ready");
  await expect(
    page.locator("#cesium-container .dev-session-mount"),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration()),
  ).toEqual(previous);
});

test("explicitly reloads the current source without leaving duplicate viewer mounts", async ({
  page,
}) => {
  await page.goto("/?debugPanel=0");
  await expect(page.locator("#source-status")).toContainText("Ready");
  const previous = await page.evaluate(() =>
    window.__COPC_DEV_VIEWER__!.getConfiguration(),
  );

  await page.getByRole("button", { name: "Reload current source" }).click();
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect
    .poll(async () =>
      page.evaluate(() => window.__COPC_DEV_VIEWER__!.getSnapshot()?.lifecycle),
    )
    .toBe("ready");
  await expect(
    page.locator("#cesium-container .dev-session-mount"),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration()),
  ).toEqual(previous);
});

test("shows actionable errors for unknown URL-driven refinement values", async ({
  page,
}) => {
  await page.goto("/?debugPanel=0&refinementAlgorithm=not-a-policy");
  const error = page.locator("#configuration-error");
  await expect(error).toContainText("Unknown refinement algorithm");
  await expect(error).toContainText("foveated");
  await expect(page.locator("#load-source")).toBeDisabled();
  await expect(page.locator("#apply-settings")).toBeDisabled();
  await page
    .locator('.schema-control-section[data-section="lod"] summary')
    .click();

  await page
    .getByRole("radiogroup", { name: "Refinement Algorithm" })
    .getByRole("radio", { name: "Screen Projection" })
    .click();
  await expect(error).toBeHidden();
  await expect(page.locator("#apply-settings")).toBeEnabled();
});

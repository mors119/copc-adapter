import { expect, test } from "./ci-diagnostic-fixtures";
import { getCompletedStreamingState } from "./streaming-state";

type BenchmarkState = {
  cesiumVersion: string;
  renderedPointCount: number;
  renderedNodeKeys: string[];
  streamingUpdateCount: number;
  performance: Record<string, number>;
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
  selectedPoint?: {
    nodeKey: string;
    pointIndex: number;
    longitude: number;
    latitude: number;
  };
  lastError?: string;
};

type BenchmarkDebugAdapter = {
  getState(): BenchmarkState;
  setCameraHeight(height: number): void;
  setCameraHeading(headingDegrees: number): void;
  runSyntheticRendererPerformanceBenchmark(
    renderer?: "point-primitive" | "batched-geometry",
    cacheLayout?: "A" | "E",
    pointCounts?: readonly number[],
  ): Array<Record<string, unknown>>;
  runSyntheticRendererLayoutComparisonBenchmark(
    renderer?: "point-primitive" | "batched-geometry",
    pointCount?: number,
  ): Array<Record<string, unknown>>;
  runSyntheticThreeCacheLayoutBenchmark(): Array<Record<string, unknown>>;
  setStyle(update: {
    colorMode?: "fixed" | "rgb" | "elevation" | "intensity" | "classification";
    classificationFilter?: { include?: number[] } | null;
  }): void;
  probePublicBatchPick(): {
    picked: boolean;
    pickedNodeKey?: string;
    pointIndex?: number;
    targetSourcePointIndex?: number;
    screenPosition?: { x: number; y: number };
  };
  probePublicBatchCpuPick(
    offsetPx?: number,
    clickTolerancePx?: number,
  ): {
    picked: boolean;
    nodeKey?: string;
    ownerId?: string;
    pointIndex?: number;
    worldPosition?: [number, number, number];
    screenDistancePx?: number;
    viewDepthMeters?: number;
    candidateCount: number;
    scannedPointCount: number;
    scenePickDurationMs: number;
    cpuResolveDurationMs: number;
    totalDurationMs: number;
    targetPointIndex?: number;
    targetWorldPosition?: [number, number, number];
    reason?: string;
  };
  runCpuBatchedPickingProbe(): Promise<Record<string, unknown>>;
  runCpuBatchedPickingStress(): Promise<Record<string, unknown>>;
  setPublicBatchVisibility(show: boolean): void;
  clearPublicBatchNodes(): number;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: BenchmarkDebugAdapter;
  }
}

async function getState(
  page: import("@playwright/test").Page,
): Promise<BenchmarkState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) {
      throw new Error("COPC debug adapter is unavailable");
    }
    return window.__COPC_DEBUG__.getState();
  });
}

async function sampleFrames(
  page: import("@playwright/test").Page,
  durationMs = 2000,
): Promise<{
  frameCount: number;
  medianFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
}> {
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
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0;

  return {
    frameCount: intervals.length,
    medianFrameMs: at(0.5),
    p95FrameMs: at(0.95),
    maxFrameMs: at(1),
  };
}

async function sampleCameraTransition(
  page: import("@playwright/test").Page,
  height: number,
): Promise<{
  state: BenchmarkState;
  frames: {
    frameCount: number;
    medianFrameMs: number;
    p95FrameMs: number;
    maxFrameMs: number;
  };
}> {
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
  await expect
    .poll(async () => (await getState(page)).streamingUpdateCount)
    .toBeGreaterThan(before.streamingUpdateCount);
  const sorted = frames.slice(5).sort((left, right) => left - right);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0;

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

test("prints repeatable synthetic and Autzen renderer performance evidence", async ({
  page,
}) => {
  const renderer =
    process.env.COPC_RENDERER_VARIANT === "public-batched"
      ? "&renderer=public-batched"
      : "";
  await page.goto(`/?scenario=issue61&debugPanel=false${renderer}`);
  await expect
    .poll(() => getState(page))
    .toMatchObject({ renderedPointCount: expect.any(Number) });
  await expect
    .poll(async () => (await getState(page)).renderedPointCount)
    .toBeGreaterThan(0);

  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    devicePixelRatio: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    hardwareConcurrency: navigator.hardwareConcurrency,
    cesiumVersion: window.__COPC_DEBUG__?.getState().cesiumVersion,
  }));
  expect(environment.cesiumVersion).toBe(
    process.env.COPC_EXPECT_CESIUM_VERSION ?? "1.146.0",
  );
  const pointPrimitiveLayouts = await page.evaluate(
    () =>
      window.__COPC_DEBUG__?.runSyntheticRendererLayoutComparisonBenchmark(
        "point-primitive",
        100_000,
      ) ?? [],
  );
  const batchedGeometryLayouts = await page.evaluate(
    () =>
      window.__COPC_DEBUG__?.runSyntheticRendererLayoutComparisonBenchmark(
        "batched-geometry",
        100_000,
      ) ?? [],
  );
  const synthetic = await page.evaluate(
    () =>
      window.__COPC_DEBUG__?.runSyntheticRendererPerformanceBenchmark() ?? [],
  );
  const batchedSynthetic = await page.evaluate(
    () =>
      window.__COPC_DEBUG__?.runSyntheticRendererPerformanceBenchmark(
        "batched-geometry",
      ) ?? [],
  );
  const threeCacheLayouts = await page.evaluate(
    () => window.__COPC_DEBUG__?.runSyntheticThreeCacheLayoutBenchmark() ?? [],
  );
  const initialFrames = await sampleFrames(page);
  const scenarios: Array<Record<string, unknown>> = [];

  for (const [label, height] of [
    ["far", 100_000],
    ["near", 1_000],
  ] as const) {
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
    const frames = scenario.frames as {
      frameCount: number;
      medianFrameMs: number;
      p95FrameMs: number;
      maxFrameMs: number;
    };
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
  if (process.env.COPC_RENDERER_VARIANT === "public-batched") {
    const farState = scenarios[0]?.state as BenchmarkState | undefined;
    const nearState = scenarios[1]?.state as BenchmarkState | undefined;
    expect(farState?.renderedNodeKeys).toHaveLength(0);
    expect(nearState?.renderedNodeKeys.length ?? 0).toBeGreaterThan(0);
  }
  console.log(
    JSON.stringify(
      {
        renderer: process.env.COPC_RENDERER_VARIANT ?? "point-primitive",
        environment,
        synthetic: {
          renderer: "point-primitive",
          result: synthetic.find((row) => row.pointCount === 100_000),
        },
        syntheticComparison: {
          pointPrimitiveA: pointPrimitiveLayouts.find(
            (row) => row.cacheLayout === "A",
          ),
          pointPrimitiveE: pointPrimitiveLayouts.find(
            (row) => row.cacheLayout === "E",
          ),
          batchedGeometryA: batchedGeometryLayouts.find(
            (row) => row.cacheLayout === "A",
          ),
          batchedGeometryE: batchedGeometryLayouts.find(
            (row) => row.cacheLayout === "E",
          ),
          three: threeCacheLayouts,
          conditions: {
            cesium: {
              repetitions: 5,
              warmups: 2,
              pointCount: 100_000,
              sourceBuffer:
                "same deterministic synthetic buffer reused per A/E pair",
              order: "paired A>E then E>A, alternating across all pairs",
              measures:
                "synchronous renderer preparation only; no GPU execution time",
            },
            three: {
              repetitions: 5,
              warmups: 2,
              pointCount: 100_000,
              sourceBuffer:
                "deterministic values regenerated for each layout sample",
              order: "paired A>E then E>A, alternating across all pairs",
              measures:
                "synchronous CPU geometry preparation only; no GPU execution time",
            },
          },
        },
        initialFrames,
        rendererEvidence,
      },
      null,
      2,
    ),
  );
  if (renderer) {
    const styleModes = [
      "fixed",
      "rgb",
      "elevation",
      "intensity",
      "classification",
    ] as const;
    for (const colorMode of styleModes) {
      await page.evaluate((mode) => {
        window.__COPC_DEBUG__?.setStyle({ colorMode: mode });
      }, colorMode);
      await expect
        .poll(async () => (await getState(page)).lastError)
        .toBeUndefined();
    }
    const unfilteredPointCount = (await getState(page)).renderedPointCount;
    await page.evaluate(() => {
      window.__COPC_DEBUG__?.setStyle({
        classificationFilter: { include: [2] },
      });
    });
    await expect
      .poll(async () => (await getState(page)).renderedPointCount)
      .toBeLessThan(unfilteredPointCount);
    await page.evaluate(() => {
      window.__COPC_DEBUG__?.setStyle({ classificationFilter: null });
    });
    await expect
      .poll(async () => (await getState(page)).renderedPointCount)
      .toBe(unfilteredPointCount);
    await page.screenshot({ path: "test-results/public-batched-autzen.png" });
    const pickProbe = await page.evaluate(() =>
      window.__COPC_DEBUG__?.probePublicBatchPick(),
    );
    console.log(JSON.stringify({ publicBatchedPickProbe: pickProbe }, null, 2));
    expect(pickProbe).toMatchObject({
      picked: true,
      pickedNodeKey: expect.any(String),
    });
    expect(pickProbe?.pointIndex).toBeUndefined();
    expect(pickProbe?.targetSourcePointIndex).toEqual(expect.any(Number));

    const cpuPickSamples = await page.evaluate(() => {
      const probes = Array.from({ length: 5 }, () =>
        window.__COPC_DEBUG__?.probePublicBatchCpuPick(),
      );
      return probes.filter((probe) => probe !== undefined);
    });
    const sortedCpuTimes = cpuPickSamples
      .map((probe) => probe.cpuResolveDurationMs)
      .sort((left, right) => left - right);
    console.log(
      JSON.stringify(
        {
          publicBatchedCpuPickSamples: cpuPickSamples,
          medianCpuResolveMs:
            sortedCpuTimes[Math.floor(sortedCpuTimes.length / 2)] ?? 0,
          medianFullPickMs:
            [...cpuPickSamples]
              .map((probe) => probe.totalDurationMs)
              .sort((left, right) => left - right)[
              Math.floor(cpuPickSamples.length / 2)
            ] ?? 0,
        },
        null,
        2,
      ),
    );
    expect(cpuPickSamples).toHaveLength(5);
    const committedNodeKeys = (await getState(page)).renderedNodeKeys;
    for (const probe of cpuPickSamples) {
      expect(probe).toMatchObject({
        picked: true,
        nodeKey: expect.any(String),
        pointIndex: expect.any(Number),
      });
      expect(probe.scannedPointCount).toBeGreaterThan(0);
      expect(
        probe.screenDistancePx ?? Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(2.5);
      expect(probe.pointIndex).toBe(probe.targetPointIndex);
      expect(committedNodeKeys).toContain(probe.nodeKey);
      expect(probe.worldPosition).toEqual(probe.targetWorldPosition);
    }

    const canvasBounds = await page
      .locator("#cesium-container canvas")
      .first()
      .boundingBox();
    expect(canvasBounds).not.toBeNull();
    expect(pickProbe?.screenPosition).toBeDefined();
    await page.mouse.click(
      (canvasBounds?.x ?? 0) + (pickProbe?.screenPosition?.x ?? 0),
      (canvasBounds?.y ?? 0) + (pickProbe?.screenPosition?.y ?? 0),
    );
    await expect
      .poll(async () => (await getState(page)).selectedPoint?.pointIndex)
      .toBe(pickProbe?.targetSourcePointIndex);
    const inspectedPick = (await getState(page)).selectedPoint;
    expect(inspectedPick).toMatchObject({
      nodeKey: pickProbe?.pickedNodeKey,
      pointIndex: pickProbe?.targetSourcePointIndex,
      longitude: expect.any(Number),
      latitude: expect.any(Number),
      height: expect.any(Number),
      world: { coordinateSystem: "wgs84-ecef-meters" },
    });

    const syntheticPick = await page.evaluate(() =>
      window.__COPC_DEBUG__?.runCpuBatchedPickingProbe(),
    );
    console.log(
      JSON.stringify({ publicBatchedCpuSyntheticPick: syntheticPick }, null, 2),
    );
    expect(syntheticPick).toBeDefined();
    const normalSyntheticHit = syntheticPick?.normalHit as Record<
      string,
      unknown
    >;
    expect(normalSyntheticHit).toMatchObject({
      picked: true,
      nodeKey: "cpu-pick-shared",
      ownerId: "cpu-pick-layer-a",
      pointIndex: 1,
      candidateCount: 2,
    });
    expect(syntheticPick?.publicPointPickOracle).toMatchObject({
      nodeKey: "cpu-pick-shared",
      pointIndex: 1,
      matchesCpuIdentity: true,
    });
    const syntheticIdentity = syntheticPick?.cpuIdentityCheck as Record<
      string,
      unknown
    >;
    expect(syntheticIdentity).toMatchObject({ expectedPointIndex: 1 });
    expect(syntheticIdentity.nearPointErrorMeters).toBeLessThan(0.001);
    expect(syntheticIdentity.farPointErrorMeters).toBeGreaterThan(10);
    const syntheticFiltered = syntheticPick?.filteredProbe as Record<
      string,
      unknown
    >;
    expect(syntheticFiltered.hiddenPointVisible).toBe(false);
    expect(syntheticFiltered.selectedFilteredIndex).toBe(false);
    const syntheticLayers = syntheticPick?.multipleLayers as Record<
      string,
      unknown
    >;
    expect(syntheticLayers.hitOwnedByLayerB).toBe(true);
    expect(syntheticLayers.otherLayerDidNotResolve).toBe(true);
    expect(syntheticPick?.removedNodeCannotBeSelected).toBe(true);

    await page.evaluate(() =>
      window.__COPC_DEBUG__?.setPublicBatchVisibility(false),
    );
    expect(
      await page.evaluate(() => window.__COPC_DEBUG__?.probePublicBatchPick()),
    ).toMatchObject({ picked: false });
    await page.evaluate(() =>
      window.__COPC_DEBUG__?.setPublicBatchVisibility(true),
    );
    expect(
      await page.evaluate(() => window.__COPC_DEBUG__?.clearPublicBatchNodes()),
    ).toBe(0);
  }
  expect(synthetic.length).toBe(3);
  expect(synthetic[2].pointCount).toBe(100_000);
  expect(batchedSynthetic).toHaveLength(3);
  expect(batchedSynthetic[2].pointCount).toBe(100_000);
  expect(batchedSynthetic[2].renderer).toBe("batched-geometry");
  expect(pointPrimitiveLayouts.map((row) => row.cacheLayout)).toEqual([
    "A",
    "E",
  ]);
  expect(batchedGeometryLayouts.map((row) => row.cacheLayout)).toEqual([
    "A",
    "E",
  ]);
  expect(pointPrimitiveLayouts[0]).toMatchObject({
    cacheLayout: "A",
    pointCount: 100_000,
    renderer: "point-primitive",
  });
  expect(pointPrimitiveLayouts[1]).toMatchObject({
    cacheLayout: "E",
    pointCount: 100_000,
    renderer: "point-primitive",
  });
  expect(batchedGeometryLayouts[0]).toMatchObject({
    cacheLayout: "A",
    pointCount: 100_000,
    renderer: "batched-geometry",
  });
  expect(batchedGeometryLayouts[1]).toMatchObject({
    cacheLayout: "E",
    pointCount: 100_000,
    renderer: "batched-geometry",
  });
  const expectedCesiumOrder = [
    "A>E",
    "E>A",
    "A>E",
    "E>A",
    "A>E",
    "E>A",
    "A>E",
  ];
  expect(pointPrimitiveLayouts[0].comparisonOrder).toEqual(expectedCesiumOrder);
  expect(pointPrimitiveLayouts[1].comparisonOrder).toEqual(expectedCesiumOrder);
  expect(batchedGeometryLayouts[0].comparisonOrder).toEqual(
    expectedCesiumOrder,
  );
  expect(batchedGeometryLayouts[1].comparisonOrder).toEqual(
    expectedCesiumOrder,
  );
  expect(threeCacheLayouts).toHaveLength(2);
  expect(threeCacheLayouts.map((row) => row.cacheLayout)).toEqual(["A", "E"]);
  expect(threeCacheLayouts[0].comparisonOrder).toEqual([
    "A>E",
    "E>A",
    "A>E",
    "E>A",
    "A>E",
    "E>A",
    "A>E",
  ]);
  expect(threeCacheLayouts[1].comparisonOrder).toEqual(
    threeCacheLayouts[0].comparisonOrder,
  );
  expect(scenarios.every((scenario) => scenario.state)).toBe(true);
});

test("keeps low/high rendered-point budgets bounded and reprioritises on rotation", async ({
  browser,
}) => {
  const loadBudgetedState = async (budget: number) => {
    const page = await browser.newPage();
    const renderer =
      process.env.COPC_RENDERER_VARIANT === "public-batched"
        ? "&renderer=public-batched"
        : "";
    await page.goto(
      `/?scenario=issue59&budget=${budget}&debugPanel=false${renderer}`,
    );
    await expect
      .poll(async () => (await getState(page)).renderedPointCount)
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () => (await getState(page)).performance.configuredPointBudget,
      )
      .toBe(budget);
    return page;
  };

  const lowPage = await loadBudgetedState(100_000);
  const lowState = await getCompletedStreamingState(() => getState(lowPage));
  expect(lowState.renderedPointCount).toBeLessThanOrEqual(100_000);
  expect(lowState.performance.activeRenderedPointCount).toBeLessThanOrEqual(
    100_000,
  );

  const highPage = await loadBudgetedState(500_000);
  await expect
    .poll(async () => (await getState(highPage)).renderedPointCount, {
      timeout: 60_000,
    })
    .toBeGreaterThan(lowState.renderedPointCount);
  const highState = await getCompletedStreamingState(() => getState(highPage));
  expect(highState.renderedPointCount).toBeLessThanOrEqual(500_000);
  expect(highState.performance.activeRenderedPointCount).toBeLessThanOrEqual(
    500_000,
  );
  expect(highState.renderedPointCount).toBeGreaterThan(
    lowState.renderedPointCount,
  );

  await highPage.evaluate(() => {
    window.__COPC_DEBUG__?.setCameraPitch(-35);
    window.__COPC_DEBUG__?.setCameraHeading(90);
  });
  await expect
    .poll(async () => (await getState(highPage)).streamingUpdateCount)
    .toBeGreaterThan(highState.streamingUpdateCount);
  const rotatedState = await getCompletedStreamingState(() =>
    getState(highPage),
  );
  expect(rotatedState.renderedPointCount).toBeLessThanOrEqual(500_000);
  expect(rotatedState.selectedNodeKeys).not.toEqual(highState.selectedNodeKeys);
  expect(rotatedState.lastError).toBeUndefined();

  await lowPage.close();
  await highPage.close();
});

test("measures dense single-node CPU picking at 250k points at DPR 1 and 2", async ({
  browser,
}) => {
  test.skip(
    process.env.COPC_RENDERER_VARIANT !== "public-batched",
    "research renderer only",
  );
  const reports: Array<Record<string, unknown>> = [];
  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor,
    });
    const page = await context.newPage();
    try {
      const testDpr = deviceScaleFactor === 2 ? "&testDpr=1" : "";
      await page.goto(
        `/?scenario=issue61&debugPanel=false&renderer=public-batched${testDpr}`,
      );
      await expect
        .poll(() => getState(page))
        .toMatchObject({
          cesiumVersion: process.env.COPC_EXPECT_CESIUM_VERSION ?? "1.146.0",
          renderedPointCount: expect.any(Number),
        });
      await expect
        .poll(async () => (await getState(page)).renderedPointCount)
        .toBeGreaterThan(0);
      const pixelPicking = await page.evaluate(
        () => window.__COPC_DEBUG__?.runCpuBatchedPickingProbe() ?? {},
      );
      expect(pixelPicking.defaultPickWindowEdge).toMatchObject({
        defaultWindowPickedNode: true,
        batchedSinglePixelPickedNode: true,
        batchedSinglePixelResolvedNodeKey: "cpu-pick-default-window-edge",
        batchedSinglePixelResolvedPointIndex: 0,
      });
      expect(
        (pixelPicking.defaultPickWindowEdge as Record<string, unknown>)
          .defaultWindowResolvedPointIndex,
      ).toBeUndefined();
      const pickPosition = await page.evaluate(() =>
        window.__COPC_DEBUG__?.getPickablePointScreenPosition(),
      );
      expect(pickPosition).toBeDefined();
      const canvasBounds = await page
        .locator("#cesium-container canvas")
        .first()
        .boundingBox();
      expect(canvasBounds).not.toBeNull();
      await page.mouse.click(
        (canvasBounds?.x ?? 0) + (pickPosition?.x ?? 0),
        (canvasBounds?.y ?? 0) + (pickPosition?.y ?? 0),
      );
      await expect
        .poll(async () => (await getState(page)).selectedPoint?.pointIndex)
        .toBeGreaterThanOrEqual(0);
      const sameDepths = pixelPicking.publicPointPickOracle as Record<
        string,
        unknown
      >;
      expect(sameDepths.matchesCpuIdentity).toBe(true);
      const toleranceCases = pixelPicking.toleranceCases as Array<
        Record<string, unknown>
      >;
      expect(
        toleranceCases.find((sample) => sample.label === "center")?.picked,
      ).toBe(true);
      expect(
        toleranceCases.find(
          (sample) => sample.label === "inside-point-footprint",
        )?.picked,
      ).toBe(true);
      expect(
        toleranceCases.find(
          (sample) => sample.label === "near-edge-point-footprint",
        )?.picked,
      ).toBe(true);
      expect(
        toleranceCases.find(
          (sample) => sample.label === "outside-point-footprint",
        )?.picked,
      ).toBe(false);
      expect(pixelPicking.filteredProbe).toMatchObject({
        selectedFilteredIndex: false,
      });
      expect(pixelPicking.multipleLayers).toMatchObject({
        hitOwnedByLayerB: true,
        otherLayerDidNotResolve: true,
      });
      expect(pixelPicking.depthQuantizationProbe).toMatchObject({
        cesiumVersion: process.env.COPC_EXPECT_CESIUM_VERSION ?? "1.146.0",
        centerPickHitNode: true,
        pointSeparationMeters: 0.00001,
        resolution: { picked: false, reason: "ambiguous-depth" },
      });
      const stagingPrecisionProbe =
        pixelPicking.stagingPrecisionProbe as Record<string, unknown>;
      expect(stagingPrecisionProbe).toMatchObject({
        cesiumVersion: process.env.COPC_EXPECT_CESIUM_VERSION ?? "1.146.0",
        centerPickHitNode: true,
        resolution: { picked: true, pointIndex: 0 },
      });
      expect(stagingPrecisionProbe.stagingPositionErrorMeters).toBeGreaterThan(
        0.5,
      );
      expect(stagingPrecisionProbe.projectedStagingErrorPx).toBeGreaterThan(1);
      expect(pixelPicking.removedNodeCannotBeSelected).toBe(true);

      const footprintProbe = await page.evaluate(() =>
        window.__COPC_DEBUG__?.runCpuBatchedPickingProbe(),
      );
      const footprintCases = footprintProbe?.toleranceCases as Array<
        Record<string, unknown>
      >;
      expect(
        footprintCases.find(
          (sample) => sample.label === "near-edge-point-footprint",
        )?.picked,
      ).toBe(true);

      const report = await page.evaluate(
        () => window.__COPC_DEBUG__?.runCpuBatchedPickingStress() ?? {},
      );
      console.log(
        JSON.stringify({ pointPickingSingleNodeStress: report }, null, 2),
      );
      expect(report).toMatchObject({
        cesiumVersion: process.env.COPC_EXPECT_CESIUM_VERSION ?? "1.146.0",
        devicePixelRatio: deviceScaleFactor,
        pointCount: 250_000,
        repetitions: 35,
        scannedPointCount: 250_000,
        worstCaseCandidateCount: 250_000,
      });
      const canvas = report.canvas as {
        cssWidth: number;
        drawingBufferWidth: number;
      };
      expect(canvas.drawingBufferWidth).toBe(
        canvas.cssWidth * deviceScaleFactor,
      );
      expect(report.sameDepthPointPrimitiveOracle).toMatchObject({
        nodeKey: "cpu-pick-full-budget-node",
        pointIndex: expect.any(Number),
      });
      expect(report.sameDepthCpuResolution).toMatchObject({
        picked: false,
        reason: "ambiguous-depth",
      });
      expect(report.sameDepthCpuPointIndices).toEqual([]);
      expect(report.latencyMs).toMatchObject({
        cpuResolveP50: expect.any(Number),
        cpuResolveP95: expect.any(Number),
        cpuResolveP99: expect.any(Number),
        combinedP50: expect.any(Number),
        combinedP95: expect.any(Number),
        combinedP99: expect.any(Number),
        pointPrimitiveScenePickP50: expect.any(Number),
        pointPrimitiveScenePickP95: expect.any(Number),
        pointPrimitiveScenePickP99: expect.any(Number),
      });
      expect(report.pointPrimitivePreparationDurationMs).toEqual(
        expect.any(Number),
      );
      reports.push(report as Record<string, unknown>);
    } finally {
      await context.close();
    }
  }
  expect(reports).toHaveLength(2);
});

import { expect, test } from "@playwright/test";
import path from "node:path";

async function state(page) {
  return page.evaluate(() => window.__PACKED_CONSUMER__?.getState());
}

async function completedState(page) {
  // Progressive rendering exposes a provisional update count. Record camera
  // baselines after completion so superseding a pending update cannot reuse it.
  await expect
    .poll(async () => (await state(page)).performance.updateDurationMs)
    .toBeGreaterThan(0);
  return state(page);
}

async function waitForStableRendering(page) {
  let previousSignature;
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const current = await state(page);
        const motionSettled =
          current.performance.motionPredictedHorizontalDisplacementDegrees ===
            0 &&
          current.performance.motionPredictedVerticalDisplacementDegrees === 0;
        const workerIdle =
          !current.worker ||
          (current.worker.activeCount === 0 &&
            current.worker.queuedCount === 0);
        const idle =
          motionSettled &&
          current.rangeRequests?.active === 0 &&
          current.performance?.activeNodeCount === 0 &&
          current.performance?.queuedNodeCount === 0 &&
          current.transition?.activeReplacementGroupCount === 0 &&
          workerIdle;
        if (!idle) {
          previousSignature = undefined;
          stableSamples = 0;
          return false;
        }

        const signature = JSON.stringify([
          current.selectedNodeKeys,
          current.renderedNodeKeys,
          current.streamingUpdateCount,
          current.renderedPointCount,
        ]);
        stableSamples = signature === previousSignature ? stableSamples + 1 : 1;
        previousSignature = signature;
        return stableSamples >= 3;
      },
      { intervals: [200, 300, 400], timeout: 60_000 },
    )
    .toBe(true);
  return state(page);
}

async function loadRustPage(page, query = "?backend=rust&mode=rgb") {
  const pageErrors = [];
  const consoleErrors = [];
  const requestUrls = [];
  const copcResponses = [];
  const assetResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("request", (request) => requestUrls.push(request.url()));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("autzen.copc.laz")) {
      copcResponses.push({
        url,
        status: response.status(),
        requestRange: response.request().headers().range,
        contentRange: response.headers()["content-range"],
        contentLength: Number(response.headers()["content-length"] ?? 0),
      });
    }
    if (
      url.includes("copc_adapter_wasm") ||
      url.includes("laz-perf") ||
      url.includes("rustCopcDecodeWorker")
    ) {
      assetResponses.push({
        url,
        status: response.status(),
        contentType: response.headers()["content-type"],
      });
    }
  });

  await page.goto(`/${query}`);
  await expect
    .poll(() => state(page))
    .toMatchObject({
      viewerCreatedByConsumer: true,
      viewerAlive: true,
      layerAttachedToCallerViewer: true,
      lifecycle: "ready",
      backend: "rust",
      metadata: { pointCount: 10653336 },
    });
  expect(
    await page.evaluate(
      () => window.__PACKED_CONSUMER__.rustCrsTransformerExportAvailable,
    ),
  ).toBe(true);
  await expect
    .poll(async () => (await state(page)).renderedPointCount)
    .toBeGreaterThan(0);
  if (!query.includes("renderer=batched")) {
    await expect
      .poll(async () => {
        const current = await state(page);
        return (
          (current.maxRenderedHeight ?? 0) - (current.minRenderedHeight ?? 0)
        );
      })
      .toBeGreaterThan(1);
  }
  await expect
    .poll(async () => (await state(page)).hierarchy?.pageRequests ?? 0)
    .toBeGreaterThan(0);

  return {
    pageErrors,
    consoleErrors,
    requestUrls,
    copcResponses,
    assetResponses,
  };
}

test("validates the packed Rust backend in an external Vite consumer", async ({
  page,
}) => {
  const {
    pageErrors,
    consoleErrors,
    requestUrls,
    copcResponses,
    assetResponses,
  } = await loadRustPage(page);
  const initial = await completedState(page);

  expect(initial.metadata.bounds.minX).toBeCloseTo(635577.79, 2);
  expect(initial.metadata.bounds.maxZ).toBeCloseTo(615.26, 2);
  expect(initial.metadata.scale).toEqual({ x: 0.01, y: 0.01, z: 0.01 });
  expect(initial.metadata.wkt).toContain("NAD83 / Oregon GIC Lambert");
  expect(initial.firstPosition.longitude).toBeGreaterThan(-124);
  expect(initial.firstPosition.longitude).toBeLessThan(-122);
  expect(initial.firstPosition.latitude).toBeGreaterThan(43);
  expect(initial.firstPosition.latitude).toBeLessThan(45);
  expect(initial.maxRenderedHeight - initial.minRenderedHeight).toBeGreaterThan(
    1,
  );
  expect(initial.renderedColorCount).toBeGreaterThan(1);
  expect(initial.hierarchy.pageRequests).toBeGreaterThan(0);
  expect(initial.hierarchy.hierarchyBytesFetched).toBeGreaterThan(0);
  expect(initial.hierarchy.hierarchyBytesFetched).toBeLessThan(81123042);

  const attributes = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.probeRustAttributes(),
  );
  expect(attributes.availableFields).toEqual([
    "classification",
    "intensity",
    "position",
    "rgb",
  ]);
  expect(attributes.pointCount).toBeGreaterThan(0);
  expect(Object.keys(attributes.sample)).toEqual([
    "x",
    "y",
    "z",
    "intensity",
    "classification",
    "red",
    "green",
    "blue",
  ]);

  await page.evaluate(() => window.__PACKED_CONSUMER__.setCameraHeight(100000));
  await expect
    .poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(initial.streamingUpdateCount);
  const far = await completedState(page);
  await page.evaluate(() => window.__PACKED_CONSUMER__.setCameraHeight(1000));
  await expect
    .poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(far.streamingUpdateCount);
  const near = await completedState(page);
  expect(near.selectedNodeKeys).not.toEqual(far.selectedNodeKeys);
  expect(near.hierarchy.pageRequests).toBeGreaterThanOrEqual(
    initial.hierarchy.pageRequests,
  );
  expect(near.lastError).toBeUndefined();

  const fixedPosition = near.cameraPosition;
  await page.evaluate(() =>
    window.__PACKED_CONSUMER__.setCameraOrientation(0, -45),
  );
  await expect
    .poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(near.streamingUpdateCount);
  const beforeRotation = await completedState(page);
  await page.evaluate(() =>
    window.__PACKED_CONSUMER__.setCameraOrientation(180, -45),
  );
  await expect
    .poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(beforeRotation.streamingUpdateCount);
  const rotated = await completedState(page);
  expect(rotated.cameraPosition.longitude).toBeCloseTo(
    fixedPosition.longitude,
    8,
  );
  expect(rotated.cameraPosition.latitude).toBeCloseTo(
    fixedPosition.latitude,
    8,
  );
  expect(rotated.cameraPosition.height).toBeCloseTo(fixedPosition.height, 4);
  expect(rotated.performance.cameraDirection).not.toEqual(
    beforeRotation.performance.cameraDirection,
  );
  expect(rotated.performance.candidatesBeforeCulling).toBeGreaterThan(0);
  expect(rotated.performance.frustumCulledCount).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  expect(copcResponses.length).toBeGreaterThan(0);
  expect(copcResponses.every((response) => response.status === 206)).toBe(true);
  expect(
    copcResponses.every((response) =>
      /^bytes=\d+-\d+$/.test(response.requestRange),
    ),
  ).toBe(true);
  expect(
    copcResponses.every((response) =>
      response.contentRange?.startsWith("bytes "),
    ),
  ).toBe(true);
  expect(
    copcResponses.reduce(
      (total, response) => total + response.contentLength,
      0,
    ),
  ).toBeLessThan(81123042);
  expect(
    copcResponses.some((response) => response.requestRange === "bytes=0-374"),
  ).toBe(true);
  expect(
    assetResponses.some(
      (response) =>
        response.url.includes("copc_adapter_wasm") && response.status === 200,
    ),
  ).toBe(true);
  const copcAdapterWasmResponses = assetResponses.filter((response) =>
    /copc_adapter_wasm[^/]*\.wasm(?:$|\?)/i.test(response.url),
  );
  expect(copcAdapterWasmResponses.length).toBeGreaterThan(0);
  expect(
    copcAdapterWasmResponses.every((response) => response.status === 200),
  ).toBe(true);
  expect(
    copcAdapterWasmResponses.every(
      (response) => !response.url.includes("/.vite/deps/"),
    ),
  ).toBe(true);
  expect(initial.worker?.completedCount).toBeGreaterThan(0);
  expect(
    assetResponses.some((response) => response.url.includes("laz-perf")),
  ).toBe(false);
  expect(
    requestUrls.some((url) =>
      /\/public\/|\/target\/|copc-adapter\/feature-/i.test(url),
    ),
  ).toBe(false);
});

test("packed Cesium required mode retains requested attributes and rejects unavailable restyles", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  let allRustCacheBytes;
  let allRustCacheBudget;
  let allRustRenderedNodeKeys;
  let allRustRenderedPointCount;

  for (const backend of ["rust", "copc-js"]) {
    if (backend === "rust") {
      await page.goto("/?backend=rust&mode=rgb");
      await expect
        .poll(() => state(page))
        .toMatchObject({
          backend: "rust",
          attributeLoading: "all",
          lifecycle: "ready",
        });
      await expect
        .poll(async () => (await state(page)).renderedPointCount)
        .toBeGreaterThan(0);
      const allRust = await waitForStableRendering(page);
      allRustCacheBytes = allRust.pointCache.currentCacheBytes;
      allRustCacheBudget = allRust.pointCache.cacheByteBudget;
      allRustRenderedNodeKeys = allRust.renderedNodeKeys;
      allRustRenderedPointCount = allRust.renderedPointCount;
    }

    await page.goto(
      `/?backend=${backend}&mode=rgb&attributeLoading=required`,
    );
    await expect
      .poll(() => state(page))
      .toMatchObject({
        backend,
        attributeLoading: "required",
        lifecycle: "ready",
      });
    await expect
      .poll(async () => (await state(page)).renderedPointCount)
      .toBeGreaterThan(0);
    const required = await waitForStableRendering(page);
    expect(required.pointCache.currentCacheBytes).toBeGreaterThan(0);

    if (backend === "rust") {
      expect(required.pointCache.cacheByteBudget).toBe(allRustCacheBudget);
      expect(required.renderedNodeKeys).toEqual(allRustRenderedNodeKeys);
      expect(required.renderedPointCount).toBe(allRustRenderedPointCount);
      expect(required.pointCache.currentCacheBytes).toBeLessThan(
        allRustCacheBytes,
      );
    }

    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__PACKED_CONSUMER__.getPointPrimitivePickTarget(),
        ),
      )
      .toBeDefined();
    const pickTarget = await page.evaluate(() =>
      window.__PACKED_CONSUMER__.getPointPrimitivePickTarget(),
    );
    const canvasBounds = await page
      .locator("#cesium-container canvas")
      .first()
      .boundingBox();
    expect(canvasBounds).not.toBeNull();
    await page.mouse.click(
      (canvasBounds?.x ?? 0) + pickTarget.screenPosition.x,
      (canvasBounds?.y ?? 0) + pickTarget.screenPosition.y,
    );
    await expect
      .poll(async () => (await state(page)).selectedPoint?.pointIndex)
      .toBe(pickTarget.pointIndex);
    const selectedBefore = (await state(page)).selectedPoint;
    expect(selectedBefore).not.toHaveProperty("intensity");
    expect(selectedBefore).not.toHaveProperty("classification");

    const beforeStyle = await state(page);
    const failedUpdate = await page.evaluate(() =>
      window.__PACKED_CONSUMER__.trySetStyle({ colorMode: "intensity" }),
    );
    expect(failedUpdate.success).toBe(false);
    expect(failedUpdate.error).toMatch(/intensity was not requested/);
    const afterStyle = await state(page);
    expect(afterStyle.style).toEqual({ colorMode: "rgb" });
    expect(afterStyle.selectedPoint).toEqual(selectedBefore);
    expect(afterStyle.rangeRequests.requested).toBe(
      beforeStyle.rangeRequests.requested,
    );
    expect(afterStyle.performance.decodeDurationMs).toBe(
      beforeStyle.performance.decodeDurationMs,
    );
    expect(afterStyle.pointCache).toEqual(beforeStyle.pointCache);

    console.log(
      JSON.stringify({
        scenario: "issue-330-required-attributes",
        backend,
        currentCacheBytes: required.pointCache.currentCacheBytes,
        cacheByteBudget: required.pointCache.cacheByteBudget,
        ...(backend === "rust"
          ? { allAttributeCacheBytes: allRustCacheBytes }
          : {}),
      }),
    );
  }

  expect(pageErrors).toEqual([]);
});

test("loads the packed opt-in batched Cesium renderer without changing the default", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/?backend=rust&mode=rgb&renderer=batched");
  await expect
    .poll(() => state(page))
    .toMatchObject({
      viewerCreatedByConsumer: true,
      viewerAlive: true,
      layerAttachedToCallerViewer: true,
      lifecycle: "ready",
      backend: "rust",
    });
  await expect
    .poll(async () => (await state(page)).renderedPointCount)
    .toBeGreaterThan(0);
  await waitForStableRendering(page);
  const current = await state(page);
  expect(current.renderedNodeKeys.length).toBeGreaterThan(0);
  expect(
    current.lastError,
    await page.evaluate(() => window.__PACKED_CONSUMER__.getLastErrorStack()),
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () => window.__PACKED_CONSUMER__.batchedRendererExportAvailable,
    ),
  ).toBe(true);
  const pickTarget = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.getBatchedPointPickTarget(),
  );
  expect(pickTarget).toMatchObject({
    nodeKey: expect.any(String),
    pointIndex: expect.any(Number),
    screenPosition: { x: expect.any(Number), y: expect.any(Number) },
  });
  const canvasBounds = await page
    .locator("#cesium-container canvas")
    .first()
    .boundingBox();
  expect(canvasBounds).not.toBeNull();
  await page.mouse.click(
    (canvasBounds?.x ?? 0) + (pickTarget?.screenPosition?.x ?? 0),
    (canvasBounds?.y ?? 0) + (pickTarget?.screenPosition?.y ?? 0),
  );
  await expect
    .poll(async () => (await state(page)).selectedPoint?.pointIndex)
    .toBe(pickTarget?.pointIndex);
  expect((await state(page)).selectedPoint).toMatchObject({
    nodeKey: pickTarget?.nodeKey,
    pointIndex: pickTarget?.pointIndex,
    longitude: expect.any(Number),
    latitude: expect.any(Number),
    height: expect.any(Number),
    world: { coordinateSystem: "wgs84-ecef-meters" },
  });
  expect(pageErrors).toEqual([]);
});

test("updates packed Cesium clipping without source reads and clears clipped picks", async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = await loadRustPage(
    page,
    "?backend=rust&mode=rgb&renderer=batched",
  );
  await waitForStableRendering(page);
  const before = await state(page);
  expect(before.renderedPointCount).toBeGreaterThan(0);

  await page.evaluate(() =>
    window.__PACKED_CONSUMER__.setClippingVolume({
      type: "box",
      coordinateSystem: "wgs84-ecef-meters",
      minimum: [0, 0, 0],
      maximum: [1, 1, 1],
    }),
  );
  await page.waitForTimeout(100);
  const clipped = await state(page);
  expect(clipped.renderedPointCount).toBe(0);
  expect(clipped.lastError).toBeUndefined();
  expect(clipped.clippingVolume).toEqual({
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: [0, 0, 0],
    maximum: [1, 1, 1],
  });
  expect(clipped.rangeRequests.requested).toBe(before.rangeRequests.requested);
  expect(
    await page.evaluate(() =>
      window.__PACKED_CONSUMER__.getBatchedPointPickTarget(),
    ),
  ).toBeUndefined();

  const shaderNodes = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.getClippingDiagnostics(),
  );
  expect(shaderNodes.length).toBeGreaterThan(0);
  expect(
    shaderNodes.every(
      (node) =>
        node.hasClippingAttribute &&
        node.clippingUniformNames.includes("u_clipPlane0") &&
        node.fragmentShaderSource.includes("v_clippingPosition") &&
        node.fragmentShaderSource.includes("copcGetClipPlane0"),
    ),
  ).toBe(true);

  await page.evaluate(() =>
    window.__PACKED_CONSUMER__.setClippingVolume(undefined),
  );
  await expect
    .poll(async () => (await state(page)).renderedPointCount)
    .toBeGreaterThan(0);
  const cleared = await state(page);
  expect(cleared.clippingVolume).toBeUndefined();
  expect(cleared.rangeRequests.requested).toBe(before.rangeRequests.requested);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("estimates against the consumer TerrainProvider and rejects ellipsoid-only sampling", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/?terrainAlignmentFixture=1");
  await expect
    .poll(() => state(page))
    .toMatchObject({
      viewerCreatedByConsumer: true,
      viewerAlive: true,
      layerAttachedToCallerViewer: true,
      lifecycle: "ready",
      backend: "custom",
    });
  await expect
    .poll(async () => (await state(page)).renderedPointCount)
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    window.__PACKED_CONSUMER__.setCameraPose({
      longitude: -122.495,
      latitude: 44.505,
      height: 3_000,
      pitch: -90,
    }),
  );

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__PACKED_CONSUMER__.getPointPrimitivePickTarget(0),
      ),
    )
    .toBeDefined();
  const target = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.getPointPrimitivePickTarget(0),
  );
  expect(target).toMatchObject({
    nodeKey: expect.any(String),
    pointIndex: expect.any(Number),
    screenPosition: { x: expect.any(Number), y: expect.any(Number) },
  });
  const canvasBounds = await page
    .locator("#cesium-container canvas")
    .first()
    .boundingBox();
  expect(canvasBounds).not.toBeNull();
  await page.mouse.click(
    (canvasBounds?.x ?? 0) + target.screenPosition.x,
    (canvasBounds?.y ?? 0) + target.screenPosition.y,
  );
  await expect
    .poll(async () => (await state(page)).selectedPoint?.pointIndex)
    .toBe(target.pointIndex);

  const before = (await state(page)).selectedPoint;
  expect(before).toMatchObject({
    classification: 2,
    height: expect.any(Number),
    world: { coordinateSystem: "wgs84-ecef-meters" },
  });
  expect(before).not.toHaveProperty("source");

  const secondTarget = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.getPointPrimitivePickTarget(1),
  );
  expect(secondTarget).toMatchObject({
    nodeKey: target.nodeKey,
    pointIndex: 1,
    screenPosition: { x: expect.any(Number), y: expect.any(Number) },
  });
  await page.mouse.click(
    (canvasBounds?.x ?? 0) + secondTarget.screenPosition.x,
    (canvasBounds?.y ?? 0) + secondTarget.screenPosition.y,
  );
  await expect
    .poll(async () => (await state(page)).selectedPoint?.pointIndex)
    .toBe(1);
  const secondAnchor = (await state(page)).selectedPoint;
  expect(secondAnchor).toMatchObject({ classification: 2, height: 101 });

  const batchResult = await page.evaluate(async ({ first, second }) => {
    const estimate = await window.__PACKED_CONSUMER__.estimateTerrainHeightAlignmentBatch([
      { anchor: first },
      { anchor: second },
    ]);
    return {
      estimate,
      current: window.__PACKED_CONSUMER__.isTerrainHeightAlignmentBatchEstimateCurrent(),
    };
  }, { first: before, second: secondAnchor });
  const batchEstimate = batchResult.estimate;
  expect(batchEstimate).toMatchObject({
    status: "ready",
    actionable: true,
    medianResidualMeters: 149.5,
    proposedHeightOffsetMeters: 149.5,
    terrainSamplingCalls: 1,
    coverage: {
      requestedAnchorCount: 2,
      sampledAnchorCount: 2,
      acceptedAnchorCount: 2,
    },
  });
  expect(batchEstimate.robustSpreadMeters).toBeCloseTo(0.7413, 4);
  expect(batchResult.current).toBe(true);
  expect((await state(page)).selectedPoint?.height).toBe(101);
  await page.mouse.click(
    (canvasBounds?.x ?? 0) + target.screenPosition.x,
    (canvasBounds?.y ?? 0) + target.screenPosition.y,
  );
  await expect
    .poll(async () => (await state(page)).selectedPoint?.pointIndex)
    .toBe(0);
  expect(
    await page.evaluate(() =>
      window.__PACKED_CONSUMER__.isTerrainHeightAlignmentBatchEstimateCurrent(),
    ),
  ).toBe(false);

  expect(
    await page.evaluate(() =>
      window.__PACKED_CONSUMER__.usesTerrainFixtureProvider(),
    ),
  ).toBe(true);

  const estimate = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.estimateTerrainHeightAlignment(),
  );
  expect(estimate).toMatchObject({
    status: "ready",
    actionable: true,
    terrainHeightMeters: 250,
    terrainProvider: {
      type: "PackedConsumerTerrainFixture",
      hasTileAvailability: true,
    },
    terrainSamplingCalls: 1,
  });
  expect(estimate.proposedOffsetMeters).toBeCloseTo(
    250 - before.height,
    3,
  );
  expect(
    await page.evaluate(() =>
      window.__PACKED_CONSUMER__.isTerrainHeightAlignmentEstimateCurrent(),
    ),
  ).toBe(true);

  const afterPreview = (await state(page)).selectedPoint;
  expect(afterPreview.height).toBe(before.height);
  expect(afterPreview.source).toBeUndefined();
  expect(afterPreview.world).toEqual(before.world);
  expect(
    await page.evaluate(() =>
      window.__PACKED_CONSUMER__.usesTerrainFixtureProvider(),
    ),
  ).toBe(true);

  await page.evaluate(() =>
    window.__PACKED_CONSUMER__.useEllipsoidTerrainProvider(),
  );
  expect(
    await page.evaluate(() =>
      window.__PACKED_CONSUMER__.isTerrainHeightAlignmentEstimateCurrent(),
    ),
  ).toBe(false);
  const ellipsoidResult = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.estimateTerrainHeightAlignment(),
  );
  expect(ellipsoidResult.status).toBe("unavailable");
  expect(ellipsoidResult.actionable).toBe(false);
  expect(ellipsoidResult.terrainSamplingCalls).toBe(0);
  expect(ellipsoidResult.rejectionReason).toMatch(/only the ellipsoid/);
  expect(pageErrors).toEqual([]);
});

test("compares fixed and spacing-aware point sizes in close and far packed Cesium views", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  let cameraOrigin;
  async function captureMode(mode) {
    await page.goto(
      `/?backend=rust&mode=rgb&renderer=batched&pointSizeMode=${mode}`,
    );
    await expect
      .poll(() => state(page))
      .toMatchObject({
        viewerCreatedByConsumer: true,
        viewerAlive: true,
        layerAttachedToCallerViewer: true,
        lifecycle: "ready",
        backend: "rust",
      });
    await expect
      .poll(async () => (await state(page)).renderedPointCount)
      .toBeGreaterThan(0);
    const initial = await state(page);
    cameraOrigin ??= {
      longitude:
        initial.datasetCenter?.longitude ?? initial.cameraPosition.longitude,
      latitude:
        initial.datasetCenter?.latitude ?? initial.cameraPosition.latitude,
    };

    const views = {};
    for (const [label, height] of [
      ["far", 10_000],
      ["close", 1_000],
    ]) {
      const before = await state(page);
      await page.evaluate(
        ({ longitude, latitude, cameraHeight }) =>
          window.__PACKED_CONSUMER__.setCameraPose({
            longitude,
            latitude,
            height: cameraHeight,
            heading: 23,
            pitch: -80,
          }),
        { ...cameraOrigin, cameraHeight: height },
      );
      await expect
        .poll(async () => (await state(page)).cameraMoveEventCount)
        .toBeGreaterThan(before.cameraMoveEventCount);
      await expect
        .poll(async () => (await state(page)).cameraPosition.height)
        .toBeCloseTo(height, 1);
      await completedState(page);
      await expect
        .poll(async () => {
          const current = await state(page);
          return (
            current.performance.activeNodeCount === 0 &&
            current.transition.activeReplacementGroupCount === 0 &&
            current.rangeRequests.active === 0
          );
        })
        .toBe(true);
      expect((await state(page)).renderedPointCount).toBeGreaterThan(0);
      await page.waitForTimeout(150);
      views[label] = {
        state: await state(page),
        screenshot: await page.screenshot({ animations: "disabled" }),
      };
      await testInfo.attach(`${mode}-${label}.png`, {
        body: views[label].screenshot,
        contentType: "image/png",
      });
    }
    return views;
  }

  const fixed = await captureMode("fixed");
  const attenuated = await captureMode("attenuated");
  for (const view of ["close", "far"]) {
    expect(attenuated[view].state.cameraPosition.longitude).toBeCloseTo(
      fixed[view].state.cameraPosition.longitude,
      7,
    );
    expect(attenuated[view].state.cameraPosition.latitude).toBeCloseTo(
      fixed[view].state.cameraPosition.latitude,
      7,
    );
    expect(attenuated[view].state.cameraPosition.height).toBeCloseTo(
      fixed[view].state.cameraPosition.height,
      1,
    );
    expect(attenuated[view].state.cameraOrientation.heading).toBeCloseTo(
      fixed[view].state.cameraOrientation.heading,
      5,
    );
    expect(attenuated[view].state.cameraOrientation.pitch).toBeCloseTo(
      fixed[view].state.cameraOrientation.pitch,
      5,
    );
    expect(attenuated[view].state.selectedNodeKeys).toEqual(
      fixed[view].state.selectedNodeKeys,
    );
    expect(attenuated[view].screenshot.equals(fixed[view].screenshot)).toBe(
      false,
    );
  }

  const pointSizeDiagnostics = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.getPointSizeDiagnostics(),
  );
  expect(pointSizeDiagnostics.length).toBeGreaterThan(0);
  expect(
    pointSizeDiagnostics.every(
      (node) =>
        node.mode === "attenuated" &&
        Number.isFinite(node.spacingMeters) &&
        node.spacingMeters > 0 &&
        node.minimumCssPixels === 1 &&
        node.maximumCssPixels === 8 &&
        node.geometrySpacingAttribute.length > 0 &&
        node.geometrySpacingAttribute.every(Number.isFinite) &&
        node.vertexShaderSource.includes("czm_projection[1][1]") &&
        node.vertexShaderSource.includes("czm_projection[2][3]") &&
        node.vertexShaderSource.includes("clamp("),
    ),
  ).toBe(true);

  expect(pageErrors).toEqual([]);
  expect((await state(page)).lastError).toBeUndefined();
});

test("browser Blob source matches the URL source hierarchy and decoded points", async ({
  page,
}) => {
  await page.goto("/?backend=copc-js");
  await expect.poll(() => state(page)).toMatchObject({ lifecycle: "ready" });
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "local-copc-file";
    input.type = "file";
    document.body.append(input);
  });
  await page
    .locator("#local-copc-file")
    .setInputFiles(
      path.resolve(process.cwd(), "public/samples/autzen.copc.laz"),
    );
  const result = await page.evaluate(() => {
    const file = document.querySelector("#local-copc-file").files[0];
    return window.__PACKED_CONSUMER__.compareUrlAndFile(file);
  });

  expect(result.urlPointCount).toBe(10653336);
  expect(result.filePointCount).toBe(result.urlPointCount);
  expect(result.fileSource).toMatch(/^file:\/\/autzen\.copc\.laz$/);
  expect(result.fileNodes).toEqual(result.urlNodes);
  expect(
    result.sample.every((point) =>
      point.every(([urlValue, fileValue]) => urlValue === fileValue),
    ),
  ).toBe(true);
});

test("processes Cesium camera input while packed Rust Workers prepare Autzen nodes", async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = await loadRustPage(page);
  const before = await completedState(page);
  await page.evaluate(() => window.__PACKED_CONSUMER__.setCameraHeight(100000));
  await expect
    .poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(before.streamingUpdateCount);
  const far = await completedState(page);
  await page.evaluate(() =>
    window.__PACKED_CONSUMER__.beginResponsivenessCapture(),
  );
  const canvas = page.locator("#cesium-container canvas").first();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );

  // Start input before waiting for progressive rendering: on slower renderers,
  // the first rendered batch can arrive after every Worker job has finished.
  await page.evaluate(() => window.__PACKED_CONSUMER__.setCameraHeight(1000));

  let diagnostics = await page.evaluate(() =>
    window.__PACKED_CONSUMER__.getResponsivenessDiagnostics(),
  );
  for (let interaction = 0; interaction < 40; interaction += 1) {
    await page.mouse.wheel(0, interaction % 2 === 0 ? -120 : 120);
    await page.waitForTimeout(25);
    diagnostics = await page.evaluate(() =>
      window.__PACKED_CONSUMER__.getResponsivenessDiagnostics(),
    );
    if (diagnostics.workerWheelCameraChangeCount > 0) break;
  }

  await expect
    .poll(async () => (await state(page)).streamingUpdateCount)
    .toBeGreaterThan(far.streamingUpdateCount);

  console.log(
    JSON.stringify(
      {
        scenario: "issue-208-packed-rust-camera-input-during-worker-processing",
        dataset: "Autzen",
        backend: "rust",
        diagnostics,
      },
      null,
      2,
    ),
  );

  expect(diagnostics.worker).toBeDefined();
  expect(diagnostics.worker.workerCount).toBeGreaterThan(0);
  expect(diagnostics.worker.peakActiveCount).toBeGreaterThan(0);
  expect(diagnostics.worker.peakActiveCount).toBeLessThanOrEqual(
    diagnostics.worker.workerCount,
  );
  expect(diagnostics.cameraChangeCount).toBeGreaterThan(0);
  expect(diagnostics.wheelInputCount).toBeGreaterThan(0);
  expect(diagnostics.workerCameraChangeCount).toBeGreaterThan(0);
  expect(diagnostics.workerWheelCameraChangeCount).toBeGreaterThan(0);
  expect(diagnostics.frameDurationMs.count).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("keeps elevation styling and the copc-js backend available to consumers", async ({
  page,
}) => {
  const rust = await loadRustPage(page, "?backend=rust&mode=elevation");
  await expect
    .poll(async () => (await state(page)).colorMode)
    .toBe("elevation");
  const elevation = await state(page);
  expect(elevation.renderedColorCount).toBeGreaterThan(1);
  expect(elevation.lastError).toBeUndefined();
  expect(
    rust.assetResponses.some((response) =>
      response.url.includes("copc_adapter_wasm"),
    ),
  ).toBe(true);

  const jsPageErrors = [];
  const jsConsoleErrors = [];
  page.on("pageerror", (error) => jsPageErrors.push(error));
  page.on("console", (message) => {
    if (message.type() === "error") {
      jsConsoleErrors.push(message.text());
    }
  });
  await page.goto("/?backend=copc-js&mode=rgb");
  await expect
    .poll(() => state(page))
    .toMatchObject({
      lifecycle: "ready",
      backend: "copc-js",
      metadata: { pointCount: 10653336 },
    });
  await expect
    .poll(async () => (await state(page)).renderedPointCount)
    .toBeGreaterThan(0);
  const jsState = await state(page);
  expect(jsState.lastError).toBeUndefined();
  expect(jsState.viewerCreatedByConsumer).toBe(true);
  expect(jsPageErrors).toEqual([]);
  expect(jsConsoleErrors).toEqual([]);
  expect(
    rust.assetResponses.some(
      (response) =>
        response.url.includes("laz-perf") && response.status === 200,
    ),
  ).toBe(true);
});

test("packed renderer-neutral Core prepares Autzen points in a browser", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto("/core.html");
  await expect
    .poll(() => page.evaluate(() => typeof window.__COPC_CORE_NODE_SOURCE__))
    .toBe("function");
  const result = await page.evaluate(() => window.__COPC_CORE_NODE_SOURCE__());

  expect(result.pointCount).toBeGreaterThan(0);
  expect(result.coordinateSystem).toBe("wgs84-ecef-meters");
  expect(result.isFloat64).toBe(true);
  expect(result.availableFields).toEqual(["intensity", "position"]);
  expect(result.boundsEnclosePoints).toBe(true);
  expect(pageErrors).toEqual([]);
});

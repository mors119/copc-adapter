import { expect, test } from '@playwright/test';

const SOFI_SOURCE = 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz';
const SOFI_OBJECT_BYTES = 2_029_696_615;
const POINT_BUDGET = 250_000;
const CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const SOFI_CENTER = { longitudeDegrees: -118.3377231, latitudeDegrees: 33.9537444 };
const requestedRefinementAlgorithm = process.env.COPC_REFINEMENT_ALGORITHM;
if (requestedRefinementAlgorithm !== undefined
  && requestedRefinementAlgorithm !== 'foveated'
  && requestedRefinementAlgorithm !== 'screen-projection') {
  throw new Error('COPC_REFINEMENT_ALGORITHM must be foveated or screen-projection.');
}
const refinementAlgorithm = requestedRefinementAlgorithm ?? 'foveated';

type DebugState = {
  layerLoaded: boolean;
  metadataPointCount?: number;
  renderedPointCount: number;
  renderedNodeKeys: string[];
  selectedNodeKeys: string[];
  streamingUpdateCount: number;
  viewDistance?: {
    visibleFootprintMeters?: number;
    targetDistanceMeters: number;
    effectiveDistanceMeters: number;
    maxRenderDistanceMeters: number;
    overscanFactor: number;
    clampedToMaxRenderDistance: boolean;
    transition: string;
    updateCount: number;
    expansionCount: number;
    shrinkCount: number;
    hysteresisHoldCount: number;
    fallbackCount: number;
  };
  cameraMoveEventCount: number;
  cameraPitchDegrees: number;
  backend: string;
  performance: Record<string, unknown> & {
    configuredPointBudget: number;
    activeRenderedPointCount: number;
    activeNodeCount: number;
    deferredNodeCount: number;
    deferredPointCount: number;
    refinementAlgorithm?: string;
    refinementFocusEnabled?: boolean;
    focusCandidateCount?: number;
    focusWeightMax?: number;
    focusInfluencedRefinementCount?: number;
    detailBiasMax?: number;
    motionLookaheadEnabled?: boolean;
    motionSampledMovementCount?: number;
    motionWeightMax?: number;
    motionLive?: { state: string; activity: number };
  };
  pointCache: {
    cacheByteBudget: number;
    currentCacheBytes: number;
    cachedNodeCount: number;
    hits: number;
    misses: number;
    evictionCount: number;
    bytesEvicted: number;
  };
  rangeRequests: {
    requested: number;
    active: number;
    completed: number;
    failed: number;
    abortedSuperseded: number;
    abortedLifecycle: number;
  };
  hierarchy: Record<string, unknown>;
  worker?: {
    workerCount: number;
    activeCount: number;
    queuedCount: number;
    peakActiveCount: number;
    peakQueuedCount: number;
    submittedCount: number;
    completedCount: number;
    cancelledCount: number;
    failedCount: number;
  };
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
  lastError?: string;
};

type CameraView = {
  longitudeDegrees: number;
  latitudeDegrees: number;
  heightMeters: number;
  headingDegrees: number;
  pitchDegrees: number;
};

type RangeResponse = {
  requestedRange?: string;
  status: number;
  contentRange?: string;
  contentLength: number;
};

type FrameSummary = { count: number; medianMs: number; p95Ms: number; maxMs: number };

function summarizeRendererStages(
  label: string,
  state: DebugState,
  frames?: FrameSummary,
): Record<string, unknown> {
  const performance = state.performance;
  return {
    camera: label,
    selectedNodeCount: state.selectedNodeKeys.length,
    renderedNodeCount: state.renderedNodeKeys.length,
    estimatedSelectedPoints: performance.estimatedSelectedPointCount,
    loadedPoints: performance.loadedPointCount,
    renderedPoints: state.renderedPointCount,
    rangeFetchBytes: performance.rangeFetchBytes,
    decodeMs: performance.decodeDurationMs,
    pointPreparationMs: performance.pointPreparationDurationMs,
    crsTransformMs: performance.crsTransformDurationMs,
    coordinateConversionMs: performance.worldToCartesianDurationMs,
    styleMs: performance.pointStylePreparationDurationMs,
    primitiveCreationMs: performance.pointCollectionCreationDurationMs,
    primitiveAddMs: performance.pointAddDurationMs,
    rendererPreparationMs: performance.rendererPreparationDurationMs,
    nodeRemovalMs: performance.nodeRemovalDurationMs,
    longestMainThreadTaskMs: state.longestMainThreadTaskMs,
    cesiumFrameDurationMs: state.cesiumFrameDurationMs,
    frames,
  };
}

type DebugAdapter = {
  getState(): DebugState;
  setCameraView(view: CameraView): void;
  probePublicBatchCpuPick?(offsetPx?: number, clickTolerancePx?: number): {
    picked: boolean;
    nodeKey?: string;
    pointIndex?: number;
    scannedPointCount: number;
    candidateCount: number;
    scenePickDurationMs: number;
    cpuResolveDurationMs: number;
    totalDurationMs: number;
  };
};

declare global {
  interface Window {
    __COPC_DEBUG__?: DebugAdapter;
  }
}

async function getState(page: import('@playwright/test').Page): Promise<DebugState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__) throw new Error('COPC debug adapter is unavailable');
    return window.__COPC_DEBUG__.getState();
  });
}

async function waitForIdle(page: import('@playwright/test').Page): Promise<DebugState> {
  let stableSamples = 0;
  let previous = await getState(page);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    await page.waitForTimeout(250);
    const current = await getState(page);
    const workerIdle = !current.worker
      || (current.worker.activeCount === 0 && current.worker.queuedCount === 0);
    if (workerIdle
      && current.rangeRequests.active === 0
      && current.streamingUpdateCount === previous.streamingUpdateCount) {
      stableSamples += 1;
      if (stableSamples >= 3) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }

  return previous;
}

async function sampleFrames(
  page: import('@playwright/test').Page,
): Promise<{ count: number; medianMs: number; p95Ms: number; maxMs: number }> {
  const frames = await page.evaluate(async () => {
    const intervals: number[] = [];
    let previous = performance.now();
    const end = previous + 1_000;
    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        intervals.push(now - previous);
        previous = now;
        if (now >= end) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return intervals;
  });
  const warmupFrames = Math.min(5, Math.max(0, frames.length - 1));
  const sorted = frames.slice(warmupFrames).sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * fraction),
  )] ?? 0;
  return {
    count: frames.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: at(1),
  };
}

function summarize(state: DebugState): Record<string, unknown> {
  return {
    renderedPointCount: state.renderedPointCount,
    renderedNodeCount: state.renderedNodeKeys.length,
    selectedNodeCount: state.selectedNodeKeys.length,
    selectedNodeKeys: state.selectedNodeKeys,
    renderedNodeKeys: state.renderedNodeKeys,
    streamingUpdateCount: state.streamingUpdateCount,
    refinementAlgorithm: state.performance.refinementAlgorithm,
    refinementFocusEnabled: state.performance.refinementFocusEnabled,
    focusCandidateCount: state.performance.focusCandidateCount,
    focusWeightMax: state.performance.focusWeightMax,
    focusInfluencedRefinementCount: state.performance.focusInfluencedRefinementCount,
    detailBiasMax: state.performance.detailBiasMax,
    motionLookaheadEnabled: state.performance.motionLookaheadEnabled,
    motionSampledMovementCount: state.performance.motionSampledMovementCount,
    motionWeightMax: state.performance.motionWeightMax,
    motionLive: state.performance.motionLive,
    viewDistance: state.viewDistance,
    performance: {
      updateDurationMs: state.performance.updateDurationMs,
      nodeSelectionMs: state.performance.nodeSelectionMs,
      loadedNodeCount: state.performance.loadedNodeCount,
      loadedPointCount: state.performance.loadedPointCount,
      activeRenderedPointCount: state.performance.activeRenderedPointCount,
      candidateSelectedPointCount: state.performance.candidateSelectedPointCount,
      deferredNodeCount: state.performance.deferredNodeCount,
      deferredPointCount: state.performance.deferredPointCount,
      activeNodeCount: state.performance.activeNodeCount,
      queuedNodeCount: state.performance.queuedNodeCount,
      maxConcurrentNodeLoads: state.performance.maxConcurrentNodeLoads,
      rangeFetchDurationMs: state.performance.rangeFetchDurationMs,
      rangeFetchBytes: state.performance.rangeFetchBytes,
      decodeDurationMs: state.performance.decodeDurationMs,
      pointPreparationDurationMs: state.performance.pointPreparationDurationMs,
      crsTransformDurationMs: state.performance.crsTransformDurationMs,
      geographicToCartesianDurationMs: state.performance.geographicToCartesianDurationMs,
      worldToCartesianDurationMs: state.performance.worldToCartesianDurationMs,
      pointStylePreparationDurationMs: state.performance.pointStylePreparationDurationMs,
      pointCollectionCreationDurationMs: state.performance.pointCollectionCreationDurationMs,
      pointAddDurationMs: state.performance.pointAddDurationMs,
      rendererPreparationDurationMs: state.performance.rendererPreparationDurationMs,
      nodeRemovalDurationMs: state.performance.nodeRemovalDurationMs,
      firstHighPriorityNodeStartLatencyMs: state.performance.firstHighPriorityNodeStartLatencyMs,
      firstHighPriorityNodeReadyLatencyMs: state.performance.firstHighPriorityNodeReadyLatencyMs,
      longestMainThreadBlockingSectionMs: state.performance.longestMainThreadBlockingSectionMs,
    },
    pointCache: {
      cacheByteBudget: state.pointCache.cacheByteBudget,
      currentCacheBytes: state.pointCache.currentCacheBytes,
      cachedNodeCount: state.pointCache.cachedNodeCount,
      hits: state.pointCache.hits,
      misses: state.pointCache.misses,
      evictionCount: state.pointCache.evictionCount,
      bytesEvicted: state.pointCache.bytesEvicted,
    },
    rangeRequests: state.rangeRequests,
    hierarchy: {
      pageRequests: state.hierarchy.pageRequests,
      pageCacheHits: state.hierarchy.pageCacheHits,
      hierarchyBytesFetched: state.hierarchy.hierarchyBytesFetched,
      loadedPageCount: state.hierarchy.loadedPageCount,
      discoveredPageCount: state.hierarchy.discoveredPageCount,
      completedPageCount: state.hierarchy.completedPageCount,
      activePageLoads: state.hierarchy.activePageLoads,
      peakActivePageLoads: state.hierarchy.peakActivePageLoads,
      sourceOpenDurationMs: state.hierarchy.sourceOpenDurationMs,
      metadataLoadDurationMs: state.hierarchy.metadataLoadDurationMs,
      rootHierarchyLoadDurationMs: state.hierarchy.rootHierarchyLoadDurationMs,
      lastQueryDurationMs: state.hierarchy.lastQueryDurationMs,
      loadedEntryCount: state.hierarchy.loadedEntryCount,
    },
    worker: state.worker,
    longestMainThreadTaskMs: state.longestMainThreadTaskMs,
    cesiumFrameDurationMs: state.cesiumFrameDurationMs,
    lastError: state.lastError,
  };
}

test('records bounded SoFi multi-GB Cesium browser streaming', async ({ page, browser }) => {
  test.setTimeout(12 * 60 * 1_000);

  const rangeResponses: RangeResponse[] = [];
  const pageStartedAt = Date.now();
  let delayNextRangeResponse = false;
  let delayedRangeCount = 0;
  let resolveDelayedRange: () => void = () => {};
  const delayedRange = new Promise<void>((resolve) => {
    resolveDelayedRange = resolve;
  });
  let releaseDelayedRange: () => void = () => {};
  const releaseRange = new Promise<void>((resolve) => {
    releaseDelayedRange = resolve;
  });

  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));

  // S3 allows this origin, but omits Content-Range from
  // Access-Control-Expose-Headers. Preserve every real upstream response and
  // add only the response headers a browser Range reader needs to inspect it.
  await page.route('https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz', async (route) => {
    const requestedRange = route.request().headers().range;
    if (!requestedRange) {
      await route.abort();
      throw new Error('Blocked a SoFi request without Range to prevent a whole-object transfer');
    }
    // S3 occasionally resets long-running Range connections. Retry only
    // transport-level ECONNRESET failures; HTTP responses remain observable.
    const upstream = await route.fetch({ maxRetries: 2 });
    const headers = upstream.headers();
    if (delayNextRangeResponse) {
      delayNextRangeResponse = false;
      delayedRangeCount += 1;
      resolveDelayedRange();
      await releaseRange;
    }
    await route.fulfill({
      response: upstream,
      headers: {
        ...headers,
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'Range',
        'access-control-expose-headers': 'Accept-Ranges, Content-Length, Content-Range',
      },
    });
  });

  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/sofi.copc.laz') return;
    const request = response.request();
    const requestedRange = request.headers().range;
    if (!requestedRange) return;
    const headers = response.headers();
    rangeResponses.push({
      requestedRange,
      status: response.status(),
      contentRange: headers['content-range'],
      contentLength: Number(headers['content-length'] ?? 0),
    });
  });

  const sourceQuery = encodeURIComponent(SOFI_SOURCE);
  const renderer = process.env.COPC_RENDERER_VARIANT === 'public-batched'
    ? '&renderer=public-batched'
    : '';
  await page.goto(
    `/?scenario=issue68&backend=rust&debugPanel=false&budget=${POINT_BUDGET}&source=${sourceQuery}&refinementAlgorithm=${refinementAlgorithm}${renderer}`,
  );
  await expect.poll(async () => {
    const state = await getState(page);
    return state.layerLoaded && state.renderedPointCount > 0;
  }, { timeout: 180_000 }).toBe(true);
  const firstUsefulVisiblePointMs = Date.now() - pageStartedAt;
  const initial = await waitForIdle(page);
  expect(initial.performance.refinementAlgorithm).toBe(refinementAlgorithm);
  const rendererStageEvidence = [summarizeRendererStages('initial', initial, await sampleFrames(page))];
  console.log(JSON.stringify({
    scenario: 'issue-212-sofi-initial',
    firstUsefulVisiblePointMs,
    state: summarize(initial),
  }));

  if (process.env.COPC_RENDERER_VARIANT === 'public-batched') {
    const cpuPickSamples = await page.evaluate(() => {
      const probes = Array.from({ length: 5 }, () =>
        window.__COPC_DEBUG__?.probePublicBatchCpuPick?.());
      return probes.filter((probe) => probe !== undefined);
    });
    const cpuTimes = cpuPickSamples
      .map((probe) => probe.cpuResolveDurationMs)
      .sort((left, right) => left - right);
    const fullTimes = cpuPickSamples
      .map((probe) => probe.totalDurationMs)
      .sort((left, right) => left - right);
    console.log(JSON.stringify({
      scenario: 'issue-233-sofi-cpu-pick-250k-budget',
      totalRenderedPointCount: initial.renderedPointCount,
      renderedNodeCount: initial.renderedNodeKeys.length,
      cpuPickSamples,
      medianCpuResolveMs: cpuTimes[Math.floor(cpuTimes.length / 2)] ?? 0,
      medianFullPickMs: fullTimes[Math.floor(fullTimes.length / 2)] ?? 0,
    }, null, 2));
    expect(cpuPickSamples).toHaveLength(5);
    for (const probe of cpuPickSamples) {
      expect(probe).toMatchObject({
        picked: true,
        nodeKey: expect.any(String),
        pointIndex: expect.any(Number),
      });
      expect(probe.scannedPointCount).toBeGreaterThan(0);
      expect(probe.scannedPointCount).toBeLessThanOrEqual(POINT_BUDGET);
    }
  }

  const transitions: Record<string, unknown>[] = [];
  const view = async (label: string, camera: CameraView): Promise<DebugState> => {
    const before = await getState(page);
    const previousNodeKeys = [...before.selectedNodeKeys].sort().join('\0');
    const startedAt = Date.now();
    await page.evaluate((nextView) => window.__COPC_DEBUG__?.setCameraView(nextView), camera);
    await expect.poll(async () => {
      const current = await getState(page);
      return current.streamingUpdateCount > before.streamingUpdateCount
        || [...current.selectedNodeKeys].sort().join('\0') !== previousNodeKeys;
    }, { timeout: 60_000 }).toBe(true);
    const firstUpdateMs = Date.now() - startedAt;
    await expect.poll(async () => {
      const current = await getState(page);
      return (current.viewDistance?.updateCount ?? 0)
        > (before.viewDistance?.updateCount ?? 0);
    }, { timeout: 60_000 }).toBe(true);
    const state = await waitForIdle(page);
    const frames = await sampleFrames(page);
    rendererStageEvidence.push(summarizeRendererStages(label, state, frames));
    transitions.push({
      label,
      camera,
      firstUpdateMs,
      state: summarize(state),
      frames,
    });
    return state;
  };

  const closeDownward = await view('close-downward', {
    ...SOFI_CENTER,
    heightMeters: 1_500,
    headingDegrees: 0,
    pitchDegrees: -89,
  });
  const mediumOverview = await view('medium-overview', {
    ...SOFI_CENTER,
    heightMeters: 20_000,
    headingDegrees: 0,
    pitchDegrees: -80,
  });
  const highOverview = await view('high-overview', {
    ...SOFI_CENTER,
    heightMeters: 100_000,
    headingDegrees: 0,
    pitchDegrees: -80,
  });
  const oblique = await view('oblique', {
    longitudeDegrees: SOFI_CENTER.longitudeDegrees - 0.0025,
    latitudeDegrees: SOFI_CENTER.latitudeDegrees - 0.002,
    heightMeters: 500,
    headingDegrees: 45,
    pitchDegrees: -55,
  });
  const areaA = await view('area-a', {
    longitudeDegrees: SOFI_CENTER.longitudeDegrees - 0.0012,
    latitudeDegrees: SOFI_CENTER.latitudeDegrees,
    heightMeters: 3_000,
    headingDegrees: 20,
    pitchDegrees: -55,
  });
  const areaB = await view('area-b', {
    longitudeDegrees: SOFI_CENTER.longitudeDegrees + 0.0012,
    latitudeDegrees: SOFI_CENTER.latitudeDegrees,
    heightMeters: 3_000,
    headingDegrees: 200,
    pitchDegrees: -55,
  });
  const areaAReturn = await view('area-a-return', {
    longitudeDegrees: SOFI_CENTER.longitudeDegrees - 0.0012,
    latitudeDegrees: SOFI_CENTER.latitudeDegrees,
    heightMeters: 3_000,
    headingDegrees: 20,
    pitchDegrees: -55,
  });

  delayNextRangeResponse = true;
  const beforeSlowRange = await getState(page);
  await page.evaluate((nextView) => window.__COPC_DEBUG__?.setCameraView(nextView), {
    longitudeDegrees: SOFI_CENTER.longitudeDegrees,
    latitudeDegrees: SOFI_CENTER.latitudeDegrees + 0.001,
    heightMeters: 1_500,
    headingDegrees: 0,
    pitchDegrees: -80,
  });
  await expect.poll(() => delayedRangeCount, {
    timeout: 60_000,
    message: 'A new point Range request must be available to supersede',
  }).toBeGreaterThan(0);
  const heldRangeState = await getState(page);
  expect(heldRangeState.rangeRequests.active).toBeGreaterThan(0);
  await page.evaluate((nextView) => window.__COPC_DEBUG__?.setCameraView(nextView), {
    ...SOFI_CENTER,
    heightMeters: 100_000,
    headingDegrees: 0,
    pitchDegrees: -80,
  });
  await expect.poll(async () => (await getState(page)).rangeRequests.abortedSuperseded, {
    timeout: 30_000,
  }).toBeGreaterThan(beforeSlowRange.rangeRequests.abortedSuperseded);
  releaseDelayedRange();
  const staleWork = await waitForIdle(page);
  transitions.push({
    label: 'slow-range-superseded-by-high-overview',
    delayedRangeCount,
    state: summarize(staleWork),
  });

  const finalState = await waitForIdle(page);
  await page.waitForTimeout(100);
  const transferredRangeBytes = rangeResponses.reduce(
    (total, response) => total + response.contentLength,
    0,
  );

  console.log(JSON.stringify({
    scenario: 'issue-212-sofi-multigb-browser-validation',
    dataset: {
      url: SOFI_SOURCE,
      totalBytes: SOFI_OBJECT_BYTES,
      pointCount: initial.metadataPointCount,
    },
    environment: {
      os: `${process.platform}-${process.arch}`,
      node: process.version,
      browser: browser.version(),
      viewport: page.viewportSize(),
      webgl: 'SwiftShader',
    },
    configuration: {
      backend: 'rust',
      colorMode: 'elevation',
      refinementAlgorithm,
      maxNodes: 32,
      maxDepth: 6,
      maxScreenSpaceError: 8,
      maxRenderDistanceMeters: 20_000,
      configuredPointBudget: POINT_BUDGET,
      decodedPointCacheByteBudget: initial.pointCache.cacheByteBudget,
    },
    firstUsefulVisiblePointMs,
    rangeTraffic: {
      requestCount: rangeResponses.length,
      transferredBytes: transferredRangeBytes,
      objectFraction: transferredRangeBytes / SOFI_OBJECT_BYTES,
      successful206Responses: rangeResponses.filter((response) => response.status === 206).length,
      largestResponseBytes: Math.max(0, ...rangeResponses.map((response) => response.contentLength)),
      sampleRanges: rangeResponses.slice(0, 8),
      instrumentedReader: finalState.rangeRequests,
    },
    initial: summarize(initial),
    transitions,
  }, null, 2));
  console.log(JSON.stringify({
    renderer: process.env.COPC_RENDERER_VARIANT ?? 'point-primitive',
    rendererStageEvidence,
  }, null, 2));

  expect(initial.backend).toBe('rust');
  expect(initial.performance.configuredPointBudget).toBe(POINT_BUDGET);
  expect(initial.pointCache.cacheByteBudget).toBe(CACHE_BUDGET_BYTES);
  expect(initial.renderedPointCount).toBeGreaterThan(0);
  expect(initial.renderedPointCount).toBeLessThanOrEqual(POINT_BUDGET);
  expect(oblique.renderedPointCount).toBeGreaterThan(0);
  expect(closeDownward.viewDistance?.effectiveDistanceMeters).toBeLessThan(9_000);
  expect(highOverview.viewDistance?.effectiveDistanceMeters)
    .toBeGreaterThan(closeDownward.viewDistance?.effectiveDistanceMeters ?? 0);
  const settledStates = [
    closeDownward,
    mediumOverview,
    highOverview,
    oblique,
    areaA,
    areaB,
    areaAReturn,
    staleWork,
  ];
  expect(settledStates.every((state) => state.lastError === undefined)).toBe(true);
  expect(settledStates.every((state) =>
    (state.viewDistance?.effectiveDistanceMeters ?? Number.POSITIVE_INFINITY) <= 20_000,
  )).toBe(true);
  expect(settledStates.every((state) => state.renderedPointCount <= POINT_BUDGET)).toBe(true);
  expect(settledStates.every((state) => state.pointCache.currentCacheBytes <= CACHE_BUDGET_BYTES)).toBe(true);
  expect(areaAReturn.pointCache.hits).toBeGreaterThan(areaB.pointCache.hits);
  expect(finalState.renderedPointCount).toBeLessThanOrEqual(POINT_BUDGET);
  expect(finalState.selectedNodeKeys.length).toBeLessThanOrEqual(32);
  expect(finalState.pointCache.currentCacheBytes).toBeLessThanOrEqual(CACHE_BUDGET_BYTES);
  expect(finalState.rangeRequests.active).toBe(0);
  expect(finalState.rangeRequests.failed).toBe(0);
  expect(finalState.rangeRequests.requested).toBe(
    finalState.rangeRequests.completed
      + finalState.rangeRequests.failed
      + finalState.rangeRequests.abortedSuperseded
      + finalState.rangeRequests.abortedLifecycle,
  );
  expect(finalState.worker).toBeDefined();
  expect(finalState.worker!.activeCount).toBeLessThanOrEqual(finalState.worker!.workerCount);
  expect(finalState.worker!.queuedCount).toBe(0);
  expect(staleWork.rangeRequests.abortedSuperseded).toBeGreaterThan(
    beforeSlowRange.rangeRequests.abortedSuperseded,
  );
  expect(delayedRangeCount).toBe(1);
  expect(rangeResponses.length).toBeGreaterThan(0);
  expect(rangeResponses.every((response) => response.status === 206)).toBe(true);
  expect(rangeResponses.every((response) => response.contentRange?.endsWith(`/${SOFI_OBJECT_BYTES}`))).toBe(true);
  expect(rangeResponses.every((response) => {
    const requested = /^bytes=(\d+)-(\d+)$/.exec(response.requestedRange ?? '');
    const returned = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.contentRange ?? '');
    if (!requested || !returned) return false;
    const [requestedStart, requestedEnd] = requested.slice(1, 3).map(Number);
    const [returnedStart, returnedEnd, returnedTotal] = returned.slice(1, 4).map(Number);
    return requestedStart === returnedStart
      && requestedEnd === returnedEnd
      && returnedTotal === SOFI_OBJECT_BYTES
      && response.contentLength === requestedEnd - requestedStart + 1;
  })).toBe(true);
  expect(transferredRangeBytes).toBeLessThan(SOFI_OBJECT_BYTES);
});

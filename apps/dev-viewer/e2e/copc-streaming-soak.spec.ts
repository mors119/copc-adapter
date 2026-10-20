import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type {
  CameraView,
  LifecycleState,
} from "./fixtures/cesium-lifecycle-fixture";

const AUTZEN_CENTER = {
  longitudeDegrees: -123.0664124403113,
  latitudeDegrees: 44.056302478080184,
};
const POINT_BUDGET = 250_000;
const CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const PRESSURE_CACHE_BUDGET_BYTES = 1 * 1024 * 1024;
const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const LIFECYCLE_REPETITIONS = 20;

type WorkerTracker = {
  snapshot(): {
    created: number;
    terminated: number;
    active: number;
    activeScripts: string[];
  };
};

declare global {
  interface Window {
    __COPC_SOAK_WORKERS__?: WorkerTracker;
  }
}

type PointRangeObservation = {
  range?: string;
  requestedBytes?: number;
  status?: number;
  contentRange?: string;
  failed?: string;
  expectedFailure?: boolean;
  expectedLifecycleAbort?: boolean;
  phase: string;
  elapsedMs: number;
};

function fixture(page: import("@playwright/test").Page): Promise<{
  cesiumVersion: string;
  source: string;
}> {
  return page.evaluate(() => {
    if (!window.__COPC_SOAK_FIXTURE__) {
      throw new Error("COPC soak browser fixture is unavailable");
    }
    return {
      cesiumVersion: window.__COPC_SOAK_FIXTURE__.cesiumVersion,
      source: window.__COPC_SOAK_FIXTURE__.source,
    };
  });
}

async function getState(
  page: import("@playwright/test").Page,
): Promise<LifecycleState> {
  return page.evaluate(() => {
    if (!window.__COPC_SOAK_FIXTURE__) {
      throw new Error("COPC soak browser fixture is unavailable");
    }
    return window.__COPC_SOAK_FIXTURE__.getState();
  });
}

async function getWorkerTracker(
  page: import("@playwright/test").Page,
): Promise<{
  created: number;
  terminated: number;
  active: number;
  activeScripts: string[];
}> {
  return page.evaluate(() => {
    if (!window.__COPC_SOAK_WORKERS__) {
      throw new Error("COPC soak Worker tracker is unavailable");
    }
    return window.__COPC_SOAK_WORKERS__.snapshot();
  });
}

async function readHeapUsedBytes(
  session: import("@playwright/test").CDPSession,
): Promise<number | undefined> {
  const { metrics } = await session.send("Performance.getMetrics");
  return metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
}

async function readDomCounters(
  session: import("@playwright/test").CDPSession,
): Promise<
  { documents: number; nodes: number; jsEventListeners: number } | undefined
> {
  try {
    return await session.send("Memory.getDOMCounters");
  } catch {
    return undefined;
  }
}

async function collectFrames(
  page: import("@playwright/test").Page,
  durationMs = 1_000,
): Promise<{ count: number; medianMs: number; p95Ms: number; maxMs: number }> {
  const frames = await page.evaluate(async (duration) => {
    const intervals: number[] = [];
    let previous = performance.now();
    const end = previous + duration;
    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        intervals.push(now - previous);
        previous = now;
        if (now >= end) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return intervals.slice(5);
  }, durationMs);
  const sorted = frames.sort((left, right) => left - right);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0;
  return {
    count: frames.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: at(1),
  };
}

function parseContentRange(value: string | undefined):
  | { start: number; end: number; total: number }
  | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return undefined;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function linearSlope(
  points: Array<{ x: number; y: number }>,
): number | undefined {
  if (points.length < 2) return undefined;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0,
  );
  const denominator = points.reduce(
    (sum, point) => sum + (point.x - meanX) ** 2,
    0,
  );
  return denominator === 0 ? undefined : numerator / denominator;
}

function summarizeState(state: LifecycleState): Record<string, unknown> {
  const { snapshot } = state;
  return {
    lifecycle: snapshot.lifecycle,
    attached: snapshot.attached,
    renderedNodeKeys: snapshot.renderedNodeKeys,
    selectedNodeKeys: snapshot.selectedNodeKeys,
    renderedPoints: snapshot.renderedPointCount,
    maxConcurrentNodeLoads: snapshot.performance.maxConcurrentNodeLoads,
    maxConcurrentWorkers: snapshot.worker?.workerCount,
    streamingUpdateCount: snapshot.streamingUpdateCount,
    updateDurationMs: snapshot.performance.updateDurationMs,
    motionLive: snapshot.performance.motionLive,
    predictivePrefetch: snapshot.predictivePrefetch,
    transition: snapshot.transition,
    pointCache: snapshot.pointCache,
    rangeRequests: snapshot.rangeRequests,
    rangeFetchBytes: snapshot.performance.rangeFetchBytes,
    worker: snapshot.worker,
    hierarchy: state.hierarchy,
    scenePrimitiveCount: state.scenePrimitiveCount,
    pointCollectionCount: state.pointCollectionCount,
    canvasCount: state.canvasCount,
    cameraMoveEndListeners: state.cameraMoveEndListeners,
    cameraChangedListeners: state.cameraChangedListeners,
    viewerDestroyed: state.viewerDestroyed,
  };
}

test("records long-run Autzen streaming and repeated Cesium layer lifecycle evidence", async ({
  page,
  context,
  browser,
}, testInfo) => {
  test.skip(
    process.env.COPC_RUN_STREAMING_SOAK !== "1",
    "Manual 30+ minute COPC streaming soak; run npm run test:soak",
  );
  const soakMinutes = Number(process.env.COPC_SOAK_MINUTES ?? "30");
  const minimumMinutes = process.env.COPC_SOAK_ALLOW_SHORT === "1" ? 1 : 30;
  if (!Number.isFinite(soakMinutes) || soakMinutes < minimumMinutes) {
    throw new Error(`COPC_SOAK_MINUTES must be at least ${minimumMinutes}`);
  }
  const sampleIntervalMs = Number(
    process.env.COPC_SOAK_SAMPLE_INTERVAL_MS ?? DEFAULT_SAMPLE_INTERVAL_MS,
  );
  if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 1_000) {
    throw new Error("COPC_SOAK_SAMPLE_INTERVAL_MS must be at least 1000");
  }
  const soakDurationMs = soakMinutes * 60_000;
  test.setTimeout(soakDurationMs + 30 * 60_000);

  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    const activeWorkers = new Map<Worker, string>();
    let created = 0;
    let terminated = 0;
    window.Worker = new Proxy(OriginalWorker, {
      construct(target, argumentsList, newTarget) {
        const worker = Reflect.construct(target, argumentsList, newTarget);
        const script = String(argumentsList[0]);
        const nativeTerminate = worker.terminate.bind(worker);
        let didTerminate = false;
        Object.defineProperty(worker, "terminate", {
          configurable: true,
          value() {
            if (!didTerminate) {
              didTerminate = true;
              activeWorkers.delete(worker);
              terminated += 1;
            }
            return nativeTerminate();
          },
        });
        created += 1;
        activeWorkers.set(worker, script);
        return worker;
      },
    });
    window.__COPC_SOAK_WORKERS__ = {
      snapshot: () => ({
        created,
        terminated,
        active: activeWorkers.size,
        activeScripts: [...activeWorkers.values()],
      }),
    };
  });

  const source = "/samples/autzen.copc.laz";
  const runStartedAt = Date.now();
  let activePhase = "setup";
  const requestObservations = new Map<
    import("@playwright/test").Request,
    PointRangeObservation
  >();
  const expectedFailureRequests = new WeakSet<
    import("@playwright/test").Request
  >();
  const expectedLifecycleAbortRequests = new WeakSet<
    import("@playwright/test").Request
  >();
  const pointRanges: PointRangeObservation[] = [];
  let failNextPointRange = false;
  let holdNextPointRange = false;
  let heldPointRangeCount = 0;
  const heldRangeReleases: Array<() => void> = [];
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith(".copc.laz")) return;
    const range = request.headers().range;
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    const observation: PointRangeObservation = {
      ...(range ? { range } : {}),
      ...(match
        ? { requestedBytes: Number(match[2]) - Number(match[1]) + 1 }
        : {}),
      phase: activePhase,
      elapsedMs: Date.now() - runStartedAt,
      ...(expectedFailureRequests.has(request) ? { expectedFailure: true } : {}),
      ...(expectedLifecycleAbortRequests.has(request)
        ? { expectedLifecycleAbort: true }
        : {}),
    };
    pointRanges.push(observation);
    requestObservations.set(request, observation);
  });
  page.on("response", (response) => {
    const observation = requestObservations.get(response.request());
    if (!observation) return;
    observation.status = response.status();
    observation.contentRange = response.headers()["content-range"];
    observation.expectedFailure = expectedFailureRequests.has(response.request());
  });
  page.on("requestfailed", (request) => {
    const observation = requestObservations.get(request);
    if (observation) {
      observation.failed = request.failure()?.errorText ?? "failed";
      observation.expectedLifecycleAbort =
        expectedLifecycleAbortRequests.has(request);
    }
  });

  await page.route("**/samples/autzen.copc.laz", async (route) => {
    const request = route.request();
    if (!request.headers().range) {
      await route.continue();
      return;
    }
    const observation = requestObservations.get(request);
    if (failNextPointRange) {
      failNextPointRange = false;
      expectedFailureRequests.add(request);
      if (observation) observation.expectedFailure = true;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Intentional COPC soak failure-path probe",
      });
      return;
    }
    if (holdNextPointRange) {
      holdNextPointRange = false;
      heldPointRangeCount += 1;
      expectedLifecycleAbortRequests.add(request);
      if (observation) observation.expectedLifecycleAbort = true;
      await new Promise<void>((resolve) => {
        heldRangeReleases.push(resolve);
      });
    }
    try {
      await route.continue();
    } catch {
      // The browser can cancel the intercepted request while layer teardown
      // runs. The abort is the behavior this lifecycle probe observes.
    }
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");

  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
    encoding: "utf8",
  }).trim();
  const gitWorkingTreeDirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
      encoding: "utf8",
    }).trim().length > 0;
  const npmVersion = execFileSync("npm", ["--version"], {
    encoding: "utf8",
  }).trim();

  await page.goto(`/e2e/fixtures/cesium-lifecycle-fixture.html?source=${encodeURIComponent(source)}`);
  const browserFixture = await fixture(page);
  expect(browserFixture.source).toBe(source);
  const versionInfo = await page.evaluate(() => ({
    cesiumVersion: window.__COPC_SOAK_FIXTURE__?.cesiumVersion,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webgl: (() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return "unavailable";
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        version: gl.getParameter(gl.VERSION),
        renderer: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : "masked",
      };
    })(),
  }));

  const centerView = (heightMeters: number, headingDegrees = 0): CameraView => ({
    ...AUTZEN_CENTER,
    heightMeters,
    headingDegrees,
    pitchDegrees: -35,
  });
  const setView = async (view: CameraView): Promise<void> => {
    await page.evaluate((nextView) => {
      window.__COPC_SOAK_FIXTURE__!.setCameraView(nextView);
    }, view);
  };
  const waitForIdle = async (
    timeoutMs = 120_000,
    requireSelectedNodesRendered = true,
  ): Promise<LifecycleState> => {
    let stableSamples = 0;
    let previous = await getState(page);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const current = await getState(page);
      const workerIdle =
        !current.snapshot.worker ||
        (current.snapshot.worker.activeCount === 0 &&
          current.snapshot.worker.queuedCount === 0);
      if (
        workerIdle &&
        current.snapshot.rangeRequests.active === 0 &&
        current.snapshot.transition.activeReplacementGroupCount === 0 &&
        (!requireSelectedNodesRendered ||
          current.snapshot.selectedNodeKeys.every((key) =>
            current.snapshot.renderedNodeKeys.includes(key),
          )) &&
        current.snapshot.streamingUpdateCount ===
          previous.snapshot.streamingUpdateCount
      ) {
        stableSamples += 1;
        if (stableSamples >= 3) return current;
      } else {
        stableSamples = 0;
      }
      previous = current;
    }
    throw new Error(
      `Streaming did not settle within ${timeoutMs} ms: ${JSON.stringify(summarizeState(previous))}`,
    );
  };

  const initialResourceBaseline = await page.evaluate(() => {
    const state = window.__COPC_SOAK_FIXTURE__;
    if (!state) throw new Error("COPC soak browser fixture is unavailable");
    state.createLayer();
    return state.getState();
  });
  const initialCameraListeners = {
    moveEnd: initialResourceBaseline.cameraMoveEndListeners,
    changed: initialResourceBaseline.cameraChangedListeners,
  };
  const initialScenePrimitiveCount = initialResourceBaseline.scenePrimitiveCount;
  const initialPointCollectionCount =
    initialResourceBaseline.pointCollectionCount;
  const initialCanvasCount = initialResourceBaseline.canvasCount;
  const initialWorkerBaseline = await getWorkerTracker(page);

  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.load());
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.attach());
  await setView(centerView(1_000));
  await expect
    .poll(async () => (await getState(page)).snapshot.renderedPointCount, {
      timeout: 120_000,
      message: "The initial Autzen view should render useful points",
    })
    .toBeGreaterThan(0);
  const initialUsefulPointsMs = Date.now() - runStartedAt;
  const initialState = await waitForIdle();
  expect(initialState.snapshot.backend).toBe("rust");
  expect(initialState.snapshot.performance.configuredPointBudget).toBe(
    POINT_BUDGET,
  );
  expect(initialState.snapshot.pointCache.cacheByteBudget).toBe(
    CACHE_BUDGET_BYTES,
  );

  const transitions: Array<Record<string, unknown>> = [];
  const samples: Array<Record<string, unknown>> = [];
  const cacheReuse: Array<Record<string, unknown>> = [];
  const settledRetentionMeasurements: Array<Record<string, unknown>> = [];
  let firstNearState = initialState;
  let maxObservedCacheBytes = initialState.snapshot.pointCache.currentCacheBytes;
  let overBudgetCacheSamples = 0;
  let sampleLoopActive = true;
  const sampleLoop = (async () => {
    while (sampleLoopActive) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, sampleIntervalMs),
      );
      if (!sampleLoopActive) break;
      const [state, frames, heapUsedBytes, workerTracker] = await Promise.all([
        getState(page),
        collectFrames(page),
        readHeapUsedBytes(cdp),
        getWorkerTracker(page),
      ]);
      const domCounters = await readDomCounters(cdp);
      maxObservedCacheBytes = Math.max(
        maxObservedCacheBytes,
        state.snapshot.pointCache.currentCacheBytes,
      );
      if (
        state.snapshot.pointCache.currentCacheBytes >
        state.snapshot.pointCache.cacheByteBudget
      ) {
        overBudgetCacheSamples += 1;
      }
      samples.push({
        elapsedMs: Date.now() - runStartedAt,
        renderedPointCount: state.snapshot.renderedPointCount,
        selectedNodeCount: state.snapshot.selectedNodeKeys.length,
        renderedNodeCount: state.snapshot.renderedNodeKeys.length,
        selectedNodeKeys: state.snapshot.selectedNodeKeys,
        performance: {
          configuredPointBudget:
            state.snapshot.performance.configuredPointBudget,
          activeRenderedPointCount:
            state.snapshot.performance.activeRenderedPointCount,
          rangeFetchBytes: state.snapshot.performance.rangeFetchBytes,
          updateDurationMs: state.snapshot.performance.updateDurationMs,
          longestMainThreadTaskMs: state.longestMainThreadTaskMs,
          longTaskCount: state.longTaskCount,
          cesiumFrameDurationMs: state.cesiumFrameDurationMs,
        },
        pointCache: state.snapshot.pointCache,
        rangeRequests: state.snapshot.rangeRequests,
        hierarchy: state.hierarchy,
        worker: state.snapshot.worker,
        workerTracker,
        heapUsedBytes,
        domCounters,
        rendererResources: {
          scenePrimitiveCount: state.scenePrimitiveCount,
          pointCollectionCount: state.pointCollectionCount,
          canvasCount: state.canvasCount,
        },
        frameTimeMs: frames,
        viewerDestroyed: state.viewerDestroyed,
      });
    }
  })();

  const cameraSchedule = [
    { name: "overview", view: centerView(20_000) },
    { name: "near", view: centerView(1_000) },
    { name: "far", view: centerView(100_000) },
    { name: "rotate", view: centerView(1_000, 165) },
    {
      name: "other-area",
      view: {
        longitudeDegrees: AUTZEN_CENTER.longitudeDegrees + 0.002,
        latitudeDegrees: AUTZEN_CENTER.latitudeDegrees + 0.0015,
        heightMeters: 1_200,
        headingDegrees: 165,
        pitchDegrees: -35,
      },
    },
    { name: "revisit", view: centerView(1_000) },
  ] as const;
  const soakStartedAt = Date.now();
  let cycle = 0;
  while (Date.now() - soakStartedAt < soakDurationMs) {
    cycle += 1;
    for (const step of cameraSchedule) {
      if (Date.now() - soakStartedAt >= soakDurationMs) break;
      activePhase = `soak-${cycle}-${step.name}`;
      const before = await getState(page);
      const rangeObservationStart = pointRanges.length;
      const movedAt = Date.now();
      await setView(step.view);
      await expect
        .poll(async () => {
          const state = await getState(page);
          return (
            state.snapshot.streamingUpdateCount >
              before.snapshot.streamingUpdateCount ||
            state.snapshot.rangeRequests.requested >
              before.snapshot.rangeRequests.requested
          );
        }, {
          timeout: 120_000,
          message: `Camera step "${step.name}" should start streaming after movement`,
        })
        .toBe(true);

      if (step.name === "far") {
        const reverseStartedAt = Date.now();
        activePhase = `soak-${cycle}-rapid-reversal`;
        await setView(centerView(1_000));
        const reversed = await waitForIdle();
        transitions.push({
          cycle,
          step: "rapid-far-to-near-reversal",
          elapsedMs: Date.now() - soakStartedAt,
          reversalSettleMs: Date.now() - reverseStartedAt,
          networkRanges: pointRanges.length - rangeObservationStart,
          state: summarizeState(reversed),
        });
      } else {
        const settled = await waitForIdle();
        const transition = {
          cycle,
          step: step.name,
          elapsedMs: Date.now() - soakStartedAt,
          firstChangeMs: Date.now() - movedAt,
          camera: step.view,
          networkRanges: pointRanges.length - rangeObservationStart,
          networkRangeBytes: pointRanges
            .slice(rangeObservationStart)
            .reduce(
              (sum, observation) => sum + (observation.requestedBytes ?? 0),
              0,
            ),
          state: summarizeState(settled),
        };
        transitions.push(transition);
        if (step.name === "near" && cycle === 1) firstNearState = settled;
        if (step.name === "revisit") {
          const rangeObservations = pointRanges.slice(rangeObservationStart);
          cacheReuse.push({
            cycle,
            cacheHitsDuringRevisit:
              settled.snapshot.pointCache.hits - before.snapshot.pointCache.hits,
            cacheMissesDuringRevisit:
              settled.snapshot.pointCache.misses - before.snapshot.pointCache.misses,
            adapterRangeRequestsDuringRevisit:
              settled.snapshot.rangeRequests.requested -
              before.snapshot.rangeRequests.requested,
            networkRangesDuringRevisit: rangeObservations.length,
            networkRangeBytesDuringRevisit: rangeObservations.reduce(
              (sum, observation) => sum + (observation.requestedBytes ?? 0),
              0,
            ),
            hitsSinceFirstNear:
              settled.snapshot.pointCache.hits -
              firstNearState.snapshot.pointCache.hits,
          });
        }
      }
      const current = await getState(page);
      maxObservedCacheBytes = Math.max(
        maxObservedCacheBytes,
        current.snapshot.pointCache.currentCacheBytes,
      );
      expect(current.snapshot.renderedPointCount).toBeLessThanOrEqual(
        POINT_BUDGET,
      );
      expect(
        current.snapshot.performance.activeRenderedPointCount,
      ).toBeLessThanOrEqual(POINT_BUDGET);
      expect(current.snapshot.worker?.activeCount ?? 0).toBeLessThanOrEqual(
        current.snapshot.worker?.workerCount ?? 0,
      );
      expect(current.snapshot.rangeRequests.active).toBe(0);
      expect(current.snapshot.worker?.queuedCount ?? 0).toBe(0);
      if (step.name === "revisit") {
        activePhase = `soak-${cycle}-stationary`;
        await page.waitForTimeout(10_000);
        const stationary = await waitForIdle();
        transitions.push({
          cycle,
          step: "stationary-after-revisit",
          elapsedMs: Date.now() - soakStartedAt,
          state: summarizeState(stationary),
        });
        settledRetentionMeasurements.push({
          cycle,
          elapsedMs: Date.now() - soakStartedAt,
          heapUsedBytes: await readHeapUsedBytes(cdp),
          domCounters: await readDomCounters(cdp),
          decodedCacheBytes: stationary.snapshot.pointCache.currentCacheBytes,
          worker: stationary.snapshot.worker,
          activeRequests: stationary.snapshot.rangeRequests.active,
          queuedWorkers: stationary.snapshot.worker?.queuedCount ?? 0,
          scenePrimitiveCount: stationary.scenePrimitiveCount,
          pointCollectionCount: stationary.pointCollectionCount,
          canvasCount: stationary.canvasCount,
        });
      }
    }
  }
  const soakDurationActualMs = Date.now() - soakStartedAt;
  sampleLoopActive = false;
  await sampleLoop;
  const finalSoakState = await waitForIdle();
  transitions.push({
    cycle,
    step: "soak-final-settled",
    elapsedMs: soakDurationActualMs,
    state: summarizeState(finalSoakState),
  });

  const lifecycle: Array<Record<string, unknown>> = [];
  const lifecycleHeapMeasurements: Array<{
    cycle: number;
    heapUsedBytes?: number;
  }> = [];
  const workerCountsAfterDestroy: number[] = [];
  const workerScriptsAfterDestroy: string[][] = [];
  const copcWorkerScriptsAfterDestroy: string[][] = [];
  const attachedPointCount = initialState.snapshot.renderedPointCount;
  for (let repetition = 1; repetition <= LIFECYCLE_REPETITIONS; repetition += 1) {
    activePhase = `lifecycle-${repetition}`;
    await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.destroy());
    const destroyedLongRunLayer = await getState(page);
    expect(destroyedLongRunLayer.snapshot.lifecycle).toBe("destroyed");
    expect(destroyedLongRunLayer.viewerDestroyed).toBe(false);
    expect(destroyedLongRunLayer.scenePrimitiveCount).toBe(
      initialScenePrimitiveCount,
    );
    expect(destroyedLongRunLayer.cameraMoveEndListeners).toBe(
      initialCameraListeners.moveEnd,
    );
    expect(destroyedLongRunLayer.cameraChangedListeners).toBe(
      initialCameraListeners.changed,
    );
    await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.createLayer());
    await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.load());
    await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.attach());
    await setView(centerView(1_000));
    await expect
      .poll(async () => (await getState(page)).snapshot.renderedPointCount, {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    const attached = await waitForIdle();
    expect(attached.snapshot.renderedPointCount).toBeLessThanOrEqual(
      POINT_BUDGET,
    );

    await page.evaluate(() => {
      const state = window.__COPC_SOAK_FIXTURE__!;
      state.detach();
      state.detach();
    });
    const detached = await getState(page);
    expect(detached.snapshot.attached).toBe(false);
    expect(detached.snapshot.lifecycle).toBe("ready");
    expect(detached.metadataPointCount).toBe(10_653_336);
    expect(detached.snapshot.renderedPointCount).toBe(0);
    expect(detached.cameraMoveEndListeners).toBe(initialCameraListeners.moveEnd);
    expect(detached.cameraChangedListeners).toBe(initialCameraListeners.changed);

    await page.evaluate(() => {
      const state = window.__COPC_SOAK_FIXTURE__!;
      state.attach();
      state.setCameraView({
        longitudeDegrees: -123.0664124403113,
        latitudeDegrees: 44.056302478080184,
        heightMeters: 1_000,
        headingDegrees: 0,
        pitchDegrees: -35,
      });
    });
    await expect
      .poll(async () => (await getState(page)).snapshot.renderedPointCount, {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    await waitForIdle();

    await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.unload());
    const unloaded = await getState(page);
    expect(unloaded.snapshot.lifecycle).toBe("mounted");
    expect(unloaded.snapshot.attached).toBe(true);
    expect(unloaded.metadataPointCount).toBeUndefined();
    expect(unloaded.snapshot.renderedPointCount).toBe(0);

    await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.reload());
    await expect
      .poll(async () => (await getState(page)).snapshot.renderedPointCount, {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    const reloaded = await waitForIdle();
    expect(reloaded.snapshot.lifecycle).toBe("ready");
    expect(reloaded.snapshot.attached).toBe(true);
    expect(reloaded.viewerDestroyed).toBe(false);
    expect(reloaded.snapshot.renderedPointCount).toBeLessThanOrEqual(
      POINT_BUDGET,
    );

    await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.destroy());
    await cdp.send("HeapProfiler.collectGarbage");
    const destroyed = await getState(page);
    const workerTracker = await getWorkerTracker(page);
    const heapUsedBytes = await readHeapUsedBytes(cdp);
    const domCounters = await readDomCounters(cdp);
    const entry = {
      repetition,
      before: summarizeState(attached),
      detached: summarizeState(detached),
      unloaded: summarizeState(unloaded),
      reloaded: summarizeState(reloaded),
      destroyed: summarizeState(destroyed),
      heapUsedBytesAfterControlledGc: heapUsedBytes,
      domCounters,
      workerTracker,
      activeCopcWorkerScripts: workerTracker.activeScripts.filter((script) =>
        script.includes("rustCopcDecodeWorker"),
      ),
      resourceBaseline: {
        scenePrimitiveCount: initialScenePrimitiveCount,
        canvasCount: initialCanvasCount,
        cameraMoveEndListeners: initialCameraListeners.moveEnd,
        cameraChangedListeners: initialCameraListeners.changed,
        workerCount: initialWorkerBaseline.active,
      },
    };
    lifecycle.push(entry);
    lifecycleHeapMeasurements.push({ cycle: repetition, heapUsedBytes });
    workerCountsAfterDestroy.push(workerTracker.active);
    workerScriptsAfterDestroy.push(workerTracker.activeScripts);
    copcWorkerScriptsAfterDestroy.push(
      workerTracker.activeScripts.filter((script) =>
        script.includes("rustCopcDecodeWorker"),
      ),
    );
    expect(destroyed.snapshot.lifecycle).toBe("destroyed");
    expect(destroyed.snapshot.attached).toBe(false);
    expect(destroyed.snapshot.renderedPointCount).toBe(0);
    expect(destroyed.viewerDestroyed).toBe(false);
    expect(destroyed.scenePrimitiveCount).toBe(initialScenePrimitiveCount);
    expect(destroyed.pointCollectionCount).toBe(initialPointCollectionCount);
    expect(destroyed.canvasCount).toBe(initialCanvasCount);
    expect(destroyed.cameraMoveEndListeners).toBe(initialCameraListeners.moveEnd);
    expect(destroyed.cameraChangedListeners).toBe(initialCameraListeners.changed);
  }

  activePhase = "lifecycle-expected-request-failure";
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.createLayer());
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.load());
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.attach());
  const beforeInjectedFailure = await getState(page);
  failNextPointRange = true;
  await setView({
    longitudeDegrees: AUTZEN_CENTER.longitudeDegrees + 0.003,
    latitudeDegrees: AUTZEN_CENTER.latitudeDegrees + 0.002,
    heightMeters: 1_000,
    headingDegrees: 25,
    pitchDegrees: -35,
  });
  await expect
    .poll(async () => (await getState(page)).snapshot.rangeRequests.failed, {
      timeout: 60_000,
      message: "The injected point Range failure should reach the layer",
    })
    .toBeGreaterThan(beforeInjectedFailure.snapshot.rangeRequests.failed);
  const afterInjectedFailure = await waitForIdle(120_000, false);
  const injectedFailureObservation = pointRanges.find(
    (observation) => observation.expectedFailure,
  );
  expect(injectedFailureObservation?.status).toBe(503);
  await setView(centerView(1_000));
  await expect
    .poll(async () => (await getState(page)).snapshot.renderedPointCount, {
      timeout: 120_000,
      message: "The layer should recover and render after a failed Range read",
    })
    .toBeGreaterThan(0);
  const afterFailureRecovery = await waitForIdle();
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.destroy());

  activePhase = "lifecycle-unload-during-in-flight-range";
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.createLayer());
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.load());
  const beforeInFlightUnload = await getState(page);
  const heldRangeStart = heldPointRangeCount;
  holdNextPointRange = true;
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.attach());
  await setView(centerView(1_000));
  await expect
    .poll(() => heldPointRangeCount, {
      timeout: 60_000,
      message: "A point Range read should be held during the unload probe",
    })
    .toBeGreaterThan(heldRangeStart);
  const heldForUnload = await getState(page);
  expect(heldForUnload.snapshot.rangeRequests.active).toBeGreaterThan(0);
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.unload());
  heldRangeReleases.pop()?.();
  await expect
    .poll(async () => (await getState(page)).snapshot.rangeRequests.abortedLifecycle, {
      timeout: 30_000,
      message: "Unload should cancel the in-flight point Range read",
    })
    .toBeGreaterThan(beforeInFlightUnload.snapshot.rangeRequests.abortedLifecycle);
  const afterInFlightUnload = await waitForIdle();
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.reload());
  await expect
    .poll(async () => (await getState(page)).snapshot.renderedPointCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);
  await waitForIdle();

  activePhase = "lifecycle-destroy-during-in-flight-range";
  const beforeInFlightDestroy = await getState(page);
  const heldRangeBeforeDestroy = heldPointRangeCount;
  holdNextPointRange = true;
  await setView({
    longitudeDegrees: AUTZEN_CENTER.longitudeDegrees - 0.003,
    latitudeDegrees: AUTZEN_CENTER.latitudeDegrees + 0.0025,
    heightMeters: 1_200,
    headingDegrees: 205,
    pitchDegrees: -35,
  });
  await expect
    .poll(() => heldPointRangeCount, {
      timeout: 60_000,
      message: "A point Range read should be held during the destroy probe",
    })
    .toBeGreaterThan(heldRangeBeforeDestroy);
  const heldForDestroy = await getState(page);
  expect(heldForDestroy.snapshot.rangeRequests.active).toBeGreaterThan(0);
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.destroy());
  heldRangeReleases.pop()?.();
  await expect
    .poll(async () => (await getState(page)).snapshot.rangeRequests.abortedLifecycle, {
      timeout: 30_000,
      message: "Destroy should cancel the in-flight point Range read",
    })
    .toBeGreaterThan(beforeInFlightDestroy.snapshot.rangeRequests.abortedLifecycle);
  const afterInFlightDestroy = await getState(page);

  activePhase = "independent-low-cache-pressure";
  await page.evaluate((cacheBudgetBytes) => {
    window.__COPC_SOAK_FIXTURE__!.createLayer(cacheBudgetBytes);
  }, PRESSURE_CACHE_BUDGET_BYTES);
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.load());
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.attach());
  await setView(centerView(1_000));
  await expect
    .poll(async () => (await getState(page)).snapshot.renderedPointCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);
  const lowCacheNear = await waitForIdle();
  expect(lowCacheNear.snapshot.pointCache.cacheByteBudget).toBe(
    PRESSURE_CACHE_BUDGET_BYTES,
  );

  const lowCacheTransitions: Array<Record<string, unknown>> = [];
  for (const [name, view] of [
    ["far", centerView(100_000)],
    [
      "other-area",
      {
        longitudeDegrees: AUTZEN_CENTER.longitudeDegrees + 0.002,
        latitudeDegrees: AUTZEN_CENTER.latitudeDegrees + 0.0015,
        heightMeters: 1_200,
        headingDegrees: 165,
        pitchDegrees: -35,
      },
    ],
    ["revisit", centerView(1_000)],
  ] as const) {
    const before = await getState(page);
    const startedAt = Date.now();
    await setView(view);
    await expect
      .poll(async () => (await getState(page)).snapshot.streamingUpdateCount, {
        timeout: 120_000,
      })
      .toBeGreaterThan(before.snapshot.streamingUpdateCount);
    const settled = await waitForIdle();
    lowCacheTransitions.push({
      name,
      elapsedMs: Date.now() - startedAt,
      view,
      state: summarizeState(settled),
    });
  }
  const lowCacheFinal = await waitForIdle();
  expect(lowCacheFinal.snapshot.pointCache.evictionCount).toBeGreaterThan(0);
  expect(lowCacheFinal.snapshot.pointCache.bytesEvicted).toBeGreaterThan(0);
  expect(lowCacheFinal.snapshot.renderedPointCount).toBeLessThanOrEqual(
    POINT_BUDGET,
  );
  await page.evaluate(() => window.__COPC_SOAK_FIXTURE__!.destroy());
  const finalResources = await getState(page);
  const finalWorkerTracker = await getWorkerTracker(page);
  const totalElapsedMs = Date.now() - runStartedAt;
  const contentRangeMismatches = pointRanges.filter((observation) => {
    if (observation.expectedFailure || observation.expectedLifecycleAbort) {
      return false;
    }
    if (!observation.range || observation.status !== 206) return true;
    const requested = /^bytes=(\d+)-(\d+)$/.exec(observation.range);
    const returned = parseContentRange(observation.contentRange);
    const expectedObjectBytes = pointRanges
      .map((item) => parseContentRange(item.contentRange)?.total)
      .find((size): size is number => size !== undefined);
    return (
      !requested ||
      !returned ||
      returned.start !== Number(requested[1]) ||
      returned.end !== Number(requested[2]) ||
      (expectedObjectBytes !== undefined &&
        returned.total !== expectedObjectBytes)
    );
  });
  const firstLifecycleWorkerCount = workerCountsAfterDestroy[0] ?? 0;
  const copcWorkersReleasedEachCycle = copcWorkerScriptsAfterDestroy.every(
    (scripts) => scripts.length === 0,
  );
  const globalWorkerCountDidNotGrowAfterFirstCycle =
    workerCountsAfterDestroy.every(
      (count) => count <= firstLifecycleWorkerCount,
    );
  const responseStatusCounts: Record<string, number> = {};
  const intervalCounts = new Map<string, number>();
  const rangeByPhase = new Map<
    string,
    {
      requests: number;
      requestedBytes: number;
      responses206: number;
      failed: number;
      expectedFailures: number;
      expectedLifecycleAborts: number;
    }
  >();
  let received206Bytes = 0;
  for (const observation of pointRanges) {
    const status = String(observation.status ?? "no-response");
    responseStatusCounts[status] = (responseStatusCounts[status] ?? 0) + 1;
    const phase = rangeByPhase.get(observation.phase) ?? {
      requests: 0,
      requestedBytes: 0,
      responses206: 0,
      failed: 0,
      expectedFailures: 0,
      expectedLifecycleAborts: 0,
    };
    phase.requests += 1;
    phase.requestedBytes += observation.requestedBytes ?? 0;
    if (observation.status === 206) {
      phase.responses206 += 1;
      const returned = parseContentRange(observation.contentRange);
      if (returned) received206Bytes += returned.end - returned.start + 1;
    }
    if (observation.expectedFailure) phase.expectedFailures += 1;
    else if (observation.expectedLifecycleAbort) phase.expectedLifecycleAborts += 1;
    else if (observation.failed || (observation.status ?? 0) >= 400) {
      phase.failed += 1;
    }
    rangeByPhase.set(observation.phase, phase);
    if (observation.range) {
      intervalCounts.set(
        observation.range,
        (intervalCounts.get(observation.range) ?? 0) + 1,
      );
    }
  }
  const repeatedIntervals = [...intervalCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1]);
  const settledHeapPoints = settledRetentionMeasurements.flatMap((measurement) => {
    const elapsedMs = measurement.elapsedMs;
    const heapUsedBytes = measurement.heapUsedBytes;
    return typeof elapsedMs === "number" && typeof heapUsedBytes === "number"
      ? [{ x: elapsedMs / 60_000, y: heapUsedBytes }]
      : [];
  });
  const controlledGcLifecycleHeapPoints = lifecycleHeapMeasurements.flatMap(
    (measurement) =>
      typeof measurement.heapUsedBytes === "number"
        ? [{ x: measurement.cycle, y: measurement.heapUsedBytes }]
        : [],
  );
  const fullSoakWasRun = soakDurationActualMs >= 30 * 60_000;
  const unexpectedRangeFailures = pointRanges.filter(
    (observation) =>
      !observation.expectedFailure &&
      !observation.expectedLifecycleAbort &&
      (observation.failed !== undefined || (observation.status ?? 0) >= 400),
  );
  const result = !fullSoakWasRun
    ? "SMOKE ONLY"
    : contentRangeMismatches.length > 0 ||
        unexpectedRangeFailures.length > 0 ||
        !globalWorkerCountDidNotGrowAfterFirstCycle ||
        !copcWorkersReleasedEachCycle
      ? "FAIL"
      : "LIMITED";
  const summary = {
    issue: 302,
    result,
    measuredAt: new Date().toISOString(),
    gitSha,
    gitWorkingTreeDirty,
    runtime: {
      node: process.version,
      npm: npmVersion,
      packageVersion: process.env.npm_package_version ?? "unknown",
      platform: process.platform,
      architecture: process.arch,
      os: os.release(),
      cpuModel: os.cpus()[0]?.model,
      logicalCpuCount: os.cpus().length,
      playwrightBrowserVersion: browser.version(),
      ...versionInfo,
    },
    runScope: {
      validated: [
        "Cesium on the local same-origin Autzen dataset",
        "configured 250,000 point and 256 MiB decoded-cache budgets",
        "an independent 1 MiB decoded-cache eviction scenario",
        "a controlled 503 request failure followed by successful recovery",
        "unload and destroy while point Range requests are pending",
        "20 repeated Cesium layer lifecycle cycles",
      ],
      notCoveredByThisRun: [
        "bounded SoFi or equivalent larger-source validation",
        "Three.js lifecycle validation",
        "matched predictive-prefetch on/off comparison",
      ],
      overallIssueConclusion: "LIMITED until remaining acceptance evidence is reviewed",
    },
    dataset: {
      url: source,
      sourceId: "Autzen local same-origin COPC sample",
      localSameOrigin: source.startsWith("/"),
      metadataPointCount: initialState.metadataPointCount,
      maxRenderedPoints: POINT_BUDGET,
      pointCacheBudgetBytes: CACHE_BUDGET_BYTES,
      pointBudgetAndCacheBudgetConfigured: true,
      httpCacheDisabled: true,
      browserCacheAndDecodedCacheSeparated: true,
    },
    configuration: {
      backend: "rust",
      colorMode: "elevation",
      maxNodes: 32,
      maxDepth: 6,
      maxConcurrentNodeLoads:
        initialState.snapshot.performance.maxConcurrentNodeLoads,
      maxConcurrentRangeRequests: 4,
      workerCount: initialState.snapshot.worker?.workerCount,
      maxScreenSpaceError: 8,
      maxRenderDistanceMeters: 20_000,
      motionLookahead: true,
      predictivePrefetch: false,
      predictivePrefetchStatus: "NOT APPLICABLE: opt-in only; left disabled",
      randomSeed: null,
      cameraCenter: AUTZEN_CENTER,
      cameraSchedule,
      sampleIntervalMs,
      minimumDurationMs: soakDurationMs,
      actualDurationMs: soakDurationActualMs,
      firstUsefulPointsMs: initialUsefulPointsMs,
    },
    rangeTraffic: {
      requests: pointRanges.length,
      rangedRequests: pointRanges.filter((item) => item.range).length,
      responseStatusCounts,
      failed: pointRanges.filter(
        (item) => item.failed !== undefined || (item.status ?? 0) >= 400,
      ).length,
      expectedInjectedFailures: pointRanges.filter(
        (item) => item.expectedFailure,
      ).length,
      expectedLifecycleAborts: pointRanges.filter(
        (item) => item.expectedLifecycleAbort,
      ).length,
      unexpectedFailures: unexpectedRangeFailures.length,
      requestedRangeBytes: pointRanges.reduce(
        (sum, item) => sum + (item.requestedBytes ?? 0),
        0,
      ),
      received206Bytes,
      objectBytes: [
        ...new Set(
          pointRanges
            .map((item) => parseContentRange(item.contentRange)?.total)
            .filter((size): size is number => size !== undefined),
        ),
      ],
      repeatedIntervals: {
        uniqueIntervals: intervalCounts.size,
        intervalKindsRepeated: repeatedIntervals.length,
        repeatedRequestCount: repeatedIntervals.reduce(
          (sum, [, count]) => sum + count - 1,
          0,
        ),
        mostRepeated: repeatedIntervals.slice(0, 8).map(([range, count]) => ({
          range,
          count,
        })),
      },
      byPhase: Object.fromEntries(rangeByPhase),
      contentRangeMismatches: contentRangeMismatches.map((item) => ({
        phase: item.phase,
        range: item.range,
        status: item.status,
        contentRange: item.contentRange,
        failed: item.failed,
      })),
    },
    baseline: summarizeState(initialState),
    finalSoak: summarizeState(finalSoakState),
    cache: {
      maxSampledRetainedBytes: maxObservedCacheBytes,
      budgetBytes: CACHE_BUDGET_BYTES,
      samplesOverBudget: overBudgetCacheSamples,
      reuseChecks: cacheReuse,
      independentLowBudgetScenario: {
        budgetBytes: PRESSURE_CACHE_BUDGET_BYTES,
        near: summarizeState(lowCacheNear),
        transitions: lowCacheTransitions,
        final: summarizeState(lowCacheFinal),
        evictions: lowCacheFinal.snapshot.pointCache.evictionCount,
        bytesEvicted: lowCacheFinal.snapshot.pointCache.bytesEvicted,
        retainedBytes: lowCacheFinal.snapshot.pointCache.currentCacheBytes,
        protectedNodeExceptions:
          lowCacheFinal.snapshot.pointCache.currentCacheBytes >
          PRESSURE_CACHE_BUDGET_BYTES,
      },
    },
    memoryTrend: {
      settledUnforcedHeapBytesPerMinute: linearSlope(settledHeapPoints),
      settledHeapMeasurements: settledHeapPoints.length,
      controlledGcLifecycleHeapBytesPerCycle: linearSlope(
        controlledGcLifecycleHeapPoints,
      ),
      controlledGcLifecycleMeasurements: controlledGcLifecycleHeapPoints.length,
      interpretation:
        "CDP heap measurements are browser heap proxies; slopes summarize this run and are not leak proof or GPU memory measurements.",
    },
    samples,
    settledRetentionMeasurements,
    transitions,
    lifecycle: {
      repetitions: LIFECYCLE_REPETITIONS,
      cancellationProbes: {
        expectedRequestFailure: {
          responseStatus: injectedFailureObservation?.status,
          failedRangeCount: afterInjectedFailure.snapshot.rangeRequests.failed,
          afterFailure: summarizeState(afterInjectedFailure),
          afterRecovery: summarizeState(afterFailureRecovery),
        },
        unloadDuringInFlightRange: {
          heldRequestCount: heldPointRangeCount - heldRangeStart,
          before: summarizeState(heldForUnload),
          after: summarizeState(afterInFlightUnload),
        },
        destroyDuringInFlightRange: {
          heldRequestCount: heldPointRangeCount - heldRangeBeforeDestroy,
          before: summarizeState(heldForDestroy),
          after: summarizeState(afterInFlightDestroy),
        },
      },
      workerResourceTrend: {
        baselineActiveCount: initialWorkerBaseline.active,
        baselineActiveScripts: initialWorkerBaseline.activeScripts,
        totalCreated: finalWorkerTracker.created,
        totalTerminated: finalWorkerTracker.terminated,
        finalActiveCount: finalWorkerTracker.active,
        countsAfterDestroy: workerCountsAfterDestroy,
        finalActiveScripts: workerScriptsAfterDestroy.at(-1) ?? [],
        copcWorkersReleasedEachCycle,
        globalNoGrowthAfterFirstCycle:
          globalWorkerCountDidNotGrowAfterFirstCycle,
      },
      finalResourceState: summarizeState(finalResources),
      cycles: lifecycle,
    },
    interpretation: {
      decodedCacheBytes:
        "Project-owned typed-array bytes only; not total browser or GPU memory.",
      heap:
        "Chromium CDP JSHeapUsedSize; periodic samples are not forced-GC values; lifecycle values are collected after HeapProfiler.collectGarbage.",
      domListeners:
        "Chromium Memory.getDOMCounters when supported; JS event-listener counts include browser and Cesium internals, so they are reported as a trend rather than an ownership-specific count.",
      gpu:
        "Exact GPU memory unavailable. Cesium primitive, point collection, and canvas counts are resource proxies only.",
      frameTime:
        "One-second requestAnimationFrame samples per minute under headless Chromium SwiftShader; not an FPS guarantee.",
      workers:
        "COPC Rust decode workers are tracked by module URL and must terminate on destroy. Cesium terrain workers can remain with the caller-owned Viewer and are reported separately.",
    },
    playwrightTest: testInfo.title,
    totalElapsedMs,
  };

  const outputPath = path.resolve(
    process.env.COPC_SOAK_OUTPUT ??
      path.join(os.tmpdir(), "copc-adapter-validation", "copc-streaming-soak.json"),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`COPC streaming soak evidence written to ${outputPath}`);
  console.log(
    JSON.stringify(
      {
        issue: summary.issue,
        result: summary.result,
        gitSha: summary.gitSha,
        durationMs: summary.configuration.actualDurationMs,
        sampleCount: summary.samples.length,
        firstUsefulPointsMs: summary.configuration.firstUsefulPointsMs,
        rangeTraffic: summary.rangeTraffic,
        cache: summary.cache,
        finalSoak: summary.finalSoak,
        workerResourceTrend: summary.lifecycle.workerResourceTrend,
        lifecycleRepetitions: summary.lifecycle.repetitions,
        finalResources: summary.lifecycle.finalResourceState,
        outputPath,
      },
      null,
      2,
    ),
  );

  expect(soakDurationActualMs).toBeGreaterThanOrEqual(soakDurationMs);
  expect(initialState.snapshot.renderedPointCount).toBeLessThanOrEqual(
    POINT_BUDGET,
  );
  expect(finalSoakState.snapshot.renderedPointCount).toBeLessThanOrEqual(
    POINT_BUDGET,
  );
  expect(pointRanges.length).toBeGreaterThan(0);
  expect(contentRangeMismatches).toHaveLength(0);
  expect(finalResources.viewerDestroyed).toBe(false);
  expect(finalResources.scenePrimitiveCount).toBe(initialScenePrimitiveCount);
  expect(finalResources.cameraMoveEndListeners).toBe(
    initialCameraListeners.moveEnd,
  );
  expect(finalResources.cameraChangedListeners).toBe(
    initialCameraListeners.changed,
  );
  expect(globalWorkerCountDidNotGrowAfterFirstCycle).toBe(true);
  expect(attachedPointCount).toBeGreaterThan(0);
});

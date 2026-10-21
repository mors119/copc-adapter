import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { ThreeLifecycleState } from "./fixtures/three-lifecycle-fixture";

const LIFECYCLE_REPETITIONS = 20;
const POINT_BUDGET = 250_000;
const CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

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
    __COPC_THREE_WORKERS__?: WorkerTracker;
    __COPC_THREE_LIFECYCLE__?: {
      threeVersion: string;
      source: string;
      createLayer(): void;
      load(): Promise<void>;
      attach(): void;
      update(): Promise<void>;
      setCameraDistance(distance: number): void;
      detach(): void;
      unload(): void;
      reload(): Promise<void>;
      destroy(): void;
      getState(): ThreeLifecycleState;
      disposeViewer(): void;
    };
  }
}

async function getState(
  page: import("@playwright/test").Page,
): Promise<ThreeLifecycleState> {
  return page.evaluate(() => {
    if (!window.__COPC_THREE_LIFECYCLE__) {
      throw new Error("Three.js lifecycle fixture is unavailable");
    }
    return window.__COPC_THREE_LIFECYCLE__.getState();
  });
}

async function waitForIdle(
  page: import("@playwright/test").Page,
): Promise<ThreeLifecycleState> {
  let stableSamples = 0;
  let previous = await getState(page);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const current = await getState(page);
    const workersIdle =
      !current.snapshot.worker ||
      (current.snapshot.worker.activeCount === 0 &&
        current.snapshot.worker.queuedCount === 0);
    const selectionRendered = current.snapshot.selectedNodeKeys.every((key) =>
      current.snapshot.renderedNodeKeys.includes(key),
    );
    if (
      workersIdle &&
      selectionRendered &&
      current.snapshot.transition.activeReplacementGroupCount === 0 &&
      current.snapshot.streamingUpdateCount === previous.snapshot.streamingUpdateCount
    ) {
      stableSamples += 1;
      if (stableSamples >= 3) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }
  throw new Error(
    `Three.js streaming did not settle: ${JSON.stringify(previous.snapshot)}`,
  );
}

function summarize(state: ThreeLifecycleState): Record<string, unknown> {
  return {
    lifecycle: state.snapshot.lifecycle,
    attached: state.snapshot.attached,
    renderedPoints: state.snapshot.renderedPointCount,
    renderedNodeKeys: state.snapshot.renderedNodeKeys,
    selectedNodeKeys: state.snapshot.selectedNodeKeys,
    streamingUpdateCount: state.snapshot.streamingUpdateCount,
    pointCache: state.snapshot.pointCache,
    worker: state.snapshot.worker,
    hierarchy: state.hierarchy,
    sceneChildCount: state.sceneChildCount,
    pointObjectCount: state.pointObjectCount,
    rendererGeometryCount: state.rendererGeometryCount,
    rendererTextureCount: state.rendererTextureCount,
    uniqueMaterialCount: state.uniqueMaterialCount,
    canvasCount: state.canvasCount,
    contextLost: state.contextLost,
    layerRootAttached: state.layerRootAttached,
    maxConcurrentNodeLoads: state.maxConcurrentNodeLoads,
    errors: state.errors,
  };
}

test("records repeated Three.js layer lifecycle resource retention", async ({
  page,
  context,
  browser,
}, testInfo) => {
  test.skip(
    process.env.COPC_RUN_THREE_LIFECYCLE !== "1",
    "Opt-in repeated Three.js lifecycle validation; run npm run test:soak:three",
  );
  test.setTimeout(30 * 60_000);

  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    const active = new Map<Worker, string>();
    let created = 0;
    let terminated = 0;
    window.Worker = new Proxy(OriginalWorker, {
      construct(target, argumentsList, newTarget) {
        const worker = Reflect.construct(target, argumentsList, newTarget);
        const nativeTerminate = worker.terminate.bind(worker);
        let didTerminate = false;
        Object.defineProperty(worker, "terminate", {
          configurable: true,
          value() {
            if (!didTerminate) {
              didTerminate = true;
              active.delete(worker);
              terminated += 1;
            }
            return nativeTerminate();
          },
        });
        active.set(worker, String(argumentsList[0]));
        created += 1;
        return worker;
      },
    });
    window.__COPC_THREE_WORKERS__ = {
      snapshot: () => ({
        created,
        terminated,
        active: active.size,
        activeScripts: [...active.values()],
      }),
    };
  });

  const source = "/samples/autzen.copc.laz";
  const pointRanges: Array<{
    range?: string;
    contentRange?: string;
    status?: number;
    bytes?: number;
  }> = [];
  const observations = new Map<
    import("@playwright/test").Request,
    { range?: string; contentRange?: string; status?: number; bytes?: number }
  >();
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith(".copc.laz")) return;
    const range = request.headers().range;
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    const observation = {
      ...(range ? { range } : {}),
      ...(match
        ? { bytes: Number(match[2]) - Number(match[1]) + 1 }
        : {}),
    };
    observations.set(request, observation);
    pointRanges.push(observation);
  });
  page.on("response", (response) => {
    const observation = observations.get(response.request());
    if (observation) {
      observation.status = response.status();
      observation.contentRange = response.headers()["content-range"];
    }
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const npmVersion = execFileSync("npm", ["--version"], {
    encoding: "utf8",
  }).trim();

  await page.goto(
    `/e2e/fixtures/three-lifecycle-fixture.html?source=${encodeURIComponent(source)}`,
  );
  await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.createLayer());
  const initialExternalState = await getState(page);
  const initialExternalResources = {
    sceneChildCount: initialExternalState.sceneChildCount,
    canvasCount: initialExternalState.canvasCount,
    rendererGeometryCount: initialExternalState.rendererGeometryCount,
    rendererTextureCount: initialExternalState.rendererTextureCount,
  };
  await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.destroy());

  const cycles: Array<Record<string, unknown>> = [];
  let observedMaxConcurrentNodeLoads: number | undefined;
  const heapMeasurements: Array<{ cycle: number; bytes?: number }> = [];
  const workerCountsAfterDestroy: number[] = [];
  for (let repetition = 1; repetition <= LIFECYCLE_REPETITIONS; repetition += 1) {
    await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.createLayer());
    await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.load());
    await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.attach());
    await page.evaluate(async () => {
      const fixture = window.__COPC_THREE_LIFECYCLE__!;
      fixture.setCameraDistance(1_500);
      await fixture.update();
    });
    const attached = await waitForIdle(page);
    observedMaxConcurrentNodeLoads ??=
      attached.snapshot.performance.maxConcurrentNodeLoads;
    expect(attached.snapshot.renderedPointCount).toBeGreaterThan(0);
    expect(attached.snapshot.renderedPointCount).toBeLessThanOrEqual(
      POINT_BUDGET,
    );
    expect(attached.snapshot.pointCache.cacheByteBudget).toBe(
      CACHE_BUDGET_BYTES,
    );

    await page.evaluate(() => {
      const fixture = window.__COPC_THREE_LIFECYCLE__!;
      fixture.detach();
      fixture.detach();
    });
    const detached = await getState(page);
    expect(detached.snapshot.attached).toBe(false);
    expect(detached.snapshot.renderedPointCount).toBe(0);
    expect(detached.layerRootAttached).toBe(false);

    await page.evaluate(async () => {
      const fixture = window.__COPC_THREE_LIFECYCLE__!;
      fixture.attach();
      fixture.setCameraDistance(1_500);
      await fixture.update();
    });
    const reattached = await waitForIdle(page);
    expect(reattached.snapshot.renderedPointCount).toBeGreaterThan(0);

    await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.unload());
    const unloaded = await getState(page);
    expect(unloaded.snapshot.lifecycle).toBe("mounted");
    expect(unloaded.snapshot.attached).toBe(true);
    expect(unloaded.metadataPointCount).toBeUndefined();
    expect(unloaded.snapshot.renderedPointCount).toBe(0);

    await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.reload());
    const reloaded = await waitForIdle(page);
    expect(reloaded.snapshot.lifecycle).toBe("ready");
    expect(reloaded.snapshot.attached).toBe(true);
    expect(reloaded.snapshot.renderedPointCount).toBeGreaterThan(0);
    expect(reloaded.snapshot.renderedPointCount).toBeLessThanOrEqual(
      POINT_BUDGET,
    );

    await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.destroy());
    await cdp.send("HeapProfiler.collectGarbage");
    const destroyed = await getState(page);
    const workerTracker = await page.evaluate(() =>
      window.__COPC_THREE_WORKERS__!.snapshot(),
    );
    const { metrics } = await cdp.send("Performance.getMetrics");
    const heapUsedBytesAfterControlledGc = metrics.find(
      (metric: { name: string }) => metric.name === "JSHeapUsedSize",
    )?.value;
    await expect
      .poll(async () => (await getState(page)).rendererGeometryCount, {
        timeout: 10_000,
      })
      .toBe(initialExternalResources.rendererGeometryCount);

    expect(destroyed.snapshot.lifecycle).toBe("destroyed");
    expect(destroyed.snapshot.attached).toBe(false);
    expect(destroyed.snapshot.renderedPointCount).toBe(0);
    expect(destroyed.sceneChildCount).toBe(initialExternalResources.sceneChildCount);
    expect(destroyed.pointObjectCount).toBe(0);
    expect(destroyed.canvasCount).toBe(initialExternalResources.canvasCount);
    expect(destroyed.contextLost).toBe(false);
    expect(destroyed.layerRootAttached).toBe(false);
    expect(destroyed.errors).toEqual([]);

    cycles.push({
      repetition,
      attached: summarize(attached),
      detached: summarize(detached),
      reattached: summarize(reattached),
      unloaded: summarize(unloaded),
      reloaded: summarize(reloaded),
      destroyed: summarize(destroyed),
      heapUsedBytesAfterControlledGc,
      workerTracker,
      callerOwnedResources: initialExternalResources,
    });
    heapMeasurements.push({
      cycle: repetition,
      bytes: heapUsedBytesAfterControlledGc,
    });
    workerCountsAfterDestroy.push(workerTracker.active);
  }

  const finalState = await getState(page);
  const sourceSizeBytes = Math.max(
    0,
    ...pointRanges
      .map((item) => {
        const match = /^bytes \d+-\d+\/(\d+)$/.exec(item.contentRange ?? "");
        return match ? Number(match[1]) : 0;
      })
      .filter(Number.isFinite),
  );
  const successful206 = pointRanges.filter((item) => item.status === 206).length;
  const rangeStatusCounts = pointRanges.reduce<Record<string, number>>(
    (counts, item) => {
      const status = String(item.status ?? "no-response");
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const heapPoints = heapMeasurements.flatMap((measurement) =>
    typeof measurement.bytes === "number"
      ? [{ x: measurement.cycle, y: measurement.bytes }]
      : [],
  );
  const meanX =
    heapPoints.reduce((sum, point) => sum + point.x, 0) /
    Math.max(1, heapPoints.length);
  const meanY =
    heapPoints.reduce((sum, point) => sum + point.y, 0) /
    Math.max(1, heapPoints.length);
  const heapSlope =
    heapPoints.length < 2
      ? undefined
      : heapPoints.reduce(
            (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
            0,
          ) /
        heapPoints.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const summary = {
    conclusion: "Three.js lifecycle scope only; interpret alongside the Cesium soak evidence",
    measuredAt: new Date().toISOString(),
    gitSha,
    runtime: {
      node: process.version,
      npm: npmVersion,
      platform: process.platform,
      architecture: process.arch,
      os: os.release(),
      cpuModel: os.cpus()[0]?.model,
      browser: browser.version(),
      three: await page.evaluate(
        () => window.__COPC_THREE_LIFECYCLE__!.threeVersion,
      ),
    },
    source: {
      url: source,
      localSameOrigin: true,
      objectBytes: sourceSizeBytes,
      pointBudget: POINT_BUDGET,
      decodedCacheBudgetBytes: CACHE_BUDGET_BYTES,
      backend: "rust",
      maxConcurrentRangeRequests: 4,
      maxConcurrentNodeLoads: observedMaxConcurrentNodeLoads,
      browserHttpCacheDisabled: true,
    },
    lifecycleRepetitions: LIFECYCLE_REPETITIONS,
    rangeTraffic: {
      requests: pointRanges.length,
      statusCounts: rangeStatusCounts,
      successful206,
      requestedRangeBytes: pointRanges.reduce(
        (sum, item) => sum + (item.bytes ?? 0),
        0,
      ),
      sourceSizeBytes,
    },
    workerResourceTrend: {
      countsAfterDestroy: workerCountsAfterDestroy,
      maxActiveAfterDestroy: Math.max(0, ...workerCountsAfterDestroy),
      totalCreated: (await page.evaluate(() =>
        window.__COPC_THREE_WORKERS__!.snapshot(),
      )).created,
      totalTerminated: (await page.evaluate(() =>
        window.__COPC_THREE_WORKERS__!.snapshot(),
      )).terminated,
    },
    memoryTrend: {
      controlledGcHeapBytesPerCycle: heapSlope,
      measurementCount: heapPoints.length,
      interpretation:
        "Chromium JavaScript heap after controlled GC is a proxy and does not include GPU memory.",
    },
    externalResources: {
      initial: initialExternalResources,
      final: summarize(finalState),
      viewerRemainedAlive: !finalState.contextLost && finalState.canvasCount === 1,
    },
    cycles,
    playwrightTest: testInfo.title,
  };
  const outputPath = path.resolve(
    process.env.COPC_THREE_LIFECYCLE_OUTPUT ??
      path.join(
        os.tmpdir(),
        "copc-adapter-validation",
        "three-lifecycle-validation.json",
      ),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        conclusion: summary.conclusion,
        gitSha,
        sourceSizeBytes,
        lifecycleRepetitions: LIFECYCLE_REPETITIONS,
        rangeStatusCounts,
        maxActiveAfterDestroy: summary.workerResourceTrend.maxActiveAfterDestroy,
        controlledGcHeapBytesPerCycle: heapSlope,
        finalResources: summary.externalResources.final,
        outputPath,
      },
      null,
      2,
    ),
  );

  expect(successful206).toBeGreaterThan(0);
  expect(Object.keys(rangeStatusCounts).every((status) => status === "206")).toBe(
    true,
  );
  expect(workerCountsAfterDestroy.every((count) => count === 0)).toBe(true);
  expect(finalState.sceneChildCount).toBe(initialExternalResources.sceneChildCount);
  expect(finalState.pointObjectCount).toBe(0);
  expect(finalState.canvasCount).toBe(initialExternalResources.canvasCount);
  expect(finalState.contextLost).toBe(false);
  await page.evaluate(() => window.__COPC_THREE_LIFECYCLE__!.disposeViewer());
});

import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Vector3 = { x: number; y: number; z: number };

type DebugState = {
  layerLoaded: boolean;
  renderedPointCount: number;
  renderedNodeKeys: string[];
  selectedNodeKeys: string[];
  cameraMoveEventCount: number;
  transition: {
    activeReplacementGroupCount: number;
    replacementGroupsWaitingCount: number;
    refinementReplacementCommitCount: number;
    collapseReplacementCommitCount: number;
    staleReplacementCancellationCount: number;
    coarseNodesRetainedForCoverageCount: number;
  };
  streamingUpdateCount: number;
  cameraBasis: {
    position: Vector3;
    direction: Vector3;
    right: Vector3;
    up: Vector3;
  };
  cameraHeadingDegrees: number;
  cameraPitchDegrees: number;
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
  backend: string;
  performance: Record<string, unknown> & {
    configuredPointBudget: number;
    activeRenderedPointCount: number;
    candidateSelectedPointCount: number;
    deferredNodeCount: number;
    deferredPointCount: number;
    motionLookaheadEnabled: boolean;
    motionSampledMovementCount: number;
    motionPredictedHorizontalDisplacementDegrees: number;
    motionPredictedVerticalDisplacementDegrees: number;
    motionCandidateCount: number;
    motionWeightMax: number;
    motionInfluencedRefinementCount: number;
    motionLive: {
      enabled: boolean;
      acceptedMovementSampleCount: number;
      horizontalAngularVelocityDegreesPerSecond: number;
      verticalAngularVelocityDegreesPerSecond: number;
      predictedHorizontalDisplacementDegrees: number;
      predictedVerticalDisplacementDegrees: number;
      activity: number;
      millisecondsSinceLastAcceptedMovement?: number;
      state: "disabled" | "active" | "decaying" | "stationary";
    };
  };
  hierarchy?: {
    sourceOpenDurationMs: number;
    metadataLoadDurationMs: number;
    rootHierarchyLoadDurationMs: number;
    lastQueryDurationMs: number;
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

type DebugAdapter = {
  getState(): DebugState;
  setCameraHeight(height: number): void;
  setCameraPitch(pitchDegrees: number): void;
  setCameraHeading(headingDegrees: number): void;
};

type StartupProfile = {
  startAt: number;
  ranges: Array<{
    at: number;
    headersAt?: number;
    range: string;
    status?: number;
    bytes?: number;
    error?: string;
    receivedBytes?: number;
    completedAt?: number;
  }>;
  copcWasmAssets: Array<{
    startAt: number;
    headersAt?: number;
    completedAt?: number;
    bytes?: number;
  }>;
  copcWasmCompilations: Array<{ startAt: number; durationMs: number }>;
  copcWasmInstantiations: Array<{ startAt: number; durationMs: number }>;
  workerInitializations: Array<{ startAt: number; readyAt?: number }>;
  workerSamples: Array<{
    at: number;
    activeCount: number;
    workerCount: number;
  }>;
  longTaskSamples: Array<{ at: number; durationMs: number }>;
  longTaskObserver?: PerformanceObserver;
  longTaskObserverAvailable: boolean;
  rangeSamples: Array<{ at: number; activeCount: number }>;
  rangeBytesAtFirstDraw?: number;
  rangeBytesAtQuality?: number;
  gpuUploads: Array<{ at: number; durationMs: number; bytes: number }>;
  firstPointDrawAt?: number;
  firstPointFrameAt?: number;
  firstPointState?: DebugState;
  firstCollectionAt?: number;
  firstSelectionAt?: number;
  layerLoadedAt?: number;
  qualityAt?: number;
  qualityState?: DebugState;
  interactionStartedAt?: number;
  interactionStartCameraMoveCount?: number;
  interactionStartHeadingDegrees?: number;
  interactionStartPitchDegrees?: number;
  interactionResponseAt?: number;
  peakHeapBytes: number;
};

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function expectedScreenMovement(
  before: DebugState["cameraBasis"],
  after: DebugState["cameraBasis"],
): { horizontalDegrees: number; verticalDegrees: number } {
  const cosine = Math.max(
    -1,
    Math.min(1, dot(before.direction, after.direction)),
  );
  return {
    horizontalDegrees:
      (Math.atan2(-dot(before.direction, after.right), cosine) * 180) / Math.PI,
    verticalDegrees:
      (Math.atan2(-dot(before.direction, after.up), cosine) * 180) / Math.PI,
  };
}

function assertMotionFollowsViewingDirection(
  before: DebugState,
  after: DebugState,
): void {
  const expected = expectedScreenMovement(
    before.cameraBasis,
    after.cameraBasis,
  );
  const motion = after.performance.motionLive;
  expect(motion.activity).toBeGreaterThan(0);
  if (Math.abs(expected.horizontalDegrees) >= 0.05) {
    expect(Math.sign(motion.predictedHorizontalDisplacementDegrees)).toBe(
      Math.sign(expected.horizontalDegrees),
    );
  }
  if (Math.abs(expected.verticalDegrees) >= 0.05) {
    expect(Math.sign(motion.predictedVerticalDisplacementDegrees)).toBe(
      Math.sign(expected.verticalDegrees),
    );
  }
}

declare global {
  interface Window {
    __COPC_DEBUG__?: DebugAdapter;
    __COPC_STARTUP_PROFILE__?: StartupProfile;
  }
}

function installStartupInstrumentation(): void {
  const profile: StartupProfile = {
    startAt: performance.now(),
    ranges: [],
    copcWasmAssets: [],
    copcWasmCompilations: [],
    copcWasmInstantiations: [],
    workerInitializations: [],
    workerSamples: [],
    longTaskSamples: [],
    longTaskObserverAvailable: false,
    rangeSamples: [],
    gpuUploads: [],
    peakHeapBytes: 0,
  };
  window.__COPC_STARTUP_PROFILE__ = profile;
  if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        profile.longTaskSamples.push({
          at: entry.startTime,
          durationMs: entry.duration,
        });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    profile.longTaskObserver = observer;
    profile.longTaskObserverAvailable = true;
  }
  window.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (
        profile.interactionStartedAt === undefined &&
        target instanceof Element &&
        target.closest("#cesium-container canvas")
      ) {
        profile.interactionStartedAt = performance.now();
        const camera = window.__COPC_DEBUG__?.getState();
        profile.interactionStartCameraMoveCount =
          camera?.cameraMoveEventCount ?? 0;
        profile.interactionStartHeadingDegrees =
          camera?.cameraHeadingDegrees ?? 0;
        profile.interactionStartPitchDegrees = camera?.cameraPitchDegrees ?? 0;
      }
    },
    true,
  );

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const isCopcWasm = url.includes("copc_adapter_wasm");
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const range = headers.get("Range");
    const request =
      range && url.includes("copc.laz")
        ? { at: performance.now(), range }
        : undefined;
    if (request) profile.ranges.push(request);

    const copcWasmStartedAt = performance.now();
    const copcWasmAsset = isCopcWasm
      ? { startAt: copcWasmStartedAt }
      : undefined;
    if (copcWasmAsset) profile.copcWasmAssets.push(copcWasmAsset);
    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (error: unknown) {
      if (request) {
        request.completedAt = performance.now();
        request.error = error instanceof Error ? error.name : String(error);
      }
      throw error;
    }
    if (isCopcWasm) {
      if (copcWasmAsset) {
        copcWasmAsset.headersAt = performance.now();
        copcWasmAsset.bytes = Number(
          response.headers.get("Content-Length") ?? 0,
        );
      }
      const readArrayBuffer = response.arrayBuffer.bind(response);
      response.arrayBuffer = async () => {
        const buffer = await readArrayBuffer();
        if (copcWasmAsset) {
          copcWasmAsset.completedAt = performance.now();
          copcWasmAsset.bytes = buffer.byteLength;
        }
        return buffer;
      };
    }
    if (request) {
      request.headersAt = performance.now();
      request.status = response.status;
      request.bytes = Number(response.headers.get("Content-Length") ?? 0);
      if (response.body) {
        const body = response.body;
        const getReader = body.getReader.bind(body);
        body.getReader = (...args) => {
          const reader = getReader(...args);
          const read = reader.read.bind(reader);
          reader.read = async () => {
            const chunk = await read();
            if (chunk.done) {
              request.completedAt = performance.now();
            } else {
              request.receivedBytes =
                (request.receivedBytes ?? 0) + chunk.value.byteLength;
            }
            return chunk;
          };
          return reader;
        };
      }
    }
    return response;
  };

  const moduleByteLength = (source: unknown): number | undefined => {
    if (source instanceof ArrayBuffer) return source.byteLength;
    if (ArrayBuffer.isView(source)) return source.byteLength;
    return undefined;
  };
  const isCopcWasmBinary = (source: unknown): boolean => {
    const byteLength = moduleByteLength(source);
    return (
      byteLength !== undefined &&
      profile.copcWasmAssets.some((asset) => asset.bytes === byteLength)
    );
  };
  const copcWasmModules = new WeakSet<WebAssembly.Module>();
  const originalCompile = WebAssembly.compile;
  WebAssembly.compile = new Proxy(originalCompile, {
    apply(target, thisArg, args) {
      const isCopcWasm = isCopcWasmBinary(args[0]);
      const startedAt = performance.now();
      const result = Reflect.apply(target, thisArg, args) as Promise<WebAssembly.Module>;
      if (isCopcWasm) {
        return result.then((module) => {
          copcWasmModules.add(module);
          profile.copcWasmCompilations.push({
            startAt: startedAt,
            durationMs: performance.now() - startedAt,
          });
          return module;
        });
      }
      return result;
    },
  });

  const originalInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = new Proxy(originalInstantiate, {
    apply(target, thisArg, args) {
      const source = args[0];
      const isCopcWasm =
        (source instanceof WebAssembly.Module && copcWasmModules.has(source)) ||
        isCopcWasmBinary(source);
      const startedAt = performance.now();
      const result = Reflect.apply(target, thisArg, args) as Promise<
        WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance
      >;
      if (isCopcWasm) {
        return result.then((instance) => {
          profile.copcWasmInstantiations.push({
            startAt: startedAt,
            durationMs: performance.now() - startedAt,
          });
          return instance;
        });
      }
      return result;
    },
  });

  const workerInitializationByInstance = new WeakMap<
    Worker,
    StartupProfile["workerInitializations"][number]
  >();
  const OriginalWorker = window.Worker;
  window.Worker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget) as Worker;
      let messageHandler: Worker["onmessage"];
      return new Proxy(worker, {
        get(targetWorker, property) {
          if (property === "postMessage") {
            return (message: unknown, transfer?: Transferable[]) => {
              if (
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "init"
              ) {
                const initialization = { startAt: performance.now() };
                workerInitializationByInstance.set(
                  targetWorker,
                  initialization,
                );
                profile.workerInitializations.push(initialization);
              }
              return targetWorker.postMessage(message, transfer ?? []);
            };
          }
          if (property === "onmessage") return messageHandler;
          const value = Reflect.get(targetWorker, property, targetWorker);
          return typeof value === "function" ? value.bind(targetWorker) : value;
        },
        set(targetWorker, property, value) {
          if (property === "onmessage") {
            const handler = value as Worker["onmessage"];
            messageHandler = (event) => {
              if (event.data?.type === "ready") {
                const initialization =
                  workerInitializationByInstance.get(targetWorker);
                if (initialization && initialization.readyAt === undefined) {
                  initialization.readyAt = performance.now();
                }
              }
              handler?.call(targetWorker, event);
            };
            return Reflect.set(
              targetWorker,
              property,
              messageHandler,
              targetWorker,
            );
          }
          return Reflect.set(targetWorker, property, value, targetWorker);
        },
      });
    },
  });

  const glPrototypes = [
    globalThis.WebGLRenderingContext?.prototype,
    globalThis.WebGL2RenderingContext?.prototype,
  ].filter((value): value is object => value !== undefined);
  for (const prototype of glPrototypes) {
    for (const method of ["bufferData", "bufferSubData"] as const) {
      const original = Reflect.get(prototype, method);
      if (typeof original !== "function") continue;
      Reflect.set(
        prototype,
        method,
        function (this: WebGLRenderingContext, ...args: unknown[]) {
          const startedAt = performance.now();
          const source = args[method === "bufferSubData" ? 2 : 1];
          const bytes =
            typeof source === "number"
              ? source
              : source && typeof source === "object" && "byteLength" in source
                ? Number(source.byteLength)
                : 0;
          const result = Reflect.apply(original, this, args);
          profile.gpuUploads.push({
            at: startedAt,
            durationMs: performance.now() - startedAt,
            bytes,
          });
          return result;
        },
      );
    }

    for (const method of [
      "drawArrays",
      "drawElements",
      "drawArraysInstanced",
      "drawElementsInstanced",
    ] as const) {
      const original = Reflect.get(prototype, method);
      if (typeof original !== "function") continue;
      Reflect.set(
        prototype,
        method,
        function (this: WebGLRenderingContext, ...args: unknown[]) {
          const result = Reflect.apply(original, this, args);
          if (
            profile.firstPointDrawAt === undefined &&
            args[0] === this.POINTS
          ) {
            const state = window.__COPC_DEBUG__?.getState();
            if (state && state.renderedPointCount > 0) {
              profile.firstPointDrawAt = performance.now();
              profile.firstPointState = state;
              profile.rangeBytesAtFirstDraw = profile.ranges
                .filter((range) => range.at <= profile.firstPointDrawAt!)
                .reduce((sum, range) => sum + (range.receivedBytes ?? 0), 0);
              requestAnimationFrame((frameAt) => {
                profile.firstPointFrameAt = frameAt;
              });
            }
          }
          return result;
        },
      );
    }
  }

  let previousStateKey = "";
  let stableQualitySamples = 0;
  const sample = (): void => {
    const now = performance.now();
    try {
      const state = window.__COPC_DEBUG__?.getState();
      if (state) {
        if (state.layerLoaded && profile.layerLoadedAt === undefined) {
          profile.layerLoadedAt = now;
        }
        if (
          state.selectedNodeKeys.length > 0 &&
          profile.firstSelectionAt === undefined
        ) {
          profile.firstSelectionAt = now;
        }
        if (state.renderedPointCount > 0 && profile.firstCollectionAt === undefined) {
          profile.firstCollectionAt = now;
        }
        if (state.worker) {
          profile.workerSamples.push({
            at: now,
            activeCount: state.worker.activeCount,
            workerCount: state.worker.workerCount,
          });
        }
        profile.rangeSamples.push({
          at: now,
          activeCount: profile.ranges.filter(
            (range) => range.at <= now && range.completedAt === undefined,
          ).length,
        });
        if (
          profile.interactionStartedAt !== undefined &&
          profile.interactionResponseAt === undefined &&
          ((profile.interactionStartCameraMoveCount !== undefined &&
            state.cameraMoveEventCount > profile.interactionStartCameraMoveCount) ||
            (profile.interactionStartHeadingDegrees !== undefined &&
              Math.abs(
                state.cameraHeadingDegrees -
                  profile.interactionStartHeadingDegrees,
              ) > 0.05) ||
            (profile.interactionStartPitchDegrees !== undefined &&
              Math.abs(
                state.cameraPitchDegrees -
                  profile.interactionStartPitchDegrees,
              ) > 0.05))
        ) {
          profile.interactionResponseAt = now;
        }
        const selectedNodesCommitted =
          state.selectedNodeKeys.length > 0 &&
          state.selectedNodeKeys.every((key) =>
            state.renderedNodeKeys.includes(key),
          );
        const idle =
          selectedNodesCommitted &&
          state.performance.activeNodeCount === 0 &&
          state.rangeRequests.active === 0 &&
          (!state.worker ||
            (state.worker.activeCount === 0 && state.worker.queuedCount === 0)) &&
          state.transition.activeReplacementGroupCount === 0 &&
          Number(state.performance.updateDurationMs) > 0;
        const stateKey = `${state.streamingUpdateCount}:${state.renderedPointCount}:${state.renderedNodeKeys.join(",")}`;
        if (profile.interactionResponseAt === undefined) {
          stableQualitySamples = 0;
          previousStateKey = "";
        } else {
          stableQualitySamples =
            idle && stateKey === previousStateKey
              ? stableQualitySamples + 1
              : 0;
          previousStateKey = stateKey;
          if (stableQualitySamples >= 12 && profile.qualityAt === undefined) {
            profile.qualityAt = now;
            profile.qualityState = state;
            profile.rangeBytesAtQuality = profile.ranges
              .filter((range) => range.at <= now)
              .reduce((sum, range) => sum + (range.receivedBytes ?? 0), 0);
          }
        }
      }
      if (performance.memory) {
        profile.peakHeapBytes = Math.max(
          profile.peakHeapBytes,
          performance.memory.usedJSHeapSize,
        );
      }
    } catch {
      // Optional browser diagnostics must not affect source loading.
    }
    setTimeout(sample, 25);
  };
  setTimeout(sample, 0);
}

async function getState(
  page: import("@playwright/test").Page,
): Promise<DebugState> {
  return page.evaluate(() => {
    if (!window.__COPC_DEBUG__)
      throw new Error("COPC debug adapter is unavailable");
    return window.__COPC_DEBUG__.getState();
  });
}

async function waitForViewChange(
  page: import("@playwright/test").Page,
  previous: DebugState,
): Promise<void> {
  const previousNodeKeys = [...previous.selectedNodeKeys].sort().join("\0");
  await expect
    .poll(
      async () => {
        const current = await getState(page);
        return (
          current.streamingUpdateCount > previous.streamingUpdateCount ||
          [...current.selectedNodeKeys].sort().join("\0") !== previousNodeKeys
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);
}

async function loadScenario(
  page: import("@playwright/test").Page,
  query: string,
): Promise<void> {
  const source = process.env.COPC_VALIDATION_SOURCE;
  const sourceQuery = source ? `&source=${encodeURIComponent(source)}` : "";
  await page.goto(
    `/?scenario=issue68&backend=rust&debugPanel=false${sourceQuery}&${query}`,
  );
  await expect
    .poll(() => getState(page), { timeout: 120_000 })
    .toMatchObject({
      layerLoaded: true,
      backend: "rust",
    });
  await expect
    .poll(async () => (await getState(page)).renderedPointCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);
}

async function waitForIdle(
  page: import("@playwright/test").Page,
): Promise<DebugState> {
  let stableSamples = 0;
  let previous = await getState(page);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(150);
    const current = await getState(page);
    const workerIdle =
      !current.worker ||
      (current.worker.activeCount === 0 && current.worker.queuedCount === 0);
    if (
      workerIdle &&
      current.rangeRequests.active === 0 &&
      current.transition.activeReplacementGroupCount === 0 &&
      current.streamingUpdateCount === previous.streamingUpdateCount
    ) {
      stableSamples += 1;
      if (stableSamples >= 2) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }

  return previous;
}

async function sampleFrames(
  page: import("@playwright/test").Page,
  durationMs = 1200,
): Promise<{
  frameCount: number;
  intervalsMs: number[];
  medianFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
}> {
  const intervals = await page.evaluate(async (duration) => {
    const values: number[] = [];
    let previous: number | undefined;
    const end = performance.now() + duration;
    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        if (previous !== undefined) values.push(now - previous);
        previous = now;
        if (now >= end) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return values;
  }, durationMs);
  const sorted = [...intervals].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianFrameMs =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : sorted[middle] ?? 0;
  return {
    frameCount: intervals.length,
    intervalsMs: intervals,
    medianFrameMs,
    p95FrameMs:
      sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    maxFrameMs: sorted.at(-1) ?? 0,
  };
}

function summarize(state: DebugState): Record<string, unknown> {
  return {
    renderedPointCount: state.renderedPointCount,
    selectedNodeKeys: state.selectedNodeKeys,
    selectedNodeCount: state.selectedNodeKeys.length,
    streamingUpdateCount: state.streamingUpdateCount,
    viewDistance: state.viewDistance,
    transition: state.transition,
    performance: state.performance,
    pointCache: state.pointCache,
    rangeRequests: state.rangeRequests,
    worker: state.worker,
    longestMainThreadTaskMs: state.longestMainThreadTaskMs,
    cesiumFrameDurationMs: state.cesiumFrameDurationMs,
    lastError: state.lastError,
  };
}

test.describe.configure({ mode: "serial" });

function numericMetric(
  metrics: Record<string, unknown>,
  name: string,
): number {
  const value = metrics[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function summarizeMeasurements(
  measurements: Record<string, number>[],
): Record<string, { median: number; p95: number }> {
  const names = Object.keys(measurements[0] ?? {});
  return Object.fromEntries(
    names.map((name) => {
      const sorted = measurements
        .map((measurement) => measurement[name] ?? 0)
        .sort((left, right) => left - right);
      return [
        name,
        {
          median: sorted[Math.floor(sorted.length / 2)] ?? 0,
          // With five samples, nearest-rank p95 is the maximum observed value.
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
        },
      ];
    }),
  );
}

test("records first-visible startup latency on Autzen", async ({ browser }) => {
  test.skip(
    process.env.COPC_FIRST_VISIBLE_BENCHMARK !== "1",
    "Run explicitly with COPC_FIRST_VISIBLE_BENCHMARK=1",
  );
  test.setTimeout(600_000);

  const repetitions = 5;
  const browserCdp = await browser.newBrowserCDPSession();
  const baseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_TEST_PORT ?? "4173"}`;
  const runOne = async (
    context: import("@playwright/test").BrowserContext,
  ): Promise<Record<string, unknown>> => {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let peakChromiumProcessRssBytes = 0;
    let memorySampleInFlight = false;
    const sampleChromiumProcessRss = async (): Promise<void> => {
      if (memorySampleInFlight) return;
      memorySampleInFlight = true;
      try {
        const { processInfo } = await browserCdp.send(
          "SystemInfo.getProcessInfo",
        );
        const processIds = processInfo.map((process) => process.id);
        if (processIds.length === 0) return;
        const { stdout } = await execFileAsync("ps", [
          "-o",
          "rss=",
          "-p",
          processIds.join(","),
        ]);
        const residentBytes = stdout
          .trim()
          .split(/\s+/u)
          .map(Number)
          .filter(Number.isFinite)
          .reduce((sum, kilobytes) => sum + kilobytes * 1024, 0);
        peakChromiumProcessRssBytes = Math.max(
          peakChromiumProcessRssBytes,
          residentBytes,
        );
      } catch {
        // Process RSS is supplemental; keep the browser run if the host does not expose ps.
      } finally {
        memorySampleInFlight = false;
      }
    };
    await sampleChromiumProcessRss();
    const memorySampler = setInterval(
      () => void sampleChromiumProcessRss(),
      250,
    );
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: (50 * 1024 * 1024) / 8,
      uploadThroughput: (10 * 1024 * 1024) / 8,
    });
    await page.addInitScript(installStartupInstrumentation);
    await page.goto(
      `${baseUrl}/?backend=rust&cameraPreset=overview&debugPanel=false`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(
      () => window.__COPC_STARTUP_PROFILE__?.firstPointFrameAt !== undefined,
      undefined,
      { timeout: 60_000 },
    );

    const beforeInteraction = await getState(page);
    const canvas = page.locator("#cesium-container canvas").first();
    const bounds = await canvas.boundingBox();
    expect(bounds, "Cesium canvas must be available for the camera check").not.toBeNull();
    const x = (bounds?.x ?? 0) + (bounds?.width ?? 0) * 0.62;
    const y = (bounds?.y ?? 0) + (bounds?.height ?? 0) * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 35, y + 12);
    await page.mouse.up();
    await page.waitForFunction(
      (previous) => {
        const current = window.__COPC_DEBUG__?.getState();
        return (
          current !== undefined &&
          (current.cameraMoveEventCount > previous.cameraMoveEventCount ||
            Math.abs(current.cameraHeadingDegrees - previous.cameraHeadingDegrees) >
              0.05 ||
            Math.abs(current.cameraPitchDegrees - previous.cameraPitchDegrees) >
              0.05)
        );
      },
      {
        cameraMoveEventCount: beforeInteraction.cameraMoveEventCount,
        cameraHeadingDegrees: beforeInteraction.cameraHeadingDegrees,
        cameraPitchDegrees: beforeInteraction.cameraPitchDegrees,
      },
      { timeout: 5_000 },
    );
    await page.waitForFunction(
      () => window.__COPC_STARTUP_PROFILE__?.interactionResponseAt !== undefined,
      undefined,
      { timeout: 5_000 },
    );
    await page.waitForFunction(
      () => window.__COPC_STARTUP_PROFILE__?.qualityAt !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    const qualityFollowedCameraResponse = await page.evaluate(() => {
      const profile = window.__COPC_STARTUP_PROFILE__;
      return (
        profile?.interactionResponseAt !== undefined &&
        profile.qualityAt !== undefined &&
        profile.qualityAt >= profile.interactionResponseAt
      );
    });
    expect(
      qualityFollowedCameraResponse,
      "target quality must settle after the camera responds to the gesture",
    ).toBe(true);

    const result = await page.evaluate(() => {
      const profile = window.__COPC_STARTUP_PROFILE__;
      const debug = window.__COPC_DEBUG__;
      if (!profile || !debug) throw new Error("Startup diagnostics are unavailable");
      const state = debug.getState();
      const firstPointState = profile.firstPointState;
      const qualityState = profile.qualityState;
      const firstRangeAt = profile.ranges[0]?.at;
      const firstPointDrawAt = profile.firstPointDrawAt;
      const firstPointFrameAt = profile.firstPointFrameAt;
      const qualityAt = profile.qualityAt;
      const wasmCompileStartAt = profile.copcWasmCompilations[0]?.startAt;
      const copcWasmAsset = profile.copcWasmAssets
        .filter(
          (asset) =>
            asset.completedAt !== undefined &&
            asset.completedAt <= (wasmCompileStartAt ?? firstPointDrawAt ?? 0),
        )
        .sort((left, right) => left.startAt - right.startAt)
        .at(-1);
      if (
        firstRangeAt === undefined ||
        firstPointDrawAt === undefined ||
        firstPointFrameAt === undefined ||
        qualityAt === undefined ||
        !firstPointState ||
        !qualityState
      ) {
        throw new Error("Startup measurement did not complete");
      }

      const workerSamples = profile.workerSamples.filter(
        (sample) => sample.at >= firstRangeAt && sample.at <= qualityAt,
      );
      const longTaskDurationsMs = profile.longTaskSamples
        .filter((sample) => sample.at >= firstRangeAt && sample.at <= qualityAt)
        .map((sample) => sample.durationMs)
        .sort((left, right) => left - right);
      const percentile = (values: number[], fraction: number): number =>
        values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
      const workerUtilizationPercent =
        workerSamples.length === 0
          ? 0
          : (workerSamples.reduce(
              (sum, sample) =>
                sum + sample.activeCount / Math.max(1, sample.workerCount),
              0,
            ) /
              workerSamples.length) *
            100;
      const rangeRowsToQuality = profile.ranges.filter(
        (range) => range.headersAt !== undefined && range.headersAt <= qualityAt,
      );
      const headerVlrRanges = profile.ranges.filter((range) => {
        const match = /^bytes=(\d+)-(\d+)$/u.exec(range.range);
        return (
          match !== null &&
          Number(match[1]) < 64 * 1024 &&
          Number(match[2]) < 64 * 1024
        );
      });
      const completedHeaderVlrRanges = headerVlrRanges.filter(
        (range) => range.completedAt !== undefined,
      );
      const workerInitializationMs = profile.workerInitializations
        .filter((worker) => worker.readyAt !== undefined)
        .map((worker) => worker.readyAt! - worker.startAt);
      const pointPerformance = firstPointState.performance;
      const pointHierarchy = firstPointState.hierarchy;
      const number = (metrics: Record<string, unknown>, key: string): number => {
        const value = metrics[key];
        return typeof value === "number" ? value : 0;
      };
      const renderedContext = document.querySelector(
        "#cesium-container canvas",
      ) as HTMLCanvasElement | null;
      const gl = renderedContext?.getContext("webgl2") ??
        renderedContext?.getContext("webgl");
      const rendererInfo = gl?.getExtension("WEBGL_debug_renderer_info");

      return {
        firstRangeAt,
        pageToFirstRangeMs: firstRangeAt - profile.startAt,
        pageToFirstPointDrawMs: firstPointDrawAt - profile.startAt,
        headerVlrRangeRequestCount: headerVlrRanges.length,
        headerVlrRangeBytes: headerVlrRanges.reduce(
          (sum, range) => sum + (range.receivedBytes ?? 0),
          0,
        ),
        headerVlrAcquisitionMs:
          completedHeaderVlrRanges.length === 0
            ? 0
            : Math.max(
                ...completedHeaderVlrRanges.map(
                  (range) => range.completedAt! - firstRangeAt,
                ),
              ),
        firstSelectionMs:
          profile.firstSelectionAt === undefined
            ? 0
            : profile.firstSelectionAt - firstRangeAt,
        metadataAndRootReadyMs:
          profile.layerLoadedAt === undefined
            ? 0
            : profile.layerLoadedAt - firstRangeAt,
        firstPointCollectionMs:
          profile.firstCollectionAt === undefined
            ? 0
            : profile.firstCollectionAt - firstRangeAt,
        firstPointDrawMs: firstPointDrawAt - firstRangeAt,
        firstPointFrameMs: firstPointFrameAt - firstRangeAt,
        cameraUsableMs:
          profile.interactionResponseAt === undefined
            ? 0
            : profile.interactionResponseAt - firstRangeAt,
        cameraInputResponseMs:
          profile.interactionStartedAt === undefined ||
          profile.interactionResponseAt === undefined
            ? 0
            : profile.interactionResponseAt - profile.interactionStartedAt,
        targetQualityMs: qualityAt - firstRangeAt,
        longTaskObserverAvailable: profile.longTaskObserverAvailable,
        mainThreadLongTaskDurationsMs: longTaskDurationsMs,
        mainThreadLongTaskCount: longTaskDurationsMs.length,
        mainThreadLongTaskP50Ms: percentile(longTaskDurationsMs, 0.5),
        mainThreadLongTaskP95Ms: percentile(longTaskDurationsMs, 0.95),
        mainThreadLongTaskMaxMs: longTaskDurationsMs.at(-1) ?? 0,
        firstPointCount: firstPointState.renderedPointCount,
        targetPointCount: qualityState.renderedPointCount,
        selectedNodeCount: qualityState.selectedNodeKeys.length,
        rangeBytesAtFirstPoint: number(
          pointPerformance,
          "rangeFetchBytes",
        ),
        rangeBytesToFirstPoint: profile.rangeBytesAtFirstDraw ?? 0,
        rangeBytesToTargetQuality: profile.rangeBytesAtQuality ?? 0,
        rangeRequestCountToTargetQuality: rangeRowsToQuality.length,
        stages: {
          sourceOpenMs: pointHierarchy?.sourceOpenDurationMs ?? 0,
          metadataLoadMs: pointHierarchy?.metadataLoadDurationMs ?? 0,
          rootHierarchyLoadMs: pointHierarchy?.rootHierarchyLoadDurationMs ?? 0,
          firstHierarchyQueryMs: pointHierarchy?.lastQueryDurationMs ?? 0,
          nodeSelectionMs: number(pointPerformance, "nodeSelectionMs"),
          firstPrioritySelectionToDrawMs:
            profile.firstSelectionAt === undefined
              ? 0
              : firstPointDrawAt - profile.firstSelectionAt,
          firstPriorityNodeStartMs: number(
            pointPerformance,
            "firstHighPriorityNodeStartLatencyMs",
          ),
          firstPriorityNodeReadyMs: number(
            pointPerformance,
            "firstHighPriorityNodeReadyLatencyMs",
          ),
          rangeFetchCumulativeMs: number(
            pointPerformance,
            "rangeFetchDurationMs",
          ),
          lazDecodeMs: number(pointPerformance, "decodeDurationMs"),
          rustPointPreparationMs: number(
            pointPerformance,
            "pointPreparationDurationMs",
          ),
          crsTransformMs: number(pointPerformance, "crsTransformDurationMs"),
          geographicToCartesianMs: number(
            pointPerformance,
            "geographicToCartesianDurationMs",
          ),
          worldToCartesianMs: number(
            pointPerformance,
            "worldToCartesianDurationMs",
          ),
          pointStyleMs: number(
            pointPerformance,
            "pointStylePreparationDurationMs",
          ),
          pointCollectionCreationMs: number(
            pointPerformance,
            "pointCollectionCreationDurationMs",
          ),
          pointAddMs: number(pointPerformance, "pointAddDurationMs"),
          rendererPreparationMs: number(
            pointPerformance,
            "rendererPreparationDurationMs",
          ),
          copcWasmAssetFetchMs:
            copcWasmAsset?.completedAt === undefined
              ? 0
              : copcWasmAsset.completedAt - copcWasmAsset.startAt,
          copcWasmAssetBytes: copcWasmAsset?.bytes ?? 0,
          copcWasmAssetStartFromFirstRangeMs:
            copcWasmAsset === undefined
              ? 0
              : copcWasmAsset.startAt - firstRangeAt,
          copcWasmCompileMs: profile.copcWasmCompilations.reduce(
            (sum, compilation) => sum + compilation.durationMs,
            0,
          ),
          copcWasmInstantiateMs: profile.copcWasmInstantiations.reduce(
            (sum, instantiation) => sum + instantiation.durationMs,
            0,
          ),
          copcWasmCompileStartFromFirstRangeMs:
            profile.copcWasmCompilations[0] === undefined
              ? 0
              : profile.copcWasmCompilations[0].startAt - firstRangeAt,
          copcWasmInstantiateStartFromFirstRangeMs:
            profile.copcWasmInstantiations[0] === undefined
              ? 0
              : profile.copcWasmInstantiations[0].startAt - firstRangeAt,
          workerInitializationMeanMs:
            workerInitializationMs.length === 0
              ? 0
              : workerInitializationMs.reduce((sum, duration) => sum + duration, 0) /
                workerInitializationMs.length,
          workerInitializationMaxMs: Math.max(0, ...workerInitializationMs),
          workerUtilizationPercent,
          peakActiveRangeRequests: Math.max(
            0,
            ...profile.rangeSamples
              .filter((sample) => sample.at <= qualityAt)
              .map((sample) => sample.activeCount),
          ),
          peakActiveWorkers: Math.max(
            0,
            ...workerSamples.map((sample) => sample.activeCount),
          ),
          glUploadCallsBeforeFirstPointDraw: profile.gpuUploads.filter(
            (upload) => upload.at <= firstPointDrawAt,
          ).length,
          glUploadBytesBeforeFirstPointDraw: profile.gpuUploads
            .filter((upload) => upload.at <= firstPointDrawAt)
            .reduce((sum, upload) => sum + upload.bytes, 0),
          glUploadApiDurationMsBeforeFirstPointDraw: profile.gpuUploads
            .filter((upload) => upload.at <= firstPointDrawAt)
            .reduce((sum, upload) => sum + upload.durationMs, 0),
          peakJsHeapBytes: profile.peakHeapBytes,
          decodedPointCacheBytes: qualityState.pointCache.currentCacheBytes,
          longestMainThreadTaskMs: qualityState.longestMainThreadTaskMs,
        },
        rangeRequestCount: profile.ranges.length,
        failedRangeCount: profile.ranges.filter(
          (range) => range.status !== undefined && range.status !== 206,
        ).length,
        abortedRangeCount: profile.ranges.filter(
          (range) => range.status === undefined && range.error !== undefined,
        ).length,
        lastError: state.lastError,
        webglRenderer: rendererInfo
          ? gl?.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)
          : "unavailable",
      };
    });

    result.steadyFrameTiming = await sampleFrames(page);

    clearInterval(memorySampler);
    await sampleChromiumProcessRss();
    result.peakChromiumProcessRssBytes = peakChromiumProcessRssBytes;
    await cdp.detach();
    await page.close();
    return result;
  };

  const coldRuns: Record<string, unknown>[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    try {
      coldRuns.push(await runOne(context));
    } finally {
      await context.close();
    }
  }

  const warmContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const warmRuns: Record<string, unknown>[] = [];
  try {
    await runOne(warmContext);
    for (let index = 0; index < repetitions; index += 1) {
      warmRuns.push(await runOne(warmContext));
    }
  } finally {
    await warmContext.close();
  }

  const summaryFor = (runs: Record<string, unknown>[]) =>
    summarizeMeasurements(
      runs.map((run) => {
        const stages = run.stages as Record<string, unknown> | undefined;
        const metric = (name: string): number =>
          Number(stages?.[name] ?? 0);
        return {
          firstPointCollectionMs: Number(run.firstPointCollectionMs ?? 0),
          pageToFirstRangeMs: Number(run.pageToFirstRangeMs ?? 0),
          pageToFirstPointDrawMs: Number(run.pageToFirstPointDrawMs ?? 0),
          headerVlrRangeRequestCount: Number(
            run.headerVlrRangeRequestCount ?? 0,
          ),
          headerVlrRangeBytes: Number(run.headerVlrRangeBytes ?? 0),
          headerVlrAcquisitionMs: Number(run.headerVlrAcquisitionMs ?? 0),
          firstPointDrawMs: Number(run.firstPointDrawMs ?? 0),
          firstPointFrameMs: Number(run.firstPointFrameMs ?? 0),
          steadyFrameMedianMs: Number(
            (run.steadyFrameTiming as { medianFrameMs?: number } | undefined)
              ?.medianFrameMs ?? 0,
          ),
          steadyFrameP95Ms: Number(
            (run.steadyFrameTiming as { p95FrameMs?: number } | undefined)
              ?.p95FrameMs ?? 0,
          ),
          steadyFrameMaxMs: Number(
            (run.steadyFrameTiming as { maxFrameMs?: number } | undefined)
              ?.maxFrameMs ?? 0,
          ),
          steadyFrameCount: Number(
            (run.steadyFrameTiming as { frameCount?: number } | undefined)
              ?.frameCount ?? 0,
          ),
          mainThreadLongTaskCount: Number(run.mainThreadLongTaskCount ?? 0),
          mainThreadLongTaskP50Ms: Number(run.mainThreadLongTaskP50Ms ?? 0),
          mainThreadLongTaskP95Ms: Number(run.mainThreadLongTaskP95Ms ?? 0),
          mainThreadLongTaskMaxMs: Number(run.mainThreadLongTaskMaxMs ?? 0),
          cameraUsableMs: Number(run.cameraUsableMs ?? 0),
          cameraInputResponseMs: Number(run.cameraInputResponseMs ?? 0),
          targetQualityMs: Number(run.targetQualityMs ?? 0),
          metadataAndRootReadyMs: Number(run.metadataAndRootReadyMs ?? 0),
          sourceOpenMs: metric("sourceOpenMs"),
          metadataLoadMs: metric("metadataLoadMs"),
          rootHierarchyLoadMs: metric("rootHierarchyLoadMs"),
          firstHierarchyQueryMs: metric("firstHierarchyQueryMs"),
          firstSelectionMs: Number(run.firstSelectionMs ?? 0),
          nodeSelectionMs: metric("nodeSelectionMs"),
          firstPrioritySelectionToDrawMs: metric(
            "firstPrioritySelectionToDrawMs",
          ),
          rangeFetchCumulativeMs: metric("rangeFetchCumulativeMs"),
          lazDecodeMs: metric("lazDecodeMs"),
          rustPointPreparationMs: metric("rustPointPreparationMs"),
          crsTransformMs: metric("crsTransformMs"),
          worldToCartesianMs: metric("worldToCartesianMs"),
          pointStyleMs: metric("pointStyleMs"),
          pointAddMs: metric("pointAddMs"),
          rendererPreparationMs: metric("rendererPreparationMs"),
          copcWasmAssetFetchMs: metric("copcWasmAssetFetchMs"),
          copcWasmAssetBytes: metric("copcWasmAssetBytes"),
          copcWasmAssetStartFromFirstRangeMs: metric(
            "copcWasmAssetStartFromFirstRangeMs",
          ),
          copcWasmCompileMs: metric("copcWasmCompileMs"),
          copcWasmCompileStartFromFirstRangeMs: metric(
            "copcWasmCompileStartFromFirstRangeMs",
          ),
          copcWasmInstantiateMs: metric("copcWasmInstantiateMs"),
          copcWasmInstantiateStartFromFirstRangeMs: metric(
            "copcWasmInstantiateStartFromFirstRangeMs",
          ),
          workerInitializationMeanMs: metric("workerInitializationMeanMs"),
          workerInitializationMaxMs: metric("workerInitializationMaxMs"),
          workerUtilizationPercent: metric("workerUtilizationPercent"),
          peakActiveWorkers: metric("peakActiveWorkers"),
          peakActiveRangeRequests: metric("peakActiveRangeRequests"),
          rangeBytesAtFirstPoint: Number(run.rangeBytesAtFirstPoint ?? 0),
          rangeBytesToFirstPoint: Number(run.rangeBytesToFirstPoint ?? 0),
          rangeBytesToTargetQuality: Number(run.rangeBytesToTargetQuality ?? 0),
          rangeRequestCountToTargetQuality: Number(
            run.rangeRequestCountToTargetQuality ?? 0,
          ),
          firstPointCount: Number(run.firstPointCount ?? 0),
          targetPointCount: Number(run.targetPointCount ?? 0),
          peakJsHeapBytes: metric("peakJsHeapBytes"),
          peakChromiumProcessRssBytes: Number(
            run.peakChromiumProcessRssBytes ?? 0,
          ),
          decodedPointCacheBytes: metric("decodedPointCacheBytes"),
          glUploadBytesBeforeFirstPointDraw: metric(
            "glUploadBytesBeforeFirstPointDraw",
          ),
          glUploadApiDurationMsBeforeFirstPointDraw: metric(
            "glUploadApiDurationMsBeforeFirstPointDraw",
          ),
        };
      }),
    );
  const coldSummary = summaryFor(coldRuns);
  const warmSummary = summaryFor(warmRuns);
  const runRowsFor = (runs: Record<string, unknown>[]) =>
    runs.map((run) => {
      const stages = run.stages as Record<string, unknown>;
      return {
        pageToFirstPointDrawMs: run.pageToFirstPointDrawMs,
        firstPointDrawMs: run.firstPointDrawMs,
        firstPointFrameMs: run.firstPointFrameMs,
        steadyFrameTiming: run.steadyFrameTiming,
        longTaskObserverAvailable: run.longTaskObserverAvailable,
        mainThreadLongTaskDurationsMs: run.mainThreadLongTaskDurationsMs,
        mainThreadLongTaskCount: run.mainThreadLongTaskCount,
        mainThreadLongTaskP50Ms: run.mainThreadLongTaskP50Ms,
        mainThreadLongTaskP95Ms: run.mainThreadLongTaskP95Ms,
        mainThreadLongTaskMaxMs: run.mainThreadLongTaskMaxMs,
        cameraUsableMs: run.cameraUsableMs,
        targetQualityMs: run.targetQualityMs,
        rangeBytesToFirstPoint: run.rangeBytesToFirstPoint,
        rangeBytesToTargetQuality: run.rangeBytesToTargetQuality,
        firstPointCount: run.firstPointCount,
        targetPointCount: run.targetPointCount,
        workerUtilizationPercent: stages.workerUtilizationPercent,
        workerInitializationMeanMs: stages.workerInitializationMeanMs,
        workerInitializationMaxMs: stages.workerInitializationMaxMs,
        peakActiveWorkers: stages.peakActiveWorkers,
        peakActiveRangeRequests: stages.peakActiveRangeRequests,
        peakJsHeapBytes: stages.peakJsHeapBytes,
        peakChromiumProcessRssBytes: run.peakChromiumProcessRssBytes,
      };
    });

  console.log(
    `[COPC_FIRST_VISIBLE_BENCHMARK] ${JSON.stringify({
      dataset: "Autzen Stadium; 81,123,042 bytes; 10,653,336 points",
      network: "40 ms RTT; 50 Mbit/s down; 10 Mbit/s up; local HTTP 206 Range server",
      hardware: "Playwright Chromium; 1280x720; renderer recorded per run",
      timingOrigin: "first COPC HTTP Range request",
      qualityDefinition:
        "all selected nodes committed, no active range/decode work or replacement transition for 300 ms",
      coldDefinition: "fresh BrowserContext for each run; browser process and host file cache are reused",
      warmDefinition: "same BrowserContext and browser HTTP cache; one unreported warm-up, then five measured reloads",
      repetitions,
      memoryDefinition:
        "peak Chromium process RSS summed across browser-reported process IDs (shared pages may be counted more than once), page JS heap, and decoded point-cache bytes",
      cold: { summary: coldSummary, runs: runRowsFor(coldRuns) },
      warm: { summary: warmSummary, runs: runRowsFor(warmRuns) },
    })}`,
  );

  expect(coldSummary.firstPointDrawMs?.p95).toBeLessThanOrEqual(4_000);
  expect(warmSummary.firstPointDrawMs?.p95).toBeLessThanOrEqual(4_000);
  expect(coldRuns.every((run) => run.failedRangeCount === 0)).toBe(true);
  expect(warmRuns.every((run) => run.failedRangeCount === 0)).toBe(true);
  await browserCdp.detach();
});

test("records the Autzen Far/Near, rotation, and stale-work streaming gate", async ({
  page,
}) => {
  const motionLookaheadEnabled = process.env.COPC_MOTION_LOOKAHEAD !== "false";
  let delayRangeResponses = false;
  let delayedRangeRequestCount = 0;
  let releaseDelayedRangeResponses: () => void = () => {};
  const delayedRangeResponses = new Promise<void>((resolve) => {
    releaseDelayedRangeResponses = resolve;
  });
  await page.route("**/*.copc.laz*", async (route) => {
    if (delayRangeResponses && route.request().headers().range) {
      const state = await getState(page);
      if (
        state.performance.activeNodeCount > 0 &&
        delayedRangeRequestCount === 0
      ) {
        delayedRangeRequestCount += 1;
        await delayedRangeResponses;
      }
    }
    await route.continue();
  });
  await loadScenario(
    page,
    `budget=250000&motionLookahead=${motionLookaheadEnabled ? "true" : "false"}`,
  );
  const transitions: Record<string, unknown>[] = [];

  const move = async (label: string, height: number): Promise<DebugState> => {
    const before = await getState(page);
    const previousDistanceUpdateCount = before.viewDistance?.updateCount ?? 0;
    const startedAt = Date.now();
    await page.evaluate(
      (nextHeight) => window.__COPC_DEBUG__?.setCameraHeight(nextHeight),
      height,
    );
    await waitForViewChange(page, before);
    await expect
      .poll(async () => (await getState(page)).viewDistance?.updateCount ?? 0)
      .toBeGreaterThan(previousDistanceUpdateCount);
    const firstVisibleMs = Date.now() - startedAt;
    const state = await waitForIdle(page);
    transitions.push({
      label,
      height,
      firstVisibleMs,
      state: summarize(state),
      frames: await sampleFrames(page),
    });
    return state;
  };

  const far = await move("far", 100_000);
  const near = await move("near", 1_000);
  const farAgain = await move("far-again", 100_000);
  const nearAgain = await move("near-again", 1_000);

  expect(far.viewDistance?.effectiveDistanceMeters).toBeLessThanOrEqual(20_000);
  expect(near.viewDistance?.effectiveDistanceMeters).toBeLessThan(
    far.viewDistance?.effectiveDistanceMeters ?? 0,
  );

  const beforeRotation = await getState(page);
  const previousRotationDistanceUpdateCount =
    beforeRotation.viewDistance?.updateCount ?? 0;
  const previousMotionSampledMovementCount =
    beforeRotation.performance.motionSampledMovementCount;
  const beforePitch = await getState(page);
  const nextPitch =
    Math.abs(beforePitch.cameraPitchDegrees + 35) < 1 ? -45 : -35;
  let rotationMotionSample: DebugState;
  if (motionLookaheadEnabled) {
    const afterPitch = await page.evaluate((pitch) => {
      const debug = window.__COPC_DEBUG__;
      debug?.setCameraPitch(pitch);
      return debug?.getState();
    }, nextPitch);
    expect(afterPitch).toBeDefined();
    expect(afterPitch!.performance.motionSampledMovementCount).toBeGreaterThan(
      previousMotionSampledMovementCount,
    );
    assertMotionFollowsViewingDirection(beforePitch, afterPitch!);

    await page.waitForTimeout(25);
    const beforeHeading = await getState(page);
    const nextHeading =
      Math.abs(beforeHeading.cameraHeadingDegrees - 90) < 1 ? 110 : 90;
    const headingMovementCount =
      beforeHeading.performance.motionSampledMovementCount;
    const afterHeading = await page.evaluate((heading) => {
      const debug = window.__COPC_DEBUG__;
      debug?.setCameraHeading(heading);
      return debug?.getState();
    }, nextHeading);
    expect(afterHeading).toBeDefined();
    expect(
      afterHeading!.performance.motionSampledMovementCount,
    ).toBeGreaterThan(headingMovementCount);
    assertMotionFollowsViewingDirection(beforeHeading, afterHeading!);
    rotationMotionSample = afterHeading!;
  } else {
    await page.evaluate(
      (pitch) => window.__COPC_DEBUG__?.setCameraPitch(pitch),
      nextPitch,
    );
    await expect
      .poll(
        async () => {
          return (await getState(page)).performance.motionSampledMovementCount;
        },
        { timeout: 10_000 },
      )
      .toBe(previousMotionSampledMovementCount);
    rotationMotionSample = await getState(page);
  }
  await waitForViewChange(page, beforeRotation);
  await expect
    .poll(async () => (await getState(page)).viewDistance?.updateCount ?? 0)
    .toBeGreaterThan(previousRotationDistanceUpdateCount);
  const rotating = await getState(page);
  expect(rotating.performance.motionLookaheadEnabled).toBe(
    motionLookaheadEnabled,
  );
  const selectionUsedMotionPrediction =
    Math.abs(
      rotating.performance.motionPredictedHorizontalDisplacementDegrees,
    ) > 0 ||
    Math.abs(rotating.performance.motionPredictedVerticalDisplacementDegrees) >
      0;
  if (
    motionLookaheadEnabled &&
    selectionUsedMotionPrediction &&
    rotating.performance.motionCandidateCount > 0
  ) {
    expect(rotating.performance.motionWeightMax).toBeGreaterThan(0);
  }
  const rotatingSelectionCount = rotating.streamingUpdateCount;
  const rotatingSelectionUsedMotion =
    motionLookaheadEnabled && selectionUsedMotionPrediction;
  const rotated = await waitForIdle(page);
  if (motionLookaheadEnabled) {
    await expect
      .poll(async () => (await getState(page)).performance.motionLive.state, {
        timeout: 10_000,
      })
      .toBe("stationary");
    if (rotatingSelectionUsedMotion) {
      await expect
        .poll(
          async () => {
            const state = await getState(page);
            return (
              state.streamingUpdateCount > rotatingSelectionCount &&
              state.performance.motionPredictedHorizontalDisplacementDegrees ===
                0 &&
              state.performance.motionPredictedVerticalDisplacementDegrees ===
                0 &&
              state.performance.motionWeightMax === 0
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    }
    await waitForIdle(page);
  }
  const settledMotion = await getState(page);
  if (motionLookaheadEnabled) {
    expect(
      settledMotion.performance.motionPredictedHorizontalDisplacementDegrees,
    ).toBe(0);
    expect(
      settledMotion.performance.motionPredictedVerticalDisplacementDegrees,
    ).toBe(0);
    expect(settledMotion.performance.motionWeightMax).toBe(0);
  }
  const settledMotionSummary = summarize(settledMotion);
  await page.waitForTimeout(400);
  const stableMotion = await getState(page);
  expect(stableMotion.streamingUpdateCount).toBe(
    settledMotion.streamingUpdateCount,
  );
  expect(stableMotion.rangeRequests.requested).toBe(
    settledMotion.rangeRequests.requested,
  );
  expect(stableMotion.performance.rangeFetchBytes).toBe(
    settledMotion.performance.rangeFetchBytes,
  );
  expect(stableMotion.worker?.submittedCount).toBe(
    settledMotion.worker?.submittedCount,
  );
  expect(stableMotion.worker?.activeCount).toBe(0);
  expect(stableMotion.worker?.queuedCount).toBe(0);
  expect(stableMotion.pointCache.misses).toBe(settledMotion.pointCache.misses);
  transitions.push({
    label: "rotate-under-load-and-stationary-decay",
    state: summarize(rotating),
    motionSample: summarize(rotationMotionSample),
    settled: summarize(rotated),
    settledMotion: settledMotionSummary,
    stableMotion: summarize(stableMotion),
    frames: await sampleFrames(page),
  });

  // Delay point ranges after the hierarchy query has started its node loads.
  // This leaves hierarchy page reads reusable while holding a real point read.
  delayRangeResponses = true;
  const beforeDelayedView = await getState(page);
  await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeading(270));
  await waitForViewChange(page, beforeDelayedView);
  await expect
    .poll(
      async () => {
        const state = await getState(page);
        return (
          delayedRangeRequestCount > 0 &&
          state.performance.activeNodeCount > 0 &&
          state.rangeRequests.active > 0
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const beforeSupersede = await getState(page);
  try {
    await page.evaluate(() => window.__COPC_DEBUG__?.setCameraHeight(100_000));
    await expect
      .poll(
        async () => (await getState(page)).rangeRequests.abortedSuperseded,
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(beforeSupersede.rangeRequests.abortedSuperseded);
  } finally {
    releaseDelayedRangeResponses();
  }
  await expect
    .poll(async () => (await getState(page)).selectedNodeKeys.length, {
      timeout: 120_000,
    })
    .toBe(0);
  const staleWork = await waitForIdle(page);
  transitions.push({
    label: "slow-range-superseded-by-far-view",
    delayedRangeRequestCount,
    state: summarize(staleWork),
  });

  console.log(
    JSON.stringify(
      {
        scenario: "issue-68-autzen-streaming-gate",
        configuration: {
          backend: "rust",
          colorMode: "elevation",
          motionLookahead: motionLookaheadEnabled,
          maxNodes: 32,
          maxDepth: 6,
          maxScreenSpaceError: 8,
          maxRenderDistanceMeters: 20_000,
          maxRenderedPoints: 250_000,
        },
        transitions,
      },
      null,
      2,
    ),
  );

  expect(far.lastError).toBeUndefined();
  expect(near.lastError).toBeUndefined();
  expect(farAgain.lastError).toBeUndefined();
  expect(nearAgain.lastError).toBeUndefined();
  expect(rotated.lastError).toBeUndefined();
  expect(staleWork.lastError).toBeUndefined();
  expect(staleWork.renderedPointCount).toBeLessThanOrEqual(250_000);
  expect(staleWork.performance.activeRenderedPointCount).toBeLessThanOrEqual(
    250_000,
  );
  expect(staleWork.transition.activeReplacementGroupCount).toBe(0);
  expect(staleWork.worker).toBeDefined();
  expect(staleWork.worker!.activeCount).toBeLessThanOrEqual(
    staleWork.worker!.workerCount,
  );
  expect(staleWork.worker!.queuedCount).toBe(0);
  expect(staleWork.rangeRequests.requested).toBe(
    staleWork.rangeRequests.completed +
      staleWork.rangeRequests.failed +
      staleWork.rangeRequests.abortedSuperseded +
      staleWork.rangeRequests.abortedLifecycle,
  );
  expect(staleWork.rangeRequests.active).toBe(0);
  expect(delayedRangeRequestCount).toBeGreaterThan(0);
  expect(staleWork.rangeRequests.abortedSuperseded).toBeGreaterThan(
    beforeSupersede.rangeRequests.abortedSuperseded,
  );
});

test("records monotonic low/high rendered-point budgets", async ({
  browser,
}) => {
  const loadBudget = async (
    budget: number,
  ): Promise<{ page: import("@playwright/test").Page; state: DebugState }> => {
    const page = await browser.newPage();
    await loadScenario(page, `budget=${budget}`);
    return { page, state: await waitForIdle(page) };
  };

  const low = await loadBudget(100_000);
  const high = await loadBudget(500_000);
  const lowState = low.state;
  const highState = await waitForIdle(high.page);
  console.log(
    JSON.stringify(
      {
        scenario: "issue-68-budget-scaling",
        low: summarize(lowState),
        high: summarize(highState),
      },
      null,
      2,
    ),
  );

  expect(lowState.renderedPointCount).toBeLessThanOrEqual(100_000);
  expect(lowState.performance.activeRenderedPointCount).toBeLessThanOrEqual(
    100_000,
  );
  expect(highState.renderedPointCount).toBeLessThanOrEqual(500_000);
  expect(highState.performance.activeRenderedPointCount).toBeLessThanOrEqual(
    500_000,
  );
  expect(highState.renderedPointCount).toBeGreaterThan(
    lowState.renderedPointCount,
  );
  expect(lowState.lastError).toBeUndefined();
  expect(highState.lastError).toBeUndefined();
  await low.page.close();
  await high.page.close();
});

test("records decoded CPU cache pressure separately from rendered workload", async ({
  page,
}) => {
  await loadScenario(
    page,
    "budget=250000&cacheBytes=1048576&motionLookahead=false",
  );
  await expect
    .poll(async () => (await getState(page)).streamingUpdateCount, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);
  await waitForIdle(page);

  const moveAndWait = async (height: number): Promise<void> => {
    const before = await getState(page);
    await page.evaluate((nextHeight) => {
      window.__COPC_DEBUG__?.setCameraHeight(nextHeight);
    }, height);
    await expect
      .poll(async () => (await getState(page)).streamingUpdateCount, {
        timeout: 120_000,
      })
      .toBeGreaterThan(before.streamingUpdateCount);
    await waitForIdle(page);
  };

  await moveAndWait(1_000);
  await moveAndWait(100_000);
  const state = await waitForIdle(page);
  console.log(
    JSON.stringify(
      {
        scenario: "issue-68-cache-pressure",
        configuration: {
          maxRenderedPoints: 250_000,
          maxPointCacheBytes: 1_048_576,
          motionLookahead: false,
        },
        state: summarize(state),
      },
      null,
      2,
    ),
  );

  expect(state.pointCache.cacheByteBudget).toBe(1_048_576);
  expect(state.pointCache.currentCacheBytes).toBeGreaterThanOrEqual(0);
  expect(state.pointCache.evictionCount).toBeGreaterThan(0);
  expect(state.pointCache.bytesEvicted).toBeGreaterThan(0);
  expect(state.renderedPointCount).toBeLessThanOrEqual(250_000);
  expect(state.lastError).toBeUndefined();
});

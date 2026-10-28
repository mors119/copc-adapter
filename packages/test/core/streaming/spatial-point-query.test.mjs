import test from "node:test";
import assert from "node:assert/strict";

import { createPreparedPointData } from "../../../core/point/preparedPoint.ts";
import { CopcStreamingCore } from "../../../core/streaming/CopcStreamingCore.ts";

const ROOT_KEY = "0-0-0-0";

function createNode(key, pointCount, pointDataLength = pointCount * 12) {
  const [level, x, y, z] = key.split("-").map(Number);
  return {
    key,
    level,
    x,
    y,
    z,
    pointCount,
    pointDataOffset: 100 + level * 100,
    pointDataLength,
  };
}

function createBackend({
  pages = new Map(),
  points = new Map(),
  preparedPoints = false,
  gateHierarchyRead,
  gatePointRead,
} = {}) {
  const rootSubtree = pages.get(ROOT_KEY) ?? { nodes: [], pages: [] };
  const counts = {
    hierarchyReads: new Map(),
    pointReads: new Map(),
    preparedReads: 0,
    activePointReads: 0,
    peakActivePointReads: 0,
  };
  const metadata = {
    pointCount: [...points.values()].reduce((total, values) => total + values.length, 0),
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 },
    cube: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 },
    spacing: 1,
  };

  const backend = {
    async open(source) {
      return {
        source,
        getMetadata: () => metadata,
        getRootHierarchyPage: () => ({
          key: ROOT_KEY,
          pageOffset: 0,
          pageLength: 10,
        }),
        async loadHierarchyPage(page, options = {}) {
          counts.hierarchyReads.set(
            page.key,
            (counts.hierarchyReads.get(page.key) ?? 0) + 1,
          );
          if (gateHierarchyRead) await gateHierarchyRead(page, options);
          const bytes = page.pageLength;
          options.performanceObserver?.({
            stage: "rangeFetch",
            durationMs: 1,
            bytes,
          });
          const subtree = pages.get(page.key);
          if (!subtree) throw new Error(`Unknown test hierarchy page ${page.key}`);
          return subtree;
        },
        async loadPointDataView(node, _fields, options = {}) {
          counts.pointReads.set(
            node.key,
            (counts.pointReads.get(node.key) ?? 0) + 1,
          );
          counts.activePointReads += 1;
          counts.peakActivePointReads = Math.max(
            counts.peakActivePointReads,
            counts.activePointReads,
          );
          try {
            if (gatePointRead) await gatePointRead(node, options);
            if (options.signal?.aborted) {
              const error = new Error("test point read aborted");
              error.name = "AbortError";
              throw error;
            }
            const records = points.get(node.key) ?? [];
            options.performanceObserver?.({
              stage: "rangeFetch",
              durationMs: 1,
              bytes: node.pointDataLength,
              nodeKey: node.key,
            });
            return {
              pointCount: records.length,
              availableFields: new Set(["position"]),
              getter(component) {
                const axis = component === "x" ? 0 : component === "y" ? 1 : 2;
                return (pointIndex) => records[pointIndex][axis];
              },
            };
          } finally {
            counts.activePointReads -= 1;
          }
        },
        ...(preparedPoints
          ? {
              async loadPreparedPointData(node) {
                counts.preparedReads += 1;
                const records = points.get(node.key) ?? [];
                const sourceCoordinates = new Float64Array(records.flat());
                return createPreparedPointData({
                  pointCount: records.length,
                  sourceCoordinates,
                  geographicCoordinates: sourceCoordinates.slice(),
                  worldCoordinates: sourceCoordinates.slice(),
                });
              },
            }
          : {}),
        destroy() {},
      };
    },
  };

  return { backend, counts };
}

function rootOnlyBackend(records, { pointDataLength = records.length * 12, preparedPoints = false } = {}) {
  const root = createNode(ROOT_KEY, records.length, pointDataLength);
  return createBackend({
    pages: new Map([[ROOT_KEY, { nodes: [root], pages: [] }]]),
    points: new Map([[ROOT_KEY, records]]),
    preparedPoints,
  });
}

function createCore(backend, streaming = {}) {
  return new CopcStreamingCore({
    url: "memory://spatial-query.copc.laz",
    backend,
    streaming: {
      maxDepth: 2,
      maxNodes: 16,
      maxRenderedPoints: 10_000,
      maxRenderDistanceMeters: 12_000,
      maxScreenSpaceError: 8,
      maxConcurrentNodeLoads: 4,
      ...streaming,
    },
  });
}

function queryOptions(overrides = {}) {
  return {
    region: {
      coordinateSystem: "copc-source",
      min: { x: 0, y: 0, z: 0 },
      max: { x: 2, y: 2, z: 2 },
    },
    mode: "fetch-missing",
    maxDepth: 0,
    ...overrides,
  };
}

async function collect(query) {
  const points = [];
  for await (const batch of query) points.push(...batch);
  return { points, summary: await query.result };
}

async function settlesWithin(promise, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("fetch-missing applies an inclusive 3D AABB and preserves raw XYZ provenance", async () => {
  const backend = rootOnlyBackend([
    [0, 0, 0],
    [1, 1, 1],
    [1.0001, 1, 1],
    [2, 2, 2],
  ]);
  const core = createCore(backend.backend);
  await core.load();

  const { points, summary } = await collect(
    core.queryPoints(
      queryOptions({
        region: {
          coordinateSystem: "copc-source",
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 1 },
        },
      }),
    ),
  );

  assert.deepEqual(
    points.map(({ x, y, z, nodeKey, pointIndex }) => [x, y, z, nodeKey, pointIndex]),
    [
      [0, 0, 0, ROOT_KEY, 0],
      [1, 1, 1, ROOT_KEY, 1],
    ],
  );
  assert.equal(summary.status, "complete");
  assert.equal(summary.pointsScanned, 4);
  assert.equal(summary.pointsReturned, 2);
  assert.equal(summary.bytesRequested, 48);
  assert.equal(summary.bytesRead, 48);
  assert.equal(backend.counts.pointReads.get(ROOT_KEY), 1);
  core.destroy();
});

test("an out-of-dataset ROI completes empty without reading point data", async () => {
  const backend = rootOnlyBackend([[0.5, 0.5, 0.5]]);
  const core = createCore(backend.backend);
  await core.load();

  const { points, summary } = await collect(
    core.queryPoints(
      queryOptions({
        region: {
          coordinateSystem: "copc-source",
          min: { x: 5, y: 5, z: 5 },
          max: { x: 6, y: 6, z: 6 },
        },
      }),
    ),
  );

  assert.deepEqual(points, []);
  assert.equal(summary.status, "complete");
  assert.equal(summary.pointsScanned, 0);
  assert.equal(backend.counts.pointReads.size, 0);
  core.destroy();
});

test("cache-only never fetches missing nodes and reports truthful partial coverage", async () => {
  const backend = rootOnlyBackend([[0.5, 0.5, 0.5]]);
  const core = createCore(backend.backend);
  await core.load();

  const { points, summary } = await collect(
    core.queryPoints(queryOptions({ mode: "cache-only" })),
  );

  assert.deepEqual(points, []);
  assert.equal(summary.status, "partial");
  assert.ok(summary.reasonCodes.includes("missing-nodes"));
  assert.equal(backend.counts.pointReads.size, 0);
  assert.equal(backend.counts.hierarchyReads.get(ROOT_KEY), 1);
  core.destroy();
});

test("cache-only reuses decoded source XYZ without changing the render selection", async () => {
  const backend = rootOnlyBackend(
    [[0.5, 0.5, 0.5], [1.5, 1.5, 1.5]],
    { preparedPoints: true },
  );
  const core = createCore(backend.backend, { maxDepth: 0 });
  await core.load();
  await core.updateView({
    longitude: 0.5,
    latitude: 0.5,
    height: 0,
    viewDistanceMeters: 1_000,
  });
  const selectionBefore = core.getCurrentSelection();
  const viewBefore = core.getCurrentView();
  const transitionBefore = core.getTransitionState();
  const pointReadsBefore = backend.counts.pointReads.size;

  const { points, summary } = await collect(
    core.queryPoints(queryOptions({ mode: "cache-only" })),
  );

  assert.equal(points.length, 2);
  assert.equal(summary.status, "complete");
  assert.equal(summary.bytesRead, 0);
  assert.equal(backend.counts.pointReads.size, pointReadsBefore);
  assert.deepEqual(core.getCurrentSelection(), selectionBefore);
  assert.equal(core.getCurrentView(), viewBefore);
  assert.deepEqual(core.getTransitionState(), transitionBefore);
  core.destroy();
});

test("the requested depth emits a non-overlapping node frontier, not parent and child samples", async () => {
  const root = createNode(ROOT_KEY, 1);
  const lowerChild = createNode("1-0-0-0", 1);
  const upperChild = createNode("1-1-1-1", 1);
  const backend = createBackend({
    pages: new Map([
      [ROOT_KEY, { nodes: [root, lowerChild, upperChild], pages: [] }],
    ]),
    points: new Map([
      [ROOT_KEY, [[0.25, 0.25, 0.25]]],
      [lowerChild.key, [[0.5, 0.5, 0.5]]],
      [upperChild.key, [[1.5, 1.5, 1.5]]],
    ]),
  });
  const core = createCore(backend.backend);
  await core.load();

  const { points, summary } = await collect(
    core.queryPoints(queryOptions({ maxDepth: 1 })),
  );

  assert.deepEqual(points.map((point) => point.nodeKey), [lowerChild.key, upperChild.key]);
  assert.equal(points.some((point) => point.nodeKey === ROOT_KEY), false);
  assert.equal(summary.status, "complete");
  assert.equal(summary.nodesProcessed, 2);
  core.destroy();
});

test("missing hierarchy is partial in cache-only and fetched only in fetch-missing", async () => {
  const root = createNode(ROOT_KEY, 1);
  const child = createNode("1-0-0-0", 1);
  const pages = new Map([
    [ROOT_KEY, { nodes: [root], pages: [{ key: child.key, pageOffset: 20, pageLength: 8 }] }],
    [child.key, { nodes: [child], pages: [] }],
  ]);
  const backend = createBackend({
    pages,
    points: new Map([[ROOT_KEY, [[0.5, 0.5, 0.5]]], [child.key, [[0.5, 0.5, 0.5]]]]),
  });
  const core = createCore(backend.backend);
  await core.load();

  const cached = await collect(
    core.queryPoints(queryOptions({ mode: "cache-only", maxDepth: 1 })),
  );
  assert.equal(cached.summary.status, "partial");
  assert.ok(cached.summary.reasonCodes.includes("missing-hierarchy"));
  assert.equal(backend.counts.hierarchyReads.get(child.key), undefined);

  const pageLimited = await collect(
    core.queryPoints(queryOptions({ mode: "fetch-missing", maxDepth: 1, maxHierarchyPages: 0 })),
  );
  assert.equal(pageLimited.summary.status, "partial");
  assert.ok(pageLimited.summary.reasonCodes.includes("hierarchy-page-limit"));
  assert.equal(backend.counts.hierarchyReads.get(child.key), undefined);

  const byteLimited = await collect(
    core.queryPoints(queryOptions({ mode: "fetch-missing", maxDepth: 1, maxBytes: 7 })),
  );
  assert.equal(byteLimited.summary.status, "partial");
  assert.ok(byteLimited.summary.reasonCodes.includes("byte-limit"));
  assert.equal(backend.counts.hierarchyReads.get(child.key), undefined);

  const fetched = await collect(
    core.queryPoints(queryOptions({ mode: "fetch-missing", maxDepth: 1 })),
  );
  assert.equal(fetched.summary.status, "complete");
  assert.deepEqual(fetched.points.map((point) => point.nodeKey), [child.key]);
  assert.equal(backend.counts.hierarchyReads.get(child.key), 1);
  core.destroy();
});

test("point and byte limits stop at their exact bounds", async () => {
  const backend = rootOnlyBackend(
    [[0.5, 0.5, 0.5], [1.5, 1.5, 1.5]],
    { pointDataLength: 24 },
  );
  const core = createCore(backend.backend);
  await core.load();

  const pointLimited = await collect(
    core.queryPoints(queryOptions({ maxPoints: 1 })),
  );
  assert.equal(pointLimited.summary.status, "partial");
  assert.ok(pointLimited.summary.reasonCodes.includes("point-limit"));
  assert.equal(pointLimited.summary.pointsScanned, 0);
  assert.deepEqual(pointLimited.points, []);
  assert.equal(backend.counts.pointReads.size, 0);

  const byteLimited = await collect(
    core.queryPoints(queryOptions({ maxBytes: 23 })),
  );
  assert.equal(byteLimited.summary.status, "partial");
  assert.ok(byteLimited.summary.reasonCodes.includes("byte-limit"));
  assert.equal(backend.counts.pointReads.size, 0);
  core.destroy();

  const exactBackend = rootOnlyBackend([[0.5, 0.5, 0.5]]);
  const exactCore = createCore(exactBackend.backend);
  await exactCore.load();
  const exact = await collect(exactCore.queryPoints(queryOptions({ maxPoints: 1 })));
  assert.equal(exact.summary.status, "complete");
  assert.equal(exact.summary.pointsScanned, 1);
  assert.equal(exact.points.length, 1);
  exactCore.destroy();
});

test("invalid source boxes, depth, and resource limits fail before any query read", async () => {
  const backend = rootOnlyBackend([[0.5, 0.5, 0.5]]);
  const core = createCore(backend.backend);
  await core.load();

  assert.throws(
    () => core.queryPoints(queryOptions({ region: { ...queryOptions().region, coordinateSystem: "wgs84" } })),
    /copc-source/,
  );
  assert.throws(
    () => core.queryPoints(queryOptions({ region: { coordinateSystem: "copc-source", min: { x: 2, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } })),
    /minimums/,
  );
  assert.throws(() => core.queryPoints(queryOptions({ maxDepth: -1 })), /maxDepth/);
  assert.throws(() => core.queryPoints(queryOptions({ maxPoints: Number.MAX_SAFE_INTEGER })), /maxPoints/);
  assert.throws(() => core.queryPoints(queryOptions({ maxConcurrentPointReads: 5 })), /maxConcurrentPointReads/);
  assert.equal(backend.counts.pointReads.size, 0);
  core.destroy();
});

test("early iterator exit and AbortSignal produce cancelled summaries", async () => {
  const root = createNode(ROOT_KEY, 1);
  const first = createNode("1-0-0-0", 1);
  const second = createNode("1-1-1-1", 1);
  const backend = createBackend({
    pages: new Map([[ROOT_KEY, { nodes: [root, first, second], pages: [] }]]),
    points: new Map([
      [ROOT_KEY, [[0.25, 0.25, 0.25]]],
      [first.key, [[0.5, 0.5, 0.5]]],
      [second.key, [[1.5, 1.5, 1.5]]],
    ]),
  });
  const core = createCore(backend.backend);
  await core.load();
  const earlyQuery = core.queryPoints(queryOptions({ maxDepth: 1 }));
  const concurrentEarlyQuery = core.queryPoints(
    queryOptions({ maxDepth: 1, maxConcurrentPointReads: 2 }),
  );
  for await (const _batch of earlyQuery) break;
  const earlySummary = await earlyQuery.result;
  assert.equal(earlySummary.status, "cancelled");
  assert.equal(earlySummary.cancelReason, "consumer-stopped");
  assert.equal([...backend.counts.pointReads.values()].reduce((a, b) => a + b, 0), 1);
  for await (const _batch of concurrentEarlyQuery) break;
  const concurrentEarlySummary = await concurrentEarlyQuery.result;
  assert.equal(concurrentEarlySummary.status, "cancelled");
  assert.equal([...backend.counts.pointReads.values()].reduce((a, b) => a + b, 0), 3);

  let started;
  const pointReadStarted = new Promise((resolve) => { started = resolve; });
  const abortingBackend = createBackend({
    pages: new Map([[ROOT_KEY, { nodes: [createNode(ROOT_KEY, 1)], pages: [] }]]),
    points: new Map([[ROOT_KEY, [[0.5, 0.5, 0.5]]]]),
    gatePointRead: (_node, options) => new Promise((resolve, reject) => {
      started();
      const abort = () => {
        const error = new Error("aborted by test");
        error.name = "AbortError";
        reject(error);
      };
      options.signal.addEventListener("abort", abort, { once: true });
    }),
  });
  const abortingCore = createCore(abortingBackend.backend);
  await abortingCore.load();
  const controller = new AbortController();
  const abortQuery = abortingCore.queryPoints(queryOptions({ signal: controller.signal }));
  const consume = collect(abortQuery);
  await pointReadStarted;
  controller.abort();
  const aborted = await consume;
  assert.equal(aborted.summary.status, "cancelled");
  assert.equal(aborted.summary.cancelReason, "aborted");
  core.destroy();
  abortingCore.destroy();
});

test("query timeout is partial and backend errors are failed, never empty success", async () => {
  let started;
  const readStarted = new Promise((resolve) => { started = resolve; });
  const timeoutBackend = createBackend({
    pages: new Map([[ROOT_KEY, { nodes: [createNode(ROOT_KEY, 1)], pages: [] }]]),
    points: new Map([[ROOT_KEY, [[0.5, 0.5, 0.5]]]]),
    gatePointRead: (_node, options) => new Promise((resolve, reject) => {
      started();
      options.signal.addEventListener("abort", () => {
        const error = new Error("query time limit");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  const timeoutCore = createCore(timeoutBackend.backend);
  await timeoutCore.load();
  const timeoutQuery = timeoutCore.queryPoints(queryOptions({ maxDurationMs: 10 }));
  const timeoutConsumption = collect(timeoutQuery);
  await readStarted;
  const timeoutResult = await timeoutConsumption;
  assert.equal(timeoutResult.summary.status, "partial");
  assert.ok(timeoutResult.summary.reasonCodes.includes("time-limit"));
  timeoutCore.destroy();

  const failingBackend = rootOnlyBackend([[0.5, 0.5, 0.5]]);
  const originalOpen = failingBackend.backend.open;
  failingBackend.backend.open = async (...args) => {
    const source = await originalOpen(...args);
    source.loadPointDataView = async () => { throw new Error("synthetic source failure"); };
    return source;
  };
  const failingCore = createCore(failingBackend.backend);
  await failingCore.load();
  const failedQuery = failingCore.queryPoints(queryOptions());
  await assert.rejects(async () => {
    for await (const _batch of failedQuery) {
      // A source failure must reject iteration.
    }
  }, /synthetic source failure/);
  const failedSummary = await failedQuery.result;
  assert.equal(failedSummary.status, "failed");
  assert.equal(failedSummary.error.message, "synthetic source failure");
  failingCore.destroy();
});

test("timeout and cancellation settle while the consumer is paused on a batch", async () => {
  const records = Array.from({ length: 5_000 }, () => [0.5, 0.5, 0.5]);
  const timeoutBackend = rootOnlyBackend(records);
  const timeoutCore = createCore(timeoutBackend.backend);
  await timeoutCore.load();
  const timeoutQuery = timeoutCore.queryPoints(
    queryOptions({ maxDurationMs: 50 }),
  );
  const timeoutIterator = timeoutQuery[Symbol.asyncIterator]();
  const firstTimeoutBatch = await timeoutIterator.next();
  assert.equal(firstTimeoutBatch.value.length, 4_096);
  const timeoutSummary = await timeoutQuery.result;
  assert.equal(timeoutSummary.status, "partial");
  assert.ok(timeoutSummary.reasonCodes.includes("time-limit"));
  timeoutCore.destroy();

  const cancelBackend = rootOnlyBackend(records);
  const cancelCore = createCore(cancelBackend.backend);
  await cancelCore.load();
  const cancelQuery = cancelCore.queryPoints(queryOptions());
  const cancelIterator = cancelQuery[Symbol.asyncIterator]();
  const firstCancelBatch = await cancelIterator.next();
  assert.equal(firstCancelBatch.value.length, 4_096);
  cancelQuery.cancel();
  const cancelSummary = await cancelQuery.result;
  assert.equal(cancelSummary.status, "cancelled");
  assert.equal(cancelSummary.cancelReason, "aborted");
  assert.deepEqual(await cancelIterator.next(), { value: undefined, done: true });
  cancelCore.destroy();
});

test("cancellation before the first iterator next settles and closes the query", async () => {
  const makeCore = async () => {
    const backend = rootOnlyBackend([[0.5, 0.5, 0.5]]);
    const core = createCore(backend.backend);
    await core.load();
    return { core, backend };
  };

  const callerCancelled = await makeCore();
  const directQuery = callerCancelled.core.queryPoints(queryOptions());
  const directIterator = directQuery[Symbol.asyncIterator]();
  directQuery.cancel();
  const directSummary = await settlesWithin(directQuery.result);
  assert.equal(directSummary.status, "cancelled");
  assert.equal(directSummary.cancelReason, "aborted");
  assert.deepEqual(await directIterator.next(), { value: undefined, done: true });
  assert.equal(callerCancelled.backend.counts.pointReads.size, 0);
  callerCancelled.core.destroy();

  const signalCancelled = await makeCore();
  const abortController = new AbortController();
  const signalQuery = signalCancelled.core.queryPoints(
    queryOptions({ signal: abortController.signal }),
  );
  const signalIterator = signalQuery[Symbol.asyncIterator]();
  abortController.abort("before-first-next");
  const signalSummary = await settlesWithin(signalQuery.result);
  assert.equal(signalSummary.status, "cancelled");
  assert.equal(signalSummary.cancelReason, "aborted");
  assert.deepEqual(await signalIterator.next(), { value: undefined, done: true });
  signalCancelled.core.destroy();

  const unloaded = await makeCore();
  const unloadQuery = unloaded.core.queryPoints(queryOptions());
  const unloadIterator = unloadQuery[Symbol.asyncIterator]();
  unloaded.core.unload();
  const unloadSummary = await settlesWithin(unloadQuery.result);
  assert.equal(unloadSummary.status, "cancelled");
  assert.equal(unloadSummary.cancelReason, "source-unloaded");
  assert.deepEqual(await unloadIterator.next(), { value: undefined, done: true });
  unloaded.core.destroy();
});

test("hierarchy cancellation and timeout detach without cancelling shared page reads", async () => {
  const runScenario = async (kind) => {
    const root = createNode(ROOT_KEY, 1);
    const child = createNode("1-0-0-0", 1);
    let notifyHierarchyReadStarted;
    const hierarchyReadStarted = new Promise((resolve) => {
      notifyHierarchyReadStarted = resolve;
    });
    let releaseHierarchyRead;
    const hierarchyReadReleased = new Promise((resolve) => {
      releaseHierarchyRead = resolve;
    });
    const backend = createBackend({
      pages: new Map([
        [ROOT_KEY, {
          nodes: [root],
          pages: [{ key: child.key, pageOffset: 20, pageLength: 8 }],
        }],
        [child.key, { nodes: [child], pages: [] }],
      ]),
      points: new Map([[child.key, [[0.5, 0.5, 0.5]]]]),
      gateHierarchyRead: async (page, options) => {
        if (page.key !== child.key) return;
        assert.equal(options.signal, undefined, "query abort must not reach a shared page read");
        notifyHierarchyReadStarted();
        await hierarchyReadReleased;
      },
    });
    const core = createCore(backend.backend);
    await core.load();

    const abortController = new AbortController();
    const query = core.queryPoints(queryOptions({
      maxDepth: 1,
      maxDurationMs: kind === "timeout" ? 50 : 1_000,
      ...(kind === "abort" ? { signal: abortController.signal } : {}),
    }));
    const consuming = collect(query);
    await hierarchyReadStarted;
    if (kind === "abort") abortController.abort("test-cancelled");

    const summary = await settlesWithin(query.result);
    assert.equal(summary.status, kind === "timeout" ? "partial" : "cancelled");
    if (kind === "timeout") {
      assert.ok(summary.reasonCodes.includes("time-limit"));
    } else {
      assert.equal(summary.cancelReason, "aborted");
    }
    await settlesWithin(consuming);

    // The first query has released its query slot. A second caller can wait on
    // the same page promise and complete once the shared read resolves.
    const followup = core.queryPoints(queryOptions({
      maxDepth: 1,
      maxDurationMs: 1_000,
    }));
    const followupTask = collect(followup);
    const followupState = await Promise.race([
      followup.result.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 10)),
    ]);
    assert.equal(followupState, "waiting");
    assert.equal(backend.counts.hierarchyReads.get(child.key), 1);

    releaseHierarchyRead();
    const completed = await settlesWithin(followupTask);
    assert.equal(completed.summary.status, "complete");
    assert.equal(backend.counts.hierarchyReads.get(child.key), 1);
    core.destroy();
  };

  await runScenario("abort");
  await runScenario("timeout");
});

test("source unload cancels an in-flight query without stale output", async () => {
  let started;
  const pointReadStarted = new Promise((resolve) => { started = resolve; });
  const backend = createBackend({
    pages: new Map([[ROOT_KEY, { nodes: [createNode(ROOT_KEY, 1)], pages: [] }]]),
    points: new Map([[ROOT_KEY, [[0.5, 0.5, 0.5]]]]),
    gatePointRead: (_node, options) => new Promise((resolve, reject) => {
      started();
      options.signal.addEventListener("abort", () => {
        const error = new Error("source unloaded");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  const core = createCore(backend.backend);
  await core.load();
  const query = core.queryPoints(queryOptions());
  const consumeQuery = collect(query);
  await pointReadStarted;
  core.unload();
  const result = await consumeQuery;
  assert.equal(result.summary.status, "cancelled");
  assert.equal(result.summary.cancelReason, "source-unloaded");
  assert.deepEqual(result.points, []);
  core.destroy();
});

test("point-read concurrency is independently bounded and preserves node order", async () => {
  const first = createNode("1-0-0-0", 1);
  const second = createNode("1-1-1-1", 1);
  let startedCount = 0;
  let notifyBothStarted;
  const bothStarted = new Promise((resolve) => { notifyBothStarted = resolve; });
  let releaseReads;
  const readsReleased = new Promise((resolve) => { releaseReads = resolve; });
  const backend = createBackend({
    pages: new Map([[ROOT_KEY, { nodes: [createNode(ROOT_KEY, 1), first, second], pages: [] }]]),
    points: new Map([
      [ROOT_KEY, [[0.25, 0.25, 0.25]]],
      [first.key, [[0.5, 0.5, 0.5]]],
      [second.key, [[1.5, 1.5, 1.5]]],
    ]),
    gatePointRead: async (_node, options) => {
      assert.equal(options.workload, "spatial-query");
      startedCount += 1;
      if (startedCount === 2) notifyBothStarted();
      await readsReleased;
    },
  });
  const core = createCore(backend.backend, { maxConcurrentNodeLoads: 3 });
  await core.load();
  const query = core.queryPoints(
    queryOptions({ maxDepth: 1, maxConcurrentPointReads: 2 }),
  );
  const consuming = collect(query);
  await bothStarted;
  assert.equal(backend.counts.peakActivePointReads, 2);
  releaseReads();
  const { points, summary } = await consuming;
  assert.deepEqual(points.map((point) => point.nodeKey), [first.key, second.key]);
  assert.equal(summary.status, "complete");
  core.destroy();
});

test("concurrent queries remain bounded and cancellation stays independent", async () => {
  let started;
  const pointReadStarted = new Promise((resolve) => { started = resolve; });
  const backend = createBackend({
    pages: new Map([[ROOT_KEY, { nodes: [createNode(ROOT_KEY, 1)], pages: [] }]]),
    points: new Map([[ROOT_KEY, [[0.5, 0.5, 0.5]]]]),
    gatePointRead: async (_node, options) => {
      started();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("query cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });
  const core = createCore(backend.backend, { maxConcurrentNodeLoads: 1 });
  await core.load();
  const abortController = new AbortController();
  const cancelledQuery = core.queryPoints(queryOptions({ signal: abortController.signal }));
  const successfulQuery = core.queryPoints(queryOptions());
  const cancelledTask = collect(cancelledQuery);
  const successfulTask = collect(successfulQuery);
  await pointReadStarted;
  abortController.abort();
  const [cancelled, successful] = await Promise.all([cancelledTask, successfulTask]);

  assert.equal(cancelled.summary.status, "cancelled");
  assert.equal(successful.summary.status, "complete");
  assert.equal(backend.counts.peakActivePointReads, 1);
  core.destroy();
});

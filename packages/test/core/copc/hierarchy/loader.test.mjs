import test from "node:test";
import assert from "node:assert/strict";

import {
  HierarchyLoader,
  CopcHierarchyPageError,
  CopcHierarchyTraversalError,
} from "../../../../core/copc/hierarchy/index.ts";

function createFakeSource(definition) {
  const calls = [];

  return {
    calls,
    source: {
      getRootHierarchyPage() {
        return definition.rootPage;
      },
      async loadHierarchyPage(page) {
        calls.push(page.key);

        if (definition.failOn?.includes(page.key)) {
          throw new Error(`boom:${page.key}`);
        }

        const subtree = definition.pages[page.key];

        if (!subtree) {
          throw new Error(`missing:${page.key}`);
        }

        return subtree;
      },
    },
  };
}

function createIncrementalSource() {
  const rootPage = {
    key: "0-0-0-0",
    pageOffset: 0,
    pageLength: 32,
  };
  const calls = [];
  const pages = {
    "0-0-0-0": {
      nodes: [
        {
          key: "0-0-0-0",
          level: 0,
          x: 0,
          y: 0,
          z: 0,
          pointCount: 100,
          pointDataOffset: 1000,
          pointDataLength: 20,
        },
      ],
      pages: [
        { key: "1-0-0-0", pageOffset: 100, pageLength: 32 },
        { key: "1-1-0-0", pageOffset: 200, pageLength: 32 },
      ],
    },
    "1-0-0-0": {
      nodes: [
        {
          key: "1-0-0-0",
          level: 1,
          x: 0,
          y: 0,
          z: 0,
          pointCount: 60,
          pointDataOffset: 1100,
          pointDataLength: 20,
        },
      ],
      pages: [{ key: "2-0-0-0", pageOffset: 300, pageLength: 32 }],
    },
    "1-1-0-0": {
      nodes: [
        {
          key: "1-1-0-0",
          level: 1,
          x: 1,
          y: 0,
          z: 0,
          pointCount: 40,
          pointDataOffset: 1200,
          pointDataLength: 20,
        },
      ],
      pages: [],
    },
    "2-0-0-0": {
      nodes: [
        {
          key: "2-0-0-0",
          level: 2,
          x: 0,
          y: 0,
          z: 0,
          pointCount: 20,
          pointDataOffset: 1300,
          pointDataLength: 20,
        },
      ],
      pages: [],
    },
  };

  return {
    calls,
    source: {
      getRootHierarchyPage() {
        return rootPage;
      },
      async loadHierarchyPage(page) {
        calls.push(page.key);
        if (!pages[page.key]) {
          throw new Error(`missing:${page.key}`);
        }
        return pages[page.key];
      },
    },
  };
}

const cubeBounds = {
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 8,
  maxY: 8,
  maxZ: 8,
};

test("HierarchyLoader loads the root page and discovers nodes", async () => {
  const { source, calls } = createFakeSource({
    rootPage: {
      key: "0-0-0-0",
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      "0-0-0-0": {
        nodes: [
          {
            key: "0-0-0-0",
            level: 0,
            x: 0,
            y: 0,
            z: 0,
            pointCount: 100,
            pointDataOffset: 10,
            pointDataLength: 20,
          },
        ],
        pages: [],
      },
    },
  });
  const tree = await new HierarchyLoader(source).load();

  assert.deepEqual(calls, ["0-0-0-0"]);
  assert.equal(tree.nodes.length, 1);
  assert.deepEqual(tree.nodes[0].children, []);
});

test("HierarchyLoader follows child hierarchy pages and collects descendant nodes", async () => {
  const { source } = createFakeSource({
    rootPage: {
      key: "0-0-0-0",
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      "0-0-0-0": {
        nodes: [
          {
            key: "0-0-0-0",
            level: 0,
            x: 0,
            y: 0,
            z: 0,
            pointCount: 100,
            pointDataOffset: 10,
            pointDataLength: 20,
          },
        ],
        pages: [
          {
            key: "1-0-0-0",
            pageOffset: 100,
            pageLength: 32,
          },
        ],
      },
      "1-0-0-0": {
        nodes: [
          {
            key: "1-0-0-0",
            level: 1,
            x: 0,
            y: 0,
            z: 0,
            pointCount: 60,
            pointDataOffset: 30,
            pointDataLength: 40,
          },
          {
            key: "2-0-0-0",
            level: 2,
            x: 0,
            y: 0,
            z: 0,
            pointCount: 25,
            pointDataOffset: 50,
            pointDataLength: 15,
          },
        ],
        pages: [],
      },
    },
  });
  const tree = await new HierarchyLoader(source).load();
  const rootNode = tree.nodes.find((node) => node.key === "0-0-0-0");
  const childNode = tree.nodes.find((node) => node.key === "1-0-0-0");

  assert.equal(tree.nodes.length, 3);
  assert.deepEqual(rootNode?.children, ["1-0-0-0"]);
  assert.deepEqual(childNode?.children, ["2-0-0-0"]);
});

test("HierarchyLoader allows speculative queries to suppress page performance events", async () => {
  const events = [];
  const rootPage = { key: "0-0-0-0", pageOffset: 0, pageLength: 32 };
  const childPage = { key: "1-0-0-0", pageOffset: 100, pageLength: 32 };
  const source = {
    getRootHierarchyPage: () => rootPage,
    async loadHierarchyPage(page, options) {
      const observer =
        options?.performanceObserver === undefined
          ? (event) => events.push(event)
          : options.performanceObserver;
      observer?.({ stage: "rangeFetch", durationMs: 1 });
      return page.key === rootPage.key
        ? {
            nodes: [
              {
                key: "0-0-0-0",
                level: 0,
                x: 0,
                y: 0,
                z: 0,
                pointCount: 100,
                pointDataOffset: 1000,
                pointDataLength: 20,
              },
            ],
            pages: [childPage],
          }
        : { nodes: [], pages: [] };
    },
  };
  const loader = new HierarchyLoader(source, cubeBounds);

  await loader.loadRoot();
  assert.equal(events.length, 1);
  await loader.query(
    { bounds: cubeBounds, maxLevel: 1 },
    { performanceObserver: null },
  );
  assert.equal(events.length, 1);
});

test("bounded hierarchy queries visit at most the configured relevant child pages", async () => {
  const { source, calls } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);
  await loader.loadRoot();
  const visited = [];
  const tree = await loader.query(
    { bounds: cubeBounds },
    {
      maxPages: 1,
      onPageVisited: (cached) => visited.push(cached),
    },
  );

  assert.deepEqual(calls, ["0-0-0-0", "1-0-0-0"]);
  assert.deepEqual(visited, [false]);
  assert.deepEqual(tree.nodes.map((node) => node.key).sort(), [
    "0-0-0-0",
    "1-0-0-0",
  ]);
});

test("aborted bounded hierarchy traversal does not start another speculative page", async () => {
  const { source, calls } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);
  await loader.loadRoot();
  const controller = new AbortController();

  await assert.rejects(
    loader.query(
      { bounds: cubeBounds },
      {
        maxPages: 1,
        signal: controller.signal,
        onPageVisited: () => controller.abort("superseded"),
      },
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, ["0-0-0-0"]);
});

test("HierarchyLoader does not load the same hierarchy page twice", async () => {
  const { source, calls } = createFakeSource({
    rootPage: {
      key: "0-0-0-0",
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      "0-0-0-0": {
        nodes: [
          {
            key: "0-0-0-0",
            level: 0,
            x: 0,
            y: 0,
            z: 0,
            pointCount: 100,
            pointDataOffset: 10,
            pointDataLength: 20,
          },
        ],
        pages: [
          {
            key: "1-0-0-0",
            pageOffset: 100,
            pageLength: 32,
          },
          {
            key: "1-1-0-0",
            pageOffset: 100,
            pageLength: 32,
          },
        ],
      },
      "1-0-0-0": {
        nodes: [
          {
            key: "1-0-0-0",
            level: 1,
            x: 0,
            y: 0,
            z: 0,
            pointCount: 50,
            pointDataOffset: 30,
            pointDataLength: 10,
          },
        ],
        pages: [],
      },
    },
  });

  await new HierarchyLoader(source).load();

  assert.deepEqual(calls, ["0-0-0-0", "1-0-0-0"]);
});

test("HierarchyLoader rejects invalid hierarchy pages", async () => {
  const { source } = createFakeSource({
    rootPage: {
      key: "0-0-0-0",
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      "0-0-0-0": {
        nodes: [],
        pages: [
          {
            key: "1-0-0-0",
            pageOffset: 100,
            pageLength: 0,
          },
        ],
      },
    },
  });

  await assert.rejects(
    () => new HierarchyLoader(source).load(),
    CopcHierarchyPageError,
  );
});

test("HierarchyLoader rejects recursive page references", async () => {
  const { source } = createFakeSource({
    rootPage: {
      key: "0-0-0-0",
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      "0-0-0-0": {
        nodes: [],
        pages: [
          {
            key: "1-0-0-0",
            pageOffset: 100,
            pageLength: 32,
          },
        ],
      },
      "1-0-0-0": {
        nodes: [],
        pages: [
          {
            key: "0-0-0-0",
            pageOffset: 0,
            pageLength: 32,
          },
        ],
      },
    },
  });

  await assert.rejects(
    () => new HierarchyLoader(source).load(),
    CopcHierarchyTraversalError,
  );
});

test("HierarchyLoader wraps hierarchy page load failures", async () => {
  const { source } = createFakeSource({
    rootPage: {
      key: "0-0-0-0",
      pageOffset: 0,
      pageLength: 32,
    },
    failOn: ["0-0-0-0"],
    pages: {},
  });

  await assert.rejects(
    () => new HierarchyLoader(source).load(),
    CopcHierarchyTraversalError,
  );
});

test("HierarchyLoader loads only the root for a root-level query", async () => {
  const { source, calls } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);

  const tree = await loader.query({
    bounds: cubeBounds,
    maxLevel: 0,
  });

  assert.deepEqual(calls, ["0-0-0-0"]);
  assert.deepEqual(
    tree.nodes.map((node) => node.key),
    ["0-0-0-0"],
  );
  assert.equal(loader.getDiagnostics().loadedPageCount, 1);
});

test("HierarchyLoader follows intersecting pages but skips a sibling", async () => {
  const { source, calls } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);

  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });

  assert.deepEqual(calls, ["0-0-0-0", "1-0-0-0"]);
});

test("HierarchyLoader does not let an out-of-query page block visible refinement", async () => {
  const { source } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);

  const tree = await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });

  assert.deepEqual(
    tree.nodes.map((node) => node.key),
    ["0-0-0-0", "1-0-0-0"],
  );
  assert.equal(
    tree.nodes.find((node) => node.key === "0-0-0-0")?.childrenComplete,
    true,
  );
});

test("HierarchyLoader reuses pages and loads more when maxLevel increases", async () => {
  const { source, calls } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);

  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });
  const firstDiagnostics = loader.getDiagnostics();
  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });
  assert.deepEqual(calls, ["0-0-0-0", "1-0-0-0"]);
  assert.ok(
    loader.getDiagnostics().pageCacheHits > firstDiagnostics.pageCacheHits,
  );

  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 2,
  });
  assert.deepEqual(calls, ["0-0-0-0", "1-0-0-0", "2-0-0-0"]);

  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });
  assert.deepEqual(calls, ["0-0-0-0", "1-0-0-0", "2-0-0-0"]);
});

test("HierarchyLoader expands the cache when a query moves to another region", async () => {
  const { source, calls } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);

  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });
  await loader.query({
    bounds: { ...cubeBounds, minX: 4.1 },
    maxLevel: 1,
  });

  assert.deepEqual(calls, ["0-0-0-0", "1-0-0-0", "1-1-0-0"]);
});

test("HierarchyLoader surfaces a malformed child page and can reset its cache", async () => {
  const { source, calls } = createIncrementalSource();
  const originalLoad = source.loadHierarchyPage;
  source.loadHierarchyPage = async (page) => {
    if (page.key === "1-0-0-0") {
      throw new Error("malformed child page");
    }
    return originalLoad(page);
  };
  const loader = new HierarchyLoader(source, cubeBounds);

  await assert.rejects(
    () => loader.query({ bounds: { ...cubeBounds, maxX: 3.9 }, maxLevel: 1 }),
    CopcHierarchyTraversalError,
  );
  assert.equal(loader.getDiagnostics().loadedPageCount, 1);

  loader.reset();
  const resetDiagnostics = loader.getDiagnostics();
  assert.deepEqual(
    {
      ...resetDiagnostics,
      rootHierarchyLoadDurationMs: 0,
      lastQueryDurationMs: 0,
    },
    {
      pageRequests: 0,
      pageCacheHits: 0,
      hierarchyBytesFetched: 0,
      loadedPageCount: 0,
      discoveredPageCount: 0,
      completedPageCount: 0,
      activePageLoads: 0,
      peakActivePageLoads: 0,
      sourceOpenDurationMs: 0,
      metadataLoadDurationMs: 0,
      rootHierarchyLoadDurationMs: 0,
      lastQueryDurationMs: 0,
      loadedEntryCount: 0,
    },
  );
  assert.deepEqual(calls, ["0-0-0-0"]);
});

test("a partial query requests fewer hierarchy pages than forced full traversal", async () => {
  const partial = createIncrementalSource();
  const full = createIncrementalSource();

  await new HierarchyLoader(partial.source, cubeBounds).query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });
  await new HierarchyLoader(full.source, cubeBounds).load();

  assert.ok(partial.calls.length < full.calls.length);
});

function createDelayedHierarchySource(delayMs = 20) {
  const rootPage = { key: "0-0-0-0", pageOffset: 0, pageLength: 32 };
  const pages = new Map();
  const calls = [];
  const completed = new Set();
  let active = 0;
  let peakActive = 0;
  const childPages = Array.from({ length: 8 }, (_, childIndex) => {
    const x = childIndex & 1;
    const y = (childIndex >> 1) & 1;
    const z = (childIndex >> 2) & 1;
    return {
      key: `1-${x}-${y}-${z}`,
      pageOffset: 100 + childIndex * 64,
      pageLength: 32,
    };
  });
  pages.set(rootPage.key, {
    nodes: [
      {
        key: rootPage.key,
        level: 0,
        x: 0,
        y: 0,
        z: 0,
        pointCount: 1,
        pointDataOffset: 10,
        pointDataLength: 10,
      },
    ],
    pages: childPages,
  });

  for (const page of childPages) {
    const [, x, y, z] = page.key.split("-").map(Number);
    const leaf = {
      key: `2-${x * 2}-${y * 2}-${z * 2}`,
      pageOffset: page.pageOffset + 32,
      pageLength: 32,
    };
    pages.set(page.key, {
      nodes: [
        {
          key: page.key,
          level: 1,
          x,
          y,
          z,
          pointCount: 1,
          pointDataOffset: 10,
          pointDataLength: 10,
        },
      ],
      pages: [leaf],
    });
    pages.set(leaf.key, {
      nodes: [
        {
          key: leaf.key,
          level: 2,
          x: x * 2,
          y: y * 2,
          z: z * 2,
          pointCount: 1,
          pointDataOffset: 10,
          pointDataLength: 10,
        },
      ],
      pages: [],
    });
  }

  return {
    calls,
    completed,
    get peakActive() {
      return peakActive;
    },
    source: {
      getRootHierarchyPage() {
        return rootPage;
      },
      async loadHierarchyPage(page) {
        calls.push({ key: page.key, completedAtStart: new Set(completed) });
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const subtree = pages.get(page.key);
          if (!subtree) throw new Error(`missing:${page.key}`);
          completed.add(page.key);
          return subtree;
        } finally {
          active -= 1;
        }
      },
    },
  };
}

test("HierarchyLoader bounds independent page work and preserves settled results", async (t) => {
  const run = async (maxConcurrentPageLoads) => {
    const fixture = createDelayedHierarchySource();
    const loader = new HierarchyLoader(fixture.source, cubeBounds, {
      maxConcurrentPageLoads,
    });
    const startedAt = performance.now();
    const tree = await loader.query({ bounds: cubeBounds, maxLevel: 2 });
    return {
      fixture,
      loader,
      tree,
      durationMs: performance.now() - startedAt,
    };
  };

  const serial = await run(1);
  const twoAtOnce = await run(2);
  const fourAtOnce = await run(4);

  assert.deepEqual(twoAtOnce.tree, serial.tree);
  assert.deepEqual(fourAtOnce.tree, serial.tree);
  assert.equal(serial.fixture.peakActive, 1);
  assert.equal(twoAtOnce.fixture.peakActive, 2);
  assert.equal(fourAtOnce.fixture.peakActive, 4);
  assert.equal(fourAtOnce.loader.getDiagnostics().activePageLoads, 0);
  assert.equal(fourAtOnce.loader.getDiagnostics().peakActivePageLoads, 4);
  assert.equal(fourAtOnce.loader.getDiagnostics().completedPageCount, 17);
  assert.equal(fourAtOnce.loader.getDiagnostics().discoveredPageCount, 17);
  assert.ok(twoAtOnce.durationMs < serial.durationMs);
  assert.ok(fourAtOnce.durationMs < twoAtOnce.durationMs);

  t.diagnostic(
    JSON.stringify({
      scenario: "hierarchy-concurrency-simulated-latency",
      pageCount: fourAtOnce.loader.getDiagnostics().completedPageCount,
      measurementsMs: {
        serial: serial.durationMs,
        concurrency2: twoAtOnce.durationMs,
        concurrency4: fourAtOnce.durationMs,
      },
      peakActive: {
        serial: serial.fixture.peakActive,
        concurrency2: twoAtOnce.fixture.peakActive,
        concurrency4: fourAtOnce.fixture.peakActive,
      },
    }),
  );

  for (const runResult of [serial, twoAtOnce, fourAtOnce]) {
    for (const call of runResult.fixture.calls) {
      if (call.key.startsWith("2-")) {
        const [, x, y, z] = call.key.split("-").map(Number);
        const parent = `1-${Math.floor(x / 2)}-${Math.floor(y / 2)}-${Math.floor(z / 2)}`;
        assert.ok(
          call.completedAtStart.has(parent),
          `${call.key} started before ${parent} completed`,
        );
      }
    }
  }
});

test("HierarchyLoader bounds active work across overlapping view queries", async () => {
  const fixture = createDelayedHierarchySource(10);
  const loader = new HierarchyLoader(fixture.source, cubeBounds, {
    maxConcurrentPageLoads: 4,
  });
  const left = loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 2,
  });
  const right = loader.query({
    bounds: { ...cubeBounds, minX: 4.1 },
    maxLevel: 2,
  });

  await Promise.all([left, right]);

  assert.equal(fixture.peakActive, 4);
  assert.equal(loader.getDiagnostics().activePageLoads, 0);
  assert.equal(loader.getDiagnostics().peakActivePageLoads, 4);
});

test("HierarchyLoader waits for slower siblings to reveal more pages", async () => {
  const rootPage = { key: "0-0-0-0", pageOffset: 0, pageLength: 32 };
  const quickPage = { key: "1-0-0-0", pageOffset: 100, pageLength: 16 };
  const slowPage = { key: "1-1-0-0", pageOffset: 116, pageLength: 16 };
  const discoveredPage = { key: "2-2-0-0", pageOffset: 132, pageLength: 16 };
  const sourceCalls = [];
  let signalQuickPageStarted;
  let resolveSlowPage;
  const quickPageStarted = new Promise((resolve) => {
    signalQuickPageStarted = resolve;
  });
  const slowPageResult = new Promise((resolve) => {
    resolveSlowPage = resolve;
  });
  const source = {
    getRootHierarchyPage: () => rootPage,
    async loadHierarchyPage(page) {
      sourceCalls.push(page.key);
      if (page.key === rootPage.key) {
        return { nodes: [], pages: [quickPage, slowPage] };
      }
      if (page.key === quickPage.key) {
        signalQuickPageStarted();
        return { nodes: [], pages: [] };
      }
      if (page.key === slowPage.key) {
        return slowPageResult;
      }
      if (page.key === discoveredPage.key) {
        return { nodes: [], pages: [] };
      }
      throw new Error(`unexpected page:${page.key}`);
    },
  };
  const loader = new HierarchyLoader(source, cubeBounds, {
    maxConcurrentPageLoads: 2,
  });
  const query = loader.query({ bounds: cubeBounds, maxLevel: 2 });

  await quickPageStarted;
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveSlowPage({ nodes: [], pages: [discoveredPage] });
  await query;

  assert.ok(sourceCalls.includes(discoveredPage.key));
  assert.equal(loader.getDiagnostics().completedPageCount, 4);
});

test("reset prevents an in-flight hierarchy page from mutating the new cache", async () => {
  let resolveRoot;
  const rootPage = { key: "0-0-0-0", pageOffset: 0, pageLength: 32 };
  const source = {
    getRootHierarchyPage: () => rootPage,
    loadHierarchyPage: () =>
      new Promise((resolve) => {
        resolveRoot = resolve;
      }),
  };
  const loader = new HierarchyLoader(source, cubeBounds);
  const pending = loader.query({ bounds: cubeBounds, maxLevel: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  loader.reset();
  resolveRoot({ nodes: [], pages: [] });

  await assert.rejects(pending, CopcHierarchyTraversalError);
  const diagnostics = loader.getDiagnostics();
  assert.equal(diagnostics.pageRequests, 0);
  assert.equal(diagnostics.loadedPageCount, 0);
  assert.equal(diagnostics.completedPageCount, 0);
  assert.equal(diagnostics.activePageLoads, 0);
  assert.equal(diagnostics.loadedEntryCount, 0);
  assert.equal(diagnostics.lastQueryDurationMs, 0);
});

test("reset drains queued page work without starting new source reads", async () => {
  const rootPage = { key: "0-0-0-0", pageOffset: 0, pageLength: 32 };
  const childPages = Array.from({ length: 8 }, (_, childIndex) => ({
    key: `1-${childIndex & 1}-${(childIndex >> 1) & 1}-${(childIndex >> 2) & 1}`,
    pageOffset: 100 + childIndex * 32,
    pageLength: 16,
  }));
  const resolvers = new Map();
  const sourceCalls = [];
  const source = {
    getRootHierarchyPage: () => rootPage,
    async loadHierarchyPage(page) {
      sourceCalls.push(page.key);
      if (page.key === rootPage.key) {
        return { nodes: [], pages: childPages };
      }
      return new Promise((resolve) => resolvers.set(page.key, resolve));
    },
  };
  const loader = new HierarchyLoader(source, cubeBounds, {
    maxConcurrentPageLoads: 4,
  });
  await loader.loadRoot();
  const queryA = loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
  });
  const queryB = loader.query({
    bounds: { ...cubeBounds, minX: 4.1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(loader.getDiagnostics().activePageLoads, 4);
  assert.equal(sourceCalls.length, 5);
  loader.reset();
  for (const resolve of resolvers.values()) {
    resolve({ nodes: [], pages: [] });
  }

  const settled = await Promise.allSettled([queryA, queryB]);
  assert.ok(settled.every((result) => result.status === "rejected"));
  assert.equal(
    sourceCalls.length,
    5,
    "queued pages must not start after reset",
  );
  assert.equal(loader.getDiagnostics().activePageLoads, 0);
  assert.equal(loader.getDiagnostics().loadedEntryCount, 0);
  assert.equal(loader.getDiagnostics().completedPageCount, 0);
});

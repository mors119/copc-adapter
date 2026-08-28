import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HierarchyLoader,
  CopcHierarchyPageError,
  CopcHierarchyTraversalError,
} from '../src/copc/hierarchy/index.ts';

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
    key: '0-0-0-0',
    pageOffset: 0,
    pageLength: 32,
  };
  const calls = [];
  const pages = {
    '0-0-0-0': {
      nodes: [{
        key: '0-0-0-0',
        level: 0,
        x: 0,
        y: 0,
        z: 0,
        pointCount: 100,
        pointDataOffset: 1000,
        pointDataLength: 20,
      }],
      pages: [
        { key: '1-0-0-0', pageOffset: 100, pageLength: 32 },
        { key: '1-1-0-0', pageOffset: 200, pageLength: 32 },
      ],
    },
    '1-0-0-0': {
      nodes: [{
        key: '1-0-0-0',
        level: 1,
        x: 0,
        y: 0,
        z: 0,
        pointCount: 60,
        pointDataOffset: 1100,
        pointDataLength: 20,
      }],
      pages: [{ key: '2-0-0-0', pageOffset: 300, pageLength: 32 }],
    },
    '1-1-0-0': {
      nodes: [{
        key: '1-1-0-0',
        level: 1,
        x: 1,
        y: 0,
        z: 0,
        pointCount: 40,
        pointDataOffset: 1200,
        pointDataLength: 20,
      }],
      pages: [],
    },
    '2-0-0-0': {
      nodes: [{
        key: '2-0-0-0',
        level: 2,
        x: 0,
        y: 0,
        z: 0,
        pointCount: 20,
        pointDataOffset: 1300,
        pointDataLength: 20,
      }],
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

test('HierarchyLoader loads the root page and discovers nodes', async () => {
  const { source, calls } = createFakeSource({
    rootPage: {
      key: '0-0-0-0',
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      '0-0-0-0': {
        nodes: [
          {
            key: '0-0-0-0',
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

  assert.deepEqual(calls, ['0-0-0-0']);
  assert.equal(tree.nodes.length, 1);
  assert.deepEqual(tree.nodes[0].children, []);
});

test('HierarchyLoader follows child hierarchy pages and collects descendant nodes', async () => {
  const { source } = createFakeSource({
    rootPage: {
      key: '0-0-0-0',
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      '0-0-0-0': {
        nodes: [
          {
            key: '0-0-0-0',
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
            key: '1-0-0-0',
            pageOffset: 100,
            pageLength: 32,
          },
        ],
      },
      '1-0-0-0': {
        nodes: [
          {
            key: '1-0-0-0',
            level: 1,
            x: 0,
            y: 0,
            z: 0,
            pointCount: 60,
            pointDataOffset: 30,
            pointDataLength: 40,
          },
          {
            key: '2-0-0-0',
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
  const rootNode = tree.nodes.find((node) => node.key === '0-0-0-0');
  const childNode = tree.nodes.find((node) => node.key === '1-0-0-0');

  assert.equal(tree.nodes.length, 3);
  assert.deepEqual(rootNode?.children, ['1-0-0-0']);
  assert.deepEqual(childNode?.children, ['2-0-0-0']);
});

test('HierarchyLoader does not load the same hierarchy page twice', async () => {
  const { source, calls } = createFakeSource({
    rootPage: {
      key: '0-0-0-0',
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      '0-0-0-0': {
        nodes: [
          {
            key: '0-0-0-0',
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
            key: '1-0-0-0',
            pageOffset: 100,
            pageLength: 32,
          },
          {
            key: '1-1-0-0',
            pageOffset: 100,
            pageLength: 32,
          },
        ],
      },
      '1-0-0-0': {
        nodes: [
          {
            key: '1-0-0-0',
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

  assert.deepEqual(calls, ['0-0-0-0', '1-0-0-0']);
});

test('HierarchyLoader rejects invalid hierarchy pages', async () => {
  const { source } = createFakeSource({
    rootPage: {
      key: '0-0-0-0',
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      '0-0-0-0': {
        nodes: [],
        pages: [
          {
            key: '1-0-0-0',
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

test('HierarchyLoader rejects recursive page references', async () => {
  const { source } = createFakeSource({
    rootPage: {
      key: '0-0-0-0',
      pageOffset: 0,
      pageLength: 32,
    },
    pages: {
      '0-0-0-0': {
        nodes: [],
        pages: [
          {
            key: '1-0-0-0',
            pageOffset: 100,
            pageLength: 32,
          },
        ],
      },
      '1-0-0-0': {
        nodes: [],
        pages: [
          {
            key: '0-0-0-0',
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

test('HierarchyLoader wraps hierarchy page load failures', async () => {
  const { source } = createFakeSource({
    rootPage: {
      key: '0-0-0-0',
      pageOffset: 0,
      pageLength: 32,
    },
    failOn: ['0-0-0-0'],
    pages: {},
  });

  await assert.rejects(
    () => new HierarchyLoader(source).load(),
    CopcHierarchyTraversalError,
  );
});

test('HierarchyLoader loads only the root for a root-level query', async () => {
  const { source, calls } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);

  const tree = await loader.query({
    bounds: cubeBounds,
    maxLevel: 0,
  });

  assert.deepEqual(calls, ['0-0-0-0']);
  assert.deepEqual(tree.nodes.map((node) => node.key), ['0-0-0-0']);
  assert.equal(loader.getDiagnostics().loadedPageCount, 1);
});

test('HierarchyLoader follows intersecting pages but skips a sibling', async () => {
  const { source, calls } = createIncrementalSource();
  const loader = new HierarchyLoader(source, cubeBounds);

  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });

  assert.deepEqual(calls, ['0-0-0-0', '1-0-0-0']);
});

test('HierarchyLoader reuses pages and loads more when maxLevel increases', async () => {
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
  assert.deepEqual(calls, ['0-0-0-0', '1-0-0-0']);
  assert.ok(loader.getDiagnostics().pageCacheHits > firstDiagnostics.pageCacheHits);

  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 2,
  });
  assert.deepEqual(calls, ['0-0-0-0', '1-0-0-0', '2-0-0-0']);

  await loader.query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });
  assert.deepEqual(calls, ['0-0-0-0', '1-0-0-0', '2-0-0-0']);
});

test('HierarchyLoader expands the cache when a query moves to another region', async () => {
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

  assert.deepEqual(calls, ['0-0-0-0', '1-0-0-0', '1-1-0-0']);
});

test('HierarchyLoader surfaces a malformed child page and can reset its cache', async () => {
  const { source, calls } = createIncrementalSource();
  const originalLoad = source.loadHierarchyPage;
  source.loadHierarchyPage = async (page) => {
    if (page.key === '1-0-0-0') {
      throw new Error('malformed child page');
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
  assert.deepEqual(loader.getDiagnostics(), {
    pageRequests: 0,
    pageCacheHits: 0,
    hierarchyBytesFetched: 0,
    loadedPageCount: 0,
    loadedEntryCount: 0,
  });
  assert.deepEqual(calls, ['0-0-0-0']);
});

test('a partial query requests fewer hierarchy pages than forced full traversal', async () => {
  const partial = createIncrementalSource();
  const full = createIncrementalSource();

  await new HierarchyLoader(partial.source, cubeBounds).query({
    bounds: { ...cubeBounds, maxX: 3.9 },
    maxLevel: 1,
  });
  await new HierarchyLoader(full.source, cubeBounds).load();

  assert.ok(partial.calls.length < full.calls.length);
});

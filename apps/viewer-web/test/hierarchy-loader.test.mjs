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

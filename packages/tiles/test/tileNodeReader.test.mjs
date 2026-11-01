import assert from 'node:assert/strict';
import test from 'node:test';
import { createExperimentalETilePointView } from '../src/input/tilePointView.ts';
import { TileNodeReader, } from '../src/source/tileNodeReader.ts';
import { TileNodeReaderError } from '../src/source/tileNodeSource.ts';

const context = (nodeKey) => ({
  sourceIdentity: 'fixture-source',
  nodeKey,
  transformGeneration: 4,
  sourceCrs: { status: 'identified', identifier: 'EPSG:4978', horizontalUnit: 'metre', verticalUnit: 'metre' },
  verticalDatum: { status: 'verified', identifier: 'WGS 84 ellipsoidal height', corrections: [] },
  heightOffsetMeters: 0,
});

const node = (key, pointCount = 2, childrenComplete = true) => ({
  key,
  level: key === 'root' ? 0 : 1,
  x: 0,
  y: 0,
  z: 0,
  pointCount,
  pointDataOffset: pointCount === 0 ? 0 : 128,
  pointDataLength: pointCount === 0 ? 0 : pointCount * 24,
  children: [],
  childrenComplete,
});

const page = (key, offset) => ({ key, pageOffset: offset, pageLength: 32 });

class FixtureSource {
  sourceIdentity = 'fixture-source';
  transformGeneration = 4;
  current = true;
  pageCalls = [];
  nodeCalls = [];

  constructor(pages = undefined) {
    this.pages = pages ?? new Map([
      ['root-page', { nodes: [node('root', 0, false)], pages: [page('left-page', 32), page('right-page', 64)] }],
      ['left-page', { nodes: [node('left')], pages: [page('left-child-page', 96)] }],
      ['right-page', { nodes: [node('right')], pages: [] }],
      ['left-child-page', { nodes: [node('left-child')], pages: [] }],
    ]);
  }

  isCurrent() { return this.current; }
  getRootHierarchyPage() { return page('root-page', 0); }

  async loadHierarchyPage(hierarchyPage, signal) {
    this.pageCalls.push(hierarchyPage.key);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const result = this.pages.get(hierarchyPage.key);
    if (!result) throw new Error(`damaged hierarchy range: ${hierarchyPage.key}`);
    return result;
  }

  async loadNode(hierarchyNode, selection, signal) {
    this.nodeCalls.push(hierarchyNode.key);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const count = hierarchyNode.pointCount;
    const attrs = {
      ...(selection.attributes?.rgb ? {
        red: new Uint16Array(count).fill(20),
        green: new Uint16Array(count).fill(40),
        blue: new Uint16Array(count).fill(60),
      } : {}),
      ...(selection.attributes?.intensity ? { intensity: new Uint16Array(count).fill(100) } : {}),
      ...(selection.attributes?.classification ? { classification: new Uint8Array(count).fill(2) } : {}),
    };
    return createExperimentalETilePointView({
      pointCount: count,
      ecef: new Float64Array(count * 3).fill(6378137),
      height: new Float64Array(count).fill(12.5),
      ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
    }, context(hierarchyNode.key), {
      sourceIdentity: this.sourceIdentity,
      transformGeneration: this.transformGeneration,
    }, selection);
  }
}

function assertReaderError(code, operation) {
  return assert.rejects(operation, (error) => error instanceof TileNodeReaderError && error.code === code);
}

test('reads only requested nodes, deduplicates duplicate keys, and stops hierarchy traversal early', async () => {
  const source = new FixtureSource();
  const reader = new TileNodeReader(source);
  const result = await reader.readNodes(['left', 'left'], { attributes: { rgb: true } });
  assert.deepEqual([...result.keys()], ['left']);
  assert.deepEqual(source.pageCalls, ['root-page', 'left-page']);
  assert.deepEqual(source.nodeCalls, ['left']);
  assert.equal(result.get('left').attributes.red[0], 20);
});

test('loads distinct requested node data once and returns results in request order', async () => {
  const source = new FixtureSource();
  const result = await new TileNodeReader(source).readNodes(['right', 'left']);
  assert.deepEqual([...result.keys()], ['right', 'left']);
  assert.deepEqual(source.nodeCalls.sort(), ['left', 'right']);
});

test('requested-node reads do not retain hierarchy records for later calls', async () => {
  const source = new FixtureSource();
  const reader = new TileNodeReader(source);

  await reader.readNodes(['left']);
  await assertReaderError('NODE_NOT_FOUND', reader.readNode(node('left')));
  assert.deepEqual(source.pageCalls, ['root-page', 'left-page']);
  assert.deepEqual(source.nodeCalls, ['left']);
});

test('does not treat incomplete child discovery as a proven missing node', async () => {
  const source = new FixtureSource(new Map([
    ['root-page', { nodes: [node('root', 0, false)], pages: [] }],
  ]));
  await assertReaderError('INCOMPLETE_HIERARCHY', new TileNodeReader(source).readNodes(['unknown']));
});

test('reports a missing node only after complete bounded hierarchy traversal', async () => {
  const source = new FixtureSource(new Map([
    ['root-page', { nodes: [node('root', 0, true)], pages: [] }],
  ]));
  await assertReaderError('NODE_NOT_FOUND', new TileNodeReader(source).readNodes(['unknown']));
});

test('does not read point ranges for a caller-fabricated hierarchy node', async () => {
  const source = new FixtureSource();
  const reader = new TileNodeReader(source);
  await assertReaderError('NODE_NOT_FOUND', reader.readNode(node('fabricated')));
  assert.deepEqual(source.nodeCalls, []);
  assert.deepEqual(source.pageCalls, []);
});

test('stops at the configured hierarchy page bound', async () => {
  const source = new FixtureSource(new Map([
    ['root-page', { nodes: [node('root', 0, false)], pages: [page('p1', 32), page('p2', 64), page('p3', 96)] }],
    ['p1', { nodes: [], pages: [] }],
    ['p2', { nodes: [], pages: [] }],
    ['p3', { nodes: [node('target')], pages: [] }],
  ]));
  await assertReaderError('HIERARCHY_LIMIT', new TileNodeReader(source, { maxHierarchyPages: 2 }).readNodes(['target']));
  assert.deepEqual(source.pageCalls, ['root-page']);
});

test('rejects malformed hierarchy ranges before point access', async () => {
  const source = new FixtureSource();
  source.getRootHierarchyPage = () => ({ key: 'bad', pageOffset: Number.MAX_SAFE_INTEGER, pageLength: 32 });
  await assertReaderError('INVALID_HIERARCHY_PAGE', new TileNodeReader(source).readNodes(['left']));
  assert.deepEqual(source.pageCalls, []);
});

test('rejects unsafe chunk ranges and over-budget nodes before loading points', async () => {
  const source = new FixtureSource(new Map([
    ['root-page', { nodes: [{ ...node('too-large'), pointDataOffset: Number.MAX_SAFE_INTEGER, pointDataLength: 2 }], pages: [] }],
  ]));
  await assertReaderError('INVALID_HIERARCHY_NODE', new TileNodeReader(source).readNodes(['too-large']));
  assert.deepEqual(source.nodeCalls, []);

  const bigSource = new FixtureSource(new Map([
    ['root-page', { nodes: [node('big', 5)], pages: [] }],
  ]));
  await assertReaderError('POINT_DATA_LIMIT', new TileNodeReader(bigSource, { maxPointsPerNode: 4 }).readNodes(['big']));
  assert.deepEqual(bigSource.nodeCalls, []);
});

test('checks pre-aborted signals before fetching hierarchy pages', async () => {
  const source = new FixtureSource();
  const controller = new AbortController();
  controller.abort();
  await assertReaderError('ABORTED', new TileNodeReader(source).readNodes(['left'], {}, { signal: controller.signal }));
  assert.deepEqual(source.pageCalls, []);
});

test('checks cancellation and source generation after a hierarchy request resolves', async () => {
  let release;
  const source = new FixtureSource();
  source.loadHierarchyPage = async () => new Promise((resolve) => { release = () => resolve({ nodes: [node('left')], pages: [] }); });
  const controller = new AbortController();
  const pending = new TileNodeReader(source).readNodes(['left'], {}, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  release();
  await assertReaderError('ABORTED', pending);
  assert.deepEqual(source.nodeCalls, []);

  const stale = new FixtureSource();
  stale.loadHierarchyPage = async () => {
    stale.transformGeneration += 1;
    return { nodes: [node('left')], pages: [] };
  };
  await assertReaderError('STALE_SOURCE', new TileNodeReader(stale).readNodes(['left']));
  assert.deepEqual(stale.nodeCalls, []);
});

test('rejects point views with stale or mismatched node identity', async () => {
  const source = new FixtureSource();
  source.loadNode = async (requestedNode) => createExperimentalETilePointView({
    pointCount: requestedNode.pointCount,
    ecef: new Float64Array(requestedNode.pointCount * 3),
    height: new Float64Array(requestedNode.pointCount),
  }, context('some-other-node'), {
    sourceIdentity: source.sourceIdentity,
    transformGeneration: source.transformGeneration,
  });
  await assertReaderError('NODE_CONTENT_MISMATCH', new TileNodeReader(source).readNodes(['left']));
});

test('aborting an active point request cancels follow-on node work', async () => {
  let loadStarted;
  const started = new Promise((resolve) => { loadStarted = resolve; });
  const source = new FixtureSource();
  source.loadNode = async (_node, _selection, signal) => new Promise((resolve, reject) => {
    loadStarted();
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const controller = new AbortController();
  const pending = new TileNodeReader(source).readNodes(['left'], {}, { signal: controller.signal });
  await started;
  controller.abort();
  await assertReaderError('ABORTED', pending);
});

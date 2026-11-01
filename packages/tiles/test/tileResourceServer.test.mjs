import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaticTileResourceProvider, createTileResourceServer, TileResourceServerError } from '../src/resources/tileResourceServer.ts';

const bytes = (text) => new TextEncoder().encode(text);
const req = (path, init) => new Request(`https://tiles.example.test${path}`, init);
const delay = (duration = 0) => new Promise((resolve) => setTimeout(resolve, duration));

function controlledProvider(sourceIdentity, initialResources = {}) {
  let generation = 1;
  const resources = new Map(Object.entries(initialResources).map(([uri, value]) => [uri, bytes(value)]));
  let calls = 0;
  let closeCalls = 0;
  let current = true;
  return {
    provider: {
      sourceIdentity,
      get generation() { return generation; },
      isCurrent: () => current,
      getResource: async (uri, signal) => {
        calls += 1;
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        return resources.get(uri);
      },
      close: () => { closeCalls += 1; current = false; },
    },
    calls: () => calls,
    closeCalls: () => closeCalls,
    setGeneration: (value) => { generation = value; },
    setCurrent: (value) => { current = value; },
  };
}

test('serves URL-addressable resources with standard MIME types, HEAD, and safe route handling', async () => {
  const provider = createStaticTileResourceProvider('static-fixture', 1, [
    { uri: 'tileset.json', bytes: bytes('{"asset":{"version":"1.1"}}') },
    { uri: 'content/0/0/0/0.glb', bytes: bytes('glb-bytes') },
    { uri: 'subtrees/0/0/0/0.subtree', bytes: new Uint8Array([115, 117, 98, 116]) },
  ]);
  const server = createTileResourceServer(provider, { basePath: '/tiles/' });
  try {
    const root = await server.handle(req('/tiles/'));
    assert.equal(root.status, 200);
    assert.equal(root.headers.get('content-type'), 'application/json');
    assert.equal(await root.text(), '{"asset":{"version":"1.1"}}');
    assert.equal(root.headers.get('cache-control'), 'no-store');

    const glb = await server.handle(req('/tiles/content/0/0/0/0.glb'));
    assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(await glb.text(), 'glb-bytes');
    const subtree = await server.handle(req('/tiles/subtrees/0/0/0/0.subtree'));
    assert.equal(subtree.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...new Uint8Array(await subtree.arrayBuffer())], [115, 117, 98, 116]);

    const head = await server.handle(req('/tiles/content/0/0/0/0.glb', { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes('glb-bytes').byteLength));
    assert.equal(await head.text(), '');
    assert.equal((await server.handle(req('/tiles/missing.glb'))).status, 404);
    assert.equal((await server.handle(req('/tiles/content%2fescape.glb'))).status, 400);
    assert.equal((await server.handle(req('/tiles/%252e%252e/secret'))).status, 400);
    assert.equal((await server.handle(req('/outside/tileset.json'))).status, 400);
    assert.equal((await server.handle(req('/tiles/content.glb', { method: 'POST' }))).status, 405);
    assert.equal((await server.handle(req('/tiles/content.glb', { method: 'POST' }))).headers.get('allow'), 'GET, HEAD');
  } finally {
    await server.close();
  }
});

test('deduplicates concurrent resource reads and serves repeat requests from the bounded cache', async () => {
  let reads = 0;
  const provider = {
    sourceIdentity: 'dedupe-fixture',
    generation: 1,
    getResource: async (uri, signal) => {
      reads += 1;
      await delay(10);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return uri === 'points.glb' ? bytes('same-content') : undefined;
    },
  };
  const server = createTileResourceServer(provider, { maxCacheBytes: 32, maxCacheEntries: 1 });
  try {
    const [first, second] = await Promise.all([
      server.handle(req('/points.glb')),
      server.handle(req('/points.glb')),
    ]);
    assert.equal(await first.text(), 'same-content');
    assert.equal(await second.text(), 'same-content');
    assert.equal(reads, 1);
    assert.equal(server.getStats().cacheEntries, 1);
    assert.equal(server.getStats().cacheBytes, bytes('same-content').byteLength);
    await server.handle(req('/points.glb'));
    assert.equal(reads, 1);
  } finally {
    await server.close();
  }
});

test('applies LRU eviction and never exceeds configured cache bytes or entries', async () => {
  const fixture = controlledProvider('lru-fixture', { 'a.glb': 'aa', 'b.glb': 'bb', 'c.glb': 'cc' });
  const server = createTileResourceServer(fixture.provider, { maxCacheBytes: 4, maxCacheEntries: 2 });
  try {
    await (await server.handle(req('/a.glb'))).arrayBuffer();
    await (await server.handle(req('/b.glb'))).arrayBuffer();
    await (await server.handle(req('/a.glb'))).arrayBuffer();
    await (await server.handle(req('/c.glb'))).arrayBuffer();
    assert.equal(server.getStats().cacheBytes, 4);
    assert.equal(server.getStats().cacheEntries, 2);
    await (await server.handle(req('/a.glb'))).arrayBuffer();
    await (await server.handle(req('/b.glb'))).arrayBuffer();
    assert.equal(fixture.calls(), 4);
    assert.ok(server.getStats().cacheBytes <= 4);
    assert.ok(server.getStats().cacheEntries <= 2);
  } finally {
    await server.close();
  }
});

test('automatically invalidates cached resources when a provider generation changes', async () => {
  let generation = 1;
  let reads = 0;
  const provider = {
    sourceIdentity: 'generation-fixture',
    get generation() { return generation; },
    getResource: async () => {
      reads += 1;
      return bytes(`generation-${generation}`);
    },
  };
  const server = createTileResourceServer(provider);
  try {
    assert.equal(await (await server.handle(req('/tile.glb'))).text(), 'generation-1');
    generation = 2;
    assert.equal(await (await server.handle(req('/tile.glb'))).text(), 'generation-2');
    assert.equal(reads, 2);
    assert.equal(server.getStats().cacheEntries, 1);
  } finally {
    await server.close();
  }
});

test('cancels a shared load only after its final request subscriber aborts', async () => {
  let readCount = 0;
  let providerSignal;
  let startedResolve;
  let resultResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const provider = {
    sourceIdentity: 'shared-cancel-fixture',
    generation: 1,
    getResource: (_uri, signal) => {
      readCount += 1;
      providerSignal = signal;
      startedResolve();
      return new Promise((resolve, reject) => {
        resultResolve = resolve;
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  };
  const server = createTileResourceServer(provider);
  const firstController = new AbortController();
  const secondController = new AbortController();
  try {
    const first = server.handle(req('/same.glb', { signal: firstController.signal }));
    const second = server.handle(req('/same.glb', { signal: secondController.signal }));
    await started;
    firstController.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(providerSignal.aborted, false);
    assert.equal(readCount, 1);
    resultResolve(bytes('shared'));
    assert.equal(await (await second).text(), 'shared');
    assert.equal(providerSignal.aborted, false);
  } finally {
    await server.close();
  }
});

test('starts a fresh load when the previous request for the same URI is still settling after abort', async () => {
  let reads = 0;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const provider = {
    sourceIdentity: 'aborted-retry-fixture',
    generation: 1,
    getResource: (uri, signal) => {
      reads += 1;
      if (reads > 1) return Promise.resolve(bytes(`retry-${uri}`));
      startedResolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 25);
        }, { once: true });
      });
    },
  };
  const server = createTileResourceServer(provider, { maxConcurrentLoads: 1, maxQueuedLoads: 1 });
  const controller = new AbortController();
  try {
    const first = server.handle(req('/retry.glb', { signal: controller.signal }));
    await started;
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });

    const second = await server.handle(req('/retry.glb'));
    assert.equal(second.status, 200);
    assert.equal(await second.text(), 'retry-retry.glb');
    assert.equal(reads, 2);
    await delay(35);
    assert.equal(server.getStats().inFlightLoads, 0);
  } finally {
    await server.close();
  }
});

test('aborts provider work when the only subscriber cancels and invalidates old generations on switch', async () => {
  let providerSignal;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const oldProvider = {
    sourceIdentity: 'old-generation',
    generation: 1,
    getResource: (_uri, signal) => {
      providerSignal = signal;
      startedResolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  };
  const server = createTileResourceServer(oldProvider);
  const abortController = new AbortController();
  try {
    const pending = server.handle(req('/cancel.glb', { signal: abortController.signal }));
    await started;
    abortController.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(providerSignal.aborted, true);

    let switchSignal;
    let switchStartedResolve;
    const switchStarted = new Promise((resolve) => { switchStartedResolve = resolve; });
    const switchProvider = {
      sourceIdentity: 'switching-source',
      generation: 1,
      getResource: (_uri, signal) => {
        switchSignal = signal;
        switchStartedResolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
    };
    await server.switchSource(switchProvider);
    const stale = server.handle(req('/switch.glb'));
    await switchStarted;
    await server.switchSource(controlledProvider('new-generation', { 'switch.glb': 'new' }).provider);
    assert.equal(switchSignal.aborted, true);
    assert.equal((await stale).status, 410);
    const newResponse = await server.handle(req('/switch.glb'));
    assert.equal(await newResponse.text(), 'new');
  } finally {
    await server.close();
  }
});

test('returns bounded overload and payload errors and closes an owned provider once', async () => {
  const fixture = controlledProvider('limit-fixture', { 'large.glb': '12345' });
  const server = createTileResourceServer(fixture.provider, { maxResourceBytes: 4, closeProviderOnShutdown: true });
  assert.equal((await server.handle(req('/large.glb'))).status, 502);
  await server.close();
  await server.close();
  assert.equal(fixture.closeCalls(), 1);
  assert.equal((await server.handle(req('/large.glb'))).status, 503);
  await assert.rejects(server.switchSource(controlledProvider('replacement').provider), TileResourceServerError);
  assert.equal(server.getStats().closed, true);
});

test('bounds simultaneous distinct node loads and rejects excess queue work', async () => {
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  let firstResolve;
  const provider = {
    sourceIdentity: 'queue-limit-fixture',
    generation: 1,
    getResource: async (uri, signal) => {
      if (uri === 'first.glb') {
        firstStartedResolve();
        return new Promise((resolve, reject) => {
          firstResolve = resolve;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      return bytes('second');
    },
  };
  const server = createTileResourceServer(provider, { maxConcurrentLoads: 1, maxQueuedLoads: 0 });
  try {
    const first = server.handle(req('/first.glb'));
    await firstStarted;
    assert.equal((await server.handle(req('/second.glb'))).status, 503);
    firstResolve(bytes('first'));
    assert.equal(await (await first).text(), 'first');
  } finally {
    await server.close();
  }
});

test('rejects malformed static manifests and excessive configuration before allocation', () => {
  assert.throws(() => createStaticTileResourceProvider('bad', 0, [{ uri: '../escape.glb', bytes: bytes('x') }]), TileResourceServerError);
  assert.throws(() => createStaticTileResourceProvider('large', 0, [{ uri: 'a.glb', bytes: bytes('123') }], { maxTotalBytes: 2 }), TileResourceServerError);
  assert.throws(() => createTileResourceServer(controlledProvider('limits').provider, { maxCacheBytes: 512 * 1024 * 1024 + 1 }), TileResourceServerError);
});

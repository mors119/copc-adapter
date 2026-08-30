import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPerspectiveViewFrustum,
  createStreamingViewBounds,
  ecefToGeographic,
  geographicToEcef,
} from '../src/viewer/streaming/view.ts';
import { HierarchyLoader } from '../src/copc/hierarchy/index.ts';

const cameraPosition = geographicToEcef({
  longitude: 0,
  latitude: 0,
  height: 1000,
});

function createFrustum({
  direction = { x: 0, y: 1, z: 0 },
  verticalFovRadians = Math.PI / 6,
  aspectRatio = 1,
  farMeters = 1000,
} = {}) {
  return createPerspectiveViewFrustum({
    position: cameraPosition,
    direction,
    up: { x: 0, y: 0, z: 1 },
    right: direction.y === 0
      ? { x: 0, y: direction.x < 0 ? 1 : -1, z: 0 }
      : { x: direction.y < 0 ? 1 : -1, y: 0, z: 0 },
    verticalFovRadians,
    aspectRatio,
    nearMeters: 10,
    farMeters,
  });
}

function createViewBounds(overrides = {}) {
  return createStreamingViewBounds({
    camera: {
      longitude: 0,
      latitude: 0,
      height: 1000,
    },
    viewDistanceMeters: 2000,
    maxRenderDistanceMeters: 1000,
    viewFrustum: createFrustum({ direction: { x: 0, y: 1, z: 0 } }),
    ...overrides,
  });
}

function assertFiniteBounds(bounds) {
  for (const value of Object.values(bounds)) {
    assert.equal(Number.isFinite(value), true);
  }
}

test('ECEF/geographic conversion is deterministic and round-trips a camera position', () => {
  const geographic = {
    longitude: 12.5,
    latitude: 44.25,
    height: 1234.5,
  };
  const result = ecefToGeographic(geographicToEcef(geographic));

  assert.ok(Math.abs(result.longitude - geographic.longitude) < 1e-10);
  assert.ok(Math.abs(result.latitude - geographic.latitude) < 1e-10);
  assert.ok(Math.abs(result.height - geographic.height) < 1e-6);
});

test('same camera position with different directions changes the query region', () => {
  const down = createViewBounds({
    viewFrustum: createFrustum({ direction: { x: -1, y: 0, z: 0 } }),
  }).bounds;
  const east = createViewBounds({
    viewFrustum: createFrustum({ direction: { x: 0, y: 1, z: 0 } }),
  }).bounds;
  const west = createViewBounds({
    viewFrustum: createFrustum({ direction: { x: 0, y: -1, z: 0 } }),
  }).bounds;

  assert.ok(east.maxX > down.maxX);
  assert.ok(west.minX < down.minX);
  assert.ok(east.maxX - west.maxX > 0.005);
  assert.ok(east.minX - west.minX > 0.005);
});

test('an oblique forward point is included while the behind-camera region is not the target', () => {
  const direction = { x: 0, y: 1, z: 0 };
  const result = createViewBounds({
    viewFrustum: createFrustum({ direction }),
  });
  const forward = ecefToGeographic({
    x: cameraPosition.x,
    y: cameraPosition.y + 500,
    z: cameraPosition.z,
  });
  const behind = ecefToGeographic({
    x: cameraPosition.x,
    y: cameraPosition.y - 500,
    z: cameraPosition.z,
  });

  assert.ok(result.bounds.minX <= forward.longitude);
  assert.ok(result.bounds.maxX >= forward.longitude);
  assert.ok(result.bounds.minX > behind.longitude);
});

test('FOV and aspect ratio expand the view envelope in the expected direction', () => {
  const narrow = createViewBounds({
    viewFrustum: createFrustum({
      direction: { x: -1, y: 0, z: 0 },
      verticalFovRadians: Math.PI / 12,
    }),
  }).bounds;
  const wideFov = createViewBounds({
    viewFrustum: createFrustum({
      direction: { x: -1, y: 0, z: 0 },
      verticalFovRadians: Math.PI / 3,
    }),
  }).bounds;
  const wideViewport = createViewBounds({
    viewFrustum: createFrustum({
      direction: { x: -1, y: 0, z: 0 },
      aspectRatio: 2,
    }),
  }).bounds;

  assert.ok(wideFov.maxX > narrow.maxX);
  assert.ok(wideFov.minX < narrow.minX);
  assert.ok(wideViewport.maxX > narrow.maxX);
  assert.ok(wideViewport.minX < narrow.minX);
});

test('distance constraint extends the query forward instead of only around the camera', () => {
  const near = createViewBounds({ maxRenderDistanceMeters: 200 }).bounds;
  const far = createViewBounds({ maxRenderDistanceMeters: 1000 }).bounds;

  assert.ok(far.maxX > near.maxX);
});

test('the padded envelope retains a point on the calculated view edge', () => {
  const result = createViewBounds();
  const halfWidth = Math.tan(Math.PI / 12) * 1000;
  const edge = ecefToGeographic({
    x: cameraPosition.x - halfWidth,
    y: cameraPosition.y + 1000,
    z: cameraPosition.z + halfWidth,
  });

  assert.ok(result.bounds.maxX >= edge.longitude);
  assertFiniteBounds(result.bounds);
});

test('invalid or missing frustums use a finite deterministic camera fallback', () => {
  const fallbackInput = {
    camera: { longitude: 3, latitude: 4, height: 5 },
    viewDistanceMeters: 600,
    maxRenderDistanceMeters: 100,
  };
  const missing = createStreamingViewBounds(fallbackInput);
  const invalid = createStreamingViewBounds({
    ...fallbackInput,
    viewFrustum: {
      coordinateSystem: 'wgs84-ecef-meters',
      position: { x: Number.NaN, y: 0, z: 0 },
    },
  });

  assert.equal(missing.mode, 'camera-fallback');
  assert.deepEqual(invalid, missing);
  assertFiniteBounds(missing.bounds);
});

function createPagedSource() {
  const calls = [];
  const pages = {
    root: {
      nodes: [{
        key: '0-0-0-0',
        level: 0,
        x: 0,
        y: 0,
        z: 0,
        pointCount: 100,
        pointDataOffset: 0,
        pointDataLength: 10,
      }],
      pages: [
        { key: '2-0-0-0', pageOffset: 100, pageLength: 20 },
        { key: '2-2-0-0', pageOffset: 200, pageLength: 20 },
      ],
    },
    west: {
      nodes: [{
        key: '2-0-0-0',
        level: 2,
        x: 0,
        y: 0,
        z: 0,
        pointCount: 50,
        pointDataOffset: 10,
        pointDataLength: 10,
      }],
      pages: [],
    },
    east: {
      nodes: [{
        key: '2-2-0-0',
        level: 2,
        x: 2,
        y: 0,
        z: 0,
        pointCount: 50,
        pointDataOffset: 20,
        pointDataLength: 10,
      }],
      pages: [],
    },
  };
  const pageByKey = {
    '0-0-0-0': pages.root,
    '2-0-0-0': pages.west,
    '2-2-0-0': pages.east,
  };

  return {
    calls,
    source: {
      getRootHierarchyPage() {
        return { key: '0-0-0-0', pageOffset: 0, pageLength: 20 };
      },
      async loadHierarchyPage(page) {
        calls.push(page.key);
        return pageByKey[page.key];
      },
    },
  };
}

function createPagedViewBounds(direction) {
  const position = geographicToEcef({ longitude: 15, latitude: 0, height: 1000 });
  const viewFrustum = createPerspectiveViewFrustum({
    position,
    direction,
    up: { x: 0, y: 0, z: 1 },
    right: direction.y > 0
      ? { x: -1, y: 0, z: 0 }
      : { x: 1, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 18,
    aspectRatio: 1,
    nearMeters: 10,
    farMeters: 2_000_000,
  });

  return createStreamingViewBounds({
    camera: { longitude: 15, latitude: 0, height: 1000 },
    viewDistanceMeters: 2_000_000,
    maxRenderDistanceMeters: 2_000_000,
    viewFrustum,
  }).bounds;
}

test('direction-driven query traverses new paged hierarchy regions and reuses the cache', async () => {
  const { source, calls } = createPagedSource();
  const loader = new HierarchyLoader(source, {
    minX: 0,
    minY: -1,
    minZ: 0,
    maxX: 40,
    maxY: 1,
    maxZ: 2000,
  });

  const west = await loader.query({
    bounds: createPagedViewBounds({ x: 0, y: -1, z: 0 }),
    maxLevel: 2,
  });
  assert.deepEqual(calls, ['0-0-0-0', '2-0-0-0']);
  assert.ok(west.nodes.some((node) => node.key === '2-0-0-0'));
  assert.ok(!west.nodes.some((node) => node.key === '2-2-0-0'));

  const east = await loader.query({
    bounds: createPagedViewBounds({ x: 0, y: 1, z: 0 }),
    maxLevel: 2,
  });
  assert.deepEqual(calls, ['0-0-0-0', '2-0-0-0', '2-2-0-0']);
  assert.ok(east.nodes.some((node) => node.key === '2-2-0-0'));
  assert.ok(east.nodes.some((node) => node.key === '2-0-0-0'));
  assert.ok(loader.getDiagnostics().pageCacheHits > 0);
});

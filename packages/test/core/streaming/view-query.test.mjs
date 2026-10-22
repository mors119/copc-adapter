import test from "node:test";
import assert from "node:assert/strict";

import {
  createPerspectiveViewFrustum,
  createStreamingViewBounds,
  ecefToGeographic,
  geographicToEcef,
} from "../../../core/streaming/view.ts";
import { HierarchyLoader } from "../../../core/copc/hierarchy/index.ts";

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
    right:
      direction.y === 0
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

function wrappedLongitudeDifferenceDegrees(actual, expected) {
  const difference = (((actual - expected + 180) % 360) + 360) % 360 - 180;
  return Math.abs(difference);
}

test("ECEF/geographic conversion is deterministic and round-trips a camera position", () => {
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

test("WGS84 ECEF inverse round-trips representative geographic positions", () => {
  const positions = [
    { name: "equator", longitude: 0, latitude: 0, height: 0 },
    { name: "Korea", longitude: 127.0276, latitude: 37.4979, height: 32 },
    { name: "Oregon", longitude: -123.1, latitude: 44.05, height: 125 },
    {
      name: "southern hemisphere",
      longitude: 151.2,
      latitude: -33.9,
      height: 250,
    },
    {
      name: "near north pole",
      longitude: 170,
      latitude: 89.999999,
      height: 400,
    },
    {
      name: "near south pole",
      longitude: -170,
      latitude: -89.999999,
      height: -100,
    },
    {
      name: "positive 180-degree meridian",
      longitude: 180,
      latitude: 15,
      height: 0,
    },
    {
      name: "negative 180-degree meridian",
      longitude: -180,
      latitude: -15,
      height: 0,
    },
    {
      name: "east of the date line",
      longitude: 179.999999,
      latitude: 15,
      height: -250,
    },
    {
      name: "west of the date line",
      longitude: -179.999999,
      latitude: -15,
      height: 1_000_000,
    },
    { name: "negative ellipsoidal height", longitude: 10, latitude: 20, height: -500 },
    { name: "geostationary orbit", longitude: -45, latitude: 70, height: 42_000_000 },
  ];

  for (const position of positions) {
    const originalEcef = geographicToEcef(position);
    const restored = ecefToGeographic(originalEcef);
    const restoredEcef = geographicToEcef(restored);
    const ecefRoundTripErrorMeters = Math.hypot(
      originalEcef.x - restoredEcef.x,
      originalEcef.y - restoredEcef.y,
      originalEcef.z - restoredEcef.z,
    );

    // These are double-precision conversion regression bounds, not survey
    // accuracy or vertical-datum guarantees.
    const longitudeError = wrappedLongitudeDifferenceDegrees(
      restored.longitude,
      position.longitude,
    );
    assert.ok(
      longitudeError <= 1e-10,
      `${position.name} longitude error was ${longitudeError} degrees`,
    );
    assert.ok(
      Math.abs(restored.latitude - position.latitude) <= 1e-10,
      `${position.name} latitude error was ${Math.abs(restored.latitude - position.latitude)} degrees`,
    );
    assert.ok(
      Math.abs(restored.height - position.height) <= 1e-6,
      `${position.name} ellipsoidal-height error was ${Math.abs(restored.height - position.height)} metres`,
    );
    assert.ok(
      ecefRoundTripErrorMeters <= 1e-6,
      `${position.name} ECEF round-trip error was ${ecefRoundTripErrorMeters} metres`,
    );
  }
});

test("ECEF inverse treats exact-pole longitude as non-unique", () => {
  const north = geographicToEcef({ longitude: 75, latitude: 90, height: 12 });
  const south = geographicToEcef({ longitude: -130, latitude: -90, height: -20 });
  const restoredNorth = ecefToGeographic({ x: 0, y: 0, z: north.z });
  const restoredSouth = ecefToGeographic({ x: 0, y: 0, z: south.z });

  assert.equal(restoredNorth.longitude, 0);
  assert.equal(restoredSouth.longitude, 0);
  assert.equal(restoredNorth.latitude, 90);
  assert.equal(restoredSouth.latitude, -90);
  assert.ok(Math.abs(restoredNorth.height - 12) <= 1e-6);
  assert.ok(Math.abs(restoredSouth.height + 20) <= 1e-6);
});

test("ECEF inverse rejects non-finite, unrepresentable, and undefined inputs", () => {
  for (const point of [
    { x: Number.NaN, y: 0, z: 0 },
    { x: 0, y: Number.POSITIVE_INFINITY, z: 0 },
    { x: 0, y: 0, z: Number.NEGATIVE_INFINITY },
  ]) {
    assert.throws(() => ecefToGeographic(point), /finite coordinates/);
  }

  assert.throws(
    () => ecefToGeographic({ x: 0, y: 0, z: 0 }),
    /no unique geographic position/,
  );
  assert.throws(
    () =>
      ecefToGeographic({
        x: Number.MAX_VALUE,
        y: Number.MAX_VALUE,
        z: 0,
      }),
    /outside the supported range/,
  );
});

test("interior ECEF frustum corners retain finite geographic bounds", () => {
  const interiorPosition = { x: -34_066, y: 21_591, z: 5_463 };
  const geographic = ecefToGeographic(interiorPosition);

  assertFiniteBounds(geographic);

  const result = createStreamingViewBounds({
    camera: { longitude: 0, latitude: 0, height: 0 },
    viewDistanceMeters: 1000,
    maxRenderDistanceMeters: 1000,
    viewFrustum: {
      coordinateSystem: "wgs84-ecef-meters",
      position: interiorPosition,
      direction: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      right: { x: 1, y: 0, z: 0 },
      planes: [],
      verticalFovRadians: Math.PI / 6,
      viewportHeightPixels: 1080,
      aspectRatio: 1,
      nearMeters: 1,
      farMeters: 1000,
    },
  });

  assert.equal(result.mode, "frustum");
  assertFiniteBounds(result.bounds);
});

test("same camera position with different directions changes the query region", () => {
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

test("an oblique forward point is included while the behind-camera region is not the target", () => {
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

test("FOV and aspect ratio expand the view envelope in the expected direction", () => {
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

test("distance constraint extends the query forward instead of only around the camera", () => {
  const near = createViewBounds({ maxRenderDistanceMeters: 200 }).bounds;
  const far = createViewBounds({ maxRenderDistanceMeters: 1000 }).bounds;

  assert.ok(far.maxX > near.maxX);
});

test("the padded envelope retains a point on the calculated view edge", () => {
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

test("invalid or missing frustums use a finite deterministic camera fallback", () => {
  const fallbackInput = {
    camera: { longitude: 3, latitude: 4, height: 5 },
    viewDistanceMeters: 600,
    maxRenderDistanceMeters: 100,
  };
  const missing = createStreamingViewBounds(fallbackInput);
  const invalid = createStreamingViewBounds({
    ...fallbackInput,
    viewFrustum: {
      coordinateSystem: "wgs84-ecef-meters",
      position: { x: Number.NaN, y: 0, z: 0 },
    },
  });

  assert.equal(missing.mode, "camera-fallback");
  assert.deepEqual(invalid, missing);
  assertFiniteBounds(missing.bounds);
});

test("dateline-crossing view bounds remain conservative with the single-AABB query contract", () => {
  const position = geographicToEcef({
    longitude: 179.999,
    latitude: 0,
    height: 1000,
  });
  const viewFrustum = createPerspectiveViewFrustum({
    position,
    direction: { x: 0, y: -1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    right: { x: 1, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 6,
    aspectRatio: 1,
    nearMeters: 10,
    farMeters: 1000,
  });
  const result = createStreamingViewBounds({
    camera: { longitude: 179.999, latitude: 0, height: 1000 },
    viewDistanceMeters: 2000,
    maxRenderDistanceMeters: 1000,
    viewFrustum,
  });

  assert.equal(result.bounds.minX, -180);
  assert.equal(result.bounds.maxX, 180);
  assertFiniteBounds(result.bounds);
});

function createPagedSource() {
  const calls = [];
  const pages = {
    root: {
      nodes: [
        {
          key: "0-0-0-0",
          level: 0,
          x: 0,
          y: 0,
          z: 0,
          pointCount: 100,
          pointDataOffset: 0,
          pointDataLength: 10,
        },
      ],
      pages: [
        { key: "2-0-0-0", pageOffset: 100, pageLength: 20 },
        { key: "2-2-0-0", pageOffset: 200, pageLength: 20 },
      ],
    },
    west: {
      nodes: [
        {
          key: "2-0-0-0",
          level: 2,
          x: 0,
          y: 0,
          z: 0,
          pointCount: 50,
          pointDataOffset: 10,
          pointDataLength: 10,
        },
      ],
      pages: [],
    },
    east: {
      nodes: [
        {
          key: "2-2-0-0",
          level: 2,
          x: 2,
          y: 0,
          z: 0,
          pointCount: 50,
          pointDataOffset: 20,
          pointDataLength: 10,
        },
      ],
      pages: [],
    },
  };
  const pageByKey = {
    "0-0-0-0": pages.root,
    "2-0-0-0": pages.west,
    "2-2-0-0": pages.east,
  };

  return {
    calls,
    source: {
      getRootHierarchyPage() {
        return { key: "0-0-0-0", pageOffset: 0, pageLength: 20 };
      },
      async loadHierarchyPage(page) {
        calls.push(page.key);
        return pageByKey[page.key];
      },
    },
  };
}

function createPagedViewBounds(direction) {
  const position = geographicToEcef({
    longitude: 15,
    latitude: 0,
    height: 1000,
  });
  const viewFrustum = createPerspectiveViewFrustum({
    position,
    direction,
    up: { x: 0, y: 0, z: 1 },
    right: direction.y > 0 ? { x: -1, y: 0, z: 0 } : { x: 1, y: 0, z: 0 },
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

test("direction-driven query traverses new paged hierarchy regions and reuses the cache", async () => {
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
  assert.deepEqual(calls, ["0-0-0-0", "2-0-0-0"]);
  assert.ok(west.nodes.some((node) => node.key === "2-0-0-0"));
  assert.ok(!west.nodes.some((node) => node.key === "2-2-0-0"));

  const east = await loader.query({
    bounds: createPagedViewBounds({ x: 0, y: 1, z: 0 }),
    maxLevel: 2,
  });
  assert.deepEqual(calls, ["0-0-0-0", "2-0-0-0", "2-2-0-0"]);
  assert.ok(east.nodes.some((node) => node.key === "2-2-0-0"));
  assert.ok(east.nodes.some((node) => node.key === "2-0-0-0"));
  assert.ok(loader.getDiagnostics().pageCacheHits > 0);
});

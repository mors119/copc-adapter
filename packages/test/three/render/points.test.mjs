import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as THREE from "three";

import {
  ThreePointRenderer,
  createThreeLocalOrigin,
} from "../../../three/render/ThreePointRenderer.ts";
import { geographicToEcef } from "../../../core/coordinates/transform/worldCoordinates.ts";
import { loadGtxGeoidGrid } from "../../../core/coordinates/transform/verticalGrid.ts";

const ORIGIN = {
  coordinateSystem: "wgs84-ecef-meters",
  x: 10_000,
  y: 20_000,
  z: 30_000,
};

function createPoints(
  values = [
    [10_001, 20_002, 30_003],
    [10_004, 20_005, 30_006],
  ],
) {
  const worldCoordinates = new Float64Array(values.flat());
  return {
    pointCount: values.length,
    // Kept alongside the world buffer to model the shared transformed buffer.
    coordinates: new Float64Array(values.flatMap(() => [-123, 44, 100])),
    coordinateSystem: "wgs84-geographic",
    worldCoordinates,
    worldCoordinateSystem: "wgs84-ecef-meters",
  };
}

function createRenderer() {
  const scene = new THREE.Scene();
  const renderer = new ThreePointRenderer({ localOrigin: ORIGIN });
  renderer.attachTo(scene);
  return { scene, renderer };
}

function spyOnDisposal(object, method = "dispose") {
  let calls = 0;
  const original = object[method].bind(object);
  object[method] = (...args) => {
    calls += 1;
    return original(...args);
  };
  return () => calls;
}

function options(pointSize = 4) {
  return { pointSize };
}

test("adds one local THREE.Points object per active node", () => {
  const { scene, renderer } = createRenderer();

  renderer.addOrUpdateNode("node-a", createPoints(), options());

  assert.equal(scene.children.length, 1);
  assert.equal(scene.children[0], renderer.getRoot());
  assert.equal(renderer.getRoot().children.length, 1);
  assert.ok(renderer.getRoot().children[0] instanceof THREE.Points);
  assert.deepEqual(renderer.getRenderedNodeKeys(), ["node-a"]);
  assert.equal(renderer.getRenderedNodePointCount("node-a"), 2);
  assert.equal(renderer.getRenderedPointCount(), 2);

  const points = renderer.getRoot().children[0];
  const positions = points.geometry.getAttribute("position").array;
  assert.ok(positions instanceof Float32Array);
  assert.deepEqual([...positions], [1, 2, 3, 4, 5, 6]);
  assert.equal(points.userData.copcNodeKey, "node-a");
  assert.equal(points.material.size, 4);
  assert.equal(points.material.sizeAttenuation, false);
  assert.equal(points.material.opacity, 0.9);
  assert.ok(points.geometry.boundingSphere);
});

test("ThreePointRenderer updates layer opacity without replacing geometry", () => {
  const { renderer } = createRenderer();
  renderer.addOrUpdateNode("node-a", createPoints(), options());
  const points = renderer.getRoot().children[0];
  const geometry = points.geometry;

  renderer.setOpacity(0.25);
  assert.equal(points.material.opacity, 0.25);
  assert.equal(points.visible, true);
  assert.equal(points.geometry, geometry);

  renderer.setOpacity(0);
  assert.equal(points.material.opacity, 0);
  assert.equal(points.visible, false);
  renderer.addOrUpdateNode("node-b", createPoints(), options());
  const newPoints = renderer.getRoot().children.find((node) => node.name === "node-b");
  assert.equal(newPoints.material.opacity, 0);
  assert.equal(newPoints.visible, false);

  renderer.setOpacity(1);
  assert.equal(points.material.opacity, 1);
  assert.equal(points.visible, true);
  assert.equal(newPoints.material.opacity, 1);
  assert.equal(newPoints.visible, true);
  renderer.destroy();
});
test("updates a node without leaking its previous geometry or material", () => {
  const { renderer } = createRenderer();
  renderer.addOrUpdateNode("node-a", createPoints(), options());
  const previous = renderer.getRoot().children[0];
  const geometryDisposed = spyOnDisposal(previous.geometry);
  const materialDisposed = spyOnDisposal(previous.material);

  renderer.addOrUpdateNode(
    "node-a",
    createPoints([[10_010, 20_020, 30_030]]),
    options(2),
  );

  assert.equal(geometryDisposed(), 1);
  assert.equal(materialDisposed(), 1);
  assert.equal(renderer.getRoot().children.length, 1);
  assert.equal(renderer.getRenderedNodePointCount("node-a"), 1);
  assert.equal(renderer.getRenderedPointCount(), 1);
  assert.notEqual(renderer.getRoot().children[0], previous);
});

test("removing a node detaches and disposes its adapter-owned resources", () => {
  const { renderer } = createRenderer();
  renderer.addOrUpdateNode("node-a", createPoints(), options());
  const points = renderer.getRoot().children[0];
  const geometryDisposed = spyOnDisposal(points.geometry);
  const materialDisposed = spyOnDisposal(points.material);

  renderer.removeNode("node-a");

  assert.equal(geometryDisposed(), 1);
  assert.equal(materialDisposed(), 1);
  assert.equal(renderer.hasNode("node-a"), false);
  assert.equal(renderer.getRoot().children.length, 0);
  assert.equal(renderer.getRenderedPointCount(), 0);
});

test("clear and destroy remove all adapter-owned objects without touching the scene", () => {
  const { scene, renderer } = createRenderer();
  const lifecycleStages = [];
  const applicationMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  scene.add(applicationMesh);
  renderer.addOrUpdateNode("node-a", createPoints(), {
    ...options(),
    onPerformance: (stage) => lifecycleStages.push(stage),
  });
  renderer.addOrUpdateNode("node-b", createPoints([[10_007, 20_008, 30_009]]), {
    ...options(),
    onPerformance: (stage) => lifecycleStages.push(stage),
  });

  renderer.clear();
  assert.equal(renderer.getRoot().children.length, 0);
  assert.equal(renderer.getRenderedPointCount(), 0);
  assert.equal(scene.children.includes(applicationMesh), true);
  assert.equal(
    lifecycleStages.filter((stage) => stage === "nodeRemoval").length,
    2,
  );

  renderer.addOrUpdateNode(
    "node-c",
    createPoints([[10_010, 20_011, 30_012]]),
    options(),
  );
  renderer.destroy();
  assert.equal(scene.children.includes(applicationMesh), true);
  assert.equal(scene.children.includes(renderer.getRoot()), false);
  assert.equal(renderer.getRenderedNodeKeys().length, 0);
  assert.throws(
    () => renderer.addOrUpdateNode("node-d", createPoints(), options()),
    /destroyed/,
  );
});

test("replacement ordering retains coverage while a new generation is prepared", () => {
  const { renderer } = createRenderer();
  renderer.addOrUpdateNode("parent", createPoints(), options());

  // Refinement: stage children before removing the still-visible parent.
  renderer.addOrUpdateNode(
    "child-a",
    createPoints([[10_001, 20_002, 30_003]]),
    options(),
  );
  renderer.addOrUpdateNode(
    "child-b",
    createPoints([[10_004, 20_005, 30_006]]),
    options(),
  );
  assert.deepEqual(renderer.getRenderedNodeKeys(), [
    "child-a",
    "child-b",
    "parent",
  ]);
  renderer.removeNode("parent");
  assert.deepEqual(renderer.getRenderedNodeKeys(), ["child-a", "child-b"]);

  // Collapse: keep children until the coarse parent is render-ready.
  renderer.addOrUpdateNode("parent", createPoints(), options());
  assert.deepEqual(renderer.getRenderedNodeKeys(), [
    "child-a",
    "child-b",
    "parent",
  ]);
  renderer.removeNode("child-a");
  renderer.removeNode("child-b");
  assert.deepEqual(renderer.getRenderedNodeKeys(), ["parent"]);
});

test("a stale replacement generation cannot mutate the committed node set", () => {
  const { renderer } = createRenderer();
  renderer.addOrUpdateNode("parent", createPoints(), options());

  let committedGeneration = 1;
  const applyReplacement = (generation, add, remove) => {
    if (generation < committedGeneration) {
      return;
    }
    for (const [nodeKey, points] of add) {
      renderer.addOrUpdateNode(nodeKey, points, options());
    }
    for (const nodeKey of remove) {
      renderer.removeNode(nodeKey);
    }
    committedGeneration = generation;
  };

  applyReplacement(
    2,
    [["child", createPoints([[10_001, 20_002, 30_003]])]],
    ["parent"],
  );
  applyReplacement(3, [["parent", createPoints()]], ["child"]);
  applyReplacement(2, [["stale-child", createPoints()]], ["parent"]);

  assert.deepEqual(renderer.getRenderedNodeKeys(), ["parent"]);
  assert.equal(renderer.getRenderedPointCount(), 2);
});

test("metadata local origin uses the dataset cube center in shared ECEF space", () => {
  const origin = createThreeLocalOrigin({
    pointCount: 1,
    bounds: { minX: -1, minY: 43, minZ: 0, maxX: 1, maxY: 45, maxZ: 20 },
    cube: { minX: -1, minY: 43, minZ: 0, maxX: 1, maxY: 45, maxZ: 20 },
    wkt: undefined,
  });

  assert.equal(origin.coordinateSystem, "wgs84-ecef-meters");
  assert.ok(Number.isFinite(origin.x));
  assert.ok(Number.isFinite(origin.y));
  assert.ok(Number.isFinite(origin.z));
});

test("metadata local origin does not sample regional grid at padded cube center", async () => {
  const bytes = new ArrayBuffer(40 + 3 * 3 * 4);
  const view = new DataView(bytes);
  view.setFloat64(0, 44.3, false);
  view.setFloat64(8, -122.7, false);
  view.setFloat64(16, 0.2, false);
  view.setFloat64(24, 0.2, false);
  view.setInt32(32, 3, false);
  view.setInt32(36, 3, false);
  Array.from({ length: 9 }, (_, index) => 20 + index * 2).forEach(
    (value, index) => view.setFloat32(40 + index * 4, value, false),
  );
  const grid = await loadGtxGeoidGrid(bytes, {
    gridId: "three-padded-origin-test-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
  });
  const metadata = {
    pointCount: 1,
    bounds: {
      minX: -122.6,
      minY: 44.4,
      minZ: 100,
      maxX: -122.4,
      maxY: 44.6,
      maxZ: 200,
    },
    cube: {
      minX: -124,
      minY: 42,
      minZ: 100,
      maxX: -122,
      maxY: 44,
      maxZ: 200,
    },
    wkt: 'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]',
  };

  const origin = createThreeLocalOrigin(metadata, grid);
  const expected = geographicToEcef({
    longitude: -123,
    latitude: 43,
    height: 178,
  });
  assert.equal(origin.x, expected.x);
  assert.equal(origin.y, expected.y);
  assert.equal(origin.z, expected.z);
});

test("legacy geographic buffers are converted to local positions before Float32 narrowing", () => {
  const scene = new THREE.Scene();
  const renderer = new ThreePointRenderer({
    localOrigin: {
      coordinateSystem: "wgs84-ecef-meters",
      x: 4_510_000,
      y: -1_250_000,
      z: 4_200_000,
    },
  });
  renderer.attachTo(scene);

  renderer.addOrUpdateNode(
    "node-a",
    {
      pointCount: 1,
      coordinates: new Float64Array([-15, 48, 100]),
    },
    options(),
  );

  const position = renderer
    .getRoot()
    .children[0].geometry.getAttribute("position").array;
  assert.ok(position.every(Number.isFinite));
  assert.ok(Math.max(...position.map(Math.abs)) < 10_000_000);
});

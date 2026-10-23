import test from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import * as THREE from "three";

import { PointPrimitiveRenderer } from "../../../cesium/render/CopcPointRenderer.ts";
import { ThreePointRenderer } from "../../../three/render/ThreePointRenderer.ts";
import { createCompactEPointCacheNode } from "../../../core/point/compactEPointCache.ts";
import { createPreparedPointData } from "../../../core/point/preparedPoint.ts";
import { geographicToEcef } from "../../../core/coordinates/transform/worldCoordinates.ts";

const ORIGIN = {
  coordinateSystem: "wgs84-ecef-meters",
  x: 0,
  y: 0,
  z: 0,
};

function createPreparedAndCompactPoints() {
  const geographicCoordinates = new Float64Array([
    179.9, 10, -25,
    -179.95, 10.1, 0.0000000001,
    -123.1, 44.2, 150.125,
    20, 88.5, 1200,
  ]);
  const worldCoordinates = new Float64Array(geographicCoordinates.length);
  for (let index = 0; index < geographicCoordinates.length / 3; index += 1) {
    const offset = index * 3;
    const world = geographicToEcef({
      longitude: geographicCoordinates[offset],
      latitude: geographicCoordinates[offset + 1],
      height: geographicCoordinates[offset + 2],
    });
    worldCoordinates.set([world.x, world.y, world.z], offset);
  }

  const prepared = createPreparedPointData({
    pointCount: 4,
    sourceCoordinates: new Float64Array([
      501.25, 610.5, -7.75,
      502.25, 611.5, -6.75,
      503.25, 612.5, 5.25,
      504.25, 613.5, 18.25,
    ]),
    geographicCoordinates,
    worldCoordinates,
    attributes: {
      red: new Uint16Array([65535, 0, 1000, 32000]),
      green: new Uint16Array([0, 65535, 2000, 33000]),
      blue: new Uint16Array([1000, 2000, 65535, 34000]),
      intensity: new Uint16Array([0, 100, 500, 1000]),
      classification: new Uint8Array([2, 5, 6, 6]),
    },
  });
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "renderer-compatibility",
    provenance: {
      sourceIdentity: "memory://renderer-compatibility.copc.laz",
      sourceCrsWkt: "synthetic source CRS",
      transformGeneration: 4,
      heightOffsetMeters: 0,
      verticalDatum: { status: "no-validated-grid-correction" },
    },
  });
  return { prepared, compact };
}

function createCesiumViewer() {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    scene: {
      primitives: {
        add(collection) {
          added.push(collection);
          return collection;
        },
        remove(collection) {
          removed.push(collection);
          return true;
        },
      },
    },
  };
}

function colorTuple(color) {
  return [color.red, color.green, color.blue, color.alpha];
}

test("Cesium renders E-only cache nodes with A-equivalent positions, colors, filtering, bounds, and cleanup", () => {
  const { prepared, compact } = createPreparedAndCompactPoints();
  const viewer = createCesiumViewer();
  const renderer = new PointPrimitiveRenderer();
  renderer.attachTo(viewer);
  const pointId = (pointIndex) => ({ nodeKey: "renderer-compatibility", pointIndex });

  renderer.addOrUpdateNode("A", prepared, {
    pointSize: 3,
    colorMode: "elevation",
    elevationRange: { min: -25, max: 1200 },
    pointId,
  });
  renderer.addOrUpdateNode("E", compact, {
    pointSize: 3,
    colorMode: "elevation",
    elevationRange: { min: -25, max: 1200 },
    pointId,
  });

  assert.deepEqual(renderer.getRenderedNodeKeys(), ["A", "E"]);
  assert.equal(renderer.getRenderedNodePointCount("E"), prepared.pointCount);
  assert.equal(renderer.getRenderedPointCount(), prepared.pointCount * 2);

  const layerCollection = viewer.added[0];
  const collectionA = layerCollection.get(0);
  const collectionE = layerCollection.get(1);
  for (let index = 0; index < prepared.pointCount; index += 1) {
    const a = collectionA.get(index);
    const e = collectionE.get(index);
    assert.deepEqual([e.position.x, e.position.y, e.position.z], [
      a.position.x,
      a.position.y,
      a.position.z,
    ]);
    assert.deepEqual(e.id, { nodeKey: "renderer-compatibility", pointIndex: index });
  }

  const ranges = [
    { min: -25, max: 1200 },
    { min: 0, max: 10 },
    { min: 0, max: 100 },
    { min: 0, max: 1000 },
    { min: 150.124, max: 150.126 },
  ];
  const modes = [
    { colorMode: "fixed" },
    { colorMode: "rgb", rgbMax: 65535 },
    { colorMode: "intensity", intensityRange: { min: 0, max: 1000 } },
    { colorMode: "classification" },
    ...ranges.map((elevationRange) => ({ colorMode: "elevation", elevationRange })),
  ];
  for (const style of modes) {
    renderer.updateNodeStyle("A", prepared, { pointSize: 3, ...style });
    renderer.updateNodeStyle("E", compact, { pointSize: 3, ...style });
    for (let index = 0; index < prepared.pointCount; index += 1) {
      assert.deepEqual(
        colorTuple(collectionE.get(index).color),
        colorTuple(collectionA.get(index).color),
        style.colorMode,
      );
    }
  }

  const classificationFilter = (index) =>
    compact.attributes.classification[index] === 6;
  renderer.updateNodeStyle("A", prepared, {
    pointSize: 3,
    colorMode: "classification",
    pointFilter: (index) => prepared.attributes.classification[index] === 6,
  });
  renderer.updateNodeStyle("E", compact, {
    pointSize: 3,
    colorMode: "classification",
    pointFilter: classificationFilter,
  });
  assert.equal(renderer.getRenderedNodePointCount("A"), 2);
  assert.equal(renderer.getRenderedNodePointCount("E"), 2);
  assert.equal(renderer.getSelectionBoundingSphere()?.radius > 0, true);
  for (let index = 0; index < prepared.pointCount; index += 1) {
    assert.equal(collectionE.get(index).show, collectionA.get(index).show);
  }

  renderer.removeNode("E");
  assert.equal(renderer.getRenderedNodePointCount("E"), undefined);
  renderer.destroy();
  assert.equal(renderer.getRenderedPointCount(), 0);
  assert.equal(viewer.removed.length, 1);
  assert.ok(viewer.removed[0] instanceof Cesium.PrimitiveCollection);
});

test("Three renders E-only cache nodes with A-equivalent local positions, colors, bounds, and cleanup", () => {
  const { prepared, compact } = createPreparedAndCompactPoints();
  const sceneA = new THREE.Scene();
  const sceneE = new THREE.Scene();
  const rendererA = new ThreePointRenderer({ localOrigin: ORIGIN });
  const rendererE = new ThreePointRenderer({ localOrigin: ORIGIN });
  rendererA.attachTo(sceneA);
  rendererE.attachTo(sceneE);

  const ranges = [
    { min: -25, max: 1200 },
    { min: 0, max: 10 },
    { min: 0, max: 100 },
    { min: 0, max: 1000 },
    { min: 150.124, max: 150.126 },
  ];
  const modes = [
    { colorMode: "fixed" },
    { colorMode: "rgb", rgbMax: 65535 },
    { colorMode: "intensity", intensityRange: { min: 0, max: 1000 } },
    { colorMode: "classification" },
    ...ranges.map((elevationRange) => ({ colorMode: "elevation", elevationRange })),
  ];
  for (const style of modes) {
    rendererA.addOrUpdateNode("node", prepared, { pointSize: 3, ...style });
    rendererE.addOrUpdateNode("node", compact, { pointSize: 3, ...style });
    const pointsA = rendererA.getRoot().children[0];
    const pointsE = rendererE.getRoot().children[0];
    assert.equal(rendererE.getRenderedPointCount(), prepared.pointCount);
    assert.deepEqual(
      [...pointsE.geometry.getAttribute("position").array],
      [...pointsA.geometry.getAttribute("position").array],
    );
    assert.deepEqual(
      [...pointsE.geometry.getAttribute("color").array],
      [...pointsA.geometry.getAttribute("color").array],
      style.colorMode,
    );
    assert.deepEqual(
      [
        pointsE.geometry.boundingSphere.center.x,
        pointsE.geometry.boundingSphere.center.y,
        pointsE.geometry.boundingSphere.center.z,
        pointsE.geometry.boundingSphere.radius,
      ],
      [
        pointsA.geometry.boundingSphere.center.x,
        pointsA.geometry.boundingSphere.center.y,
        pointsA.geometry.boundingSphere.center.z,
        pointsA.geometry.boundingSphere.radius,
      ],
    );
  }

  rendererE.removeNode("node");
  assert.equal(rendererE.getRenderedPointCount(), 0);
  rendererE.destroy();
  rendererA.destroy();
  assert.equal(sceneE.children.includes(rendererE.getRoot()), false);
  assert.equal(sceneA.children.includes(rendererA.getRoot()), false);
});

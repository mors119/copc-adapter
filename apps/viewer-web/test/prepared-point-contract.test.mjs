import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  assertPreparedPointData,
  preparedPointDataToGeographicBuffer,
  transformPointBufferToPreparedPointData,
} from '../src/index.ts';
import { geographicToEcef } from '../src/viewer/streaming/view.ts';
import { toCartesian3ArrayFromBuffer } from '../src/cesium/render/renderPoints.ts';
import { ThreePointRenderer } from '../src/three/render/ThreePointRenderer.ts';
import * as THREE from 'three';

function metadata() {
  return {
    pointCount: 3,
    bounds: {
      minX: 10,
      minY: 20,
      minZ: 2,
      maxX: 12,
      maxY: 22,
      maxZ: 20,
    },
    cube: {
      minX: 10,
      minY: 20,
      minZ: 2,
      maxX: 12,
      maxY: 22,
      maxZ: 20,
    },
  };
}

function fixture() {
  return transformPointBufferToPreparedPointData(metadata(), {
    pointCount: 3,
    coordinateSystem: 'copc-source',
    coordinates: new Float64Array([
      10, 20, 2,
      11, 21, 12,
      12, 22, 20,
    ]),
    attributes: {
      intensity: new Uint16Array([10, 20, 30]),
      red: new Uint16Array([1, 128, 255]),
      green: new Uint16Array([2, 129, 254]),
      blue: new Uint16Array([3, 130, 253]),
    },
  });
}

test('prepared point data has tagged buffers, exact lengths, optional fields, and statistics', () => {
  const prepared = fixture();

  assert.equal(prepared.pointCount, 3);
  assert.equal(prepared.source.coordinateSystem, 'copc-source');
  assert.equal(prepared.geographic.coordinateSystem, 'wgs84-geographic');
  assert.equal(prepared.world.coordinateSystem, 'wgs84-ecef-meters');
  assert.equal(prepared.source.coordinates.length, 9);
  assert.equal(prepared.geographic.coordinates.length, 9);
  assert.equal(prepared.world.coordinates.length, 9);
  assert.equal(prepared.attributes.classification, undefined);
  assert.deepEqual(prepared.statistics, {
    elevation: { min: 2, max: 20 },
    intensity: { min: 10, max: 30 },
    rgbMax: 255,
  });
  assert.equal(prepared.coordinates, prepared.geographic.coordinates);
  assert.equal(prepared.sourceCoordinates, prepared.source.coordinates);
  assert.equal(prepared.worldCoordinates, prepared.world.coordinates);
  assertPreparedPointData(prepared);
});

test('prepared point data preserves absent optional attributes', () => {
  const prepared = transformPointBufferToPreparedPointData(metadata(), {
    pointCount: 3,
    coordinates: new Float64Array([
      10, 20, 2,
      11, 21, 12,
      12, 22, 20,
    ]),
  });

  assert.equal(prepared.attributes, undefined);
  assert.equal(preparedPointDataToGeographicBuffer(prepared).attributes, undefined);
});

test('prepared geographic and world coordinates remain consistent', () => {
  const prepared = fixture();
  const expected = geographicToEcef({ longitude: 11, latitude: 21, height: 12 });

  assert.deepEqual([...prepared.source.coordinates.slice(3, 6)], [11, 21, 12]);
  assert.deepEqual([...prepared.geographic.coordinates.slice(3, 6)], [11, 21, 12]);
  assert.deepEqual([...prepared.world.coordinates.slice(3, 6)], [expected.x, expected.y, expected.z]);
});

test('Cesium and Three adapters consume the same prepared fixture', () => {
  const prepared = fixture();
  assert.equal(toCartesian3ArrayFromBuffer(prepared).length, prepared.pointCount);

  const scene = new THREE.Scene();
  const renderer = new ThreePointRenderer({
    localOrigin: {
      coordinateSystem: 'wgs84-ecef-meters',
      x: prepared.world.coordinates[0],
      y: prepared.world.coordinates[1],
      z: prepared.world.coordinates[2],
    },
  });
  renderer.attachTo(scene);
  renderer.addOrUpdateNode('fixture', prepared, { pointSize: 2 });
  assert.equal(renderer.getRenderedPointCount(), prepared.pointCount);
  renderer.destroy();
});

test('the prepared contract module has no renderer dependency', () => {
  const source = readFileSync(
    new URL('../src/point/preparedPoint.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"][^'"]*(?:cesium|three)/iu);
  assert.doesNotMatch(source, /\b(?:Cesium|THREE|BufferGeometry|BufferAttribute)\b/u);
});

import * as THREE from 'three';
import { ThreePointRenderer } from '../src/three/render/ThreePointRenderer.ts';

const pointCount = Number(process.argv[2] ?? 100_000);
const origin = {
  coordinateSystem: 'wgs84-ecef-meters',
  x: 4_510_000,
  y: -1_250_000,
  z: 4_200_000,
};

function createPoints() {
  const worldCoordinates = new Float64Array(pointCount * 3);
  const coordinates = new Float64Array(pointCount * 3);
  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 3;
    worldCoordinates[offset] = origin.x + (index % 1000) * 0.25;
    worldCoordinates[offset + 1] = origin.y + Math.floor(index / 1000) * 0.25;
    worldCoordinates[offset + 2] = origin.z + (index % 100) * 0.1;
    coordinates[offset] = -123;
    coordinates[offset + 1] = 44;
    coordinates[offset + 2] = 100;
  }
  return {
    pointCount,
    coordinates,
    coordinateSystem: 'wgs84-geographic',
    worldCoordinates,
    worldCoordinateSystem: 'wgs84-ecef-meters',
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minMs: sorted[0] ?? 0,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
}

const points = createPoints();
const scene = new THREE.Scene();
const renderer = new ThreePointRenderer({ localOrigin: origin });
renderer.attachTo(scene);
const samples = { add: [], update: [], remove: [] };

for (let repetition = 0; repetition < 9; repetition += 1) {
  const addStartedAt = performance.now();
  renderer.addOrUpdateNode('benchmark-node', points, { pointSize: 2 });
  const addDuration = performance.now() - addStartedAt;

  const updateStartedAt = performance.now();
  renderer.addOrUpdateNode('benchmark-node', points, { pointSize: 2 });
  const updateDuration = performance.now() - updateStartedAt;

  const removeStartedAt = performance.now();
  renderer.removeNode('benchmark-node');
  const removeDuration = performance.now() - removeStartedAt;

  if (repetition >= 2) {
    samples.add.push(addDuration);
    samples.update.push(updateDuration);
    samples.remove.push(removeDuration);
  }
}

renderer.destroy();
console.log(JSON.stringify({
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    timing: 'performance.now(); warmup=2, samples=7; CPU scene-object preparation only',
  },
  pointCount,
  localPositionAttribute: 'Float32Array',
  sizeAttenuation: false,
  stages: {
    add: summarize(samples.add),
    update: summarize(samples.update),
    remove: summarize(samples.remove),
  },
}, null, 2));

import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  createExperimentalETilePointView,
  createTilePointViewFromA,
} from '../src/input/tilePointView.ts';
import { encodePointCloudGlb } from '../src/gltf/pointCloudGlb.ts';
import { createTileResourceServer } from '../src/resources/tileResourceServer.ts';
import { TileNodeReader } from '../src/source/tileNodeReader.ts';

const pointCount = Number(process.env.COPC_TILES_BENCH_POINTS ?? 100_000);
if (!Number.isSafeInteger(pointCount) || pointCount < 1 || pointCount > 1_000_000) {
  throw new Error('COPC_TILES_BENCH_POINTS must be a safe integer from 1 to 1,000,000.');
}

const ecef = new Float64Array(pointCount * 3);
const preparedHeight = new Float64Array(pointCount);
const geographic = new Float64Array(pointCount * 3);
const sourceCoordinates = new Float64Array(pointCount * 3);
const red = new Uint16Array(pointCount);
const green = new Uint16Array(pointCount);
const blue = new Uint16Array(pointCount);
const intensity = new Uint16Array(pointCount);
const classification = new Uint8Array(pointCount);

for (let point = 0; point < pointCount; point += 1) {
  const phase = point * 0.0001;
  const offset = point * 3;
  ecef[offset] = 6_378_137 + Math.cos(phase) * 125;
  ecef[offset + 1] = Math.sin(phase) * 125;
  ecef[offset + 2] = Math.sin(phase * 0.73) * 80;
  preparedHeight[point] = Math.sin(phase * 0.73) * 80;
  geographic[offset] = phase % (Math.PI * 2) - Math.PI;
  geographic[offset + 1] = Math.sin(phase) * 0.00002;
  geographic[offset + 2] = preparedHeight[point];
  sourceCoordinates[offset] = point;
  sourceCoordinates[offset + 1] = point % 4096;
  sourceCoordinates[offset + 2] = point % 1024;
  red[point] = (point * 257) & 0xffff;
  green[point] = (point * 911) & 0xffff;
  blue[point] = (point * 3_571) & 0xffff;
  intensity[point] = (point * 13) & 0xffff;
  classification[point] = point % 32;
}

const context = Object.freeze({
  sourceIdentity: 'benchmark-deterministic-ecef-v1',
  nodeKey: '0-0-0-0',
  transformGeneration: 1,
  sourceCrs: { status: 'unknown', reason: 'Synthetic benchmark coordinates.' },
  verticalDatum: { status: 'unknown', corrections: [] },
  heightOffsetMeters: 0,
});
const expected = { sourceIdentity: context.sourceIdentity, transformGeneration: context.transformGeneration };
const selection = {
  coordinates: { preparedHeight: true },
  attributes: { rgb: true, intensity: true, classification: true },
};
const selectionA = { ...selection, coordinates: {} };
const attributes = { red, green, blue, intensity, classification };
const aInput = {
  pointCount,
  source: { coordinateSystem: 'copc-source', pointCount, coordinates: sourceCoordinates },
  geographic: { coordinateSystem: 'wgs84-geographic', pointCount, coordinates: geographic },
  world: { coordinateSystem: 'wgs84-ecef-meters', pointCount, coordinates: ecef },
  coordinates: geographic,
  sourceCoordinates,
  worldCoordinates: ecef,
  attributes,
};
const eInput = { pointCount, ecef, height: preparedHeight, attributes };

const aView = createTilePointViewFromA(aInput, context, expected, selectionA);
const eView = createExperimentalETilePointView(eInput, context, expected, selection);
const encoded = encodePointCloudGlb(eView);
if (!encoded) throw new Error('Non-empty benchmark view encoded to no GLB.');
const encodedA = encodePointCloudGlb(aView);
if (!encodedA || !bytesEqual(encoded.bytes, encodedA.bytes)) {
  throw new Error('A/E source views did not produce identical point-tile bytes.');
}

const timings = {
  createAView: await measure(() => createTilePointViewFromA(aInput, context, expected, selectionA), 25),
  createEView: await measure(() => createExperimentalETilePointView(eInput, context, expected, selection), 25),
  encodeAView: await measure(() => encodePointCloudGlb(aView), 7),
  encodeEView: await measure(() => encodePointCloudGlb(eView), 7),
  prepareEncodeA: await measure(() => {
    const view = createTilePointViewFromA(aInput, context, expected, selectionA);
    return encodePointCloudGlb(view);
  }, 7),
  prepareEncodeE: await measure(() => {
    const view = createExperimentalETilePointView(eInput, context, expected, selection);
    return encodePointCloudGlb(view);
  }, 7),
};
const cancellationReader = new TileNodeReader({
  sourceIdentity: 'benchmark-cancellation-v1',
  transformGeneration: 1,
  isCurrent: () => true,
});
const aborted = new AbortController();
aborted.abort();
timings.preAbortedReadDetection = await measure(async () => {
  try {
    await cancellationReader.readNodes(['root'], {}, { signal: aborted.signal });
  } catch (error) {
    if (error?.code !== 'ABORTED') throw error;
  }
}, 50);

let warmProviderReads = 0;
const cold = await measureColdRequests(7);
const server = createTileResourceServer({
  sourceIdentity: 'benchmark-deterministic-ecef-v1',
  generation: 1,
  async getResource(uri) {
    if (uri !== 'tile.glb') return undefined;
    warmProviderReads += 1;
    return encoded.bytes;
  },
}, { maxCacheBytes: encoded.bytes.byteLength });
const warm = await measure(async () => {
  const response = await server.handle(new Request('https://tiles.invalid/tile.glb'));
  await response.arrayBuffer();
}, 50);
const resourceStats = server.getStats();
await server.close();

if (warmProviderReads !== 1 || resourceStats.cacheEntries !== 1 || cold.providerReads !== 7) {
  throw new Error(`Resource cache benchmark failed: warmReads=${warmProviderReads}, coldReads=${cold.providerReads}, cacheEntries=${resourceStats.cacheEntries}.`);
}

globalThis.gc?.();
const memory = process.memoryUsage();
const coordinateInputBytes = ecef.byteLength + preparedHeight.byteLength;
const coordinateInputBytesA = ecef.byteLength + sourceCoordinates.byteLength + geographic.byteLength;
const attributeInputBytes = red.byteLength + green.byteLength + blue.byteLength + intensity.byteLength + classification.byteLength;

console.log(JSON.stringify({
  benchmark: 'deterministic synthetic ECEF point node',
  pointCount,
  nodeCount: 1,
  glbBytes: encoded.bytes.byteLength,
  inputs: {
    coordinateBytesE: coordinateInputBytes,
    coordinateBytesA: coordinateInputBytesA,
    selectedAttributeBytes: attributeInputBytes,
    aViewRetainedTypedArrayBytes: retainedViewBytes(aView),
    eViewRetainedTypedArrayBytes: retainedViewBytes(eView),
    glbRetainedOutputBytes: encoded.bytes.byteLength,
    note: 'Views alias prepared inputs; the GLB output byte count is retained allocation. Temporary encoder allocations and source preparation/decoding are not included.'
  },
  timingsMilliseconds: {
    aViewConstruction: timings.createAView,
    eViewConstruction: timings.createEView,
    aGlbEncoding: timings.encodeAView,
    eGlbEncoding: timings.encodeEView,
    aPrepareAndEncode: timings.prepareEncodeA,
    ePrepareAndEncode: timings.prepareEncodeE,
    preAbortedReadDetection: timings.preAbortedReadDetection,
    resourceColdRequest: cold.timings,
    resourceWarmRequest: warm,
  },
  resourceCache: { coldProviderReads: cold.providerReads, warmProviderReads, stats: resourceStats },
  processMemoryBytes: memory,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
  },
}, null, 2));

async function measure(operation, count) {
  const samples = [];
  for (let index = 0; index < Math.min(count, 3); index += 1) await operation();
  for (let index = 0; index < count; index += 1) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return {
    samples: count,
    median: round(samples[Math.floor(samples.length / 2)]),
    p95: round(samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]),
  };
}

async function measureColdRequests(count) {
  const samples = [];
  let providerReads = 0;
  for (let index = 0; index < count; index += 1) {
    const server = createTileResourceServer({
      sourceIdentity: `benchmark-cold-${index}`,
      generation: 1,
      async getResource(uri) {
        if (uri !== 'tile.glb') return undefined;
        providerReads += 1;
        return encoded.bytes;
      },
    }, { maxCacheBytes: encoded.bytes.byteLength });
    const startedAt = performance.now();
    const response = await server.handle(new Request('https://tiles.invalid/tile.glb'));
    await response.arrayBuffer();
    samples.push(performance.now() - startedAt);
    await server.close();
  }
  samples.sort((left, right) => left - right);
  return {
    providerReads,
    timings: {
      samples: count,
      median: round(samples[Math.floor(samples.length / 2)]),
      p95: round(samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]),
    },
  };
}

function round(value) {
  return Number(value.toFixed(3));
}

function retainedViewBytes(view) {
  const buffers = new Set();
  const add = (value) => {
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  };
  add(view.ecef);
  add(view.preparedHeight);
  add(view.source);
  add(view.geographic);
  for (const values of Object.values(view.attributes ?? {})) {
    if (values && typeof values === 'object' && !ArrayBuffer.isView(values)) {
      for (const extra of Object.values(values)) add(extra);
    } else {
      add(values);
    }
  }
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

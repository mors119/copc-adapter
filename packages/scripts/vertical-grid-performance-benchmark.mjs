import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

import {
  transformPointBufferToPreparedPointData,
} from "../core/coordinates/transform/createPointTransformer.ts";
import { loadGtxGeoidGrid } from "../core/coordinates/transform/verticalGrid.ts";

const execFileAsync = promisify(execFile);
const openAsBlob = nodeFs.openAsBlob;
const MiB = 1024 * 1024;
const repetitions = Number(process.env.COPC_VERTICAL_GRID_SAMPLES ?? 7);
const warmups = Number(process.env.COPC_VERTICAL_GRID_WARMUPS ?? 2);
const float32Value = Buffer.allocUnsafe(4);
float32Value.writeFloatBE(25, 0);

const cases = [
  { name: "small-361x181", width: 361, height: 181, repetitions },
  { name: "medium-2048x1024", width: 2048, height: 1024, repetitions },
  {
    name: "large-global-egm-shaped-8640x4321-synthetic",
    width: 8640,
    height: 4321,
    repetitions: Math.min(3, repetitions),
  },
];

const orthometricWkt =
  'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';

const gridMetadata = (gridId, sha256) => ({
  gridId,
  sourceVerticalCrs: "Local orthometric height",
  targetVerticalCrs: "EPSG:4979",
  horizontalCrs: "EPSG:4326",
  referenceEllipsoid: "WGS84",
  sha256,
  valueUnit: "metre",
  valueConvention: "ellipsoidal-minus-orthometric",
  noDataValue: null,
});

function writeGridHeader(handle, width, height) {
  const header = Buffer.alloc(40);
  header.writeDoubleBE(-90, 0);
  header.writeDoubleBE(-180, 8);
  header.writeDoubleBE(180 / (height - 1), 16);
  header.writeDoubleBE(360 / width, 24);
  header.writeInt32BE(height, 32);
  header.writeInt32BE(width, 36);
  return handle.write(header, 0, header.byteLength, 0);
}

async function createGridFile(path, width, height) {
  const handle = await open(path, "w");
  const sampleCount = width * height;
  const dataLength = sampleCount * float32Value.byteLength;
  const chunk = Buffer.allocUnsafe(Math.min(8 * MiB, dataLength));
  chunk.fill(float32Value);
  const headerWrite = await writeGridHeader(handle, width, height);
  if (headerWrite.bytesWritten !== 40) {
    await handle.close();
    throw new Error(`Short GTX header write: ${headerWrite.bytesWritten}/40 bytes`);
  }
  let offset = 40;
  while (offset < 40 + dataLength) {
    const byteLength = Math.min(chunk.byteLength, 40 + dataLength - offset);
    let written = 0;
    while (written < byteLength) {
      const result = await handle.write(
        chunk,
        written,
        byteLength - written,
        offset + written,
      );
      written += result.bytesWritten;
    }
    offset += byteLength;
  }
  await handle.close();
  return { sampleCount, encodedByteLength: 40 + dataLength, decodedByteLength: dataLength };
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function openGridBlob(path) {
  if (typeof openAsBlob === "function") return openAsBlob(path);
  return new Blob([await readFile(path)]);
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, values.length - 1);
  return {
    samples: values.length,
    min: sorted[0] ?? 0,
    median,
    p95NearestRank: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    max: sorted.at(-1) ?? 0,
    standardDeviation: Math.sqrt(variance),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function maxRssBytes() {
  const { maxRSS } = process.resourceUsage();
  // ru_maxrss is KiB on POSIX hosts, including macOS (cross-checked against
  // `ps -o rss=` here), and bytes on Windows.
  return process.platform === "win32" ? maxRSS : maxRSS * 1024;
}

async function runColdChild(path, sha256, gridId) {
  if (typeof globalThis.gc !== "function") {
    throw new Error("Run with --expose-gc to make memory observations reproducible");
  }
  const blob = await openGridBlob(path);
  globalThis.gc();
  const before = memorySnapshot();
  const maxRssBeforeBytes = maxRssBytes();
  const startedAt = performance.now();
  let grid = await loadGtxGeoidGrid(blob, gridMetadata(gridId, sha256));
  const loadDurationMs = performance.now() - startedAt;
  const afterLoad = memorySnapshot();
  const maxRssAfterBytes = maxRssBytes();
  const gridSummary = {
    width: grid.width,
    height: grid.height,
    encodedByteLength: grid.encodedByteLength,
    decodedByteLength: grid.decodedByteLength,
    sha256: grid.sha256,
  };

  globalThis.gc();
  const retained = memorySnapshot();
  grid = undefined;
  await new Promise((resolveNextTurn) => setImmediate(resolveNextTurn));
  globalThis.gc();
  globalThis.gc();
  const afterRelease = memorySnapshot();

  process.stdout.write(
    `${JSON.stringify({
      loadDurationMs,
      before,
      afterLoad,
      retained,
      afterRelease,
      maxRssBeforeBytes,
      maxRssAfterBytes,
      maxRssIncreaseBytes: Math.max(0, maxRssAfterBytes - maxRssBeforeBytes),
      grid: gridSummary,
    })}\n`,
  );
}

function createPoints(pointCount) {
  const coordinates = new Float64Array(pointCount * 3);
  let seed = 0x51f15e;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 3;
    // Cluster the deterministic points around the Autzen COPC benchmark area.
    coordinates[offset] = -123.06875 + (random() - 0.5) * 0.1;
    coordinates[offset + 1] = 44.04034 + (random() - 0.5) * 0.1;
    coordinates[offset + 2] = 100 + random() * 20;
  }
  return { pointCount, coordinates };
}

const metadata = {
  pointCount: 1,
  wkt: orthometricWkt,
  bounds: {
    minX: -123.2,
    minY: 43.9,
    minZ: 0,
    maxX: -122.9,
    maxY: 44.2,
    maxZ: 200,
  },
  cube: {
    minX: -123.2,
    minY: 43.9,
    minZ: 0,
    maxX: -122.9,
    maxY: 44.2,
    maxZ: 200,
  },
};

function benchmarkWarm(grid, pointCount, useGrid) {
  const pointBuffer = createPoints(pointCount);
  const transform = () =>
    transformPointBufferToPreparedPointData(
      metadata,
      pointBuffer,
      0,
      useGrid ? grid : undefined,
    );
  for (let index = 0; index < warmups; index += 1) transform();
  const measurements = [];
  for (let index = 0; index < repetitions; index += 1) {
    globalThis.gc?.();
    const startedAt = performance.now();
    const prepared = transform();
    measurements.push(performance.now() - startedAt);
    assert.equal(prepared.pointCount, pointCount);
    assert.equal(prepared.source.coordinates[0], pointBuffer.coordinates[0]);
  }
  if (useGrid && pointCount > 0) {
    const withGrid = transform();
    const withoutGrid = transformPointBufferToPreparedPointData(
      metadata,
      pointBuffer,
    );
    assert.equal(withGrid.geographic.coordinates[2] - withoutGrid.geographic.coordinates[2], 25);
    assert.deepEqual(withGrid.source.coordinates, withoutGrid.source.coordinates);
  }
  return summary(measurements);
}

async function runParent() {
  if (typeof globalThis.gc !== "function") {
    throw new Error("Run with --expose-gc to make memory observations reproducible");
  }
  assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 3);
  assert.ok(Number.isSafeInteger(warmups) && warmups >= 0);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "copc-vertical-grid-benchmark-"),
  );
  const results = [];
  try {
    for (const testCase of cases) {
      const path = join(temporaryDirectory, `${testCase.name}.gtx`);
      const file = await createGridFile(path, testCase.width, testCase.height);
      const sha256 = await fileSha256(path);
      const coldRuns = [];
      for (let sampleIndex = 0; sampleIndex < testCase.repetitions; sampleIndex += 1) {
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            "--expose-gc",
            "--import",
            "tsx",
            resolve(process.argv[1]),
            "--cold-child",
            path,
            sha256,
            testCase.name,
          ],
          { maxBuffer: 1024 * 1024 },
        );
        coldRuns.push(JSON.parse(stdout.trim().split("\n").at(-1)));
      }

      const source = await openGridBlob(path);
      let grid = await loadGtxGeoidGrid(source, gridMetadata(testCase.name, sha256));
      const warmBatches = {};
      for (const pointCount of [50_000, 250_000]) {
        warmBatches[pointCount] = {
          withoutGrid: benchmarkWarm(grid, pointCount, false),
          withGrid: benchmarkWarm(grid, pointCount, true),
        };
      }
      const sampleLocations = createPoints(250_000).coordinates;
      const interpolation = [];
      for (let sampleIndex = 0; sampleIndex < repetitions; sampleIndex += 1) {
        globalThis.gc();
        const startedAt = performance.now();
        let checksum = 0;
        for (let pointIndex = 0; pointIndex < 250_000; pointIndex += 1) {
          const offset = pointIndex * 3;
          checksum += grid.sampleUndulation(
            sampleLocations[offset],
            sampleLocations[offset + 1],
          );
        }
        interpolation.push({ durationMs: performance.now() - startedAt, checksum });
      }

      const firstPointSource = createPoints(1);
      const firstPointWithoutGrid = transformPointBufferToPreparedPointData(
        metadata,
        firstPointSource,
      );
      const firstPointWithGrid = transformPointBufferToPreparedPointData(
        metadata,
        firstPointSource,
        0,
        grid,
      );
      assert.equal(
        firstPointWithGrid.geographic.coordinates[2] -
          firstPointWithoutGrid.geographic.coordinates[2],
        25,
      );
      const output = {
        grid: {
          ...file,
          width: testCase.width,
          height: testCase.height,
          sha256,
          source: "synthetic constant 25 m GTX; not an authoritative geoid model",
        },
        coldLoad: {
          repetitions: summary(coldRuns.map((run) => run.loadDurationMs)),
          sampledPeakRssIncreaseBytes: summary(
            coldRuns.map((run) => run.maxRssIncreaseBytes),
          ),
          processMaxRssBytes: summary(
            coldRuns.map((run) => run.maxRssAfterBytes),
          ),
          arrayBuffersDeltaAtReturnBytes: summary(
            coldRuns.map(
              (run) => run.afterLoad.arrayBuffersBytes - run.before.arrayBuffersBytes,
            ),
          ),
          retainedArrayBuffersDeltaBytes: summary(
            coldRuns.map(
              (run) => run.retained.arrayBuffersBytes - run.before.arrayBuffersBytes,
            ),
          ),
          arrayBuffersAfterReleaseDeltaBytes: summary(
            coldRuns.map(
              (run) => run.afterRelease.arrayBuffersBytes - run.before.arrayBuffersBytes,
            ),
          ),
        },
        warmBatches,
        warmInterpolation250k: summary(interpolation.map((run) => run.durationMs)),
        warmInterpolationChecksumRange: {
          min: Math.min(...interpolation.map((run) => run.checksum)),
          max: Math.max(...interpolation.map((run) => run.checksum)),
        },
      };
      results.push(output);
      grid = undefined;
      globalThis.gc();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const cpu = (await import("node:os")).cpus()[0];
  const os = await import("node:os");
  process.stdout.write(
    `${JSON.stringify(
      {
        environment: {
          node: process.version,
          platform: `${os.type()} ${os.release()}`,
          arch: process.arch,
          cpu: cpu?.model,
          logicalCpus: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          repetitions,
          largeGridRepetitions: Math.min(3, repetitions),
          warmups,
          timing: "performance.now; cold load runs in fresh Node child processes; p95 is nearest-rank",
          memory: "process.resourceUsage maxRSS and process.memoryUsage; GC exposed; RSS is a process high-water mark",
          blobInput: typeof openAsBlob === "function"
            ? "file-backed Blob via fs.openAsBlob"
            : "in-memory Blob fallback; input buffer is retained by Blob",
          dataPolicy: "generated to the OS temp directory, removed on completion, never committed",
        },
        results,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[2] === "--cold-child") {
  const [, , , path, sha256, gridId] = process.argv;
  await runColdChild(path, sha256, gridId);
} else {
  await runParent();
}

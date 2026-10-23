import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { CopcJsBackend, RustCopcBackend } from "../index.ts";
import {
  applyPreparedPointHeightOffset,
  transformPointBufferToPreparedPointData,
} from "../core/coordinates/transform/createPointTransformer.ts";
import {
  ecefToGeographic,
  geographicToEcef,
} from "../core/coordinates/transform/worldCoordinates.ts";
import {
  getCopcPointColor,
  getPointBufferElevationRange,
  getPointBufferIntensityRange,
  getPointBufferRgbMax,
} from "../core/point/style/pointStyle.ts";
import { createCompactEPointCacheNode } from "../core/point/compactEPointCache.ts";
import {
  createNodePointCache,
  estimateDecodedCpuPointBufferBytes,
} from "../core/streaming/createNodePointCache.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const openAsBlob = nodeFs.openAsBlob;
if (typeof openAsBlob !== "function") {
  throw new Error(
    "The cache representation benchmark requires Node.js 22 or newer to read COPC inputs as file-backed Blobs without buffering entire datasets in memory",
  );
}
const packageDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(packageDirectory, "..");
const sampleDirectory = path.join(repositoryDirectory, "samples", "local");
const datasetRegistry = JSON.parse(
  await readFile(
    path.join(repositoryDirectory, "samples", "datasets.json"),
    "utf8",
  ),
);
const crsAuditMatrix = JSON.parse(
  await readFile(
    path.join(repositoryDirectory, "crates", "crs-audit", "src", "fixtures.json"),
    "utf8",
  ),
);
const warmups = readPositiveInteger(
  process.env.COPC_CACHE_BENCHMARK_WARMUPS,
  5,
  "COPC_CACHE_BENCHMARK_WARMUPS",
  true,
);
const repetitions = readPositiveInteger(
  process.env.COPC_CACHE_BENCHMARK_REPETITIONS,
  15,
  "COPC_CACHE_BENCHMARK_REPETITIONS",
);
const runSofi = process.env.COPC_CACHE_BENCHMARK_SOFI === "1";
const backendFields = new Set([
  "position",
  "intensity",
  "classification",
  "rgb",
]);
const backendFieldNames = [...backendFields];
const syntheticPointCounts = [10_000, 100_000, 250_000, 1_000_000];
const candidateLayouts = ["A", "B", "C", "D", "E"];
const styleModes = ["fixed", "elevation", "rgb", "intensity", "classification"];
const paletteBoundaries = [0.25, 0.5, 0.75];
const colorRangeSpansMeters = [10, 100, 1_000];
const maxBoundaryColorSamples = 100_000;

if (typeof globalThis.gc !== "function") {
  throw new Error(
    "Run with npm run benchmark:cache-representations so GC can be controlled between samples",
  );
}

function readPositiveInteger(rawValue, fallback, name, allowZero = false) {
  if (rawValue === undefined) return fallback;
  const value = Number(rawValue);
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new RangeError(`${name} must be a valid non-negative integer`);
  }
  return value;
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, samples.length - 1);

  return {
    sampleCount: samples.length,
    p50Ms: sorted[Math.floor(samples.length / 2)] ?? 0,
    p95NearestRankMs:
      sorted[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0,
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    meanMs: mean,
    varianceMsSquared: variance,
    standardDeviationMs: Math.sqrt(variance),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
    rawSamplesMs: [...samples],
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    maxRssBytes: maxRssBytes(),
  };
}

function maxRssBytes() {
  const { maxRSS } = process.resourceUsage();
  return process.platform === "win32" ? maxRSS : maxRSS * 1024;
}

function memoryDelta(before, after) {
  return Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key] - before[key]]),
  );
}

function mib(bytes) {
  return bytes / (1024 * 1024);
}

function withUnits(bytes) {
  return { bytes, mebibytes: mib(bytes) };
}

function byteLength(value) {
  return estimateDecodedCpuPointBufferBytes(value);
}

function copyCoordinateBuffer(buffer) {
  return { ...buffer, coordinates: buffer.coordinates.slice() };
}

function materializeCandidate(prepared, name) {
  if (name === "A") {
    const source = copyCoordinateBuffer(prepared.source);
    const geographicBuffer = copyCoordinateBuffer(prepared.geographic);
    const world = copyCoordinateBuffer(prepared.world);
    return {
      ...prepared,
      source,
      geographic: geographicBuffer,
      world,
      coordinates: geographicBuffer.coordinates,
      sourceCoordinates: source.coordinates,
      worldCoordinates: world.coordinates,
    };
  }

  if (name === "B") {
    return {
      pointCount: prepared.pointCount,
      geographic: copyCoordinateBuffer(prepared.geographic),
      world: copyCoordinateBuffer(prepared.world),
      attributes: prepared.attributes,
      statistics: prepared.statistics,
    };
  }

  if (name === "E") {
    const compact = createCompactEPointCacheNode(prepared, {
      nodeKey: "benchmark-node",
      provenance: {
        sourceIdentity: "local benchmark input",
        transformGeneration: 0,
        heightOffsetMeters: 0,
        verticalDatum: { status: "no-validated-grid-correction" },
      },
    });
    return { ...compact, world: prepared.world };
  }

  const world = copyCoordinateBuffer(prepared.world);
  if (name === "C") {
    return {
      pointCount: prepared.pointCount,
      world,
      attributes: prepared.attributes,
      statistics: prepared.statistics,
    };
  }

  if (name === "D") {
    const heights32 = new Float32Array(prepared.pointCount);
    const geographic = prepared.geographic.coordinates;
    for (let index = 0; index < prepared.pointCount; index += 1) {
      heights32[index] = geographic[index * 3 + 2];
    }
    return {
      pointCount: prepared.pointCount,
      world,
      heights32,
      attributes: prepared.attributes,
      statistics: prepared.statistics,
    };
  }

  throw new RangeError(`Unknown candidate layout: ${name}`);
}

/**
 * Internal benchmark-only batch wrapper over the production scalar inverse.
 * Input is interleaved ECEF Float64 XYZ metres with exact `pointCount * 3`
 * length. Output is interleaved longitude degrees, latitude degrees, and
 * ellipsoidal height metres. It never retains either buffer. Without `output`
 * it allocates a caller-owned Float64Array; with `output` it fills and returns
 * the caller-owned, exact-length array. Input and output backing stores must
 * differ. Zero points are valid; malformed lengths and non-finite input fail.
 */
function ecefBufferToGeographicBuffer(ecef, pointCount, output) {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new RangeError("pointCount must be a non-negative safe integer");
  }
  if (!(ecef instanceof Float64Array)) {
    throw new TypeError("ECEF input must be a Float64Array");
  }
  const coordinateLength = pointCount * 3;
  if (!Number.isSafeInteger(coordinateLength) || ecef.length !== coordinateLength) {
    throw new RangeError("ECEF input length must equal pointCount * 3");
  }
  if (output !== undefined && !(output instanceof Float64Array)) {
    throw new TypeError("Geographic output must be a Float64Array");
  }
  if (output !== undefined && output.length !== coordinateLength) {
    throw new RangeError("Geographic output length must equal pointCount * 3");
  }
  if (output !== undefined && output.buffer === ecef.buffer) {
    throw new RangeError("Geographic output must not share the ECEF input buffer");
  }
  for (let offset = 0; offset < coordinateLength; offset += 1) {
    if (!Number.isFinite(ecef[offset])) {
      throw new RangeError(`ECEF input coordinate ${offset} must be finite`);
    }
  }

  const geographic = output ?? new Float64Array(coordinateLength);
  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 3;
    const point = ecefToGeographic({
      x: ecef[offset],
      y: ecef[offset + 1],
      z: ecef[offset + 2],
    });
    geographic[offset] = point.longitude;
    geographic[offset + 1] = point.latitude;
    geographic[offset + 2] = point.height;
  }
  return geographic;
}

function verifyBatchInverseContract() {
  const empty = ecefBufferToGeographicBuffer(new Float64Array(), 0);
  assert.equal(empty.length, 0);
  assert.throws(
    () => ecefBufferToGeographicBuffer(new Float64Array(), -1),
    /pointCount/,
  );
  assert.throws(
    () => ecefBufferToGeographicBuffer(new Float64Array(2), 1),
    /length/,
  );
  assert.throws(
    () => ecefBufferToGeographicBuffer(new Float64Array([Number.NaN, 0, 0]), 1),
    /must be finite/,
  );
  assert.throws(
    () => ecefBufferToGeographicBuffer(new Float64Array(3), 1, new Float64Array(6)),
    /output length/,
  );
  const sharedBuffer = new ArrayBuffer(24);
  assert.throws(
    () =>
      ecefBufferToGeographicBuffer(
        new Float64Array(sharedBuffer),
        1,
        new Float64Array(sharedBuffer),
      ),
    /share the ECEF input buffer/,
  );

  const sample = geographicToEcef({ longitude: 127, latitude: 37.5, height: 50 });
  const input = new Float64Array([sample.x, sample.y, sample.z]);
  const output = new Float64Array(3);
  assert.equal(ecefBufferToGeographicBuffer(input, 1, output), output);
  assert.ok(Math.abs(output[0] - 127) < 1e-10);
  assert.ok(Math.abs(output[1] - 37.5) < 1e-10);
  assert.ok(Math.abs(output[2] - 50) < 1e-6);
}

function createErrorAccumulator() {
  return { count: 0, maximum: 0, squaredTotal: 0, total: 0 };
}

function addError(accumulator, value) {
  accumulator.count += 1;
  accumulator.maximum = Math.max(accumulator.maximum, Math.abs(value));
  accumulator.squaredTotal += value * value;
  accumulator.total += value;
}

function finishErrorAccumulator(accumulator) {
  return {
    sampleCount: accumulator.count,
    max: accumulator.maximum,
    rms:
      accumulator.count === 0
        ? null
        : Math.sqrt(accumulator.squaredTotal / accumulator.count),
    mean:
      accumulator.count === 0 ? null : accumulator.total / accumulator.count,
  };
}

function compareCandidateAccuracy(prepared, name, candidate) {
  const reference = prepared.geographic.coordinates;
  const world = candidate.world.coordinates;
  const errors = {
    longitudeDegrees: createErrorAccumulator(),
    latitudeDegrees: createErrorAccumulator(),
    ellipsoidalHeightMeters: createErrorAccumulator(),
    ecefEuclideanMeters: createErrorAccumulator(),
  };
  const float32Height = createErrorAccumulator();

  for (let index = 0; index < prepared.pointCount; index += 1) {
    const offset = index * 3;
    const recovered =
      name === "A" || name === "B"
        ? {
            longitude: candidate.geographic.coordinates[offset],
            latitude: candidate.geographic.coordinates[offset + 1],
            height: candidate.geographic.coordinates[offset + 2],
          }
        : ecefToGeographic({
            x: world[offset],
            y: world[offset + 1],
            z: world[offset + 2],
          });
    const displayHeight =
      name === "D"
        ? candidate.heights32[index]
        : name === "E"
          ? candidate.height[index]
          : recovered.height;
    const restoredEcef = geographicToEcef({
      longitude: recovered.longitude,
      latitude: recovered.latitude,
      height: displayHeight,
    });
    const longitudeError =
      ((((recovered.longitude - reference[offset] + 180) % 360) + 360) %
        360) - 180;

    addError(errors.longitudeDegrees, longitudeError);
    addError(
      errors.latitudeDegrees,
      recovered.latitude - reference[offset + 1],
    );
    addError(
      errors.ellipsoidalHeightMeters,
      displayHeight - reference[offset + 2],
    );
    addError(
      errors.ecefEuclideanMeters,
      Math.hypot(
        world[offset] - restoredEcef.x,
        world[offset + 1] - restoredEcef.y,
        world[offset + 2] - restoredEcef.z,
      ),
    );
    if (name === "D") {
      addError(float32Height, candidate.heights32[index] - reference[offset + 2]);
    }
  }

  return {
    longitudeErrorDegrees: finishErrorAccumulator(errors.longitudeDegrees),
    latitudeErrorDegrees: finishErrorAccumulator(errors.latitudeDegrees),
    ellipsoidalHeightErrorMeters: finishErrorAccumulator(
      errors.ellipsoidalHeightMeters,
    ),
    ecefEuclideanErrorMeters: finishErrorAccumulator(errors.ecefEuclideanMeters),
    float32HeightQuantizationMeters:
      name === "D" ? finishErrorAccumulator(float32Height) : null,
    heightMatchesPreparedGeographicExactly:
      name === "E"
        ? candidate.height.every(
            (height, index) => height === reference[index * 3 + 2],
          )
        : null,
  };
}

function benchmarkManualOffsetSemantics(prepared, { warmups, repetitions }) {
  const byOffset = {};
  for (const offsetMeters of [-25, 25]) {
    const samples = [];
    let measuredResult;
    for (let run = 0; run < warmups + repetitions; run += 1) {
      globalThis.gc();
      const startedAt = performance.now();
      const adjusted = applyPreparedPointHeightOffset(prepared, offsetMeters);
      const durationMs = performance.now() - startedAt;
      if (run >= warmups) samples.push(durationMs);
      measuredResult = adjusted;
    }

    assert.equal(measuredResult.source.coordinates, prepared.source.coordinates);
    const heightError = createErrorAccumulator();
    const ecefError = createErrorAccumulator();
    for (let index = 0; index < prepared.pointCount; index += 1) {
      const offset = index * 3;
      assert.equal(
        measuredResult.geographic.coordinates[offset],
        prepared.geographic.coordinates[offset],
      );
      assert.equal(
        measuredResult.geographic.coordinates[offset + 1],
        prepared.geographic.coordinates[offset + 1],
      );
      const expectedHeight = prepared.geographic.coordinates[offset + 2] + offsetMeters;
      const recovered = ecefToGeographic({
        x: measuredResult.world.coordinates[offset],
        y: measuredResult.world.coordinates[offset + 1],
        z: measuredResult.world.coordinates[offset + 2],
      });
      addError(
        heightError,
        measuredResult.geographic.coordinates[offset + 2] - expectedHeight,
      );
      const restored = geographicToEcef(recovered);
      addError(
        ecefError,
        Math.hypot(
          measuredResult.world.coordinates[offset] - restored.x,
          measuredResult.world.coordinates[offset + 1] - restored.y,
          measuredResult.world.coordinates[offset + 2] - restored.z,
        ),
      );
    }
    byOffset[offsetMeters] = {
      preparation: summarize(samples),
      sourceBufferRetainedByReference: true,
      exactLongitudeLatitudePreserved: true,
      displayHeightOffsetErrorMeters: finishErrorAccumulator(heightError),
      ecefInverseRoundTripErrorMeters: finishErrorAccumulator(ecefError),
    };
    measuredResult = undefined;
  }

  const first = applyPreparedPointHeightOffset(prepared, 25);
  const changedAgain = applyPreparedPointHeightOffset(first, -50);
  let maxChangeErrorMeters = 0;
  for (let index = 0; index < prepared.pointCount; index += 1) {
    const offset = index * 3 + 2;
    maxChangeErrorMeters = Math.max(
      maxChangeErrorMeters,
      Math.abs(
        changedAgain.geographic.coordinates[offset] -
          (prepared.geographic.coordinates[offset] - 25),
      ),
    );
  }

  return {
    heightOffsetMeters: byOffset,
    sequentialPlanDeltaCheck: {
      deltasMeters: [25, -50],
      expectedNetDeltaMeters: -25,
      maxDisplayHeightErrorMeters: maxChangeErrorMeters,
      sourceCoordinatesRetained: changedAgain.source.coordinates === prepared.source.coordinates,
    },
    geoidSemantics: "N/A: no real, source-compatible geoid grid was used in this local fixture; ECEF inverse returns the display height already encoded in ECEF and never reapplies a grid",
  };
}

function benchmarkHeightColorSensitivity(prepared, candidateHeights, layout) {
  const originalHeights = prepared.geographic.coordinates;
  const range = getPointBufferElevationRange(prepared.geographic);
  const fullRangeDelta = { maxChannelDelta: 0, eightBitChannelMismatches: 0 };

  for (let index = 0; index < prepared.pointCount; index += 1) {
    const original = getCopcPointColor(
      originalHeights[index * 3 + 2],
      { colorMode: "elevation", elevationRange: range },
      prepared.attributes,
      index,
    );
    const quantized = getCopcPointColor(
      candidateHeights[index],
      { colorMode: "elevation", elevationRange: range },
      prepared.attributes,
      index,
    );
    for (const channel of ["red", "green", "blue"]) {
      fullRangeDelta.maxChannelDelta = Math.max(
        fullRangeDelta.maxChannelDelta,
        Math.abs(original[channel] - quantized[channel]),
      );
      if (
        Math.round(original[channel] * 255) !==
        Math.round(quantized[channel] * 255)
      ) {
        fullRangeDelta.eightBitChannelMismatches += 1;
      }
    }
  }

  const stride = Math.max(
    1,
    Math.ceil(prepared.pointCount / maxBoundaryColorSamples),
  );
  const scenarios = [];
  for (const boundary of paletteBoundaries) {
    for (const rangeSpanMeters of colorRangeSpansMeters) {
      let sampleCount = 0;
      let maxChannelDelta = 0;
      let eightBitChannelMismatches = 0;
      for (let index = 0; index < prepared.pointCount; index += stride) {
        const height = originalHeights[index * 3 + 2];
        const boundaryRange = {
          min: height - rangeSpanMeters * boundary,
          max: height + rangeSpanMeters * (1 - boundary),
        };
        const options = {
          colorMode: "elevation",
          elevationRange: boundaryRange,
        };
        const original = getCopcPointColor(
          height,
          options,
          prepared.attributes,
          index,
        );
        const quantized = getCopcPointColor(
          candidateHeights[index],
          options,
          prepared.attributes,
          index,
        );
        sampleCount += 1;
        for (const channel of ["red", "green", "blue"]) {
          maxChannelDelta = Math.max(
            maxChannelDelta,
            Math.abs(original[channel] - quantized[channel]),
          );
          if (
            Math.round(original[channel] * 255) !==
            Math.round(quantized[channel] * 255)
          ) {
            eightBitChannelMismatches += 1;
          }
        }
      }
      scenarios.push({
        paletteBoundaryNormalized: boundary,
        rangeSpanMeters,
        sampleCount,
        maxChannelDelta,
        eightBitChannelMismatches,
      });
    }
  }

  return {
    candidateLayout: layout,
    fullDatasetRange: {
      sampleCount: prepared.pointCount,
      ...fullRangeDelta,
    },
    paletteBoundaryScenarios: scenarios,
    method: {
      sampleStride: stride,
      rangeSpanMeters: colorRangeSpansMeters,
      normalizedBoundaries: paletteBoundaries,
      note: "Sensitivity check: each sampled prepared height is placed exactly at a palette boundary; these are not dataset-specific display ranges.",
    },
  };
}

function benchmarkPointInspection(candidates, warmupCount, sampleCount) {
  const pointCount = candidates.A.pointCount;
  const result = {};
  const sourceXYZ = {};

  for (const pickCount of [1, 100]) {
    result[pickCount] = {};
    const pointIndices = Array.from(
      { length: pickCount },
      (_, index) => (index * 97) % pointCount,
    );

    for (const name of candidateLayouts) {
      const samples = [];
      for (let run = 0; run < warmupCount + sampleCount; run += 1) {
        globalThis.gc();
        const startedAt = performance.now();
        let checksum = 0;
        for (const index of pointIndices) {
          const offset = index * 3;
          if (name === "A" || name === "B") {
            checksum +=
              candidates[name].geographic.coordinates[offset] +
              candidates[name].geographic.coordinates[offset + 1] +
              candidates[name].geographic.coordinates[offset + 2];
            continue;
          }

          const inverse = ecefToGeographic({
            x: candidates[name].world.coordinates[offset],
            y: candidates[name].world.coordinates[offset + 1],
            z: candidates[name].world.coordinates[offset + 2],
          });
          checksum +=
            inverse.longitude +
            inverse.latitude +
            (name === "D"
              ? candidates.D.heights32[index]
              : name === "E"
                ? candidates.E.height[index]
                : inverse.height);
        }
        const durationMs = performance.now() - startedAt;
        assert.ok(Number.isFinite(checksum));
        if (run >= warmupCount) samples.push(durationMs);
      }
      result[pickCount][name] = summarize(samples);
    }

    const sourceSamples = [];
    for (let run = 0; run < warmupCount + sampleCount; run += 1) {
      globalThis.gc();
      const startedAt = performance.now();
      let checksum = 0;
      for (const index of pointIndices) {
        const offset = index * 3;
        checksum +=
          candidates.A.source.coordinates[offset] +
          candidates.A.source.coordinates[offset + 1] +
          candidates.A.source.coordinates[offset + 2];
      }
      const durationMs = performance.now() - startedAt;
      assert.ok(Number.isFinite(checksum));
      if (run >= warmupCount) sourceSamples.push(durationMs);
    }
    sourceXYZ[pickCount] = summarize(sourceSamples);
  }

  return { geographicDisplayPosition: result, cachedSourceXYZ: sourceXYZ };
}

function summarizeNumbers(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, values.length - 1);
  return {
    sampleCount: values.length,
    min: sorted[0] ?? null,
    p50: sorted[Math.floor(sorted.length / 2)] ?? null,
    p95NearestRank:
      sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
    max: sorted.at(-1) ?? null,
    mean,
    variance,
    standardDeviation: Math.sqrt(variance),
    rawValues: [...values],
  };
}

function candidateBufferInventory(name, candidate) {
  const coordinateBuffers = {};
  if (name === "A") {
    coordinateBuffers.sourceFloat64 = candidate.source.coordinates;
    coordinateBuffers.geographicFloat64 = candidate.geographic.coordinates;
    coordinateBuffers.ecefFloat64 = candidate.world.coordinates;
  } else if (name === "B") {
    coordinateBuffers.geographicFloat64 = candidate.geographic.coordinates;
    coordinateBuffers.ecefFloat64 = candidate.world.coordinates;
  } else {
    coordinateBuffers.ecefFloat64 = candidate.world.coordinates;
    if (name === "D") coordinateBuffers.heightFloat32 = candidate.heights32;
    if (name === "E") coordinateBuffers.heightFloat64 = candidate.height;
  }

  const attributeArrays = Object.fromEntries(
    Object.entries(candidate.attributes ?? {}).filter(([, value]) =>
      ArrayBuffer.isView(value),
    ),
  );
  const coordinateBytes = Object.values(coordinateBuffers).reduce(
    (total, values) => total + values.byteLength,
    0,
  );
  const attributeBytesByField = Object.fromEntries(
    Object.entries(attributeArrays).map(([field, values]) => [
      field,
      values.byteLength,
    ]),
  );
  const attributeBytes = byteLength(candidate.attributes);
  const attributeViewBytesSum = Object.values(attributeBytesByField).reduce(
    (total, value) => total + value,
    0,
  );
  const statisticsBackingBytes = byteLength(candidate.statistics);
  const retainedBytes = byteLength(candidate);

  return {
    coordinateBuffers: Object.fromEntries(
      Object.entries(coordinateBuffers).map(([kind, values]) => [
        kind,
        withUnits(values.byteLength),
      ]),
    ),
    coordinateAndHeight: withUnits(coordinateBytes),
    attributes: {
      byField: attributeBytesByField,
      total: withUnits(attributeBytes),
      fieldViewBytesSum: attributeViewBytesSum,
      sharedBackingStoreDeduplicated: true,
    },
    statistics: {
      typedArrayBackingStores: withUnits(statisticsBackingBytes),
      objectAndscalarOverhead: "N/A: JavaScript object/string/number heap sizes are engine-specific",
    },
    aliases: {
      present:
        name === "A"
          ? [
              "coordinates -> geographic",
              "sourceCoordinates -> source",
              "worldCoordinates -> world",
            ]
          : name === "E"
            ? ["ecef -> world"]
            : [],
      duplicateBackingStoreBytes: 0,
    },
    retainedArrayBufferBytes: withUnits(retainedBytes),
    coordinateBytesPerPoint: coordinateBytes / candidate.pointCount,
  };
}

function createStyleOptions(prepared) {
  const points = {
    ...prepared.geographic,
    attributes: prepared.attributes,
    statistics: prepared.statistics,
  };
  const shared = {
    elevationRange: getPointBufferElevationRange(prepared.geographic),
    intensityRange: getPointBufferIntensityRange(points),
    rgbMax: getPointBufferRgbMax(points),
  };
  return Object.fromEntries(
    styleModes.map((colorMode) => [colorMode, { ...shared, colorMode }]),
  );
}

function writeStyleBuffer(candidate, name, mode, styleOptions, output) {
  let checksum = 0;
  for (let index = 0; index < candidate.pointCount; index += 1) {
    const height =
      mode === "elevation"
        ? name === "A" || name === "B"
          ? candidate.geographic.coordinates[index * 3 + 2]
          : name === "D"
            ? candidate.heights32[index]
            : name === "E"
              ? candidate.height[index]
              : ecefToGeographic({
                x: candidate.world.coordinates[index * 3],
                y: candidate.world.coordinates[index * 3 + 1],
                z: candidate.world.coordinates[index * 3 + 2],
              }).height
        : 0;
    const color = getCopcPointColor(
      height,
      styleOptions[mode],
      candidate.attributes,
      index,
    );
    const offset = index * 4;
    output[offset] = color.red;
    output[offset + 1] = color.green;
    output[offset + 2] = color.blue;
    output[offset + 3] = color.alpha;
    checksum += color.red + color.green + color.blue + color.alpha;
  }
  return checksum;
}

function compareColorBuffers(reference, candidate, pointCount) {
  let maxFloatChannelDelta = 0;
  let eightBitChannelMismatches = 0;
  for (let index = 0; index < pointCount * 4; index += 1) {
    maxFloatChannelDelta = Math.max(
      maxFloatChannelDelta,
      Math.abs(reference[index] - candidate[index]),
    );
    if (
      index % 4 !== 3 &&
      Math.round(reference[index] * 255) !== Math.round(candidate[index] * 255)
    ) {
      eightBitChannelMismatches += 1;
    }
  }
  return { maxFloatChannelDelta, eightBitChannelMismatches };
}

function benchmarkStyleModes(candidates, styleOptions, { warmups, repetitions }) {
  const candidateNames = candidateLayouts;
  const pointCount = candidates.A.pointCount;
  const coldSamples = Object.fromEntries(
    candidateNames.map((name) => [
      name,
      Object.fromEntries(styleModes.map((mode) => [mode, []])),
    ]),
  );
  const warmSamples = Object.fromEntries(
    candidateNames.map((name) => [
      name,
      Object.fromEntries(styleModes.map((mode) => [mode, []])),
    ]),
  );
  const toggleCycleSamples = Object.fromEntries(
    candidateNames.map((name) => [name, []]),
  );
  const parity = Object.fromEntries(
    candidateNames.map((name) => [
      name,
      Object.fromEntries(
        styleModes.map((mode) => [mode, { maxFloatChannelDelta: 0, eightBitChannelMismatches: 0 }]),
      ),
    ]),
  );
  const checksums = {};

  for (const mode of styleModes) {
    for (let run = 0; run < warmups + repetitions; run += 1) {
      let baselineOutput;
      for (const name of candidateNames) {
        globalThis.gc();
        const startedAt = performance.now();
        const output = new Float32Array(pointCount * 4);
        checksums[`${name}:${mode}:cold`] = writeStyleBuffer(
          candidates[name],
          name,
          mode,
          styleOptions,
          output,
        );
        const durationMs = performance.now() - startedAt;
        if (run >= warmups) coldSamples[name][mode].push(durationMs);
        assert.ok(Number.isFinite(checksums[`${name}:${mode}:cold`]));
        if (run === warmups) {
          if (name === "A") baselineOutput = output;
          else parity[name][mode] = compareColorBuffers(baselineOutput, output, pointCount);
        }
      }
    }
  }

  for (const name of candidateNames) {
    const output = new Float32Array(pointCount * 4);
    for (let run = 0; run < warmups + repetitions; run += 1) {
      const cycleStartedAt = performance.now();
      for (const mode of styleModes) {
        const startedAt = performance.now();
        checksums[`${name}:${mode}:warm`] = writeStyleBuffer(
          candidates[name],
          name,
          mode,
          styleOptions,
          output,
        );
        const durationMs = performance.now() - startedAt;
        if (run >= warmups) warmSamples[name][mode].push(durationMs);
      }
      const cycleDurationMs = performance.now() - cycleStartedAt;
      if (run >= warmups) toggleCycleSamples[name].push(cycleDurationMs);
    }
  }

  return {
    coldFirstBuildByMode: Object.fromEntries(
      candidateNames.map((name) => [
        name,
        Object.fromEntries(
          styleModes.map((mode) => [mode, summarize(coldSamples[name][mode])]),
        ),
      ]),
    ),
    warmRepeatedStyleChangesByMode: Object.fromEntries(
      candidateNames.map((name) => [
        name,
        Object.fromEntries(
          styleModes.map((mode) => [mode, summarize(warmSamples[name][mode])]),
        ),
      ]),
    ),
    fiveModeToggleCycle: Object.fromEntries(
      candidateNames.map((name) => [name, summarize(toggleCycleSamples[name])]),
    ),
    colorParityAgainstA: parity,
    checksums,
    method: {
      cold: "each measured pass creates a new Float32 RGBA CPU color buffer; process/JIT is warm, so this is a cold per-node buffer build, not a cold process",
      warm: "reuses one Float32 RGBA CPU buffer while toggling fixed/rgb/elevation/intensity/classification; excludes renderer/GPU submission",
      outputBytesPerPoint: 16,
      inverseCallsPerFullElevationStyleChange: {
        A: 0,
        B: 0,
        C: pointCount,
        D: 0,
        E: 0,
      },
      inverseCallsForOtherStyleModesPerFullChange: 0,
    },
  };
}

function benchmarkBatchInverse(candidate, { warmups, repetitions }) {
  const ecef = candidate.world.coordinates;
  const pointCount = candidate.pointCount;
  const reusable = new Float64Array(pointCount * 3);
  const allocatingSamples = [];
  const reusedSamples = [];
  let checksum = 0;

  for (let run = 0; run < warmups + repetitions; run += 1) {
    globalThis.gc();
    let startedAt = performance.now();
    const allocated = ecefBufferToGeographicBuffer(ecef, pointCount);
    const allocatingMs = performance.now() - startedAt;
    checksum += allocated[0] + allocated[allocated.length - 1];
    if (run >= warmups) allocatingSamples.push(allocatingMs);

    globalThis.gc();
    startedAt = performance.now();
    const reused = ecefBufferToGeographicBuffer(ecef, pointCount, reusable);
    const reusedMs = performance.now() - startedAt;
    checksum += reused[0] + reused[reused.length - 1];
    if (run >= warmups) reusedSamples.push(reusedMs);
  }

  return {
    allocatingOutput: summarize(allocatingSamples),
    callerProvidedOutput: summarize(reusedSamples),
    outputBytes: withUnits(pointCount * 3 * Float64Array.BYTES_PER_ELEMENT),
    checksum,
    validationAndFiniteScanIncluded: true,
  };
}

function benchmarkRepresentationMaterialization(prepared, { warmups, repetitions }) {
  const candidateNames = candidateLayouts;
  const results = {};
  const candidates = {};
  for (const name of candidateNames) {
    const timingSamples = [];
    const memorySamples = [];
    for (let run = 0; run < warmups + repetitions; run += 1) {
      globalThis.gc();
      const before = memorySnapshot();
      const startedAt = performance.now();
      let candidate = materializeCandidate(prepared, name);
      const durationMs = performance.now() - startedAt;
      const afterAllocation = memorySnapshot();
      globalThis.gc();
      globalThis.gc();
      const afterGc = memorySnapshot();
      if (run >= warmups) {
        timingSamples.push(durationMs);
        memorySamples.push({
          before,
          afterAllocation,
          afterGc,
          allocationSnapshotDelta: memoryDelta(before, afterAllocation),
          steadySnapshotDelta: memoryDelta(before, afterGc),
        });
      }
      candidate = undefined;
      globalThis.gc();
    }

    results[name] = {
      timing: summarize(timingSamples),
      processMemorySamples: memorySamples,
      steadyArrayBufferDeltaBytes: summarizeNumbers(
        memorySamples.map((sample) => sample.steadySnapshotDelta.arrayBuffersBytes),
      ),
      candidateByteInventory: candidateBufferInventory(
        name,
        materializeCandidate(prepared, name),
      ),
    };
    globalThis.gc();
  }

  for (const name of candidateNames) {
    candidates[name] = materializeCandidate(prepared, name);
  }
  globalThis.gc();
  return {
    materialization: results,
    candidates,
    allCandidatesRetainedProcessMemory: memorySnapshot(),
  };
}

async function benchmarkCacheInsertion(candidate, { warmups, repetitions }) {
  const samples = [];
  const diagnostics = [];
  for (let run = 0; run < warmups + repetitions; run += 1) {
    globalThis.gc();
    const cache = createNodePointCache(async () => candidate, {
      maxEntries: 1,
      maxBytes: 256 * 1024 * 1024,
      estimateBytes: byteLength,
    });
    const startedAt = performance.now();
    await cache.load("benchmark-node");
    const durationMs = performance.now() - startedAt;
    if (run >= warmups) {
      samples.push(durationMs);
      diagnostics.push(cache.getDiagnostics());
    }
    cache.clear();
  }
  return {
    timing: summarize(samples),
    diagnostics: diagnostics.at(-1),
    method: "NodePointCache load and retained-byte accounting for one already-materialized node; excludes decode, transform, and coordinate-array allocation",
  };
}

async function benchmarkCacheRepresentations(prepared, { warmups, repetitions }) {
  if (prepared.pointCount === 0) {
    throw new RangeError("Cache benchmark input must contain at least one point");
  }
  const memoryBefore = memorySnapshot();
  const representation = benchmarkRepresentationMaterialization(prepared, {
    warmups,
    repetitions,
  });
  const candidates = representation.candidates;
  const styleOptions = createStyleOptions(prepared);
  const storage = Object.fromEntries(
    Object.entries(candidates).map(([name, candidate]) => [
      name,
      candidateBufferInventory(name, candidate),
    ]),
  );
  const memoryAfterGc = memorySnapshot();
  const cacheInsertion = {};
  for (const [name, candidate] of Object.entries(candidates)) {
    cacheInsertion[name] = await benchmarkCacheInsertion(candidate, {
      warmups,
      repetitions,
    });
  }

  return {
    pointCount: prepared.pointCount,
    pointIdentity: "same stable point index under the enclosing root nodeKey for every candidate",
    requestedAttributes: backendFieldNames,
    cacheBudgets: {
      cacheByteBudget: "N/A: one-node representation microbenchmark does not instantiate the streaming LRU",
      maxNodes: "N/A: one node per comparison",
      workerCount: "N/A: Node backend benchmark has no browser Worker pool",
    },
    storage,
    theoreticalCoordinateBytesByCandidate: Object.fromEntries(
      Object.entries(storage).map(([name, value]) => [
        name,
        value.coordinateAndHeight,
      ]),
    ),
    materialization: representation.materialization,
    cacheInsertion,
    processMemory: {
      beforeRepresentations: memoryBefore,
      afterAllCandidatesAndGc: memoryAfterGc,
      delta: memoryDelta(memoryBefore, memoryAfterGc),
      transientPeak: "N/A: process-level allocation peaks are not sampled at each allocation; memory snapshots are checkpoints only",
      workerIsolatedMemory: "N/A: no browser Worker in this Node run",
      wasmLinearMemory: "N/A: this runner cannot isolate the WASM linear-memory allocation from the Node process",
    },
    ecefToGeographicBatch: benchmarkBatchInverse(candidates.C, {
      warmups,
      repetitions,
    }),
    styleTimings: benchmarkStyleModes(candidates, styleOptions, {
      warmups,
      repetitions,
    }),
    accuracyByCandidate: Object.fromEntries(
      Object.entries(candidates).map(([name, candidate]) => [
        name,
        compareCandidateAccuracy(prepared, name, candidate),
      ]),
    ),
    heightColorSensitivity: {
      float32ResearchBaseline: benchmarkHeightColorSensitivity(
        prepared,
        candidates.D.heights32,
        "D",
      ),
      float64ImplementationCandidate: benchmarkHeightColorSensitivity(
        prepared,
        candidates.E.height,
        "E",
      ),
    },
    pointInspection: benchmarkPointInspection(candidates, warmups, repetitions),
  };
}

function createSyntheticPreparedData(pointCount) {
  const sourceCoordinates = new Float64Array(pointCount * 3);
  const geographicCoordinates = new Float64Array(pointCount * 3);
  const worldCoordinates = new Float64Array(pointCount * 3);
  const intensity = new Uint16Array(pointCount);
  const classification = new Uint8Array(pointCount);
  const red = new Uint16Array(pointCount);
  const green = new Uint16Array(pointCount);
  const blue = new Uint16Array(pointCount);

  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 3;
    const position = {
      longitude: -123.1 + (index % 1000) * 0.000001,
      latitude: 44.05 + (Math.floor(index / 1000) % 1000) * 0.000001,
      height: (index % 2001) / 10 - 100,
    };
    const ecef = geographicToEcef(position);
    sourceCoordinates.set(
      [position.longitude, position.latitude, position.height],
      offset,
    );
    geographicCoordinates.set(
      [position.longitude, position.latitude, position.height],
      offset,
    );
    worldCoordinates.set([ecef.x, ecef.y, ecef.z], offset);
    intensity[index] = index % 65_536;
    classification[index] = index % 19;
    red[index] = index % 256;
    green[index] = (index * 3) % 256;
    blue[index] = (index * 7) % 256;
  }

  return {
    pointCount,
    source: {
      pointCount,
      coordinateSystem: "copc-source",
      coordinates: sourceCoordinates,
    },
    geographic: {
      pointCount,
      coordinateSystem: "wgs84-geographic",
      coordinates: geographicCoordinates,
    },
    world: {
      pointCount,
      coordinateSystem: "wgs84-ecef-meters",
      coordinates: worldCoordinates,
    },
    coordinates: geographicCoordinates,
    coordinateSystem: "wgs84-geographic",
    sourceCoordinates,
    sourceCoordinateSystem: "copc-source",
    worldCoordinates,
    worldCoordinateSystem: "wgs84-ecef-meters",
    attributes: { intensity, classification, red, green, blue },
    statistics: {},
  };
}

function createPreparedFromGeographicPositions(positions) {
  const prepared = createSyntheticPreparedData(positions.length);
  for (let index = 0; index < positions.length; index += 1) {
    const offset = index * 3;
    const position = positions[index];
    const ecef = geographicToEcef(position);
    prepared.source.coordinates.set(
      [position.longitude, position.latitude, position.height],
      offset,
    );
    prepared.geographic.coordinates.set(
      [position.longitude, position.latitude, position.height],
      offset,
    );
    prepared.world.coordinates.set([ecef.x, ecef.y, ecef.z], offset);
  }
  return prepared;
}

function accuracyForAllLayouts(prepared) {
  const results = {};
  for (const name of candidateLayouts) {
    const candidate = materializeCandidate(prepared, name);
    results[name] = compareCandidateAccuracy(prepared, name, candidate);
  }
  return results;
}

function buildAccuracyFixtures(crsAuditResults) {
  const geographicBoundaryPositions = [
    { longitude: 0, latitude: 0, height: 0 },
    { longitude: 127.0276, latitude: 37.4979, height: 32 },
    { longitude: -123.1, latitude: 44.05, height: 125 },
    { longitude: 151.2, latitude: -33.9, height: 250 },
    { longitude: 170, latitude: 89.999999, height: 400 },
    { longitude: -170, latitude: -89.999999, height: -100 },
    { longitude: 179.999999, latitude: 15, height: -250 },
    { longitude: -179.999999, latitude: -15, height: 1_000_000 },
    { longitude: -45, latitude: 70, height: 42_000_000 },
    { longitude: -45, latitude: 70, height: 42_000_001.25 },
    { longitude: 10, latitude: 20, height: -500 },
  ];
  const results = [
    {
      id: "geographic-boundary-positions",
      source: "deterministic WGS84 geographic inputs; no independent survey controls",
      pointCount: geographicBoundaryPositions.length,
      accuracyByCandidate: accuracyForAllLayouts(
        createPreparedFromGeographicPositions(geographicBoundaryPositions),
      ),
    },
  ];

  const auditById = new Map(crsAuditResults.map((result) => [result.id, result]));
  for (const fixture of crsAuditMatrix.fixtures) {
    const auditResult = auditById.get(fixture.id);
    if (!auditResult || auditResult.error) {
      results.push({
        id: fixture.id,
        source: fixture.source,
        wktFamily: fixture.wkt_family,
        pointCount: fixture.points.length,
        status: "N/A: checked-in CRS audit produced no forward transform result",
        error: auditResult?.error ?? "missing fixture result",
        accuracyByCandidate: null,
      });
      continue;
    }
    const prepared = createPreparedFromGeographicPositions(auditResult.points);
    results.push({
      id: fixture.id,
      source: fixture.source,
      wktFamily: fixture.wkt_family,
      pointCount: auditResult.points.length,
      forwardResult: "points returned by cargo run -q -p crs-audit; ECEF then uses the production geographicToEcef implementation",
      fullWktStatus: auditResult.full_wkt_error ? "N/A: Rust parser uses its documented PROJCS compatibility path" : "supported by the audit fixture",
      verticalSemantics: "uses the checked-in CRS audit's transformed display heights; no geoid grid or manual offset is applied",
      accuracyByCandidate: accuracyForAllLayouts(prepared),
    });
  }

  return results;
}

function attributeParity(left, right) {
  const leftAttributes = left.attributes ?? {};
  const rightAttributes = right.attributes ?? {};
  const names = new Set([
    ...Object.keys(leftAttributes),
    ...Object.keys(rightAttributes),
  ]);

  for (const name of names) {
    const leftValues = leftAttributes[name];
    const rightValues = rightAttributes[name];
    if (leftValues === undefined && rightValues === undefined) continue;
    if (!leftValues || !rightValues || leftValues.length !== rightValues.length) {
      return false;
    }
    for (let index = 0; index < leftValues.length; index += 1) {
      if (leftValues[index] !== rightValues[index]) return false;
    }
  }

  return true;
}

async function benchmarkBackendPreparation(
  source,
  node,
  backend,
  { warmups, repetitions },
) {
  const totals = [];
  const transformSamples = [];
  const stageSamples = new Map();
  const memorySamples = [];
  const recordStage = (stage, durationMs) => {
    const samples = stageSamples.get(stage) ?? [];
    samples.push(durationMs);
    stageSamples.set(stage, samples);
  };

  for (let run = 0; run < warmups + repetitions; run += 1) {
    globalThis.gc();
    const events = [];
    const memoryBefore = memorySnapshot();
    const startedAt = performance.now();
    let prepared;
    let raw;
    let transformDurationMs = 0;
    let afterDecode = null;

    if (backend === "copc-js-typescript") {
      raw = await source.loadPointDataBuffer(node, backendFields, {
        performanceObserver: (event) => events.push(event),
      });
      afterDecode = memorySnapshot();
      const transformStartedAt = performance.now();
      prepared = transformPointBufferToPreparedPointData(
        source.getMetadata(),
        raw,
      );
      transformDurationMs = performance.now() - transformStartedAt;
    } else {
      prepared = await source.loadPreparedPointData(node, backendFields, {
        performanceObserver: (event) => events.push(event),
      });
      transformDurationMs = events
        .filter((event) => event.stage === "pointPreparation")
        .reduce((total, event) => total + event.durationMs, 0);
    }

    const totalDurationMs = performance.now() - startedAt;
    const afterPreparation = memorySnapshot();
    raw = undefined;
    await new Promise((resolveNextTurn) => setImmediate(resolveNextTurn));
    globalThis.gc();
    globalThis.gc();
    const afterGc = memorySnapshot();
    if (run >= warmups) {
      totals.push(totalDurationMs);
      transformSamples.push(transformDurationMs);
      memorySamples.push({
        before: memoryBefore,
        afterDecode,
        afterPreparation,
        afterGc,
        transientPeak: "N/A: memory is sampled at stage boundaries, not during allocations",
      });
      if (backend === "copc-js-typescript") {
        recordStage("typescriptPointPreparation", transformDurationMs);
      }
      for (const event of events) {
        recordStage(event.stage, event.durationMs);
      }
    }

    assert.equal(prepared.pointCount, node.pointCount);
    prepared = undefined;
  }

  return {
    totalLoadAndPreparation: summarize(totals),
    pointPreparation: summarize(transformSamples),
    memorySamples,
    memoryInterpretation: {
      arrayBuffersAfterGc: "snapshot while source node preparation buffers are still alive; compare the per-sample checkpoint with the same backend process baseline",
      peak: "N/A: the Node API used here does not expose allocation-time peak ArrayBuffer residency",
      worker: "N/A: this is direct Node backend execution, not the browser worker pool",
    },
    observedStages: Object.fromEntries(
      [...stageSamples.entries()].map(([stage, samples]) => [
        stage,
        summarize(samples),
      ]),
    ),
  };
}

async function openBackendAtRoot(filePath, backend) {
  const blob = await openAsBlob(filePath);
  const source =
    backend === "rust-wasm"
      ? await new RustCopcBackend().open(blob)
      : await new CopcJsBackend().open(blob);
  const root = await source.loadHierarchyPage(source.getRootHierarchyPage());
  const node = root.nodes.find(({ pointCount }) => pointCount > 0);
  assert.ok(node, `${path.basename(filePath)} must have a non-empty root node`);
  return { source, node };
}

async function loadCompleteHierarchyNodeInventory(source) {
  const pendingPages = [source.getRootHierarchyPage()];
  const visitedPages = new Set();
  const nodes = [];
  let hierarchyPageReadCount = 0;
  while (pendingPages.length > 0) {
    const page = pendingPages.shift();
    const pageKey = String(page.pageOffset) + ":" + String(page.pageLength);
    if (visitedPages.has(pageKey)) continue;
    visitedPages.add(pageKey);
    const subtree = await source.loadHierarchyPage(page);
    hierarchyPageReadCount += 1;
    nodes.push(...subtree.nodes.filter((entry) => entry.pointCount > 0));
    pendingPages.push(...subtree.pages);
  }
  return { nodes, hierarchyPageReadCount };
}

function cacheRegionsFromHierarchy(nodes) {
  const withinSelectionDepth = nodes.filter((node) => node.level <= 6);
  const keySet = new Set(withinSelectionDepth.map((node) => node.key));
  const parentKeys = new Set();
  for (const node of withinSelectionDepth) {
    if (node.level === 0) continue;
    const parentKey = [
      node.level - 1,
      Math.floor(node.x / 2),
      Math.floor(node.y / 2),
      Math.floor(node.z / 2),
    ].join("-");
    if (keySet.has(parentKey)) parentKeys.add(parentKey);
  }
  const leafNodes = withinSelectionDepth.filter(
    (node) => !parentKeys.has(node.key),
  );
  const selectionLevel = Math.max(0, ...leafNodes.map((node) => node.level));
  const regionBuckets = new Map();
  for (const node of leafNodes) {
    const divisor = 2 ** node.level;
    const regionX = Math.min(3, Math.floor(((node.x + 0.5) / divisor) * 4));
    const regionY = Math.min(3, Math.floor(((node.y + 0.5) / divisor) * 4));
    const regionKey = String(regionX) + "," + String(regionY);
    const bucket = regionBuckets.get(regionKey) ?? [];
    bucket.push(node);
    regionBuckets.set(regionKey, bucket);
  }

  const selectionBudgetPoints = 250_000;
  const maxSelectedNodes = 24;
  const regions = [...regionBuckets.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        right.length - left.length || leftKey.localeCompare(rightKey),
    )
    .map(([regionKey, bucket]) => {
      const selected = [];
      let selectedPointCount = 0;
      for (const node of bucket.sort((left, right) => left.key.localeCompare(right.key))) {
        if (selected.length >= maxSelectedNodes) break;
        if (selectedPointCount + node.pointCount > selectionBudgetPoints) continue;
        selected.push(node);
        selectedPointCount += node.pointCount;
      }
      return { regionKey, nodes: selected, selectedPointCount };
    })
    .filter(({ nodes: selected }) => selected.length > 0);

  return {
    selectionLevel,
    selectionBudgetPoints,
    maxSelectedNodes,
    regions,
  };
}

async function benchmarkCacheBudgetSensitivity(
  hierarchyNodes,
  attributes,
  pointCount,
) {
  const regions = cacheRegionsFromHierarchy(hierarchyNodes);
  const cameraPathIndices = [0, 1, 2, 3, 4, 5].filter(
    (index) => index < regions.regions.length,
  );
  if (cameraPathIndices.length >= 3) cameraPathIndices.push(0);
  const attributeBytesPerPoint = byteLength(attributes) / pointCount;
  const bytesPerCoordinatePoint = { A: 72, B: 48, C: 24, D: 28, E: 32 };
  const nodeByKey = new Map(hierarchyNodes.map((node) => [node.key, node]));
  const runLayoutReplay = async ({
    byteBudget,
    maxEntries,
    replayPathIndices = cameraPathIndices,
  }) => {
    const layouts = {};
    for (const [name, coordinateBytesPerPoint] of Object.entries(
      bytesPerCoordinatePoint,
    )) {
      const bytesPerPoint = coordinateBytesPerPoint + attributeBytesPerPoint;
      const cache = createNodePointCache(
        async (nodeKey) => nodeByKey.get(nodeKey),
        {
          maxEntries,
          maxBytes: byteBudget,
          estimateBytes: (node) => node.pointCount * bytesPerPoint,
        },
      );
      const cameraViews = [];
      const regionVisits = new Map();
      let revisitHitCount = 0;
      for (const regionIndex of replayPathIndices) {
        const region = regions.regions[regionIndex];
        const nodeKeys = region.nodes.map((node) => node.key);
        const visitCount = regionVisits.get(regionIndex) ?? 0;
        cache.setRequiredNodeKeys(nodeKeys);
        const hitsBeforeViewLoads = cache.getDiagnostics().hits;
        for (const nodeKey of nodeKeys) await cache.load(nodeKey);
        const diagnostics = cache.getDiagnostics();
        if (visitCount > 0) {
          revisitHitCount += diagnostics.hits - hitsBeforeViewLoads;
        }
        regionVisits.set(regionIndex, visitCount + 1);
        cameraViews.push({
          regionKey: region.regionKey,
          selectedNodeCount: region.nodes.length,
          selectedPointCount: region.selectedPointCount,
          diagnostics,
        });
      }
      const finalDiagnostics = cache.getDiagnostics();
      layouts[name] = {
        bytesPerPoint,
        cameraViews,
        finalDiagnostics,
        revisitHitCount,
        countLimitBoundBeforeByteBudget:
          finalDiagnostics.cachedNodeCount === maxEntries &&
          finalDiagnostics.currentCacheBytes < byteBudget,
        byteBudgetEvictedBeforeCountLimit:
          maxEntries > 48 && finalDiagnostics.evictionCount > 0,
      };
      cache.clear();
    }
    return { budgets: { byteBudget, maxEntries }, layouts };
  };

  const productionBudgetAndCountLimit = await runLayoutReplay({
    byteBudget: 256 * 1024 * 1024,
    maxEntries: 48,
  });
  const byteBoundPathIndices =
    regions.regions.length >= 2 ? [0, 1, 0] : cameraPathIndices;
  const revisitedRegionPointCount = byteBoundPathIndices
    .slice(0, -1)
    .reduce(
      (total, regionIndex) =>
        total + regions.regions[regionIndex].selectedPointCount,
      0,
    );
  const bytesForFirstTwoRegions = {
    A: Math.ceil(revisitedRegionPointCount * (72 + attributeBytesPerPoint)),
    E: Math.ceil(revisitedRegionPointCount * (32 + attributeBytesPerPoint)),
  };
  const byteBoundBudget = Math.floor(
    (bytesForFirstTwoRegions.A + bytesForFirstTwoRegions.E) / 2,
  );
  const byteBoundSensitivity = await runLayoutReplay({
    byteBudget: byteBoundBudget,
    maxEntries: 256,
    replayPathIndices: byteBoundPathIndices,
  });

  return {
    budgets: productionBudgetAndCountLimit.budgets,
    attributeBytesPerPoint,
    selectionPolicyProxy: {
      maxNodesPerView: regions.maxSelectedNodes,
      maxEstimatedPointsPerView: regions.selectionBudgetPoints,
      level: regions.selectionLevel,
      regions: regions.regions.map(({ regionKey, nodes: selected, selectedPointCount }) => ({
        regionKey,
        nodeCount: selected.length,
        pointCount: selectedPointCount,
      })),
      cameraPathRegionIndices: cameraPathIndices,
      note: "Deterministic hierarchy-bin trace using actual node keys/point counts; this is an LRU policy simulation, not a live NodeSelector/browser camera run.",
    },
    layouts: productionBudgetAndCountLimit.layouts,
    byteBoundSensitivity: {
      ...byteBoundSensitivity,
      estimatedABytesForTwoRevisitedRegions: bytesForFirstTwoRegions.A,
      estimatedEBytesForTwoRevisitedRegions: bytesForFirstTwoRegions.E,
      replayPathRegionIndices: byteBoundPathIndices,
      note: "Sensitivity-only replay: the byte budget is set midway between A and E's estimated retained bytes for the first two regions, the path revisits region 0 after region 1, and the node cap is raised to 256 to isolate byte pressure.",
    },
  };
}

async function benchmarkFreshBackendPreparation(
  filePath,
  backend,
  { warmups, repetitions },
) {
  const totals = [];
  const transformSamples = [];
  const stageSamples = new Map();
  const samples = [];
  const recordStage = (stage, durationMs) => {
    const values = stageSamples.get(stage) ?? [];
    values.push(durationMs);
    stageSamples.set(stage, values);
  };

  for (let run = 0; run < warmups + repetitions; run += 1) {
    globalThis.gc();
    const memoryBefore = memorySnapshot();
    const events = [];
    const startedAt = performance.now();
    const { source, node } = await openBackendAtRoot(filePath, backend);
    let prepared;
    let raw;
    let afterDecode = null;
    let transformDurationMs = 0;
    if (backend === "copc-js-typescript") {
      raw = await source.loadPointDataBuffer(node, backendFields, {
        performanceObserver: (event) => events.push(event),
      });
      afterDecode = memorySnapshot();
      const transformStartedAt = performance.now();
      prepared = transformPointBufferToPreparedPointData(
        source.getMetadata(),
        raw,
      );
      transformDurationMs = performance.now() - transformStartedAt;
    } else {
      prepared = await source.loadPreparedPointData(node, backendFields, {
        performanceObserver: (event) => events.push(event),
      });
      transformDurationMs = events
        .filter((event) => event.stage === "pointPreparation")
        .reduce((total, event) => total + event.durationMs, 0);
    }
    const totalDurationMs = performance.now() - startedAt;
    if (run >= warmups) {
      totals.push(totalDurationMs);
      transformSamples.push(transformDurationMs);
      for (const event of events) recordStage(event.stage, event.durationMs);
      if (backend === "copc-js-typescript") {
        recordStage("typescriptPointPreparation", transformDurationMs);
      }
      samples.push({
        run,
        totalOpenHierarchyDecodePreparationMs: totalDurationMs,
        pointPreparationMs: transformDurationMs,
        afterDecode,
        stages: events,
        memoryBefore,
        memoryAfterPreparation: memorySnapshot(),
      });
    }
    assert.equal(prepared.pointCount, node.pointCount);
    prepared = undefined;
    raw = undefined;
    source.destroy?.();
    await new Promise((resolveNextTurn) => setImmediate(resolveNextTurn));
    globalThis.gc();
  }

  return {
    meaning: "fresh backend object and root hierarchy per sample; OS/filesystem cache is not flushed, so this is not a cold disk read",
    totalOpenHierarchyDecodePreparation: summarize(totals),
    pointPreparation: summarize(transformSamples),
    observedStages: Object.fromEntries(
      [...stageSamples.entries()].map(([stage, values]) => [stage, summarize(values)]),
    ),
    rawRunSamples: samples.filter(({ run }) => run >= warmups),
  };
}

async function benchmarkSourceReRead(source, node, prepared, { warmups, repetitions }) {
  const samples = [];
  const stageSamples = new Map();
  const sourcePositionOnly = new Set(["position"]);
  for (let run = 0; run < warmups + repetitions; run += 1) {
    globalThis.gc();
    const events = [];
    const startedAt = performance.now();
    const raw = await source.loadPointDataBuffer(node, sourcePositionOnly, {
      performanceObserver: (event) => events.push(event),
    });
    const durationMs = performance.now() - startedAt;
    if (run >= warmups) {
      for (const event of events) {
        const values = stageSamples.get(event.stage) ?? [];
        values.push(event.durationMs);
        stageSamples.set(event.stage, values);
      }
      for (let offset = 0; offset < raw.coordinates.length; offset += 1) {
        assert.equal(
          raw.coordinates[offset],
          prepared.source.coordinates[offset],
          `source re-read must preserve source XYZ at coordinate ${offset}`,
        );
      }
      samples.push({
        durationMs,
        pointCount: raw.pointCount,
        bytesReturned: raw.coordinates.byteLength,
        sourceCoordinatesEqual: true,
        memoryAfterDecode: memorySnapshot(),
        stages: events,
      });
    }
  }

  return {
    fields: ["position"],
    decodedPointCount: node.pointCount,
    returnedSourceCoordinateBytes: node.pointCount * 3 * Float64Array.BYTES_PER_ELEMENT,
    localFileNodeReRead: summarize(samples.map(({ durationMs }) => durationMs)),
    stages: Object.fromEntries(
      [...stageSamples.entries()].map(([stage, values]) => [stage, summarize(values)]),
    ),
    rawRunSamples: samples,
    remoteFileVersionChangeOrOfflineFailure: "N/A: local immutable sample only; no HTTP source is used",
  };
}

async function loadDatasetBackends(datasetId) {
  const filePath = path.join(sampleDirectory, `${datasetId}.copc.laz`);
  const dataset = datasetRegistry.datasets.find(({ id }) => id === datasetId);
  if (!dataset) throw new Error(`Unknown dataset registry id: ${datasetId}`);

  let fileStats;
  let actualSha256;
  try {
    fileStats = await stat(filePath);
  } catch {
    throw new Error(
      `Missing ${dataset.name} at ${filePath}. Run npm run download-samples -- ${datasetId} first.`,
    );
  }
  if (dataset.sizeBytes !== undefined && fileStats.size !== dataset.sizeBytes) {
    throw new Error(
      `${dataset.name} size mismatch: expected ${dataset.sizeBytes}, received ${fileStats.size}`,
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  actualSha256 = hash.digest("hex");
  if (
    dataset.sha256 &&
    actualSha256.toLowerCase() !== dataset.sha256.toLowerCase()
  ) {
    throw new Error(`${dataset.name} SHA-256 does not match samples/datasets.json`);
  }

  const blob = await openAsBlob(filePath);
  const rust = await new RustCopcBackend().open(blob);
  const copcJs = await new CopcJsBackend().open(blob);

  try {
    const [rustRoot, jsRoot] = await Promise.all([
      rust.loadHierarchyPage(rust.getRootHierarchyPage()),
      copcJs.loadHierarchyPage(copcJs.getRootHierarchyPage()),
    ]);
    const rustNode = rustRoot.nodes.find((node) => node.pointCount > 0);
    assert.ok(rustNode, `${datasetId} root hierarchy must contain points`);
    const hierarchyInventory = await loadCompleteHierarchyNodeInventory(rust);
    const jsNode = jsRoot.nodes.find(({ key }) => key === rustNode.key);
    assert.ok(jsNode, `${datasetId} JavaScript backend must expose ${rustNode.key}`);
    assert.equal(jsNode.pointCount, rustNode.pointCount);

    const [rustPrepared, jsBuffer] = await Promise.all([
      rust.loadPreparedPointData(rustNode, backendFields),
      copcJs.loadPointDataBuffer(jsNode, backendFields),
    ]);
    const jsPrepared = transformPointBufferToPreparedPointData(
      copcJs.getMetadata(),
      jsBuffer,
    );
    assert.equal(rustPrepared.pointCount, jsPrepared.pointCount);

    const copcJsPreparation = await benchmarkBackendPreparation(
      copcJs,
      jsNode,
      "copc-js-typescript",
      { warmups, repetitions },
    );
    const rustPreparation = await benchmarkBackendPreparation(
      rust,
      rustNode,
      "rust-wasm",
      { warmups, repetitions },
    );
    const copcJsFreshPreparation = await benchmarkFreshBackendPreparation(
      filePath,
      "copc-js-typescript",
      { warmups, repetitions },
    );
    const rustFreshPreparation = await benchmarkFreshBackendPreparation(
      filePath,
      "rust-wasm",
      { warmups, repetitions },
    );
    const copcJsSourceReRead = await benchmarkSourceReRead(
      copcJs,
      jsNode,
      jsPrepared,
      { warmups, repetitions },
    );
    const rustSourceReRead = await benchmarkSourceReRead(
      rust,
      rustNode,
      rustPrepared,
      { warmups, repetitions },
    );

    let maxGeographicComponentDifference = 0;
    let maxEcefComponentDifferenceMeters = 0;
    const crossBackend = {
      longitudeDegrees: createErrorAccumulator(),
      latitudeDegrees: createErrorAccumulator(),
      ellipsoidalHeightMeters: createErrorAccumulator(),
      ecefEuclideanMeters: createErrorAccumulator(),
    };
    for (let index = 0; index < rustPrepared.pointCount * 3; index += 1) {
      maxGeographicComponentDifference = Math.max(
        maxGeographicComponentDifference,
        Math.abs(
          rustPrepared.geographic.coordinates[index] -
            jsPrepared.geographic.coordinates[index],
        ),
      );
      maxEcefComponentDifferenceMeters = Math.max(
        maxEcefComponentDifferenceMeters,
        Math.abs(
          rustPrepared.world.coordinates[index] -
            jsPrepared.world.coordinates[index],
        ),
      );
    }
    for (let index = 0; index < rustPrepared.pointCount; index += 1) {
      const offset = index * 3;
      const longitudeDifference =
        ((((rustPrepared.geographic.coordinates[offset] -
          jsPrepared.geographic.coordinates[offset] +
          180) %
          360) +
          360) %
          360) -
        180;
      addError(crossBackend.longitudeDegrees, longitudeDifference);
      addError(
        crossBackend.latitudeDegrees,
        rustPrepared.geographic.coordinates[offset + 1] -
          jsPrepared.geographic.coordinates[offset + 1],
      );
      addError(
        crossBackend.ellipsoidalHeightMeters,
        rustPrepared.geographic.coordinates[offset + 2] -
          jsPrepared.geographic.coordinates[offset + 2],
      );
      addError(
        crossBackend.ecefEuclideanMeters,
        Math.hypot(
          rustPrepared.world.coordinates[offset] -
            jsPrepared.world.coordinates[offset],
          rustPrepared.world.coordinates[offset + 1] -
            jsPrepared.world.coordinates[offset + 1],
          rustPrepared.world.coordinates[offset + 2] -
            jsPrepared.world.coordinates[offset + 2],
        ),
      );
    }

    return {
      dataset: {
        id: datasetId,
        name: dataset.name,
        sourceUrl: dataset.url,
        path: path.relative(repositoryDirectory, filePath),
        bytes: fileStats.size,
        expectedSha256: dataset.sha256 ?? null,
        actualSha256: actualSha256 ?? null,
        rootNodeKey: rustNode.key,
        pointCount: rustNode.pointCount,
      },
      backendParity: {
        maximumGeographicComponentDifference:
          maxGeographicComponentDifference,
        maximumEcefComponentDifferenceMeters:
          maxEcefComponentDifferenceMeters,
        errorDistribution: Object.fromEntries(
          Object.entries(crossBackend).map(([name, values]) => [
            name,
            finishErrorAccumulator(values),
          ]),
        ),
        attributesEqual: attributeParity(rustPrepared, jsPrepared),
      },
      backendPreparation: {
        warmBackendReuse: {
          copcJsPlusTypeScript: copcJsPreparation,
          rustWasm: rustPreparation,
        },
        freshBackendInstance: {
          copcJsPlusTypeScript: copcJsFreshPreparation,
          rustWasm: rustFreshPreparation,
        },
      },
      sourcePointRecovery: {
        nodeKey: rustNode.key,
        pointIdentity: "nodeKey + pointIndex; the selected point index is stable only while this local file hash and node key remain the same",
        candidateA: {
          sourceXYZAccess: "direct cached source buffer; timing is included with pointInspection.cachedSourceXYZ",
        },
        candidatesBCD: {
          sourceXYZAccess: "re-read and decode the entire root node with position only; timings below are local Blob data and not remote HTTP",
          copcJs: copcJsSourceReRead,
          rustWasm: rustSourceReRead,
          changedRemoteFileOrOffline: "N/A: local file did not change and network was not used",
        },
      },
      hierarchyCachePolicySensitivity: {
        hierarchyPageReadCount: hierarchyInventory.hierarchyPageReadCount,
        nonEmptyNodeCount: hierarchyInventory.nodes.length,
        totalHierarchyPointCount: hierarchyInventory.nodes.reduce(
          (total, entry) => total + entry.pointCount,
          0,
        ),
        simulation: await benchmarkCacheBudgetSensitivity(
          hierarchyInventory.nodes,
          rustPrepared.attributes,
          rustPrepared.pointCount,
        ),
      },
      manualHeightOffsetChanges: {
        copcJsPlusTypeScript: benchmarkManualOffsetSemantics(jsPrepared, {
          warmups,
          repetitions,
        }),
        rustWasm: benchmarkManualOffsetSemantics(rustPrepared, {
          warmups,
          repetitions,
        }),
      },
      copcJsTypeScriptPreparation: await benchmarkCacheRepresentations(
        jsPrepared,
        { warmups, repetitions },
      ),
      rustWasmPreparation: await benchmarkCacheRepresentations(rustPrepared, {
        warmups,
        repetitions,
      }),
    };
  } finally {
    rust.destroy();
  }
}

async function describeRuntimeFile(filePath) {
  try {
    const fileStats = await stat(filePath);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return {
      path: path.relative(repositoryDirectory, filePath),
      bytes: fileStats.size,
      sha256: hash.digest("hex"),
    };
  } catch {
    return { path: path.relative(repositoryDirectory, filePath), state: "N/A: file unavailable" };
  }
}

function tryCommand(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "N/A: command unavailable";
  }
}

verifyBatchInverseContract();
const processMemoryAtStart = memorySnapshot();
const commit = tryCommand("git", ["rev-parse", "HEAD"]);
const gitBranch = tryCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const gitStatus = tryCommand("git", ["status", "--short"]);
const dirtyPaths = gitStatus === "N/A: command unavailable"
  ? []
  : gitStatus.split("\n").filter(Boolean);
const scriptSha256 = createHash("sha256")
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest("hex");
const packageJson = JSON.parse(
  await readFile(path.join(packageDirectory, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(path.join(packageDirectory, "package-lock.json"), "utf8"),
);
const binaryRuntimes = {
  copcAdapterWasm: await describeRuntimeFile(
    path.join(packageDirectory, "core", "wasm", "copc_adapter_wasm.wasm"),
  ),
  lazPerfWasm: await describeRuntimeFile(
    path.join(packageDirectory, "core", "wasm", "laz-perf.wasm"),
  ),
};
const crsFixtureFilePath = path.join(
  repositoryDirectory,
  "crates",
  "crs-audit",
  "src",
  "fixtures.json",
);
const crsFixtureSha256 = createHash("sha256")
  .update(await readFile(crsFixtureFilePath))
  .digest("hex");
let crsAuditResults = [];
let crsAuditFailure = null;
try {
  crsAuditResults = JSON.parse(
    execFileSync("cargo", ["run", "-q", "-p", "crs-audit"], {
      cwd: repositoryDirectory,
      encoding: "utf8",
    }),
  );
} catch (error) {
  crsAuditFailure = error instanceof Error ? error.message : String(error);
}
const accuracyFixtures = buildAccuracyFixtures(crsAuditResults);
const datasetIds = runSofi ? ["autzen", "sofi"] : ["autzen"];
const datasets = [];
for (const datasetId of datasetIds) {
  datasets.push(await loadDatasetBackends(datasetId));
}

const synthetic = [];
for (const pointCount of syntheticPointCounts) {
  synthetic.push({
    dataset: "deterministic WGS84 output around Autzen; no source file or geoid",
    benchmarkPointCountOnly: pointCount > 250_000,
    ...(await benchmarkCacheRepresentations(
      createSyntheticPreparedData(pointCount),
      { warmups, repetitions },
    )),
  });
  globalThis.gc();
}

await new Promise((resolveNextTurn) => setImmediate(resolveNextTurn));
globalThis.gc();
globalThis.gc();
const processMemoryAtEnd = memorySnapshot();

console.log(
  JSON.stringify(
    {
      environment: {
        timestampUtc: new Date().toISOString(),
        gitCommit: commit,
        gitBranch,
        worktreeDirty: dirtyPaths.length > 0,
        dirtyPaths,
        benchmarkScriptSha256: scriptSha256,
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        osVersion: os.version(),
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        ramBytes: os.totalmem(),
        ramMebibytes: mib(os.totalmem()),
        gpu: "N/A: Node-only runner",
        rustc: tryCommand("rustc", ["--version"]),
        packageVersions: Object.fromEntries(
          ["copc", "proj4", "typescript", "tsx", "laz-perf"].map((name) => [
            name,
            packageLock.packages?.[`node_modules/${name}`]?.version ?? "N/A",
          ]),
        ),
        wasmRuntimeFiles: binaryRuntimes,
      },
      sourceRevision: {
        commit,
        branch: gitBranch,
        dirtyPaths,
      },
      sourceAndConfiguration: {
        command: "npm run benchmark:cache-representations",
        flags: {
          COPC_CACHE_BENCHMARK_WARMUPS: process.env.COPC_CACHE_BENCHMARK_WARMUPS ?? "5 (default)",
          COPC_CACHE_BENCHMARK_REPETITIONS: process.env.COPC_CACHE_BENCHMARK_REPETITIONS ?? "15 (default)",
          COPC_CACHE_BENCHMARK_SOFI: process.env.COPC_CACHE_BENCHMARK_SOFI ?? "0 (default)",
        },
        requestedFields: backendFieldNames,
        cacheByteBudget: "N/A: representation microbenchmark; no production LRU configured",
        nodeBudget: "N/A: one root node is compared per real dataset",
        browserWorkers: "0: Node direct-backend path; no browser Worker pool",
        transformations: {
          manualHeightOffsetMeters: 0,
          geoidGrid: "none",
          verticalDatum: "as declared by the dataset WKT and current forward path; no geoid correction added by the benchmark",
        },
        datasetReadMode: "local file-backed Blob via fs.openAsBlob; no network timing or HTTP request data",
        crsAuditCommand: "cargo run -q -p crs-audit",
        crsAuditFailure,
        crsAuditFixtureSha256: crsFixtureSha256,
      },
      method: {
        timingSummary: "all timings are milliseconds; every summary includes sampleCount, p50, nearest-rank p95, min, max, mean, sample variance, standard deviation, coefficient of variation, and raw measured samples",
        warmups,
        repetitions,
        coldBackend: "fresh backend instance and freshly loaded hierarchy per sample; operating-system/file page cache is not flushed",
        warmBackend: "same opened backend instance reused across point-node samples",
        candidateMaterialization: {
          A: {
            coordinateBuffersCopied: ["source", "geographic", "world"],
            derivedBuffersAllocated: [],
          },
          B: {
            coordinateBuffersCopied: ["geographic", "world"],
            derivedBuffersAllocated: [],
          },
          C: {
            coordinateBuffersCopied: ["world"],
            derivedBuffersAllocated: [],
          },
          D: {
            coordinateBuffersCopied: ["world"],
            derivedBuffersAllocated: [
              {
                name: "height",
                type: "Float32Array",
                valuesFrom: "geographic Z",
              },
            ],
          },
          E: {
            coordinateBuffersCopied: [],
            derivedBuffersAllocated: [
              {
                name: "height",
                type: "Float64Array",
                valuesFrom: "geographic Z",
              },
            ],
            aliases: [
              "ecef -> prepared.world.coordinates",
              "world -> prepared.world",
            ],
          },
        },
        candidateMaterializationCommon: {
          requestedAttributesAndStatistics: "shared unchanged",
          repeatedCoordinateTransform: false,
        },
        inverseBatchHelper: "benchmark-only wrapper reuses ecefToGeographic; interleaved Float64 XYZ input, exact pointCount*3 validation, finite-value validation, optional distinct exact-length Float64 output, and degree/degree/metre output semantics",
        color: "full Float32 RGBA CPU buffer construction using getCopcPointColor for fixed/elevation/RGB/intensity/classification; cold samples allocate a new buffer and warm samples reuse one while toggling every mode",
        colorBoundary: "D is compared to A across the observed height range and engineered normalized palette boundaries at multiple height spans; boundary sensitivity ranges are synthetic checks, not actual display settings",
        picking: "one and one hundred deterministic point inspections; A/B read cached Geographic triples; C/D use scalar ecefToGeographic; D uses cached Float32 display height",
        backends: "default copc-js plus TypeScript and explicitly selected Rust/WASM, measured separately on the same local file, root node, and requested fields; this runner does not exercise browser Workers",
        synthetic: "10k/100k/250k/1M deterministic WGS84 positions; counts above 250k are benchmark-only and exceed typical production point budgets",
        data: "Autzen is required; SoFi runs only when COPC_CACHE_BENCHMARK_SOFI=1; each local file size and registered SHA-256 are reported",
        accuracyAcceptance: {
          float64NumericalRegressionBounds: {
            longitudeDegrees: 1e-10,
            latitudeDegrees: 1e-10,
            ellipsoidalHeightMeters: 1e-6,
            ecefRoundTripMeters: 1e-6,
            source: "existing packages/test/core/streaming/view-query.test.mjs inverse-transform regression test; software round-trip bounds only",
          },
          float32AdoptionThreshold: "UNSET: repository has no independent survey/control-point requirement for candidate D; measured errors are reported without claiming survey accuracy or adoption acceptance",
          existingCrsConformance: "CRS audit tolerances are operation/software conformance bounds, not independent survey accuracy",
        },
        limitations: [
          "local Blob range reads do not represent remote HTTP latency or file-change/offline behavior",
          "process memory snapshots are checkpoints; transient allocation peak, per-worker residency, and WASM linear-memory residency cannot be isolated in this direct Node run",
          "browser Worker encode/transfer/return, renderer submission, GPU memory, frame p50/p95, and main-thread Long Tasks are N/A in the Node harness",
          "actual streaming LRU hit/miss/eviction and camera revisit Range request behavior require the browser-stage run",
          "synthetic and checked-in CRS fixtures exercise coordinate math but do not provide surveyed control points; no real geoid grid is included",
          "source XYZ re-read decodes a whole local COPC node; remote HTTP latency, remote file replacement, and offline failure are not measured",
          "memory inventories count reachable ArrayBuffer backing stores exactly once and separately show typed attributes/statistics/aliases; JavaScript object overhead is engine-specific and reported N/A",
        ],
      },
      processMemory: {
        atBenchmarkStart: processMemoryAtStart,
        atBenchmarkEndAfterGc: processMemoryAtEnd,
      },
      accuracyFixtures,
      datasets,
      synthetic,
    },
    null,
    2,
  ),
);

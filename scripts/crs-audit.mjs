import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const require = createRequire(import.meta.url);
const proj4 = require('../apps/viewer-web/node_modules/proj4');
const repositoryDirectory = path.resolve(new URL('..', import.meta.url).pathname);
const fixturePath = path.join(repositoryDirectory, 'crates/crs-audit/src/fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).fixtures;
const sizes = [10_000, 100_000, 250_000, 500_000];
const iterations = 5;

function sourceWkt(fixture) {
  return fixture.horizontal_wkt ?? fixture.wkt;
}

function adapterIntegrationStatus(fixture) {
  return fixture.horizontal_wkt ? 'PASS' : 'ADAPTER INTEGRATION ISSUE';
}

function referencePoints(fixture) {
  const transform = proj4(sourceWkt(fixture), 'WGS84');
  return fixture.points.map((point) => {
    const [longitude, latitude] = transform.forward([point.x, point.y]);
    return {
      longitude,
      latitude,
      height: point.z * fixture.vertical_unit_scale,
    };
  });
}

function maxErrors(reference, candidate) {
  return reference.reduce((max, expected, index) => {
    const actual = candidate[index];
    return {
      longitude: Math.max(max.longitude, Math.abs(expected.longitude - actual.longitude)),
      latitude: Math.max(max.latitude, Math.abs(expected.latitude - actual.latitude)),
      height: Math.max(max.height, Math.abs(expected.height - actual.height)),
    };
  }, { longitude: 0, latitude: 0, height: 0 });
}

function runCandidate() {
  const stdout = execFileSync('cargo', ['run', '-q', '-p', 'crs-audit'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function differentialReport() {
  const candidateResults = new Map(runCandidate().map((result) => [result.id, result]));
  return fixtures.map((fixture) => {
    const candidate = candidateResults.get(fixture.id);
    if (!candidate || candidate.error) {
      return {
        id: fixture.id,
        status: 'CANDIDATE ERROR',
        candidateStatus: 'PROJ4RS GAP',
        fullWktStatus: 'UNKNOWN',
        candidateError: candidate?.error ?? 'missing candidate result',
        adapterIntegration: adapterIntegrationStatus(fixture),
      };
    }

    try {
      const reference = referencePoints(fixture);
      const errors = maxErrors(reference, candidate.points);
      const tolerance = fixture.tolerance;
      const withinTolerance = errors.longitude <= tolerance.longitude_degrees
        && errors.latitude <= tolerance.latitude_degrees
        && errors.height <= tolerance.height_meters;
      return {
        id: fixture.id,
        status: withinTolerance ? 'PASS' : 'DIFFERENTIAL MISMATCH',
        candidateStatus: 'SUPPORTED',
        fullWktStatus: candidate.full_wkt_error ? 'PROJ4WKT GAP' : 'SUPPORTED',
        pointCount: fixture.points.length,
        maxError: errors,
        tolerance: {
          longitude: tolerance.longitude_degrees,
          latitude: tolerance.latitude_degrees,
          height: tolerance.height_meters,
        },
        fullWktConversion: candidate.full_wkt_error ? 'FAIL' : 'PASS',
        fullWktError: candidate.full_wkt_error,
        adapterIntegration: adapterIntegrationStatus(fixture),
      };
    } catch (error) {
      return {
        id: fixture.id,
        status: 'REFERENCE ERROR',
        candidateStatus: 'SUPPORTED',
        fullWktStatus: candidate.full_wkt_error ? 'PROJ4WKT GAP' : 'SUPPORTED',
        referenceError: error instanceof Error ? error.message : String(error),
        fullWktConversion: candidate.full_wkt_error ? 'FAIL' : 'PASS',
        fullWktError: candidate.full_wkt_error,
        adapterIntegration: adapterIntegrationStatus(fixture),
      };
    }
  });
}

function benchmarkJavaScript(fixture) {
  const initializationStart = performance.now();
  const initializedTransform = proj4(sourceWkt(fixture), 'WGS84');
  const initializationMilliseconds = performance.now() - initializationStart;
  const base = fixture.points;

  return sizes.map((pointCount) => {
    const points = Array.from({ length: pointCount }, (_, index) => base[index % base.length]);
    const start = performance.now();
    let output = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      output = points.map((point) => {
        const [longitude, latitude] = initializedTransform.forward([point.x, point.y]);
        return [longitude, latitude, point.z * fixture.vertical_unit_scale];
      });
    }
    return {
      fixtureId: fixture.id,
      pointCount,
      iterations,
      initializationMilliseconds,
      transformMilliseconds: performance.now() - start,
      outputBytes: output.length * 3 * Float64Array.BYTES_PER_ELEMENT,
    };
  });
}

function benchmarkNative() {
  return execFileSync('cargo', ['run', '-q', '-p', 'crs-audit', '--', '--benchmark'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function benchmarkWasm() {
  const wasmPath = path.join(
    repositoryDirectory,
    'target/wasm32-unknown-unknown/release/crs_audit.wasm',
  );
  if (!fs.existsSync(wasmPath)) {
    execFileSync('cargo', [
      'build', '-p', 'crs-audit', '--target', 'wasm32-unknown-unknown', '--release',
    ], { cwd: repositoryDirectory, stdio: 'inherit' });
  }
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'copc-adapter-crs-wasm-'));
  execFileSync('wasm-bindgen', [wasmPath, '--target', 'nodejs', '--out-dir', outputDirectory], {
    cwd: repositoryDirectory,
    stdio: 'inherit',
  });
  const wasmModule = await import(pathToFileURL(path.join(outputDirectory, 'crs_audit.js')).href);

  return fixtures
    .filter((fixture) => fixture.id.startsWith('autzen') || fixture.id.startsWith('sofi'))
    .flatMap((fixture) => sizes.map((pointCount) => {
      const input = new Float64Array(
        Array.from({ length: pointCount }, (_, index) => fixture.points[index % fixture.points.length])
          .flatMap((point) => [point.x, point.y, point.z]),
      );
      const initializationStart = performance.now();
      const transformer = new wasmModule.CrsAuditTransformer(fixture.id);
      const initializationMilliseconds = performance.now() - initializationStart;
      const start = performance.now();
      let output;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        output = transformer.transform_points(input);
      }
      return {
        fixtureId: fixture.id,
        pointCount,
        iterations,
        initializationMilliseconds,
        transformMilliseconds: performance.now() - start,
        outputBytes: output.length * Float64Array.BYTES_PER_ELEMENT,
        wasmBytes: fs.statSync(wasmPath).size,
      };
    }));
}

const report = {
  differential: differentialReport(),
  nativeBenchmark: [],
  javascriptBenchmark: [],
  wasmBenchmark: [],
};

if (process.argv.includes('--benchmark')) {
  report.nativeBenchmark = benchmarkNative();
  report.javascriptBenchmark = fixtures
    .filter((fixture) => fixture.id.startsWith('autzen') || fixture.id.startsWith('sofi'))
    .flatMap(benchmarkJavaScript);
}

if (process.argv.includes('--wasm')) {
  report.wasmBenchmark = await benchmarkWasm();
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.table(report.differential);
  if (report.nativeBenchmark.length > 0) {
    console.log('\nNative Rust benchmark:');
    console.table(report.nativeBenchmark);
    console.log('\nproj4js benchmark:');
    console.table(report.javascriptBenchmark);
    if (report.wasmBenchmark.length > 0) {
      console.log('\nWASM benchmark:');
      console.table(report.wasmBenchmark);
    }
  }
}

if (report.differential.some((result) => result.status !== 'PASS')) {
  process.exitCode = 1;
}

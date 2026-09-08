import test from 'node:test';
import assert from 'node:assert/strict';

import { RustCrsTransformer } from '../src/coordinates/transform/rustCrsTransformer.ts';
import { geographicToEcef } from '../src/coordinates/transform/worldCoordinates.ts';
import { getCopcWasmBinary } from '../src/wasm/copcWasm.ts';
import { loadCopcWasmWorker } from '../src/wasm/copcWasmWorker.ts';

const WGS84_GEOGRAPHIC_WKT = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';

test('Rust CRS WASM worker loader supplies the proj4rs imports', async () => {
  const wasm = await loadCopcWasmWorker(await getCopcWasmBinary());
  const wktBytes = new TextEncoder().encode(WGS84_GEOGRAPHIC_WKT);
  const wktPointer = wasm.alloc_bytes(wktBytes.byteLength);
  new Uint8Array(wasm.memory.buffer, wktPointer, wktBytes.byteLength).set(wktBytes);

  try {
    const responsePointer = wasm.create_crs_transform_json(wktPointer, wktBytes.byteLength);
    const responseBytes = new Uint8Array(wasm.memory.buffer);
    let responseEnd = responsePointer;
    while (responseBytes[responseEnd] !== 0) responseEnd += 1;
    const response = JSON.parse(new TextDecoder().decode(responseBytes.subarray(responsePointer, responseEnd)));
    assert.equal(response.ok, true);
    wasm.free_crs_transform(response.value.handle);
    wasm.free_parser_json(responsePointer);
  } finally {
    wasm.dealloc_bytes(wktPointer, wktBytes.byteLength);
  }
});

test('Rust CRS transformer reuses a WASM handle for geographic and ECEF buffers', async () => {
  const transformer = await RustCrsTransformer.fromMetadata({
    wkt: WGS84_GEOGRAPHIC_WKT,
    bounds: { minX: 10, minY: 20, minZ: 0, maxX: 11, maxY: 21, maxZ: 100 },
  });

  try {
    const first = transformer.transform(new Float64Array([10.25, 20.5, 100]));
    const second = transformer.transform(new Float64Array([10.75, 20.75, 200]));

    assert.equal(first.pointCount, 1);
    assert.equal(second.pointCount, 1);
    assert.ok(Math.abs(first.geographicCoordinates[0] - 10.25) < 1e-12);
    assert.ok(Math.abs(first.geographicCoordinates[1] - 20.5) < 1e-12);
    assert.equal(first.geographicCoordinates[2], 100);
    assert.ok(first.ecefCoordinates.every(Number.isFinite));
    const reference = geographicToEcef({ longitude: 10.25, latitude: 20.5, height: 100 });
    assert.ok(Math.abs(first.ecefCoordinates[0] - reference.x) < 1e-6);
    assert.ok(Math.abs(first.ecefCoordinates[1] - reference.y) < 1e-6);
    assert.ok(Math.abs(first.ecefCoordinates[2] - reference.z) < 1e-6);
    assert.equal(first.usedHorizontalFallback, false);
  } finally {
    transformer.dispose();
  }
});

test('Rust CRS transformer preserves the projected-WKT requirement without hidden fallback', async () => {
  await assert.rejects(
    () => RustCrsTransformer.fromMetadata({
      bounds: { minX: 1000, minY: 1000, minZ: 0, maxX: 1001, maxY: 1001, maxZ: 1 },
    }),
    (error) => error?.code === 'missing-wkt',
  );
});

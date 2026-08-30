# Library API

`apps/viewer-web/src/index.ts` 가 source public entrypoint 이며, package
consumers should import the generated `@frillab/copc-adapter` package.

## Exported API

### `CopcCesiumLayer`

호출자가 소유한 Cesium `Viewer`에 COPC streaming primitives를 연결하는 public class.

주요 메서드:

- `load()`: URL에서 metadata / hierarchy 로딩
- `unload()`: loaded data와 rendered primitives 정리
- `reload()`: `unload()` 후 configured URL을 다시 로딩
- `attachTo(viewer)`: caller-owned Cesium viewer에 primitives와 camera listener 연결
- `detachFrom()`: Cesium viewer를 destroy하지 않고 primitives와 listener 분리
- `destroy()`: layer resource 와 listener 정리
- `getSnapshot()`: 현재 lifecycle, 선택 node, 렌더링 point 수와 decoded CPU
  point-cache, stage-timing, range-byte, and (Rust) worker queue metrics 조회
- `getHierarchyDiagnostics()`: hierarchy page request/cache/byte counters 조회
- `getPointCacheDiagnostics()`: decoded CPU point-buffer cache counters 조회
- `getSelectedPoint()`: 현재 live decoded buffer에서 선택된 point inspection 조회

`load()`와 `reload()`는 source/context 생성, metadata 및 CRS 검증,
root hierarchy page 로딩 실패를 각각 project-owned `CopcLoadError`로 reject한다.
`stage`는 `'source' | 'metadata' | 'hierarchy' | 'point-data' | 'decode' |
'wasm'`, `source`는 원본 configured URL이며, 지원되는 runtime에서는 원래 오류가 `cause`에 보존된다. 표시용
`message`에서는 URL credential, query, fragment가 제거되므로 demo/debug
panel에 그대로 표시할 수 있다. `CopcSourceError`, `CopcMetadataError`,
`CopcHierarchyLoadError`도 public entrypoint에서 export된다.

### `probeCopcSource(url)`

`probeCopcSource(url)` is a low-cost browser diagnostic for a remote source.
It is independent of `CopcCesiumLayer.load()` and is not run automatically by
the library's normal loading path.

```ts
import { probeCopcSource } from '@frillab/copc-adapter';

const result = await probeCopcSource(url);
```

The returned `CopcSourceProbeResult` is project-owned and contains the
observed HTTP status, requested and returned ranges, known resource length
and `Content-Range` when available, `reachable`, `rangeSupported`,
`corsReadable`, `copcDetected`, optional LAS `pointFormat`, and actionable
`warnings`. Boolean capability fields use `true`, `false`, or `'unknown'`
where a browser cannot distinguish a network failure from a CORS block.

The default request is `bytes=0-1023`. The response body is bounded; if the
LAS header says its VLR metadata extends beyond that prefix, the probe can
request only the missing metadata bytes. A healthy response is HTTP `206`,
has a `Content-Range` matching the requested bytes, and contains exactly the
requested body length. HTTP `200`, malformed or mismatched `Content-Range`,
short bodies, `404`, `416`, and network failures are retained as structured
diagnostic outcomes rather than raw `Response` objects.

For cross-origin resources, CORS and Range should be diagnosed separately. A
readable response with bad range semantics reports `corsReadable: true` and
`rangeSupported: false`. When the browser rejects the fetch before exposing a
response, both reachability of the resource and the precise cause are not
provable; the result uses `corsReadable: 'unknown'` and points to network and
CORS checks in `warnings`. The current reader requires the browser to send a
`Range` request and read `Content-Range`; it does not depend on
`Content-Length` being exposed.

### `CopcCesiumLayerOptions`

- `url`: HTTP range request를 지원하는 browser-readable COPC URL
- `pointSize`: Cesium point primitive 크기 (기본값 `3`)
- `colorMode`: `'fixed' | 'elevation' | 'rgb' | 'intensity' |
  'classification'` (기본값 `'fixed'`). `elevation`은 transformed dataset
  height, `rgb`는 source RGB, `intensity`는 node buffer의 intensity 범위,
  `classification`은 categorical palette를 사용한다. 필요한 attribute가
  없으면 fixed cyan으로 fallback한다.
- `debug`: lifecycle debug logging 활성화
- `maxRenderedPoints`: maximum estimated points in the active current-view
  workload. This is equivalent to `streaming.maxRenderedPoints` and is shown
  separately because it is the primary render-pressure control.
- `streaming`: `maxNodes`, `maxDepth`, `maxScreenSpaceError`,
  `maxRenderDistanceMeters`, and `maxRenderedPoints` overrides.
  `maxRenderedPoints` bounds the estimated active current-view point workload;
  it is not GPU-memory accounting. The default is an experimental conservative
  `250000`, informed by the issue-48 renderer benchmark. `maxScreenSpaceError` is the maximum
  projected replacement error in pixels and defaults to `8`. The former
  `refineDistanceMultiplier` remains accepted for source compatibility but is
  deprecated and no longer controls refinement.
- `backend`: `'copc-js' | 'rust' | CopcBackend`; defaults to `'copc-js'`.
  Rust is opt-in and does not silently fall back to `copc-js`.
- `decoder`: optional `CopcPointDecoder`; defaults to the Rust/WASM decoder
- `renderer`: optional project-owned `CopcPointRenderer`; defaults to the
  compatibility `PointPrimitiveRenderer`. A renderer receives transformed
  geographic point buffers and owns only node add/update/remove/clear/destroy;
  COPC loading, selection, LoD, and streaming remain layer responsibilities.
- `maxPointCacheBytes`: decoded CPU point-buffer cache budget in bytes (default
  `256 * 1024 * 1024`). This estimates project-owned typed-array storage and
  does not measure exact Cesium/WebGL/browser memory.
- `onPointPicked`: optional callback receiving the current point inspection, or
  `undefined` when a non-COPC/empty pick or lifecycle change clears selection.

The Rust selector uses the same layer API; it does not create a Rust-only
Viewer. Applications continue to create and own `Cesium.Viewer`, then call
`layer.attachTo(viewer)`.

In browsers, Rust point chunks are decoded by a per-source bounded Web Worker
pool. Range requests stay on the main thread, queued work is superseded on a
new streaming generation, and stale active results are ignored. Worker
failures use `CopcBackendError` code `worker`; unloading or destroying a layer
terminates the source-owned workers. `getSnapshot().worker`, when present,
reports configured/active/queued counts, observed peaks, and submitted,
completed, cancelled, and failed job counts. `getSnapshot().performance` reports
range bytes alongside range, decode, CRS, and renderer timings.

### Point field selection

The public `CopcPointFieldSelection` is a `ReadonlySet` of project-owned
fields: `position`, `intensity`, `classification`, and `rgb`. Use
`getCopcPointFieldSelection(colorMode)` to obtain the minimum request for a
render mode. `CopcSource.loadPointDataView(node, fields)` accepts that request
without exposing `copc.js`, LAS, LAZ, or Cesium types.

The returned `CopcPointView.availableFields` reports fields that are both
requested and present in the source. Missing and unrequested fields are
unavailable, never zero-filled. Decode failures propagate as errors. Point
buffers validate that every present attribute array has exactly `pointCount`
values. RGB channel arrays retain source 16-bit precision until the rendering
layer normalizes them for Cesium.

## Quick Start

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo(viewer);

// Optional request/cache diagnostics for incremental hierarchy loading.
console.log(layer.getHierarchyDiagnostics());
```

Install the package together with the Cesium version owned by the host app:

```bash
npm install @frillab/copc-adapter cesium
```

`cesium` is a peer dependency. `copc`, `proj4`, and the browser decoder
runtime are provided by the adapter package; its `npm pack` artifact includes
the Rust/WASM and LAZ decoder assets, so no `/wasm` or `/laz-perf.wasm` web-root
copy is required.

## Layer Lifecycle

```ts
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
});

await layer.load();
layer.attachTo(viewer);

layer.detachFrom();
await layer.reload();
layer.attachTo(viewer);

layer.destroy();
```

## Decoder Boundary

The public entrypoint exports `CopcBackend`, `CopcSource`, `CopcJsBackend`, and
`CopcPointDecoder`. Applications normally use the defaults; alternative
backends and test doubles can be passed through layer options without changing
the controller or renderer.

The default backend is `CopcJsBackend`. Selecting `backend: 'rust'` uses the
exported `RustCopcBackend` behind the same source boundary; the layer,
streaming manager, coordinate transform, and Cesium renderer do not change.
Both production backends return project-owned buffers. The Rust path decodes
XYZ and selected LAS attributes directly in Rust/WASM.

The public entrypoint also exports the backend-neutral `RandomAccessByteSource`,
`HttpRangeByteSource`, `InMemoryByteSource`, and `RangeSourceError` types for
the Rust/WASM reader boundary. `RustCopcReader` and `RustCopcParseError` are
also exported for callers that need to parse LAS/COPC metadata, the root
hierarchy, and one LAS 1.4 point chunk through an injected random-access
source. `CopcBackendError` maps Rust source, parser, hierarchy, point-chunk,
LAZ, unsupported-format, worker, and WASM failures into project-owned stage/category
values while preserving `cause`.

`CopcPointBuffer`와 `GeographicPointBuffer`는 optional `intensity`,
`classification`, `red`, `green`, `blue` typed arrays를 보존한다. source point
format에 없는 attribute는 생성하지 않는다. RGB/intensity/classification
style은 해당 typed arrays를 직접 사용하며, attribute 누락 시 fixed color로
fallback한다.

### Point picking and inspection

Cesium point picks carry only a project-owned `{ nodeKey, pointIndex }` identity
plus a compact layer-local ownership token. `CopcCesiumLayer.getSelectedPoint()` resolves it through the current
rendered node and decoded CPU cache, returning transformed position/height,
retained source XYZ, node level, and available attributes. RGB, intensity, and
classification remain unavailable when the active field selection did not
request or decode them. Picking does not force unconditional full-field
decoding; removed or evicted nodes clear stale selection safely.

- `copc.js`: metadata, hierarchy, point view 로딩
- `copc-wasm`: focused LAS 1.4 point 6/7/8 node decode and X/Y/Z interleaving
- `viewer-web` decoder: available LAS attributes -> optional typed arrays
- `viewer-web`: streaming selection, CRS transform, Cesium rendering

Worker/WASM assets are resolved from the installed package build using the
worker module's `import.meta.url`; consumers do not need to copy assets into
`/public`.

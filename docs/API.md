# Public API

This document describes the current public API of `@frillab/copc-adapter`.
The root entrypoint is the backwards-compatible Cesium entrypoint. New
integrations may import the explicit renderer paths:

```text
@frillab/copc-adapter         → Cesium-compatible root
@frillab/copc-adapter/cesium  → Cesium API
@frillab/copc-adapter/three   → Three.js API
```

`cesium` and `three` are optional peer dependencies. Install the renderer used
by the application. The internal point-processing implementation is not part
of the public API contract; its placement may change between TypeScript and
Rust/WASM while these interfaces remain compatible.

## `CopcCesiumLayer`

`CopcCesiumLayer` connects a streamed COPC resource to a caller-owned Cesium
`Viewer`. It never creates or destroys that viewer.

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
  colorMode: 'elevation',
});

await layer.load();
layer.attachTo(viewer);
```

### `CopcCesiumLayerOptions`

- `url`: browser-readable COPC URL. The source must support HTTP Range
  requests and appropriate CORS headers.
- `pointSize`: Cesium point size in pixels. Default: `3`.
- `colorMode`: `'fixed' | 'elevation' | 'rgb' | 'intensity' |
  'classification'`. Default: `'fixed'`.
- `debug`: enable lifecycle messages through `console.debug`.
- `maxRenderedPoints`: maximum estimated point workload in the active view.
  Default: `250000`.
- `streaming`: overrides for `maxNodes` (default `24`), `maxDepth` (default
  `6`), `maxScreenSpaceError` in pixels (default `8`),
  `screenSpaceErrorHysteresis` in pixels, `maxRenderDistanceMeters` (default
  `12000`), and `maxRenderedPoints`.
- `refineDistanceMultiplier`: accepted for source compatibility but deprecated;
  the current selector uses screen-space error instead.
- `backend`: `'copc-js' | 'rust' | CopcBackend`. Default: `'copc-js'`.
  `'rust'` explicitly selects the Rust/WASM backend. Backend failures are not
  silently retried through `copc-js`.
- `decoder`: optional `CopcPointDecoder` used when a source returns a point
  view rather than a direct point buffer. The default is the bundled
  Rust/WASM-backed XYZ interleaver; the Rust backend's direct buffer path is
  used when available.
- `renderer`: optional Cesium renderer implementation. The default uses Cesium
  point primitives.
- `maxPointCacheBytes`: decoded CPU point-buffer cache budget. Default:
  `256 * 1024 * 1024`.
- `onPointPicked`: called with a selected `CopcPointInspection`, or `undefined`
  when selection is cleared.

### Lifecycle

```ts
await layer.load();       // metadata and the root hierarchy page
layer.attachTo(viewer);   // camera/view updates and rendering
layer.detachFrom();       // detach without unloading or destroying viewer
await layer.reload();     // unload and load the configured URL again
layer.unload();           // release loaded source, hierarchy, and point data
layer.destroy();          // permanently release layer-owned resources
```

`load()` and `reload()` reject with project-owned errors when source, metadata,
CRS, or hierarchy initialization fails. `getMetadata()` returns the loaded
metadata, when available.

## `CopcThreeLayer`

`CopcThreeLayer` is exported from `@frillab/copc-adapter/three`. It attaches to
an application-owned scene and camera and does not own the renderer or render
loop.

```ts
import * as THREE from 'three';
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
const renderer = new THREE.WebGLRenderer();
const layer = new CopcThreeLayer({
  url: 'https://example.com/data.copc.laz',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo({ scene, camera, renderer });

function animate() {
  requestAnimationFrame(animate);
  void layer.update();
  renderer.render(scene, camera);
}
animate();
```

Current options include `url`, `pointSize` (default `3`), `colorMode`,
`maxRenderedPoints`, `streaming`, `backend`, `decoder`,
`maxPointCacheBytes`, `debug`, `pickingThreshold` (default `1` scene unit),
an optional compatible `renderer`, and `onPointPicked`.

`update()` reads the attached camera and drives the shared streaming core. It
does not render or schedule the application loop; equivalent views are not
submitted repeatedly. The layer creates one root `THREE.Group` and owns the
point objects, geometries, and materials below it. The application owns the
scene, camera, WebGL renderer, controls, and loop.

The loaded dataset uses a fixed local ENU frame in metres: +X east, +Y north,
and +Z up. `pick({ x, y })` accepts normalized device coordinates and returns a
`CopcPointInspection` or `undefined`. An optional `THREE.Raycaster` and
threshold can be supplied. `detachFrom()`, `unload()`, `reload()`, and
`destroy()` do not dispose application-owned Three.js resources.

## `CopcStreamingController`

`CopcStreamingController` is the renderer-neutral streaming core, also
exported as `CopcStreamingCore`. It can be used without importing Cesium or
Three.js.

```ts
import { CopcStreamingController } from '@frillab/copc-adapter/three';

const core = new CopcStreamingController({
  url: 'https://example.com/data.copc.laz',
});

await core.load();
await core.updateView({
  longitude,
  latitude,
  height,
  viewDistanceMeters,
  viewFrustum,
});
```

`CopcStreamingControllerOptions` includes:

- `url`;
- `streaming`, with the shared selection limits;
- `maxRenderedPoints`;
- `backend`;
- `decoder`;
- `pointFields`, a project-owned selection of `position`, `intensity`,
  `classification`, and `rgb`;
- `maxPointCacheBytes`; and
- `debug`.

The shared streaming limits include `maxNodes` (default `24`), `maxDepth`
(default `6`), `maxScreenSpaceError` in pixels (default `8`),
`screenSpaceErrorHysteresis`, `maxRenderDistanceMeters` (default `12000`),
`maxRenderedPoints` (default `250000`), and `maxConcurrentNodeLoads` (default
`4`). `maxConcurrentNodeLoads` bounds active range/decode/preparation work and
is independent of the rendered-point budget. The limit is shared by overlapping
view generations; superseded work keeps its slot until its underlying load
settles. `maxPointsPerBatch` is retained for source compatibility but no longer
creates completion barriers.
`refineDistanceMultiplier` is accepted for compatibility but is deprecated and
no longer controls refinement.

`load()` reads metadata and the root hierarchy. `updateView(view,
onProgress?)` performs view-driven hierarchy loading and selection and reports
progressively prepared point data. The view and progress types contain no
engine objects; loaded entries use the shared `PreparedPointData` contract and
retain compatibility geographic aliases. `undefined` is returned when an update is
superseded by a newer view or lifecycle operation.

`getSnapshot().performance` includes aggregate scheduler diagnostics for the
configured load slots, queued/active/completed/cancelled work, peak active
loads, and first-priority-node ready latency.

The core lifecycle is `idle | loading | ready | destroyed`. It provides
`getSnapshot()`, `getMetadata()`, `getHierarchyDiagnostics()`,
`getPointCacheDiagnostics()`, `getCurrentSelection()`, `getCurrentView()`,
`getHierarchyNode()`, `getCachedPointBuffer()`, and `getTransitionState()`, as
well as `unload()`, `reload()`, and `destroy()`.

## Backend and point contracts

`CopcBackend.open(url)` returns a project-owned `CopcSource`. A source exposes
metadata, the root hierarchy page, hierarchy-page loading, and point views or
point buffers. It does not expose `copc` or renderer types.

The current backend selection is:

- `copc-js`: the default production backend. It uses the `copc` implementation
  for metadata, hierarchy, and point-view loading.
- `rust`: explicit opt-in Rust/WASM processing. The current path uses Rust for
  LAS/COPC metadata and hierarchy interpretation plus LAS 1.4 point/LAZ
  decoding and requested-field extraction. Streaming node loads additionally
  use Rust's fused decode/CRS/ECEF prepared-point path. TypeScript retains
  browser Range I/O and worker orchestration.
- an injected `CopcBackend`: supported for tests and host-owned sources.

`CopcPointFieldSelection` is a `ReadonlySet` of `position`, `intensity`,
`classification`, and `rgb`. `CopcPointView.availableFields` reports fields
that were requested and are present. Missing fields are not zero-filled.
`CopcPointBuffer` retains `Float64Array` `copc-source` coordinates and optional
typed attribute arrays. RGB and intensity retain their source integer precision.

`CopcPointData` and the current `GeographicPointBuffer` can retain all three
coordinate spaces:

- `copc-source` source/project XYZ;
- `wgs84-geographic` longitude, latitude, and height; and
- `wgs84-ecef-meters` world coordinates.

`PreparedPointData` is the shared cache contract for prepared node data. It
retains the three coordinate buffers as tagged `Float64Array` values, requested
typed attributes, and optional `elevation`, `intensity`, and `rgbMax`
statistics. The legacy flat geographic fields are aliases to the named
buffers, so existing inspection and renderer APIs do not require a second copy.
The ECEF buffer is the renderer-neutral render-space authority. Three.js
derives its own local ENU/Float32 representation from it, while Cesium wraps
prepared ECEF triples directly as `Cartesian3` values without a second
geographic conversion.

Rust/WASM results tag each coordinate buffer explicitly. The fused Worker
result contains source, WGS84 geographic, and WGS84 ECEF buffers, requested
attributes, and Rust-computed statistics. The Worker transfers owned
`ArrayBuffer` instances, and TypeScript copies out of WASM memory before the
result enters the decoded CPU cache. No renderer object or view into WASM
linear memory is retained by the cache.

The current TypeScript coordinate path uses the project WKT helpers and the
`proj4js` dependency for applicable projected CRS transformations. The
Rust/WASM backend remains opt-in and its CRS path covers the validated supported
WKT/CRS matrix only; full PROJ or vertical-datum parity is not implied. This
implementation detail is not a separate public coordinate API.

`CopcPointDecoder.decode(view)` remains available for injected decoders and
legacy source implementations. The public point-processing types are
renderer-neutral; a renderer receives numeric data, not COPC compression or
engine objects.

## Diagnostics, errors, and picking

`getSnapshot()` reports lifecycle, backend, selected nodes, rendered nodes and
points, streaming performance, replacement transitions, hierarchy counters,
point-cache counters, and Rust worker counters when the Rust backend is active.
The performance values include selection, frustum/SSE, workload budget,
hierarchy, range, decode, point preparation, CRS, and renderer stages where
applicable. `pointPreparationDurationMs` separates the fused Rust CRS/ECEF and
reduction stage from `decodeDurationMs`; the legacy TypeScript path continues
to report `crsTransformDurationMs`. Cesium's `worldToCartesianDurationMs`
measures ECEF wrapping separately from its legacy `geographicToCartesian` path.

`getHierarchyDiagnostics()` reports hierarchy-page requests, cache hits, bytes,
pages, and entries. `getPointCacheDiagnostics()` reports project-owned decoded
CPU point-buffer memory, not exact browser, WebGL, or GPU memory.

The public errors include `CopcLoadError`, `CopcSourceError`,
`CopcMetadataError`, `CopcHierarchyLoadError`, and `CopcBackendError`.
Backend errors retain their original `cause` where available and identify the
stage/category, including source range, metadata, hierarchy, point chunk,
decode, worker, unsupported input, and WASM failures.

`CopcCesiumLayer.getSelectedPoint()` and `CopcThreeLayer.pick()` resolve a
project-owned `{ nodeKey, pointIndex }` identity through the live decoded
buffer. The inspection may include transformed position/height, source XYZ,
WGS84 ECEF/world coordinates, node level, and requested attributes. Evicted or
removed nodes clear stale selection safely.

## Source requirements

COPC sources must support byte Range requests. Cross-origin sources must allow
the consuming origin, allow the browser's `Range` request header, and expose
`Content-Range`. `probeCopcSource(url)` performs a bounded prefix probe and
returns structured reachability, Range, CORS-observability, LAS/COPC, and
warning fields without downloading the whole source.

See [ARCHITECTURE.md](ARCHITECTURE.md) for implementation ownership and
[CONFORMANCE.md](CONFORMANCE.md) for backend and CRS correctness strategy.

# COPC Adapter

[![npm](https://img.shields.io/npm/v/@frillab/copc-adapter.svg)](https://www.npmjs.com/package/@frillab/copc-adapter) [![CI](https://github.com/mors119/copc-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/mors119/copc-adapter/actions/workflows/ci.yml) [![License](https://img.shields.io/github/license/mors119/copc-adapter.svg)](https://github.com/mors119/copc-adapter/blob/main/LICENSE) [![GitHub release](https://img.shields.io/github/v/release/mors119/copc-adapter.svg)](https://github.com/mors119/copc-adapter/releases)

Stream and visualize Cloud Optimized Point Cloud (COPC) data directly in
CesiumJS and Three.js without preprocessing or converting it to
renderer-specific tiles.

COPC Adapter reads the original COPC resource in the browser, uses HTTP Range
requests to load the hierarchy and selected point chunks, and renders them
through the renderer adapter selected by the application. The application
keeps ownership of its own viewer or scene.

![COPC Adapter demo](docs/assets/copc-main.gif)

The repository-owned captures use the local Autzen Stadium sample
(`/samples/autzen.copc.laz`) rendered in CesiumJS with the demo's `rgb` color
mode. The streaming capture shows the same dataset while camera movement
drives view-aware LoD refinement; the static styling examples below also
include the `elevation` and `classification` modes.

## Why COPC Adapter

Many point-cloud workflows look like this:

```text
Point cloud -> preprocessing -> tiling/conversion -> hosting -> visualization
```

COPC Adapter keeps the original COPC resource as the source for both storage
and visualization:

```text
COPC -> HTTP Range requests -> hierarchy / LoD -> point chunks
                                                    ├─ CesiumJS
                                                    └─ Three.js
```

It is a focused browser-side path for applications that want to stream COPC
data without a separate conversion step.

## Features

- Direct COPC streaming from a browser-readable URL
- HTTP Range random access and recursive hierarchy traversal
- Incremental view-driven hierarchy loading with perspective frustum filtering
- Coverage-preserving mixed-LoD streaming with screen-space-error refinement
- Bounded node/point workload and decoded-point cache
- Gaze-aware refinement priority and LoD hysteresis
- Coverage-safe asynchronous coarse/fine renderer transitions
- CesiumJS rendering through a caller-owned `Viewer`
- Three.js rendering through a caller-owned scene and render loop
- Stable `copc-js` backend and opt-in Rust/WASM backend
- Fixed, RGB, elevation, intensity, and classification styling
- Typed TypeScript API and explicit layer lifecycle
- Public point picking with a compact node/index identity and demo inspector
- Packed npm artifact with declarations and decoder runtime assets

## Quick Start: CesiumJS

Install the package and the Cesium version owned by your application:

```bash
npm install @frillab/copc-adapter cesium
```

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

The caller owns the Cesium `Viewer` and is responsible for destroying it.

The historical root import remains supported for existing Cesium consumers:

```ts
import { CopcCesiumLayer } from '@frillab/copc-adapter';
```

### Three.js package boundary

Three.js consumers should import the isolated renderer entrypoint rather than
the backwards-compatible Cesium root entrypoint:

```bash
npm install @frillab/copc-adapter three
```

```ts
import * as THREE from 'three';
import {
  CopcStreamingCore,
  createPerspectiveViewFrustum,
} from '@frillab/copc-adapter/three';
```

`@frillab/copc-adapter/three` has no static Cesium module dependency. The
package keeps both renderer peers optional because one package serves both
entrypoints; applications install the renderer they use. The Three.js façade
is available from the isolated `./three` export. It uses a
fixed dataset-local ENU frame (`+X` east, `+Y` north, `+Z` up) for both camera
views and rendered points, while the application retains ownership of the
scene, camera, WebGL renderer, and render loop. See the [Three package boundary
decision](docs/benchmarks/issue-139-three-package-boundary.md).

```ts
import * as THREE from 'three';
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
const renderer = new THREE.WebGLRenderer();
const layer = new CopcThreeLayer({
  url: 'https://example.com/data.copc.laz',
  colorMode: 'elevation',
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

`layer.pick({ x, y })` accepts normalized device coordinates and resolves the
hit through the live decoded buffer. `pickingThreshold` is in scene units and
defaults to one metre. `layer.detachFrom()`, `layer.unload()`,
`layer.reload()`, and `layer.destroy()` release only resources owned by the
layer; they never dispose the application renderer or scene.

For the Cesium façade, destroying the layer does not destroy the viewer:

```ts
layer.detachFrom();
layer.destroy();
viewer.destroy();
```

The decoded point cache is bounded by `maxPointCacheBytes` (256 MiB by
default), in addition to its node-count safety cap. Its diagnostics count the
actual `TypedArray.byteLength` values for cached project-owned coordinates and
attributes. They represent decoded CPU point-buffer memory, not exact browser,
Cesium, or GPU memory:

```ts
console.log(layer.getPointCacheDiagnostics());
```

Rendered points are picked with Cesium's normal `scene.pick` behavior. The
layer keeps only a project-owned `{ nodeKey, pointIndex }` identity on each
point and a layer-local ownership token, then resolves it through the current decoded node buffer. Use
`onPointPicked` or `layer.getSelectedPoint()` after a click to read transformed
position/height, retained source XYZ, and RGB/intensity/classification when
those fields were requested and decoded. Missing fields remain unavailable,
and picking never forces full-field decoding. The demo includes a compact
lower-right inspector.

The COPC source must support HTTP Range requests. Cross-origin sources also
need CORS headers that allow the consuming origin, allow the browser's `Range`
request header, and expose `Content-Range` so the reader can validate each
partial response.

### Diagnose a COPC source

COPC stores hierarchy pages and compressed point chunks at different byte
offsets, so browser streaming needs reliable random access. Use the small
project-owned probe before reporting a load failure:

```ts
import { probeCopcSource } from '@frillab/copc-adapter';

const source = await probeCopcSource('https://example.com/data.copc.laz');
console.table(source);
```

The probe requests only bytes `0-1023`, reads a bounded response prefix, and
may request the remainder of the LAS VLR area when that metadata is not in the
first prefix. It does not download the whole file. A healthy result has
`reachable: true`, `rangeSupported: true`, HTTP `206`, a returned range that
matches the request, and `copcDetected: true`. `pointFormat` is the LAS point
data record format when the header is observable.

`rangeSupported: false` means the browser observed an unusable response, such
as HTTP `200` when the server ignored Range, a mismatched `Content-Range`, or a
short body. `corsReadable: true` means the response could be inspected. A
browser fetch failure can be caused by CORS, DNS, TLS, an offline client, or
another network condition, so the probe reports that state as `unknown` and
suggests checking both network availability and CORS policy.

Range and CORS are separate concerns: a response can be CORS-readable but
still return `200` or invalid partial content, and a server can implement
correct ranges while the browser is unable to read them cross-origin. Common
deployment problems include an object-storage gateway, CDN, or reverse proxy
stripping the `Range` request, converting `206` to `200`, changing
`Content-Range`, or omitting the CORS rules for the application origin and
`Range`/`Content-Range`. The server should preserve the requested byte range,
return exactly that body, and make `Content-Range` readable to the browser.

The development viewer runs this probe once when its debug panel is enabled
and displays reachability, Range/206, CORS observability, COPC detection, point
format, and warnings. Normal `CopcCesiumLayer.load()` does not add a separate
diagnostic request.

## Rust / WASM Backend

`copc-js` is the stable default backend. Rust/WASM is opt-in and experimental:

```ts
const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
  backend: 'rust',
});
```

Both backends use the same public layer, renderer-neutral streaming, and
prepared-point contract. Rust/WASM does not create or own a viewer or scene.
In the Rust streaming path, each Worker initializes reusable dataset CRS/LAZ state
and prepares one node's source/geographic/ECEF buffers, requested attributes,
and point statistics in one job. `decodeDurationMs` and
`pointPreparationDurationMs` are reported separately; the JS path remains the
reference implementation and is not silently used as a Rust fallback.

## Styling Modes

<table>
  <thead>
    <tr>
      <th>RGB</th>
      <th>Elevation</th>
      <th>Classification</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><img src="docs/assets/copc-rgb.webp" width="280" alt="RGB COPC rendering"></td>
      <td><img src="docs/assets/copc-elevation.webp" width="280" alt="Elevation COPC rendering"></td>
      <td><img src="docs/assets/copc-classification.webp" width="280" alt="Classification COPC rendering"></td>
    </tr>
    <tr>
      <td><code>colorMode: 'rgb'</code></td>
      <td><code>colorMode: 'elevation'</code></td>
      <td><code>colorMode: 'classification'</code></td>
    </tr>
  </tbody>
</table>

The supported modes are:

- `fixed`: stable cyan fallback color
- `rgb`: source RGB channels
- `elevation`: transformed dataset height range
- `intensity`: normalized intensity range
- `classification`: categorical classification palette

Attribute-based modes fall back to the fixed color when the required source
attribute is unavailable.

## Camera-Driven LoD and Streaming

![COPC Adapter streaming demo](docs/assets/copc-streaming.gif)

Camera movement changes hierarchy discovery and selection. With a valid
perspective camera, hierarchy queries follow a conservative envelope of the
active view (including oblique views) rather than a box centered only on the
camera position. Callers without a usable perspective view retain a finite
camera-based fallback. Cached hierarchy pages are reused as the view changes.

The selector maintains a visible coarse frontier and replaces nodes with finer
data when screen-space error, view relevance, hysteresis, and node/point
workload limits permit it. Replacements preserve coarse coverage until finer
data is ready, while newer camera generations supersede stale asynchronous
work. See the [architecture guide](docs/ARCHITECTURE.md) for the ownership
boundary and the [API documentation](docs/API.md) for current options.

## Architecture

COPC Adapter has a shared browser streaming core and thin renderer adapters.
The current implementation uses `copc-js` by default and an opt-in Rust/WASM
backend. TypeScript owns browser Range I/O, view/LoD policy, and the copc-js
reference preparation path; Rust streaming uses its fused decode/CRS/ECEF
preparation result. CesiumJS and Three.js consume the shared prepared data
while the application retains ownership of its viewer or scene.

See the [architecture guide](docs/ARCHITECTURE.md) for current ownership,
target processing architecture, and migration invariants.

## Public API and Lifecycle

With a caller-owned `viewer` and a configured `layer`, the lifecycle is:

```ts
import { CopcCesiumLayer } from '@frillab/copc-adapter';

await layer.load();
layer.attachTo(viewer);

layer.detachFrom();
await layer.reload();
layer.unload();
layer.destroy();

const snapshot = layer.getSnapshot();
const metadata = layer.getMetadata();
```

See [API documentation](docs/API.md) for options, backend boundaries, point
fields, errors, and lifecycle details.

## Development

Requirements: Node.js 18 or later and a Rust toolchain with the
`wasm32-unknown-unknown` target.

```bash
rustup target add wasm32-unknown-unknown
npm ci
npm ci --prefix apps/viewer-web
npm run download-samples -- autzen
```

The development server serves the downloaded `samples/local` file through its
range-request middleware; a staged `apps/viewer-web/public/samples` copy is
also supported when a host needs to provide a different local sample.

Start the local viewer with:

```bash
npm --prefix apps/viewer-web run dev
```

Core validation commands:

```bash
npm --prefix apps/viewer-web run typecheck
npm --prefix apps/viewer-web run test
npm --prefix apps/viewer-web run coverage
npm --prefix apps/viewer-web run build
npm --prefix apps/viewer-web run test:e2e
npm --prefix apps/viewer-web run benchmark:renderer
npm --prefix apps/viewer-web run benchmark:streaming
npm --prefix apps/viewer-web run test:e2e -- e2e/renderer-performance.spec.ts
npm run test:pack
cargo test --workspace
```

To build and inspect the library artifact:

```bash
cd apps/viewer-web
npm run build:library
npm pack
```

The package is an ESM library with declarations and package-local decoder
runtime assets. Library builds clean `dist` first, `npm pack` rebuilds through
`prepack`, and sample COPC data is excluded from the package.

`npm run test:pack` is the release-boundary gate for the generated `.tgz`. It
builds Rust/WASM and the library, checks the tarball contents, installs it by
package name into a disposable external Vite + Cesium consumer, builds and
previews that consumer, and runs Chromium against the production bundle. The
consumer verifies HTTP 206/Range traffic, package-local decoder assets,
incremental hierarchy diagnostics, Rust backend selection without fallback,
coordinate/attribute rendering, and continued `copc-js` operation. Its
checked-in template is in `tests/environments/cesium-vite/`; the sample is
staged only into the disposable consumer and is never packaged.

## Known Limitations

These are the current boundaries:

### Three.js current boundaries

The Three.js entrypoint is a composable layer for an existing application,
not a full point-cloud viewer. The current adapter does not implement:

- `OrthographicCamera` support; the validated camera is
  `THREE.PerspectiveCamera`.
- EDL, measurements, profiles, annotations, clipping, or viewer UI.
- React Three Fiber, Babylon.js, or WebGPU adapters.
- Moving-origin/rebasing, arbitrary root transforms into an application
  coordinate frame, or a custom shader-extension framework.

The dataset-local ENU frame is fixed for the lifetime of a loaded dataset.
The application remains responsible for the scene, camera, WebGL renderer,
controls, render loop, and UI.

- Hierarchy loading starts with the root page and follows only relevant
  intersecting pages for the current project-coordinate bounds and target
  level; broader hierarchy/loading optimization remains future work.
- LoD uses adapter-owned screen-space error with bounds/frustum filtering,
  mixed-LoD coverage, gaze-aware priority, hysteresis, and node/point safety
  caps; occlusion culling is not implemented yet.
- Browser Rust/WASM point preparation uses a bounded worker pool when `Worker`
  is available; environments without workers use the same `copc-core`
  semantics on the main thread. Worker queue/concurrency diagnostics are
  exposed in snapshots.
- Rendering uses the compatibility `PointPrimitiveRenderer` boundary backed by
  `Cesium.PointPrimitiveCollection`; coverage-safe transitions keep old
  coverage until a replacement is ready. Benchmark evidence is in the
  [renderer benchmark](docs/benchmarks/issue-48-renderer.md).
- Dense refinement workloads can take time to finish progressively. The
  scheduler yields between bounded batches, stale generations are discarded,
  and rendered-point budget/backpressure keeps active work bounded. See the
  [streaming validation report](docs/benchmarks/issue-68-streaming.md).
- The Rust backend currently targets the supported LAS 1.4 point format
  subset, including point formats 6, 7, and 8.
- Source URLs must support HTTP Range requests and appropriate CORS behavior.

## Roadmap

See the [project roadmap](docs/ROADMAP.md) for capability-based development
stages and remaining goals. Historical measurements remain in
[`docs/benchmarks/`](docs/benchmarks/).

## Related Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Examples](docs/EXAMPLES.md)
- [Conformance](docs/CONFORMANCE.md)
- [Roadmap](docs/ROADMAP.md)
- [Sample datasets](samples/README.md)
- [Contributing](CONTRIBUTING.md)

## Community and License

- [Contributing guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)

COPC Adapter is released under the [Apache License 2.0](LICENSE).

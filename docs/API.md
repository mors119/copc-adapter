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

The issue #239 API and event semantics are summarized in the
[layer API semantics matrix](proposals/issue-239-layer-api.md).

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
layer.show = false; // hide this layer's primitives only
layer.show = true;
```

`show` defaults to `true`. The built-in renderer owns one
`Cesium.PrimitiveCollection` per attached layer, with its node point
collections below it. Changing `show` affects only that parent collection;
it does not change point filters, streaming, or rendered-point diagnostics.
The value survives detach/reattach and unload/reload. A custom renderer can
implement the optional `setShow(show)` renderer method to receive visibility
changes.

### Metadata bounds and explicit camera framing

`boundingSphere` is available after metadata and the root hierarchy load. It
uses the full `metadata.bounds` extent, transformed through the existing CRS
path to WGS84 ECEF metres, and includes `heightOffsetMeters` once. It is not
derived from the nodes currently selected or rendered. The getter returns a
clone, so mutating it does not change the cached value.

The implementation supports inferred geographic bounds without WKT and the
WKT1 geographic/projected coordinate systems supported by the existing
`proj4` transformation. Projected bounds are accepted up to 2,000 km on each
horizontal axis, with up to 1,000 km vertical span. The bounds algorithm
samples grid edges and cell interiors and pads the sampled sphere by cell
spacing and observed curvature residual. It rejects invalid values, sampled
transform discontinuities, unsupported CRS data, and larger extents. This is
a bounded method for supported local extents, not a guarantee for arbitrary
projection singularities or malformed CRS definitions. In those cases
`boundingSphere` is `undefined`.

`zoomTo()` is an explicit caller request that uses Cesium's native
`Camera.flyToBoundingSphere`. It resolves `true` on completion and `false`
when Cesium cancels or supersedes the flight, or when the layer is detached,
unloaded, reloaded, or destroyed. It rejects if the layer is destroyed,
detached, has no supported sphere, receives an invalid offset, or Cesium
cannot start the flight. The application continues to own the Viewer and
camera. Existing automatic initial `flyToDataset()` framing remains in place.
`layer.zoomTo()`, that legacy initial framing, and native `viewer.zoomTo(...)`
are separate operations; `viewer.zoomTo(layer)` is not supported.

### Lifecycle events

Subscribe before `load()` if an initial milestone matters. `metadataReady` /
`metadataready` can fire before `load()` settles. The `load()` Promise keeps
its existing adapter-specific behavior: Cesium awaits the initial streaming
view when attached, while Three.js `load()` prepares metadata and the root
hierarchy without driving `update()`.

| Event | Payload | Meaning |
| --- | --- | --- |
| `loadProgress` / `progress` | queued node count, active node count, public view generation | Current selected COPC node jobs waiting for scheduling or doing range/decode/preparation work. These are not HTTP counts, bytes, or source download percentage. |
| `metadataReady` / `metadataready` | metadata snapshot, load generation | Metadata and root hierarchy are ready; point work may still be pending. |
| `firstVisible` / `firstvisible` | load generation, view generation | The first nonempty point node was committed to the renderer. This does not promise a GPU frame, pixel visibility, or terrain/viewport visibility. Hiding the layer does not suppress this renderer-commit milestone. |
| `viewSettled` / `viewsettled` | view generation, selected node keys | Selected work completed and ready results were applied by the renderer. A still-pending replacement group does not settle. The full source is not necessarily loaded. |
| `viewCancelled` / `viewcancelled` | view generation, cancellation reason | An active view was invalidated by camera change, detach, unload, reload, or destroy. |
| `error` | error, phase, applicable load or view generation | A load failure or current background view failure. Load and reload promises still reject. A failed view does not also settle or cancel. |

Public load and view generation numbers are monotonically increasing and
independent. Each active view has one terminal outcome: settled, cancelled, or
failed. Stale work cannot emit later progress or terminal events. Cesium uses
native `Cesium.Event`; Three uses typed listener methods. Listener exceptions
are caught and reported with `console.error`, and `destroy()` removes that
layer's listeners.

```ts
const removeProgress = layer.loadProgress.addEventListener(
  (queuedNodeCount, activeNodeCount, viewGeneration) => {
    console.log({ queuedNodeCount, activeNodeCount, viewGeneration });
  },
);
layer.metadataReady.addEventListener((metadata, loadGeneration) => {
  console.log({ metadata, loadGeneration });
});
layer.viewSettled.addEventListener((viewGeneration, selectedNodeKeys) => {
  console.log({ viewGeneration, selectedNodeKeys });
});

layer.attachTo(viewer);
await layer.load();
const completed = await layer.zoomTo(
  new Cesium.HeadingPitchRange(0, -0.5, 0),
);
removeProgress();
layer.destroy();
```

`attachTo()` currently requires a `Cesium.Viewer`. A Scene/CesiumWidget attach
contract is deferred because camera movement subscriptions and picking also
depend on the Viewer camera and canvas lifecycle; those inputs do not yet have
a separately defined and tested contract.

### `CopcCesiumLayerOptions`

- `url`: browser-readable COPC URL. The source must support HTTP Range
  requests and appropriate CORS headers.
- `pointSize`: Cesium point size in pixels. Default: `3`.
- `pointSizeMode`: `'fixed' | 'attenuated'`. Default: `'fixed'`. Attenuation
  requires a renderer that advertises shader support, such as the opt-in
  `BatchedGeometryPointRenderer`; unsupported renderers retain fixed sizing.
- `minPointSize`: minimum attenuated diameter in CSS pixels. Default: `1`.
- `maxPointSize`: maximum attenuated diameter in CSS pixels. Default: `12`;
  values above `64` are rejected.
- `colorMode`: `'fixed' | 'elevation' | 'rgb' | 'intensity' |
  'classification'`. Default: `'fixed'`.
- `heightOffsetMeters`: manual additive correction in metres applied after
  source vertical-unit conversion and horizontal reprojection, before ECEF
  preparation. Default: `0`.
- `verticalTransform`: optional `GtxGeoidGrid` returned by
  `loadGtxGeoidGrid()`. Applies a caller-verified orthometric-to-ellipsoidal
  grid operation before `heightOffsetMeters`. Omitted by default.
- `debug`: enable lifecycle messages through `console.debug`.
- `maxRenderedPoints`: maximum estimated point workload in the active view.
  Default: `250000`.
- `streaming`: overrides for `maxNodes` (default `24`), `maxDepth` (default
  `6`), `maxScreenSpaceError` in pixels (default `8`),
  `screenSpaceErrorHysteresis` in pixels, `maxRenderDistanceMeters` (default
  `12000`), `maxRenderedPoints`, and `refinementAlgorithm` (default
  `'foveated'`; `'screen-projection'` selects the v0.5 passive gaze behavior),
  and `motionLookahead` (default `true`).
- `refineDistanceMultiplier`: accepted for source compatibility but deprecated
  and planned for removal in v0.9, after v0.8; the current selector uses
screen-space error instead.

### Refinement strategy and Focus Lens

The v0.6 default is `streaming.refinementAlgorithm: 'foveated'`. It weights
refinement pressure and scheduling from the camera's actual view direction and
node bounding-sphere overlap. Set the value to `'screen-projection'` to retain
the v0.5 passive projection/gaze scoring, including its 1.25× passive
refinement ceiling and separate scheduling preference. The selection frontier,
raw SSE, hysteresis, coverage transitions, and hard budgets are shared by both
strategies. Unknown values throw an actionable `TypeError`.

```ts
const foveated = new CopcCesiumLayer({
  url: '/data/area.copc.laz',
  streaming: { refinementAlgorithm: 'foveated' },
});
const legacy = new CopcCesiumLayer({
  url: '/data/area.copc.laz',
  streaming: { refinementAlgorithm: 'screen-projection' },
});
```

Applications can set a runtime circular focus region on a Cesium layer:

```ts
layer.setRefinementFocus({
  type: 'screen-circle',
  center: { x: 0.8, y: 0.5 }, // normalized viewer canvas; y grows downward
  radius: 0.15,               // fraction of min(canvas width, canvas height)
  detailBias: 2,              // bounded refinement-pressure multiplier, 1–2
});

layer.setRefinementFocus(undefined); // restore the selected strategy's automatic center
```

The focus weight uses signed screen projection, projected node-sphere extent,
and a feather outside the circle. It can increase both refinement pressure
and scheduling relevance, but it does not clip points, force an octree level,
or bypass node, depth, distance, or point budgets. A focus move invalidates the
current selection generation and reuses the loaded source, hierarchy, and
decoded cache. The library does not draw a DOM focus guide. The Three.js layer
uses the same named strategy option; its layer facade does not yet expose a
focus setter.

- `backend`: `'copc-js' | 'rust' | CopcBackend`. Default: `'copc-js'`.
  `'rust'` explicitly selects the Rust/WASM backend. Backend failures are not
  silently retried through `copc-js`.
- `decoder`: optional `CopcPointDecoder` used when a source returns a point
  view rather than a direct point buffer. The default is the bundled
  Rust/WASM-backed XYZ interleaver; the Rust backend's direct buffer path is
  used when available.
- `renderer`: optional Cesium renderer implementation. The default uses Cesium
  point primitives inside the layer-owned primitive collection.
- `maxPointCacheBytes`: decoded CPU point-buffer cache budget. Default:
  `256 * 1024 * 1024`.
- `rangeValidation`: `'strict' | 'head-fallback'`. Default:
  `'head-fallback'` for HTTP sources. Both modes require `206`, an exact body
  length, and reject readable malformed or mismatched `Content-Range` values.
  When `Content-Range` is not readable, the default mode requires a successful
  `HEAD` with readable `Content-Length`, checks the requested range against
  that size, and verifies the exact response body length. It compares readable
  representation validators and rejects detectable size or validator changes,
  but cannot establish the byte offset returned by the server or prove that a
  same-sized representation stayed unchanged. It warns once per HTTP source
  instance after a fallback-validated read succeeds. Set
  `rangeValidation: 'strict'` to require readable, valid, request-matching
  `Content-Range`; strict mode never falls back to `HEAD` and rejects when that
  information is unavailable. Strict mode also checks exact body length,
  known resource size, visible validators, and visible non-identity content
  encoding. HTTP checks are not cryptographic integrity verification and do
  not defend against a malicious server that returns fabricated consistent
  metadata. Cross-origin JavaScript cannot distinguish an absent
  `Content-Encoding` from one hidden by CORS, so strict mode can only reject a
  non-identity encoding when that header is readable. This option has no
  effect on `File`, `Blob`, or caller-provided
  `RandomAccessByteSource` inputs. The option is also available on
  `CopcThreeLayer` and `CopcStreamingCore`.
- `maxRangeBytes`: maximum bytes allowed in one HTTP range response. Default:
  `64 * 1024 * 1024`. Set a larger positive safe integer when a valid source
  needs larger chunks. The setting is passed through both backends and the
  Rust/WASM decoder, and is also available on `CopcThreeLayer` and
  `CopcStreamingCore`. Raising this value can increase memory use.
- `maxConcurrentRangeRequests`: maximum active HTTP range requests per source.
  Default: `4`. Set a larger positive safe integer for workloads that benefit
  from more parallel ranges. The range-size and concurrency settings together
  bound active response buffers; defaults allow up to 256 MiB. Raising either
  setting increases that possible memory use. This option is also available on
  `CopcThreeLayer` and `CopcStreamingCore`.
- `onPointPicked`: called with a selected `CopcPointInspection`, or `undefined`
  when selection is cleared.

### Camera motion lookahead

`streaming.motionLookahead` defaults to `true` for both Cesium and Three.js.
It gives currently visible refinement candidates a smooth, bounded preference
toward the direction of recent camera rotation. It uses a fixed 200 ms
prediction horizon, clamps angular speed to 90 degrees/second, and reaches
exactly zero 600 ms after movement stops. The current frustum, raw screen-space
error, refinement hysteresis, atomic replacements, and node/point budgets
remain authoritative. The predicted direction does not add offscreen nodes or
requests to the current view.

Set `motionLookahead: false` to retain the pre-motion refinement ranking while
moving. At rest, enabled lookahead also returns to the existing Foveated or
Screen Projection baseline. A layer snapshot exposes the sampled movement
count, selected motion velocities, predicted displacement, candidate weight
range, and the count of accepted refinements whose winner changed with motion
influence under its `performance` field. The sampled movement count is
cumulative until camera history is reset or the source is unloaded; no sample
history is retained.

```ts
const layer = new CopcCesiumLayer({
  url: '/data/area.copc.laz',
  streaming: {
    refinementAlgorithm: 'foveated',
    motionLookahead: true,
  },
});
```

### Predictive offscreen prefetch

`streaming.predictivePrefetch` optionally prepares a small number of nodes from
the fixed-horizon predicted view. It defaults to `false` and requires the
motion estimator to observe recent camera rotation. The predicted frustum is
rotated toward that measured direction; stationary cameras do not create new
speculative work.

Prefetched data stays in the shared decoded point cache and is never selected
or rendered by prediction alone. It does not consume `maxRenderedPoints`. The
first implementation limits each prediction to two point nodes, 25,000
estimated points, 8 MiB of point-chunk ranges, and one relevant hierarchy page.
It leaves a current-view node-load slot available and does not add Workers. A
single-worker Rust configuration skips point prefetch so visible decode work
keeps the only worker slot.

Prefetch failures do not fail a current-view request: current demand retries
through the ordinary cache loader. Speculative cache entries are the first
entries evicted under cache pressure. `getSnapshot().predictivePrefetch` reports
queued, active, completed, failed, and cancelled nodes; point-range bytes
requested; hierarchy page visits, requests, and cache hits; useful decoded
cache hits; and unused speculative evictions. The range byte count is the COPC
point-chunk length requested by the prefetch loader, not a claim of network
byte savings.

```ts
const layer = new CopcCesiumLayer({
  url: '/data/area.copc.laz',
  streaming: {
    motionLookahead: true,
    predictivePrefetch: true,
  },
});
```

This remains opt-in until representative browser runs establish its latency
and network tradeoffs.

`BatchedGeometryPointRenderer` is an opt-in implementation exported from
`@frillab/copc-adapter/cesium`. It submits one public Cesium `Geometry(POINTS)`
primitive per node. It passes the prepared absolute ECEF Float64 positions
through Cesium's public high/low position pipeline and keeps a node-relative
Float32 buffer for CPU point refinement. It supports the existing color modes,
classification filter, fixed point size, layer visibility, and renderer
lifecycle. Picking uses the node-level Cesium result plus the current
committed node buffer; ambiguous pick windows and equal-depth ties deliberately
produce no selection. Point identity resolution is supported in 3D mode;
2D, Columbus View, and morphing scenes return no selection. Browser validation
has covered Cesium 1.142.0 and 1.146.0. The package peer range remains
`cesium >=1.142.0`, so this validation is not a guarantee for every version in
that open-ended range. The batched picker requests a 1×1 `scene.pick` window to
match the CPU resolver's screen sample; the default compatibility renderer
continues to use Cesium's normal pick window. The compatibility renderer
remains the default.

For `pointSizeMode: 'attenuated'`, the batched renderer derives local spacing
from COPC metadata as `spacing / 2^level`. It converts source CRS offsets at
each node center through the same transform used for rendering and measures
them in WGS84 ECEF metres. This prevents geographic degrees from being used
as metre values and accounts for latitude-dependent ground spacing. The
vertex shader projects spacing with the current camera projection. Perspective
sizes decrease with view depth; orthographic sizes do not. The shader clamps
to `minPointSize`/`maxPointSize` in CSS pixels, then uses Cesium's pixel ratio
for device pixel ratio and resolution scaling. Missing spacing uses fixed size.
No node geometry is recreated for camera-only changes. CPU point picking
applies the same per-point projected footprint. Other renderers retain the
fixed-size path unless they explicitly advertise shader support.

The Cesium layer retains the supported standard style attributes (intensity,
classification, and RGB) in its decoded point buffers so the color mode can be
changed later without requesting the point chunk again. This increases retained
decoded attribute data; `maxPointCacheBytes` still bounds the point-buffer
cache.

### Runtime styling

`setStyle()` applies a partial style update to visible nodes using their cached
decoded point buffers. It does not reload metadata or hierarchy, fetch point
chunks, or decode LAZ data. The current style is returned as a detached value by
`getStyle()`.

```ts
layer.setStyle({ colorMode: 'classification' });
layer.setStyle({
  classificationFilter: { include: [2, 6] },
});
layer.setStyle({
  classificationFilter: { exclude: [7, 18] },
});
layer.setStyle({ classificationFilter: null }); // clear the filter
```

Classification codes are integers from `0` through `255`. If both `include`
and `exclude` are provided, a point must be included and must not be excluded.
An empty `include` list hides every point; an empty `exclude` list has no
effect. An empty filter object has no effect. Codes absent from the source
simply match no points. Points without a classification value are hidden while
an include or exclude filter is active.
Color modes that lack their required source attribute use the existing fixed
cyan fallback. Restyling requires each currently rendered node's decoded buffer
to still be cached; if a buffer is no longer retained, `setStyle()` throws
instead of fetching or decoding it again. Point picking keeps the original
source point index after filtering, and selection is cleared if its point is
hidden by the new filter.

### Lifecycle

```ts
await layer.load();       // metadata and root hierarchy; if already attached,
                          // also awaits the initial streaming view
layer.attachTo(viewer);   // camera/view updates and rendering
layer.detachFrom();       // detach without unloading or destroying viewer
await layer.reload();     // unload and load the configured URL again
layer.unload();           // release loaded source, hierarchy, and point data
layer.destroy();          // permanently release layer-owned resources
```

`load()` and `reload()` reject with project-owned errors when source, metadata,
CRS, or hierarchy initialization fails. `getMetadata()` returns the loaded
metadata, when available. `metadataReady` is dispatched as soon as metadata
and the root hierarchy are available. Register its listener before `load()`.

## `CopcThreeLayer`

`CopcThreeLayer` is exported from `@frillab/copc-adapter/three`. It attaches to
an application-owned scene and camera and does not own the renderer or render
loop.

```ts
import * as THREE from 'three';
import {
  CopcThreeLayer,
  type CopcThreeLayerViewSettledEvent,
} from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
const renderer = new THREE.WebGLRenderer();
const layer = new CopcThreeLayer({
  url: 'https://example.com/data.copc.laz',
  colorMode: 'rgb',
});
const onSettled = (event: CopcThreeLayerViewSettledEvent) => {
  console.log(event.viewGeneration, event.selectedNodeKeys);
};
layer.addEventListener('viewsettled', onSettled);

await layer.load();
layer.attachTo({ scene, camera, renderer });

function animate() {
  requestAnimationFrame(animate);
  void layer.update();
  renderer.render(scene, camera);
}
animate();

function disposeLayer() {
  layer.removeEventListener('viewsettled', onSettled);
  layer.destroy();
}
```

Current options include `url`, `pointSize` (default `3`), `colorMode`,
`heightOffsetMeters` (default `0`), `verticalTransform` (omitted by default),
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

The default Three.js path keeps this local-coordinate workflow and does not
require vertical CRS metadata or a geoid grid. It never selects or applies a
grid automatically. Supply `verticalTransform` only when the application
explicitly needs geographic alignment; correction uses the shared coordinate
pipeline before Three converts the corrected ECEF positions into its local ENU
frame.

For a native bounds query, call `layer.getRoot().updateWorldMatrix(true, true)`
and use `new THREE.Box3().setFromObject(layer.getRoot())`. This is the
currently instantiated root geometry's world-space bound, not a full-source
COPC extent.

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
- `heightOffsetMeters`, a manual additive ellipsoidal-height correction in metres;
- `verticalTransform`, an optional caller-supplied `GtxGeoidGrid`;
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
`streaming.refinementAlgorithm` is available to both Cesium and Three.js
consumers and defaults to `'foveated'` in v0.6. Set it to
`'screen-projection'` when migrating a v0.5 application that needs its previous
passive gaze ranking preserved.

### Deprecated compatibility APIs

The following compatibility APIs remain available through v0.8 and are planned
for removal starting in v0.9:

| Deprecated API | Replacement |
| --- | --- |
| `streaming.refineDistanceMultiplier` | `streaming.maxScreenSpaceError` and, when needed, `streaming.screenSpaceErrorHysteresis` |
| `maxPointsPerBatch` | `maxConcurrentNodeLoads`; this limits active work and does not recreate the old batch completion barrier |
| `CopcPointRendererPerformanceStage` | `CopcCesiumPointRendererPerformanceStage` |
| Cesium entrypoint's `CopcPointRendererOptions` | `CopcCesiumPointRendererOptions` |

The deprecated TypeScript declarations carry the same v0.9 removal notice.

`load()` reads metadata and the root hierarchy. `updateView(view,
onProgress?)` performs view-driven hierarchy loading and selection and reports
progressively prepared point data. The view and progress types contain no
engine objects; loaded entries use the shared `PreparedPointData` contract and
retain compatibility geographic aliases. `undefined` is returned when an update is
superseded by a newer view or lifecycle operation.

`getSnapshot().performance` includes aggregate scheduler diagnostics for the
configured load slots, queued/active/completed/cancelled work, peak active
loads, and first-priority-node ready latency.

For a perspective view, the shared core estimates the current visible ground
footprint from nine renderer-neutral frustum rays against a local plane at
least 25 m below the WGS84 surface and below the dataset's minimum elevation
when known. It applies a 1.5× overscan, expands when the target
grows by more than 15%, and shrinks when the target falls below 75% of the
current distance. Views whose frustum reaches the local horizon use the
nearer of the camera far plane and configured maximum as a conservative
fallback. `maxRenderDistanceMeters` remains the hard application ceiling, and
overscan only extends the current view envelope.

The streaming and renderer layer snapshots include `viewDistance` after the
first update. It reports the visible-footprint estimate, overscanned target,
effective distance, hard cap, clamp state, and aggregate expansion, shrink,
hysteresis-hold, fallback, and policy-update counts. The debug panel shows the
same values. Autzen and SoFi measurements are recorded in the
[issue 191 browser report](benchmarks/issue-191-adaptive-view-distance.md).

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

When an injected source implements `loadPreparedPointData`, the shared core
applies `heightOffsetMeters` to its prepared geographic and ECEF coordinates
unless the source reports the amount already applied through
`preparedHeightOffsetMeters`. A source that applies the offset during its own
preparation should set that property to the applied value to prevent a second
correction. Omitting the property means the prepared coordinates have no
height offset.

### Extra schema dimensions

COPC files can carry dimensions beyond the standard LAS point record, such as
LAS extra bytes like `leg_id` or `CE`. The `copc-js` backend can read them when
constructed with `extraDimensions`:

```ts
import { CopcCesiumLayer, CopcJsBackend } from '@frillab/copc-adapter/cesium';

const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
  backend: new CopcJsBackend({ extraDimensions: ['leg_id', 'CE'] }),
  onPointPicked: (point) => console.log(point?.dimensions),
});
```

- `extraDimensions` is a list of dimension names, or `'*'` for every dimension
  outside the standard LAS point record. Names missing from a file's schema are
  skipped, so one configuration works across files with different schemas.
- Requested dimensions are decoded for every loaded point and retained in
  `CopcPointAttributes.extraDimensions`, which counts toward
  `maxPointCacheBytes`. Request only what you need.
- The picked point reports them as `CopcPointInspection.dimensions`. Values are
  `number`, except 64-bit integer dimensions, which are `bigint` so identifiers
  above `Number.MAX_SAFE_INTEGER` stay exact. Scaled 64-bit integers are read
  through the scale and offset as `number`.
- Extra dimensions are not read by the `rust` backend yet; its picked points
  have no `dimensions`.

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

`heightOffsetMeters` defaults to `0`. When supplied, it is added to the
ellipsoidal height after the source Z unit has been converted to metres and
the horizontal coordinates have been reprojected. Point inspection keeps
`source.z` unchanged in the source CRS units; `height` is the corrected WGS84
ellipsoidal display height in metres, and `world` is its corrected ECEF
position. Point buffers, hierarchy bounds, camera queries, and camera fly-to
use that same corrected frame.

This option is a manual correction, separate from vertical datum conversion.
Use it only when you know the needed residual and sign. When a geoid grid is
configured, the adapter first converts the source vertical unit to metres,
reprojects horizontal coordinates to WGS 84, samples the grid and applies
`h = H + N`, then adds `heightOffsetMeters`, then prepares ECEF. Leave the
manual offset at `0` when no independent residual is known. Terrain alignment
from issue #305 remains separate; the adapter does not sample terrain or
imagery to derive either correction.

## Explicit vertical CRS grid conversion

Vertical conversion is opt-in. The default is unchanged and no model is
selected from location or CRS guesses. The implemented provider reads one
offline GTX file supplied as a `File`/`Blob`, `ArrayBuffer`, or typed-array
view. GTX is the historical binary vertical-shift grid format; this provider
accepts big-endian float32 or float64 values and bilinear interpolation.
It does not download grids or convert EGM2008 or KNGeoid24 source formats.

```ts
import * as Cesium from 'cesium';
import {
  CopcCesiumLayer,
  loadGtxGeoidGrid,
} from '@frillab/copc-adapter';

const gridFile = (document.querySelector('#geoid-grid') as HTMLInputElement)
  .files?.[0];
if (!gridFile) throw new Error('Select a documented GTX grid first');

async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const verticalGrid = await loadGtxGeoidGrid(gridFile, {
  gridId: 'operator-supplied-grid-version',
  // Use the exact outer EPSG authority when the COPC WKT declares one;
  // otherwise use its exact vertical CRS name.
  sourceVerticalCrs: 'Exact source vertical CRS from the data and grid docs',
  targetVerticalCrs: 'EPSG:4979',
  horizontalCrs: 'EPSG:4326',
  referenceEllipsoid: 'WGS84',
  sha256: await sha256Hex(gridFile),
  valueUnit: 'metre',
  // Set null only when the grid documentation confirms that it has no
  // finite NoData sentinel.
  noDataValue: null,
  valueConvention: 'ellipsoidal-minus-orthometric',
  interpolation: 'bilinear',
});

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/data/area.copc.laz',
  verticalTransform: verticalGrid,
  heightOffsetMeters: 0,
});
await layer.load();
layer.attachTo(viewer);
```

Replace the example metadata with values verified for the exact grid file.
The loader verifies the file SHA-256, GTX structure, geographic extent, memory
budget, finite values, and the declared NoData sentinel. It cannot prove that
the caller's CRS, sign, unit, epoch, license, or model label is true. The COPC
WKT must be a supported WKT1 compound definition with a `GEOGCS` or `PROJCS`
horizontal CRS and an explicit `VERT_CS` source vertical CRS. The horizontal
component must declare a supported WGS 84 datum name and the exact WGS 84
ellipsoid parameters; this includes ESRI's `D_WGS_1984` spelling. Other
horizontal reference frames fail until a verified frame transformation is
available. When the WKT declares an outer EPSG vertical authority, the
configured source must use that EPSG code; names are accepted only when the
WKT has no outer authority. Other authority namespaces are not configurable.
Any explicitly declared vertical axis must point `UP`. The rendering target is
WGS 84 ellipsoidal height
(`EPSG:4979`). Missing CRS/grid metadata, hash mismatch, malformed data,
authority/name mismatch, downward vertical axes, unsupported epochs, NoData
samples, or points outside coverage fail the requested point preparation.
There is no fallback to uncorrected heights or to a constant offset.

`noDataValue` is mandatory: provide the documented finite sentinel or `null`
when the grid documentation confirms there is none. Grid values must already
use the declared sign convention; this API does not infer or reverse signs.
`valueUnit` is converted to metres. The loader defaults to a 256 MiB encoded
grid limit and allows an explicit increase up to 512 MiB. It holds one private
decoded grid in the layer/core; input bytes and decoded values can together
use roughly twice the grid size during loading. Grid data is not sent to each
Worker. Rust/WASM preparation and JavaScript preparation both pass through the
shared TypeScript grid sampler, so corrected geographic and ECEF positions
follow the same rule. Sampling currently runs synchronously in the shared
streaming preparation stage.

The configured grid remains owned by the layer/core for its lifetime; reuse it
across reloads that use the same grid and source CRS. Create a new layer/core
when changing the transform configuration. Omitting `verticalTransform`
disables datum conversion. `heightOffsetMeters` is then still available as
the independent manual adjustment described above.

The provider is validated with synthetic grids only. No EGM2008 or KNGeoid24
grid is bundled or declared model-supported. Evidence gaps and requirements
for model-specific support are recorded in the
[issue #244 implementation record](proposals/issue-244-vertical-crs-geoid-grid.md).

The projected EPSG:5186 Rust/JavaScript differential fixture checks longitude
and latitude within `1e-7` degrees, corrected height within `1e-9` metres, and
ECEF coordinates within `0.05` metres.

## Source requirements

HTTP COPC sources must support byte Range requests and return `206` with the
exact requested body. Cross-origin sources should expose `Content-Range` to
browser JavaScript so strict validation can check the reported byte offsets.
The default `head-fallback` policy uses a successful, readable `HEAD` response
only when JavaScript cannot read `Content-Range`; it can check size and body
length but cannot prove byte-offset correctness. Choose
`rangeValidation: 'strict'` to disable that fallback and fail when
`Content-Range` is unavailable. A single byte-range `GET` is CORS-safelisted
and does not by itself require preflight; custom request headers or the
fallback `HEAD` method can require CORS permission. These HTTP policies do not
apply to local `File`/`Blob` inputs or caller-provided byte sources.
`probeCopcSource(url)` uses the same default policy, performs a bounded prefix
probe, and returns structured reachability, Range, validation assurance,
CORS-observability, LAS/COPC, and warning fields without downloading the whole
source. Pass `{ rangeValidation: 'strict' }` to make the probe require
readable, matching `Content-Range`. See the [HTTP Range / CORS hosting
guide](source-hosting.md) for deployment examples and browser checks.

See [ARCHITECTURE.md](ARCHITECTURE.md) for implementation ownership and
[CONFORMANCE.md](CONFORMANCE.md) for backend and CRS correctness strategy.

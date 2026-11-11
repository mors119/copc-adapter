# Cesium API

The CesiumJS layer adapter and its renderer-specific options and lifecycle.

## `CopcCesiumLayer`

`CopcCesiumLayer` connects a streamed COPC resource to a caller-owned Cesium
`Viewer`. It never creates or destroys that viewer.

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
});

await layer.load();
layer.attachTo(viewer);
layer.show = false; // hide this layer's primitives only
layer.show = true;
```

This uses the current defaults: fixed cyan points at 3 pixels, the `copc-js`
backend, all standard point attributes for synchronous restyling, and the
shared streaming limits. `url` also accepts a browser `File` or `Blob`; local
sources are read in slices and are not uploaded.

To retain only fields used by the initial style, opt in explicitly. An initial
classification filter also retains classification even when another color
mode is selected:

```ts
const layer = new CopcCesiumLayer({
  url: '/data/area.copc.laz',
  colorMode: 'rgb',
  attributeLoading: 'required',
  classificationFilter: { include: [2, 6] },
  pointFields: new Set(['intensity']),
});
```

`pointFields` explicitly retains additional standard attributes such as
intensity for inspection while required mode is active. It does not request
extra LAS dimensions.

### Metadata bounds and explicit camera framing

`boundingSphere` is available after metadata and the root hierarchy load. It
uses the full `metadata.bounds` extent, transformed through the existing CRS
path to WGS84 ECEF metres, and includes `heightOffsetMeters` once. It is not
derived from the nodes currently selected or rendered. The getter returns a
clone, so mutating it does not change the cached value.

The implementation supports inferred geographic bounds without WKT, WKT1
geographic/projected coordinate systems, root WKT2 `GEOGCRS`/`PROJCRS`
definitions, and the supported WKT2 compound subset used by explicit vertical
grid conversion. Declared east/west and north/south horizontal axes are
normalized before projection. Projected bounds are accepted up to 2,000 km on
each horizontal axis, with up to 1,000 km vertical span. The bounds algorithm
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

- `url`: COPC URL, browser `Blob`/`File`, or `RandomAccessByteSource`.
  HTTP URLs need byte Range support and appropriate CORS headers.
- `pointSize`: Cesium point size in pixels. Default: `3`.
- `opacity`: optional final uniform alpha from `0` through `1`. Omitted
  preserves the selected renderer's current appearance for other color modes.
  Dimension ramps use their interpolated palette alpha in both the batched
  shader and Three.js renderer. Explicit values replace point-style alpha with
  the requested layer alpha.
- `pointSizeMode`: `'fixed' | 'attenuated'`. Default: `'fixed'`. Attenuation
  requires a renderer that advertises shader support, such as the opt-in
  `BatchedGeometryPointRenderer`; unsupported renderers retain fixed sizing.
- `minPointSize`: minimum attenuated diameter in CSS pixels. Default: `1`.
- `maxPointSize`: maximum attenuated diameter in CSS pixels. Default: `12`;
  values above `64` are rejected.
- `colorMode`: `'fixed' | 'elevation' | 'rgb' | 'intensity' |
  'classification' | 'dimension'`. Default: `'fixed'`.
- `elevationRange`: optional finite WGS 84 ellipsoidal-height range in metres
  for elevation colors. It must have `min < max`; by default the layer uses the
  dataset bounds transformed into displayed ellipsoidal metres, including the
  configured vertical transform and `heightOffsetMeters`.
- `elevationStyle`: optional `{ palette, interpolation }` for elevation mode.
  Palette stops use the same normalized RGB(A) model as numeric dimension
  ramps, must be strictly ordered from position `0` through `1`, and default
  alpha to `0.9`. Interpolation is `'linear'` or `'step'` (default `'linear'`).
  A custom elevation palette uses the prepared displayed WGS 84 ellipsoidal
  height in metres after vertical transformation and visual offset. It does
  not represent dataset-relative or terrain height above ground.
- `dimension`: `CopcDimensionStyle` for numeric dimension coloring. Required
  when `colorMode` is `'dimension'`. `Intensity` is available on both built-in
  backends; supported scalar Extra Bytes are available through both backends
  when explicitly selected.
- `dimensionFilter`: optional inclusive numeric range filter for a named
  dimension. Non-finite and missing values are hidden.
- `clippingVolume`: optional `CopcCesiumClippingVolume` in WGS 84 ECEF metres.
  Use a `planes` volume with one to six half-spaces whose non-negative sides
  remain visible, or a `box` with inclusive `minimum` and `maximum` ECEF XYZ
  coordinates. Projected COPC source coordinates are transformed by the layer
  before this filter; do not pass source CRS coordinates. Runtime
  `setClippingVolume()` updates cached nodes and future streamed nodes without
  reloading the source. It composes with style filters and excludes clipped
  points from picking. It is a rendering/filter operation and does not reduce
  hierarchy or point-range reads. `BatchedGeometryPointRenderer` applies the
  volume in its fragment shader; other renderers apply the point filter.
- `extraDimensions`: optional list of Extra Bytes names to retain in addition
  to names required by the initial style/filter. These values count toward the
  decoded CPU cache limit and are available through point inspection.
- `attributeLoading`: `'all' | 'required'`. Default: `'all'`. `all` retains
  RGB, intensity, and classification for synchronous runtime restyling.
  `required` retains only the initial color mode's attributes and
  classification when `classificationFilter` is supplied.
- `classificationFilter`: optional initial classification visibility filter.
  A filter supplied here is active from the first rendered view.
- `pointFields`: optional `CopcPointFieldSelection` of additional standard
  attributes to retain. These are additive to required mode's initial style
  fields; Extra Bytes are selected with `extraDimensions`.
- `coordinateCacheLayout`: `'E' | 'A'`. Default: `'E'`. E keeps the decoded
  CPU cache at 32 coordinate/height bytes per point before attributes. Point
  inspection returns exact cached height and ECEF; it derives longitude and
  latitude from ECEF on demand and omits source XYZ. Choose A to retain exact
  Source and Geographic triples and preserve the previous inspection values.
  This changes retained cache storage; decoders still prepare the full A-shaped
  result first, so it does not reduce Worker transfer or transient preparation
  memory. The public `CopcStreamingCore` retains its A-shaped API contract.
- `retainSourceCoordinatesForQueries`: optional boolean, default `false`.
  With E, retain source XYZ in the shared point cache so later `cache-only`
  queries can use already-decoded nodes. This adds 24 bytes per cached point
  and is included in `maxPointCacheBytes`; it does not change renderer output.
- `heightOffsetMeters`: manual additive correction in metres applied after
  source vertical-unit conversion and horizontal reprojection, before ECEF
  preparation. Default: `0`.
- `verticalTransform`: optional `GtxGeoidGrid` returned by
  `loadGtxGeoidGrid()`. Applies a caller-verified orthometric-to-ellipsoidal
  grid operation before `heightOffsetMeters`. Omitted by default.
- `debug`: enable lifecycle messages through `console.debug`.
- `maxRenderedPoints`: maximum estimated point workload in the active view.
  Default: `250000`. This top-level option wins if
  `streaming.maxRenderedPoints` is also supplied.
- `streaming`: overrides for `maxNodes` (default `24`), `maxDepth` (default
  `6`), `maxScreenSpaceError` in pixels (default `8`),
  `screenSpaceErrorHysteresis` (defaults to 12.5% of the threshold, or `1`
  pixel at the default threshold), `maxRenderDistanceMeters` (default
  `12000`), `maxConcurrentNodeLoads` (default `4`), the compatibility
  `maxRenderedPoints` field, `refinementAlgorithm` (default `'foveated'`;
  `'screen-projection'` selects the v0.5 passive gaze behavior),
  `motionLookahead` (default `true`), and `predictivePrefetch` (default
  `false`). Top-level `maxRenderedPoints` takes precedence over the nested
  field.
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

The Cesium layer defaults to retaining the supported standard style
attributes (intensity, classification, and RGB) in its decoded point buffers
so the color mode can be changed later without requesting the point chunk
again. `attributeLoading: 'required'` is an opt-in alternative that retains
only the initial color mode's fields and classification when an initial
classification filter is supplied. Fixed and elevation modes need no standard
LAS attributes. Picking remains available, but inspection omits attributes
that were not retained. The cache-byte limit still applies to the resulting
point buffers.

### Runtime styling

`setStyle()` applies a partial style update to visible nodes using their cached
decoded point buffers. It does not reload metadata or hierarchy, fetch point
chunks, or decode LAZ data. The current style is returned as a detached value by
`getStyle()`.

```ts
layer.setStyle({ colorMode: 'classification' });
layer.setStyle({
  colorMode: 'elevation',
  elevationRange: { min: 20, max: 120 },
  elevationStyle: {
    interpolation: 'linear',
    palette: [
      { position: 0, color: { red: 0, green: 0, blue: 0.3 } },
      { position: 0.5, color: { red: 0, green: 0.8, blue: 0.3, alpha: 0.7 } },
      { position: 1, color: { red: 1, green: 0, blue: 0 } },
    ],
  },
});
layer.setStyle({ elevationStyle: null, elevationRange: null }); // restore defaults
layer.setStyle({
  classificationFilter: { include: [2, 6] },
});
layer.setStyle({
  classificationFilter: { exclude: [7, 18] },
});
layer.setStyle({ classificationFilter: null }); // clear the filter
layer.setStyle({
  colorMode: 'dimension',
  dimension: {
    name: 'canopy_height',
    range: { min: 0, max: 50 },
    palette: [
      { position: 0, color: { red: 0.05, green: 0.2, blue: 0.65 } },
      { position: 1, color: { red: 0.85, green: 0.1, blue: 0.05 } },
    ],
  },
  dimensionFilter: { name: 'canopy_height', min: 2, max: 40 },
});
layer.setStyle({ dimensionFilter: null }); // clear the range filter
```

Classification codes are integers from `0` through `255`. If both `include`
and `exclude` are provided, a point must be included and must not be excluded.
An empty `include` list hides every point; an empty `exclude` list has no
effect. An empty filter object has no effect. Codes absent from the source
simply match no points. Points without a classification value are hidden while
an include or exclude filter is active.
Dimension ranges must be finite with `min < max`; filters allow `min <= max`
and include both endpoints. Ramp colors use normalized `[0, 1]` components,
with at least two strictly ordered stops spanning positions `0` through `1`.
Stop alpha is interpolated with RGB and defaults to `0.9`; an explicit layer
opacity overrides the palette alpha.
Values below or above the color range clamp to the first or last stop. Missing,
non-finite, and configured `missingValue` values use fixed cyan; a matching
dimension filter hides them. A metadata NoData sentinel is used automatically
when the backend exposes it. A style change can use only dimensions selected
when the layer was created, through the initial style/filter or
`extraDimensions`.

Elevation uses the prepared displayed WGS 84 ellipsoidal height in metres,
after the configured vertical transform and `heightOffsetMeters`. An explicit
`elevationRange` is interpreted in those same metres; otherwise the full
transformed dataset bounds define the range. The default palette remains
unchanged when `elevationStyle` is omitted. Custom stops share dimension ramp
validation, clamp out-of-range heights to the end stops, and support `linear`
or `step` interpolation. Step interpolation keeps each lower stop's color
until the next stop position, then selects that stop. Non-finite heights map
to the range midpoint. Stop alpha is interpolated, defaults to `0.9`, and is
replaced by explicit layer opacity. This is absolute displayed elevation;
dataset-relative and height above ground modes are separate semantics.

LAS Extra Bytes styling supports signed/unsigned 8-, 16-, and 32-bit integers
and 32-/64-bit floats through either built-in backend. Both paths apply declared
scale/offset, and returned values match `CopcPointInspection.dimensions`.
64-bit integer dimensions remain exact `bigint` values for inspection but are
rejected for numeric styling/filtering. Vector Extra Bytes and untyped byte
fields are retained in metadata but explicitly rejected when requested for
numeric decoding. `CopcMetadata` includes Extra Bytes names, primitive type,
byte length, optional scale/offset, numeric NoData, and an exact NoData string
for 64-bit integers when needed.

Color modes that lack their required source attribute use the existing fixed
cyan fallback when the initial style requested an attribute that the source
does not provide. In `attributeLoading: 'required'` mode, a later style that
needs an unrequested field makes `setStyle()` throw an actionable error before
changing the current style or selection; the error states that source
availability was not checked because the field was not requested. Recreate the
layer with `attributeLoading: 'all'` or include the needed field in the initial
color mode/filter or `pointFields`. Restyling also requires each currently
rendered node's decoded buffer to still be cached; `setStyle()` never fetches
or decodes again. Point picking keeps the original source point index after
filtering, and selection is cleared if its point is hidden by a successful
filter update.

### Layer opacity

Both renderer APIs accept an optional constructor `opacity` and expose
`setOpacity(opacity)` for runtime changes. The explicit value is the final
uniform alpha in `[0, 1]`; it is independent of the layer's color mapping and
classification colors. Omitted opacity preserves legacy defaults, which can
differ between renderers. `setOpacity()` updates existing renderer resources
and applies to future streamed nodes without reading or decoding COPC data.
At zero, the layer is hidden from point picking and any selection is cleared.

```ts
const cesiumLayer = new CopcCesiumLayer({ url, opacity: 0.5 });
cesiumLayer.setOpacity(0.25);

const threeLayer = new CopcThreeLayer({ url, opacity: 0.5 });
threeLayer.setOpacity(0.25);
```

Transparency uses each renderer's normal blending and depth behavior. The
adapter does not sort translucent points, coordinate draw order across layers,
or implement order-independent transparency, so overlapping translucent
layers and terrain can composite differently by renderer and scene order. A
custom renderer must implement its optional `setOpacity()` capability before
the layer accepts an explicit opacity value.

### Cesium clipping volumes

Clipping uses the renderer's prepared WGS 84 ECEF coordinates, not the COPC
source CRS or an implicit local origin. The batched renderer subtracts each
node's Float64 ECEF origin before sending plane distances to its Float32 shader
uniforms. This preserves useful precision for projected datasets and large
Earth-centered offsets. Plane normals point toward the visible side; each
plane boundary and each box face is included.

```ts
import * as Cesium from 'cesium';
import {
  BatchedGeometryPointRenderer,
  CopcCesiumLayer,
} from '@frillab/copc-adapter/cesium';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/area.copc.laz',
  renderer: new BatchedGeometryPointRenderer(),
});
await layer.load();
layer.attachTo(viewer);

// Pick a point first, then keep its positive-X side in ECEF coordinates.
const selected = layer.getSelectedPoint();
if (!selected?.world) throw new Error('Pick a point first');
layer.setClippingVolume({
  type: 'planes',
  coordinateSystem: 'wgs84-ecef-meters',
  planes: [{
    normal: [1, 0, 0],
    point: [selected.world.x, selected.world.y, selected.world.z],
  }],
});

layer.setClippingVolume(undefined); // show all points again
```

The layer also accepts an axis-aligned ECEF `box`. Constructor clipping uses
the same type. Clipped points cannot be selected, styles and classification
filters still apply, and other layers retain their own clipping state. The
volume does not reduce streaming or network work.

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

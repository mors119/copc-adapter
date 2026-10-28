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

## Checked-in defaults and option precedence

This matrix records the current workspace contracts for package version
`0.6.0`, checked against `packages/{index,cesium,three}.ts`, the Core, Cesium,
and Three implementations, and packed declarations for the root, `/cesium`,
and `/three` entrypoints. A published version can have different defaults;
check the declarations for the version installed by your application. The
compact URL examples below omit options that already have a usable default.

### Layer and Core options

| Setting | Public type and requiredness | Effective default | Core | Cesium | Three | Resolution, impact, and disposition |
| --- | --- | --- | --- | --- | --- | --- |
| `url` | `CopcInputSource`, required | Required | Yes | Yes | Yes | Accepts a URL, browser `Blob`/`File`, or `RandomAccessByteSource`. A local source must still contain COPC hierarchy metadata; ordinary LAS/LAZ is unsupported. Keep. |
| `backend` | `CopcBackendSelection`, optional | `copc-js` | Yes | Yes | Yes | `rust` is explicit opt-in; a selected backend failure is surfaced without silent fallback. Custom backends remain supported. Keep and document. |
| `decoder` | `CopcPointDecoder`, optional | Built-in WASM decoder only when a source returns point views instead of direct buffers | Yes | Yes | Yes | Direct-buffer backends can bypass the decoder. An injected decoder is used for view-backed sources. Keep advanced. |
| `pointFields` | `CopcPointFieldSelection`, optional | `position` in Core; see `attributeLoading` in Cesium | Yes | Yes | No | Core callers and Cesium can request standard `rgb`, `intensity`, and `classification` fields. In Cesium required mode these fields are retained alongside the initial style requirements. Three requests fields required by `colorMode`. Extra dimensions remain separately explicit. |
| `colorMode` | `CopcColorMode`, optional | `fixed` (cyan fallback) | No | Yes | Yes | Other modes are `elevation`, `rgb`, `intensity`, and `classification`. A missing source attribute falls back to fixed cyan. Keep. |
| `attributeLoading` | `'all'` or `'required'`, optional | `all` for Cesium | No | Yes | No | `all` preserves synchronous runtime restyling by retaining all standard fields. `required` retains the initial color mode's fields, classification for an initial filter, and any explicit `pointFields`. Changing to a mode that needs an unretained field throws before changing style or selection. |
| `classificationFilter` | `CopcClassificationFilter`, optional | No filter | No | Yes | No | Initial filter applied from the first rendered view. Classification is retained in `required` mode even when the initial color mode is different. |
| `coordinateCacheLayout` | `'A' | 'E'`, optional | `E` for Cesium/Three layers; direct `CopcStreamingCore` remains A-shaped | No | Yes | Yes | E retains ECEF F64 XYZ plus prepared-height F64 (32 coordinate bytes/point). Select A to retain exact Source and Geographic triples for synchronous inspection. E derives longitude/latitude from ECEF when Geographic is absent and omits source XYZ when Source is absent. |
| `retainSourceCoordinatesForQueries` | `boolean`, optional | `false` | No | Yes | Yes | With compact E, retains exact source XYZ in the shared point cache for `cache-only` queries. Adds 24 CPU-cache bytes per point and counts toward `maxPointCacheBytes`. No effect with coordinate layout A. |
| `pointSize` | `number`, optional | `3` pixels | No | Yes | Yes | Cesium uses CSS-pixel diameter; Three uses screen-facing pixel size. Keep. |
| `heightOffsetMeters` | `number`, optional | `0` | Yes | Yes | Yes | Manual additive correction to ellipsoidal height after source unit conversion; no automatic datum correction. Keep. |
| `verticalTransform` | `GtxGeoidGrid`, optional | Omitted; no vertical datum conversion | Yes | Yes | Yes | Requires a caller-loaded and verified grid; no grid is selected or bundled automatically. Keep opt-in. |
| `maxRenderedPoints` | `number`, optional | `250,000` estimated points | Yes | Yes | Yes | **Canonical location for new code is top-level.** `streaming.maxRenderedPoints` remains compatible; top-level wins when both are set. Must be a positive safe integer and is a workload guard, not a GPU-memory cap. Keep both locations and precedence. |
| `maxPointCacheBytes` | `number`, optional | `256 MiB` | Yes | Yes | Yes | Caps retained decoded CPU point buffers; the cache also has a 48-node cap. This is not a browser or GPU memory limit. Keep. |
| `rangeValidation` | `RangeValidationPolicy`, optional | `head-fallback` for HTTP sources | Yes | Yes | Yes | `strict` remains fail-closed and requires readable, valid, matching `Content-Range`; it does not use `HEAD` fallback. This policy does not apply to local `File`/`Blob` or custom random-access sources. Keep the current security default. |
| `maxRangeBytes` | `number`, optional | `64 MiB` per read | Yes | Yes | Yes | Positive safe integer overrides are accepted. Larger ranges can increase memory use; the Rust/WASM decoder also has a 32-bit range-length limit. Keep. |
| `maxConcurrentRangeRequests` | `number`, optional | `4` per source | Yes | Yes | Yes | Positive safe integer overrides are accepted. Together with the per-range ceiling, this bounds active HTTP response buffers. Keep. |
| `debug` | `boolean`, optional | `false` | Yes | Yes | Yes | Enables optional lifecycle `console.debug` messages; normal safety warnings and listener-error reporting may still be emitted. Keep. |
| `onPointPicked` | `(point: CopcPointInspection \| undefined) => void`, optional | No callback | No | Yes | Yes | Called for a selection or when selection clears. Keep optional. |

`CopcStreamingCoreOptions`, `CopcCesiumLayerOptions`, and
`CopcThreeLayerOptions` each require `url`; the other settings in this table
are optional. `streaming` is also optional and accepts a partial selection
object at each of those entrypoints. The concrete `NodeSelector` constructor
uses `StreamingSelectionOptions` directly and requires `maxNodes`, `maxDepth`,
and `maxRenderDistanceMeters`.

`decoder`, `pointFields`, range limits, height offsets, and validation policy
are passed through the layer adapters to the shared core. `colorMode: 'rgb'`,
`'intensity'`, or `'classification'` controls which point attributes the Three
adapter requests. Cesium defaults to all standard style fields; set
`attributeLoading: 'required'` to retain only fields needed by its initial
style and optional initial classification filter. This reduces retained
attribute buffers and, with the Rust backend, skips unrequested LAS attribute
decompression. The copc-js backend still decodes a complete point view, so its
required-only mode reduces prepared and retained attribute buffers but does
not skip LAZ attribute decompression.

### Streaming selection options

The `streaming` object is partial. Omitted fields resolve to these current
shared defaults for Core and both layer adapters:

| Setting | Public type and requiredness | Default | Core | Cesium | Three | Meaning and impact | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `maxNodes` | `number`, optional through `streaming?: Partial<StreamingSelectionOptions>` | `24` | Yes | Yes | Yes | Upper bound for selected hierarchy nodes in the active view. | Keep. |
| `maxDepth` | `number`, optional through the partial `streaming` object | `6` | Yes | Yes | Yes | Deepest hierarchy level eligible for selection. | Keep. |
| `maxScreenSpaceError` | `number`, optional through the partial `streaming` object | `8` pixels | Yes | Yes | Yes | Refinement threshold. | Keep. |
| `screenSpaceErrorHysteresis` | `number`, optional through the partial `streaming` object | `12.5%` of the threshold (`1` pixel at the default threshold) | Yes | Yes | Yes | Hold band that reduces LoD churn. | Keep. |
| `maxRenderDistanceMeters` | `number`, optional through the partial `streaming` object | `12,000` m | Yes | Yes | Yes | Distance limit used during selection. | Keep. |
| `maxRenderedPoints` | `number`, optional through the partial `streaming` object | `250,000` estimated points | Yes | Yes | Yes | Compatibility duplicate of the top-level option; top-level takes precedence. | Keep for compatibility; use top-level in new code. |
| `maxConcurrentNodeLoads` | `number`, optional through the partial `streaming` object | `4` | Yes | Yes | Yes | Active range/decode/preparation node loads, independent of the point budget. It is shared across overlapping view generations. | Keep. |
| `refinementAlgorithm` | `RefinementAlgorithm`, optional through the partial `streaming` object | `foveated` | Yes | Yes | Yes | `screen-projection` restores the older passive gaze scoring policy. | Keep. |
| `motionLookahead` | `boolean`, optional through the partial `streaming` object | `true` | Yes | Yes | Yes | Uses recent camera rotation to prioritize work within the current visible view. | Keep. |
| `predictivePrefetch` | `boolean`, optional through the partial `streaming` object | `false` | Yes | Yes | Yes | Opt-in, bounded preparation of likely next-view nodes; uses extra network and decode work. | Keep opt-in. |
| `refineDistanceMultiplier` | `number`, optional through the partial `streaming` object | No effective behavior | Yes | Yes | Yes | Deprecated compatibility field; screen-space error controls refinement. | Retain through v0.8; planned removal in v0.9. |
| `maxPointsPerBatch` | `number`, optional through the partial `streaming` object | No effective behavior | Yes | No | Yes | Deprecated compatibility field; it no longer controls a completion barrier. Use `maxConcurrentNodeLoads` to bound active work. | Retain through v0.8; planned removal in v0.9. |

The Cesium `CopcStreamingOptions` type now exposes the same active shared
`maxConcurrentNodeLoads` control as Core and Three. Existing defaults and
selection behavior are unchanged. Explicit invalid point budgets still fail
with `RangeError`; invalid refinement algorithm names still fail with
`TypeError`.

### Renderer-specific options and similarly named renderer values

| Setting | Public type and requiredness | Default | Applicability and distinction | Status |
| --- | --- | --- | --- | --- |
| Cesium `pointSizeMode` | `CopcCesiumPointSizeMode`, optional | `fixed` | `attenuated` projects COPC spacing and requires a renderer that advertises shader support. The built-in batched renderer supports it; point diameter bounds default to `1`–`12` CSS pixels, with a maximum accepted bound of `64`. | Keep opt-in. |
| Cesium `minPointSize` / `maxPointSize` | `number`, optional | `1` / `12` CSS pixels | Used only for attenuated sizing; accepted maximum is `64`, and `0 < minPointSize <= maxPointSize`. | Keep. |
| Cesium `renderer` | `CesiumPointRenderer`, optional | `PointPrimitiveRenderer` | Layer constructor's point renderer. `BatchedGeometryPointRenderer` is opt-in. | Keep. |
| Three layer `renderer` | `CopcThreePointRenderer`, optional | `ThreePointRenderer` | Layer constructor's custom point-renderer seam. | Keep. |
| Three attachment `renderer` | `ThreeViewportSource`, optional | Omitted | `attachTo({ scene, camera, renderer })` accepts the application-owned WebGL renderer only as a viewport-size source. It is separate from the layer constructor's custom point renderer of the same property name. If omitted, the view adapter uses its canvas/viewport fallback. | Keep both contracts; document their different objects. |
| Three `pickingThreshold` | `number`, optional | `1` scene unit | Used by the default point raycaster. A per-call `CopcThreeLayerPickOptions.threshold` overrides the layer value. | Keep. |

### Direct source utilities

These lower-level exported constructors use the same current range defaults.
The layer options pass them through for supported URL and local-file sources.

| Public API | Public type and requiredness | Default | Scope and impact | Status |
| --- | --- | --- | --- | --- |
| `HttpRangeByteSource(source, options?)` | Required `source: string`; optional `options: HttpRangeByteSourceOptions` | Constructor options omitted | HTTP URL source; construction performs no network request. | Keep. |
| `HttpRangeByteSource` | Optional `fetch?: RangeFetch`, `headers?: HeadersInit`, `size?: number` | global `fetch`; no extra headers; size discovered when needed | An explicitly known `size` avoids needing a `HEAD` size lookup. | Keep. |
| `HttpRangeByteSource` | Optional `rangeValidation?: RangeValidationPolicy` | `head-fallback` | HTTP only; use `strict` to reject when the browser cannot read a matching `Content-Range`. | Keep current security default. |
| `HttpRangeByteSource`, `BlobByteSource` | Optional `maxRangeBytes?: number` | `64 MiB` | Per returned slice; increasing it can increase active response memory. | Keep. |
| `HttpRangeByteSource`, `BlobByteSource` | Optional `maxConcurrentRangeRequests?: number` | `4` | Per-source active reads; Blob reads are local and do not make HTTP requests. | Keep. |
| `BlobByteSource(blob, identity?, options?)` | Required `blob: Blob`; optional `identity?: string` and `options: BlobByteSourceOptions` | Identity inferred from File name or `blob://local-copc`; default limits above | Browser File/Blob source. Slice reads check cancellation before and after each non-cancellable read. | Keep. |
| `probeCopcSource(source, options?)` | Required `source: string`; optional `options: CopcSourceProbeOptions` | Options omitted | HTTP source diagnostic only. The first request covers bytes `0–1023`; metadata follow-up reads are bounded. | Keep. |
| `probeCopcSource` | Optional `fetch?: RangeFetch`, `headers?: HeadersInit`, `signal?: AbortSignal`, `rangeValidation?: RangeValidationPolicy` | global `fetch`; no extra headers or signal; `head-fallback` | Accepts strict validation as an explicit override; probe result distinguishes false from unknown when browser access is limited. | Keep current security default. |

### Other exported configuration types

These option objects are also exported by the package entrypoints and packed
declarations. They are specialized controls rather than additional layer
defaults; references point to their detailed contract and example below.

| Public type / entrypoint | Required fields and optional defaults | Core / Cesium / Three applicability | Impact and reference | Status |
| --- | --- | --- | --- | --- |
| `CopcBackendOpenOptions` (root, `/cesium`, `/three`) | Optional `signal?: AbortSignal`, `rangeRequestDiagnostics?: RangeRequestDiagnosticsRecorder`, `rangeValidation?: RangeValidationPolicy`, `maxRangeBytes?: number`, `maxConcurrentRangeRequests?: number`, `heightOffsetMeters?: number`. Defaults for range policy/limits/offset are in the layer table; omitted signal/diagnostics add no caller override. | Core backend boundary; forwarded by all layers | Source lifetime, HTTP security, range memory/concurrency, and height preparation. See [Backend and point contracts](#backend-and-point-contracts). | Keep. |
| `CopcPointLoadOptions` (root, `/cesium`, `/three`) | Optional `signal?: AbortSignal`, `performanceObserver?: CopcPerformanceObserver \| null`. `undefined` inherits the source observer; `null` suppresses it. | Core backend boundary; adapters use these internally | Cancellation and diagnostic routing only. See [Backend and point contracts](#backend-and-point-contracts). | Keep. |
| `CopcHierarchyPageLoadOptions` (root, `/cesium`) | Optional `performanceObserver?: CopcPerformanceObserver \| null`; `undefined` inherits the source observer and `null` suppresses it. | Core hierarchy boundary; Three consumers can use source-wide diagnostics | Per-page diagnostic routing only. See [Backend and point contracts](#backend-and-point-contracts). | Keep. |
| `RangeReadOptions` (root, `/cesium`, `/three`) | Optional `signal?: AbortSignal`; omitted means no per-read cancellation override. | Shared source boundary | Cancels only that read; shared cached source work can remain reusable. See [Direct source utilities](#direct-source-utilities). | Keep. |
| `CopcJsBackendOptions` (root, `/cesium`, `/three`) | Optional `extraDimensions?: CopcExtraDimensionSelection`; omitted means no nonstandard dimensions are read. | All entrypoints; only `copc-js` | Extra decoded dimensions increase retained point-cache memory. See [Extra schema dimensions](#extra-schema-dimensions). | Keep opt-in. |
| `RustCopcBackendOptions` (root, `/cesium`, `/three`) | Optional `createByteSource?: RustByteSourceFactory`; omitted uses the backend's built-in source handling. | All entrypoints; only explicit `rust` | Advanced host/test source bridge. There is no silent backend fallback. See [Backend and point contracts](#backend-and-point-contracts). | Keep opt-in. |
| `GtxGeoidGridOptions` (root, `/cesium`, `/three`) | Required `gridId: string`, `sourceVerticalCrs: string`, `targetVerticalCrs: 'EPSG:4979'`, `horizontalCrs: 'EPSG:4326'`, `referenceEllipsoid: 'WGS84'`, `sha256: string`, `valueUnit: VerticalGridValueUnit`, `valueConvention: 'ellipsoidal-minus-orthometric'`, and `noDataValue: number \| null`. Optional `interpolation?: 'bilinear'` defaults to `bilinear`; `maxGridBytes?: number` defaults to `256 MiB` with `512 MiB` hard limit; `requiresMatchedEpoch?: boolean` defaults false; `sourceCoordinateEpoch?: number` and `gridReferenceEpoch?: number` are omitted unless applicable. | Shared coordinate pipeline | Caller assertions are verified against grid bytes and COPC WKT where possible; bad metadata or uncovered samples fail preparation. See [Explicit vertical CRS grid conversion](#explicit-vertical-crs-grid-conversion). | Keep opt-in. |
| `NgaEgm2008GridOptions` (root, `/cesium`, `/three`) | Optional `maxGridBytes?: number`, default `256 MiB`, hard limit `512 MiB`. | Shared coordinate pipeline | Resource bound for the pinned NGA grid loader. See [NGA EGM2008 2.5-minute grid](#nga-egm2008-25-minute-grid). | Keep opt-in. |
| `TerrainHeightAlignmentOptions` (root, `/cesium`) | Optional `groundConfirmed?: boolean` (defaults false), `terrainSourceId?: string`, `timeoutMs?: number` (defaults to 30 seconds, cap 60 seconds), and `signal?: AbortSignal`. | Cesium only | One-point opt-in diagnostic; no point correction is applied automatically. See [Explicit Cesium Terrain residual estimate](#explicit-cesium-terrain-residual-estimate). | Keep opt-in. |
| `CopcPointRendererOptions` (root, `/cesium`, `/three`) | Required `pointSize: number`; optional `colorMode?: CopcColorMode`, `elevationRange?: CopcValueRange`, `rgbMax?: 255 \| 65535`, `pointId?: (pointIndex: number) => unknown`, and `pointFilter?: (pointIndex: number) => boolean`. | Shared renderer seam | Renderer call contract, not another layer configuration location. See [Three.js API](#copcthreelayer). | Keep. |
| `CopcCesiumPointRendererOptions` (root, `/cesium`) | Extends shared per-node options; optional `pointSizeMode?: CopcCesiumPointSizeMode` defaults to `fixed`, `minPointSize?: number` / `maxPointSize?: number` default to `1` / `12` CSS pixels and cap at `64`, `pointSpacingMeters?: number`, `onPerformance?: callback`. | Cesium renderer extension | Renderer call contract, not another layer configuration location. See [CopcCesiumLayerOptions](#copccesiumlayeroptions). | Keep. |
| `ThreePointRendererOptions` (`/three`) | Extends shared per-node options; optional `onPerformance?: callback`. | Three renderer extension | Renderer call contract, not another layer configuration location. See [Three.js API](#copcthreelayer). | Keep. |
| `ThreePointRendererConstructorOptions` (`/three`) | Optional `localOrigin?: Wgs84EcefPoint` and `localFrame?: DatasetLocalFrame`; omitted direct-constructor origin is derived from the first nonempty node. | Three only | `CopcThreeLayer` supplies its dataset-local frame after metadata; see [Three.js API](#copcthreelayer). | Keep. |
| `CopcThreeLayerPickOptions` (`/three`) | Optional `raycaster?: THREE.Raycaster`; optional `threshold?: number` defaults to layer `pickingThreshold`, then `1` scene unit. | Three only | Per-call pick control; see [Three.js API](#copcthreelayer). | Keep. |
| `CopcPointStyleInput` / `CopcPointStyleOptions` (root, `/cesium`) | Input `colorMode?: CopcColorMode`, `elevationRange?: CopcElevationRange`, `intensityRange?: CopcValueRange`, and `rgbMax?: 255 \| 65535` are optional and infer from point buffers; resolved `CopcPointStyleOptions` fields are required. | Core styling helpers; not layer constructor options | Omitted color mode resolves to fixed cyan. See [Runtime styling](#runtime-styling). | Keep. |
| `CopcThreePointStyleOptions`, `CopcThreePointsMaterialOptions` (root) | `CopcThreePointStyleOptions` requires `pointSize: number`; the material helper requires `pointSize: number` and returns opacity `0.9`, transparent vertex colors, and disabled size attenuation. | Root compatibility helpers only | No hidden layer override or precedence relationship. See [Runtime styling](#runtime-styling). | Keep. |
| `ThreeStreamingViewOptions` (`/three`) | Required `camera: THREE.Camera` and `frame: DatasetLocalFrame`; optional `renderer?: ThreeViewportSource` and `maxRenderDistanceMeters?: number`. A finite positive camera far plane wins; otherwise the option or `12,000` m is used. | Three view helper only | Here `renderer` is only a viewport-size source, as distinguished in the renderer table above. | Keep. |

The packed consumers typecheck the minimal public `/cesium` and `/three`
layer options. Other specialized option contracts remain advanced API; they
are listed here to make their required inputs and defaults discoverable without
adding them to minimal examples.

The minimal Cesium and Three examples in this API, the [repository README](https://github.com/mors119/copc-adapter/blob/main/README.md),
the [package README](https://github.com/mors119/copc-adapter/blob/main/packages/README.md),
[Examples](EXAMPLES.md), [Korean getting-started guide](ko/getting-started.md),
and [Korean API guide](ko/api.md) omit default-valued options. The full
advanced option combinations remain in [Examples](EXAMPLES.md) and the later
API sections.

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

### CRS metadata diagnostics

`getMetadata()` includes the original `wkt` and a versioned
`crsDiagnostic` for both built-in backends. The diagnostic records the source
horizontal and vertical CRS names/identifiers, declared units (including
international and US survey feet), explicit horizontal axis order, WKT1/WKT2
metadata syntax support, evidence provenance, and stable reason codes.
`heightKind` is `ellipsoidal`, `gravity-related/orthometric`, or
`local/unknown`, with an `explicit`, `inferred`, or `unknown` certainty.
Both readers choose the first WKT VLR and use the first WKT EVLR only when no
VLR WKT exists. If multiple WKT records disagree, the diagnostic reports
`conflicting-source-wkt` and retains the first value under that precedence.

The resolver does not infer a CRS or height reference from coordinate ranges,
country, output labels, or transformed WGS84/ECEF values. Missing or
unprovable vertical semantics remain `local/unknown`. WKT syntax recognition
is metadata parsing only; `transformSupport: "backend-dependent"` does not
promise that either backend can transform every recognized definition.
Rendering defaults are unchanged, and this metadata resolver does not alter
source bytes or coordinates. Applications requesting precise vertical datum
conversion must use the existing explicit conversion path, which fails closed
when source metadata is incompatible or insufficient.

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
- `pointSizeMode`: `'fixed' | 'attenuated'`. Default: `'fixed'`. Attenuation
  requires a renderer that advertises shader support, such as the opt-in
  `BatchedGeometryPointRenderer`; unsupported renderers retain fixed sizing.
- `minPointSize`: minimum attenuated diameter in CSS pixels. Default: `1`.
- `maxPointSize`: maximum attenuated diameter in CSS pixels. Default: `12`;
  values above `64` are rejected.
- `colorMode`: `'fixed' | 'elevation' | 'rgb' | 'intensity' |
  'classification'`. Default: `'fixed'`.
- `attributeLoading`: `'all' | 'required'`. Default: `'all'`. `all` retains
  RGB, intensity, and classification for synchronous runtime restyling.
  `required` retains only the initial color mode's attributes and
  classification when `classificationFilter` is supplied.
- `classificationFilter`: optional initial classification visibility filter.
  A filter supplied here is active from the first rendered view.
- `pointFields`: optional `CopcPointFieldSelection` of additional standard
  attributes to retain. These are additive to required mode's initial style
  fields; extra LAS dimensions are not included.
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
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
const renderer = new THREE.WebGLRenderer();
const layer = new CopcThreeLayer({
  url: 'https://example.com/data.copc.laz',
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

This uses fixed cyan points at 3 pixels by default. `url` also accepts a
browser `File` or `Blob`. The application owns the scene, camera, renderer, and
render loop.

Current options include `url`, `pointSize` (default `3`), `colorMode`,
`coordinateCacheLayout` (default `E`; choose `A` to retain exact source and
geographic inspection coordinates),
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
`CopcPointInspection` or `undefined`. With layout E, height/world are exact,
longitude/latitude are derived from ECEF, and source XYZ is omitted; choose A
for the previous exact coordinate inspection values. An optional
`THREE.Raycaster` and threshold can be supplied. `detachFrom()`, `unload()`,
`reload()`, and `destroy()` do not dispose application-owned Three.js
resources.

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

### Bounded spatial point queries

`queryPoints()` is available on `CopcStreamingCore`, `CopcCesiumLayer`, and
`CopcThreeLayer`. It reads exact decoded source XYZ from a 3D inclusive AABB;
region coordinates use the COPC source CRS axes and units. The query does not
apply display-height offsets or geoid conversion, and it does not change camera
state, rendered selection, styles, or picking state.

```ts
const query = layer.queryPoints({
  region: {
    coordinateSystem: 'copc-source',
    min: { x: 100, y: 200, z: 0 },
    max: { x: 120, y: 240, z: 30 },
  },
  mode: 'fetch-missing',
  maxDepth: 4,
});

for await (const batch of query) {
  for (const point of batch) {
    consume(point.x, point.y, point.z, point.nodeKey, point.pointIndex);
  }
}
const summary = await query.result;
```

The query is one-shot and yields batches of at most 4,096 matching points.
Each point includes its exact source `x`, `y`, `z`, `nodeKey`, and zero-based
`pointIndex`. Results are ordered by node key and then point index. The
`maxDepth` frontier uses root depth zero: it descends through relevant known
children and selects a parent only when that node has no relevant children and
its hierarchy coverage is complete. It never returns a parent together with
its selected descendants. A missing relevant child page makes the result
partial; the query does not silently substitute the parent.

`summary.complete` means all matching records in this non-overlapping
frontier up to `maxDepth` were processed. It does not mean all original COPC
records or all detail below that depth were returned. Await `query.result`
after iteration. A summary reports `complete`, `partial`, `cancelled`, or
`failed`; a failed iteration also throws its source error, while `result`
resolves with its structured error details. Budget and coverage partial
reasons are listed in `reasonCodes`.

Partial reason codes are explicit: `missing-hierarchy` means a relevant child
page was unavailable; `missing-nodes` means a selected node lacked source XYZ
in cache-only mode; `hierarchy-page-limit`, `point-limit`, and `byte-limit`
identify the exhausted budget; `time-limit` identifies deadline expiry;
`invalid-point-coordinate` means a non-finite source record was excluded;
`unsupported-backend` means the backend did not expose positions; and
`query-concurrency-limit` means this core already has its maximum two spatial
query streams active. A cancelled summary uses `cancelReason: 'aborted'` for
`cancel()` or the caller's signal, `'source-unloaded'` for source lifecycle
changes, and `'consumer-stopped'` when iteration ends early.

| Query limit | Default | Hard maximum | Meaning |
| --- | ---: | ---: | --- |
| `maxPoints` | 100,000 | 1,000,000 | Source records scanned, including points outside the box. `fetch-missing` skips a node before reading its chunk when that chunk's full point count exceeds the remaining budget, and reports `point-limit`. |
| `maxBytes` | 64 MiB | 256 MiB | Query-reserved hierarchy page and point-chunk range bytes. Cached data does not consume this budget. |
| `maxHierarchyPages` | 64 | 1,024 | Relevant child pages considered by this query. The already-loaded root page is excluded. |
| `maxConcurrentPointReads` | 1 | 4 | Active point range/decode operations for this query. The shared streaming manager can impose a lower effective limit and gives current-view work priority. |
| `maxDurationMs` | 30,000 ms | 300,000 ms | Wall time after iteration starts. Expiry produces a partial `time-limit` summary. |

`cache-only` reads parsed hierarchy and resolved point-cache entries only; it
starts no hierarchy-page or point-data reads. Compact E caches omit source XYZ
by default, so enable `retainSourceCoordinatesForQueries: true` on a Cesium or
Three layer if cache-only queries must reuse already-decoded E entries. The
option adds 24 bytes per cached point and remains within the existing point
cache byte budget. The core's A-shaped cache already retains source XYZ.

`fetch-missing` loads only required hierarchy pages and selected point chunks
through the existing backend. It requests only the position field, ignores
renderer filters/styles, and uses the raw COPC coordinates. Both built-in
backends use the same point-view contract; if a backend cannot provide
position, the query reports `unsupported-backend` as partial without a hidden
backend fallback. Abort signals, source unload/reload, and early iterator exit
cancel query work; early exit drains only already-started bounded reads.

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

## Explicit Cesium Terrain residual estimate

Cesium Terrain alignment is an opt-in placement diagnostic for one selected
ground point. It does not read elevation from imagery, sample arbitrary 3D
Tiles, modify point positions, or change the Viewer’s `TerrainProvider`.
`CopcCesiumLayer.estimateTerrainHeightAlignment()` reads the Terrain provider
already attached to the application-owned Viewer and calls Cesium’s public
`sampleTerrainMostDetailed(provider, [position], true)` API. This API requires
provider tile availability and returns heights relative to the ellipsoid.
Providers without availability, ellipsoid-only providers, unavailable
coverage, sampling failures, and timeouts produce a non-actionable result.
The consumer chooses a provider when it creates its Viewer; for example:

```ts
const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
  '/terrain',
);
const viewer = new Cesium.Viewer('cesium-container', { terrainProvider });
```

The URL must be an explicitly configured source that the application is
authorized to use. This library does not configure Cesium ion, add credentials,
or replace/destroy a provider on a consumer-owned Viewer. Cesium's `fromUrl`
expects the service root and resolves `layer.json` itself.

```ts
const anchor = layer.getSelectedPoint();
if (!anchor) throw new Error('Pick a rendered point from this layer first');

const estimate = await layer.estimateTerrainHeightAlignment(anchor, {
  // Use only after independently confirming this selected point is ground.
  groundConfirmed: true,
  signal: estimateAbortController.signal,
});

if (estimate.status === 'ready' && estimate.actionable) {
  // Show estimate.anchor.displayedHeightMeters, estimate.terrainHeightMeters,
  // estimate.proposedOffsetMeters and warnings in an application preview.
  // Apply only after a separate user action and a current-result check.
  const stillCurrent = layer.isTerrainHeightAlignmentEstimateCurrent(estimate);
  if (stillCurrent) {
    const approvedHeightOffsetMeters =
      estimate.effectiveProposedHeightOffsetMeters;
    // Rebuild/reload the layer with this approved value in its existing
    // heightOffsetMeters option. The adapter does not apply it automatically.
  }
}
```

An anchor must be the selected rendered point owned by this layer, include
finite displayed coordinates and any retained source XYZ, and be classified
LAS/ASPRS class 2 or explicitly confirmed by the caller. Compact E inspection
omits source XYZ by default; this does not prevent terrain sampling. The
estimate becomes stale when the selection, layer source generation, Viewer, or
TerrainProvider changes. Keep `source` XYZ unchanged; `height` is the current
displayed numeric height.

The result compares
`terrainHeightMeters - anchor.displayedHeightMeters`. Both values must have a
verified WGS 84 ellipsoidal-height interpretation. A configured
`verticalTransform` must pass its source-WKT compatibility check; otherwise
the source must explicitly identify supported WGS 84 ellipsoidal height. A
NAVD88/orthometric Z converted from US survey feet to metres is still
orthometric. A numeric unit conversion alone does not make it compatible with
Terrain’s ellipsoidal height. Missing or incompatible vertical metadata returns
`uncertain` and never an actionable proposal. Do not use Terrain alignment to
hide a missing #244 geoid conversion.

A source-declared ellipsoidal height is recognized from a WKT2 root
`GEOGCRS` identified as EPSG:4979 when its direct coordinate system is
ellipsoidal, three-dimensional, and has an `UP` axis. A WKT1 `VERT_CS` section
carrying EPSG:4979 is not accepted because EPSG:4979 identifies a 3D geographic
CRS, not a standalone vertical CRS.

The returned effective offset is `existing heightOffsetMeters + proposed
offset`. Recreating from the original COPC applies the validated vertical grid
first, then this single total additive offset. Estimating again after approval
does not add the same residual twice. A rebuild uses the existing coordinate
preparation path so displayed points, bounds, camera navigation and picking
share one transform; it can repeat source Range reads, LAZ decoding, worker
work, and renderer uploads. The dev-viewer stages a replacement session and
keeps the previous one until the candidate is ready.

One estimate samples at most one anchor. Only one in-flight estimate per
Viewer is accepted, and the default caller wait deadline is 30 seconds (bounded
to 60 seconds). Cesium’s sampler has no `AbortSignal`: cancelling or timing out
discards the result but cannot abort an already-issued Terrain request. The
per-Viewer request lock remains until that request settles. Terrain LOD,
coverage, source provenance and anchor quality limit confidence; this is not
survey-grade positioning.

For the Autzen development sample, WKT identifies horizontal EPSG:2992 and
vertical EPSG:6360 NAVD88 height in US survey feet. The dev-viewer does not
configure a `verticalTransform` and starts with `heightOffsetMeters: 0`; its
default Cesium globe is ellipsoid-only. Thus the current numeric display
heights are not verified ellipsoidal heights and no Terrain residual is
available or implied. A verified #244 transformation is required before an
estimate can be actionable. The #244 grid implementation currently accepts
only its documented compatible WGS 84 horizontal CRS path, so a grid that
does not validate against a projected source remains unavailable.

### Terrain, imagery, ellipsoid and 3D Tiles

| Surface or correction | Provides height samples? | Role in this workflow |
| --- | --- | --- |
| WGS 84 ellipsoid | Defines a mathematical reference surface; height zero is not measured local ground | Default Cesium globe only; estimator returns unavailable |
| Imagery | No; supplies color/texture | Can show roads, vegetation, or shadows over either globe surface, but cannot establish elevation |
| Cesium TerrainProvider | Yes; exposes terrain tiles and ellipsoidal samples where available | The only sampled surface in this feature |
| 3D Tiles | May contain roofs, walls, vegetation, bridges or other surfaces | Not sampled; a separate explicit-surface workflow would be required |
| #244 vertical transform | Converts a validated source vertical datum with a geoid/grid operation | Coordinate correction before the independent Terrain residual |
| #237 `heightOffsetMeters` | Adds a caller-chosen uniform metre value | Manual correction reused to apply an approved Terrain residual |
| #305 residual | Compares one verified ground anchor with Terrain | Explicit estimate, preview and user-approved placement correction |

## Explicit vertical CRS grid conversion

Vertical conversion is opt-in. The default is unchanged and no model is
selected from location or CRS guesses. The implemented provider reads one
offline GTX file supplied as a `File`/`Blob`, `ArrayBuffer`, or typed-array
view. GTX is the historical binary vertical-shift grid format; this provider
accepts big-endian float32 or float64 values and bilinear interpolation.
It does not download grids. A separate explicit loader supports the exact NGA
EGM2008 2.5-minute small-endian grid described below; KNGeoid24 is unsupported.

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
WKT must be a supported WKT1 `COMPD_CS` or WKT2 `COMPOUNDCRS` with a
`GEOGCS`/`PROJCS` or `GEOGCRS`/`PROJCRS` horizontal component and an explicit
`VERT_CS`/`VERTCRS` source vertical CRS. WKT2 vertical units are read from the
declared axis units. Explicit east/west and north/south axes are normalized to
the projection engine's coordinate order; unsupported directions fail closed.
The horizontal component must declare a supported WGS 84 datum name and the
exact WGS 84 ellipsoid parameters; this includes ESRI's `D_WGS_1984` spelling.
Other horizontal reference frames fail until a verified frame transformation
is available. When the WKT declares an outer EPSG vertical authority, the
configured source must use that EPSG code; names are accepted only when the
WKT has no outer authority. Other authority namespaces are not configurable.
Any explicitly declared vertical axis must point `UP`. The rendering target is
WGS 84 ellipsoidal height
(`EPSG:4979`). Missing CRS/grid metadata, hash mismatch, malformed data,
authority/name mismatch, downward vertical axes, unsupported epochs, NoData
samples, or points outside coverage fail the requested point preparation.
There is no fallback to uncorrected heights or to a constant offset.

### NGA EGM2008 2.5-minute grid

The dedicated loader accepts only the extracted raw
`Und_min2.5x2.5_egm2008_isw=82_WGS84_TideFree_SE` member from NGA's official
`EGM2008_Interpolation_Grid.zip`. Select/extract that file locally before
calling the API. It verifies the exact inspected file digest and Fortran
record structure, then fixes the operation to EGM2008 gravity-related height
(`EPSG:3855`) → WGS 84 ellipsoidal height (`EPSG:4979`), WGS 84 geographic
sampling (`EPSG:4326`), metres, `h - H`, no NoData sentinel, and bilinear
interpolation.

```ts
import * as Cesium from 'cesium';
import {
  CopcCesiumLayer,
  loadNgaEgm2008Grid,
} from '@frillab/copc-adapter';

const gridFile = (document.querySelector('#egm2008-grid') as HTMLInputElement)
  .files?.[0];
if (!gridFile) throw new Error('Select the extracted NGA EGM2008 grid file');

const egm2008 = await loadNgaEgm2008Grid(gridFile);
const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/data/egm2008-height.copc.laz',
  verticalTransform: egm2008,
  heightOffsetMeters: 0,
});
await layer.load();
layer.attachTo(viewer);
```

This profile applies only when the COPC compound WKT explicitly identifies
EPSG:3855 and its horizontal CRS meets the supported WGS 84 restriction. It
does not propagate a coordinate epoch or transform between WGS 84 frame
realizations. The source grid is not bundled or fetched by the library; no
grid request occurs in CI or during point streaming. NGA's accessed page and
archive materials do not state redistribution/modification terms, so users
must obtain and supply the file themselves under terms applicable to their
use. This loader is pinned to one file digest and rejects other releases or
byte layouts.

`noDataValue` is mandatory: provide the documented finite sentinel or `null`
when the grid documentation confirms there is none. Grid values must already
use the declared sign convention; this API does not infer or reverse signs.
`valueUnit` is converted to metres. The loader defaults to a 256 MiB encoded
grid limit and allows an explicit increase up to 512 MiB. It holds one private
decoded grid in the layer/core; input bytes and decoded values can together
use roughly twice the grid size during loading. The NGA EGM2008 file is
149,368,328 bytes encoded and 149,333,760 bytes decoded (about 284.86 MiB
together before runtime overhead). Mutable `ArrayBuffer` and typed-array input
is snapshotted during loading; if the caller keeps that original buffer alive,
it adds another 142.45 MiB. A local `File`/`Blob` avoids that caller-owned copy.
Grid data is not sent to each Worker.
Rust/WASM preparation and JavaScript preparation both pass through the
shared TypeScript grid sampler, so corrected geographic and ECEF positions
follow the same rule. Sampling currently runs synchronously in the shared
streaming preparation stage. During initial EGM2008 loading, decoding yields to
the event loop after each 16 latitude rows (138,240 samples); this keeps the
entire 37-million-sample scan from running as one long browser task. Decoding
still uses main-thread CPU time and is not moved to a Worker.

The configured grid remains owned by the layer/core for its lifetime; reuse it
across reloads that use the same grid and source CRS. Create a new layer/core
when changing the transform configuration. Omitting `verticalTransform`
disables datum conversion. `heightOffsetMeters` is then still available as
the independent manual adjustment described above.

The generic GTX provider is tested with synthetic grids. The exact NGA
EGM2008 file is also validated locally against NGA's official sample values
and GeoGRAV bilinear outputs; those comparisons validate model samples and
interpolation only, not survey-control accuracy or an arbitrary COPC dataset.
No grid is bundled. No KNGeoid24 support is declared. Evidence gaps and
requirements are recorded in the
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

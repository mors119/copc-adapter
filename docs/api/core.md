# Core API

Renderer-neutral source, streaming, backend, point, and diagnostic contracts.

This document describes the current public API of `@frillab/copc-adapter`.
The root entrypoint is the backwards-compatible Cesium entrypoint. New
integrations may import the explicit renderer paths:

```text
@frillab/copc-adapter         → Cesium-compatible root
@frillab/copc-adapter/cesium  → Cesium API
@frillab/copc-adapter/three   → Three.js API
@frillab/copc-adapter/core    → renderer-neutral COPC source API
```

`cesium` and `three` are optional peer dependencies. Install the renderer used
by the application. The `/core` entrypoint does not import either renderer and
is intended for consumers that provide their own scheduling and output
formats. The internal point-processing implementation is not part of the
public API contract; its placement may change between TypeScript and Rust/WASM
while these interfaces remain compatible.

The issue #239 API and event semantics are summarized in the
[layer API semantics matrix](../proposals/issue-239-layer-api.md).

## Checked-in defaults and option precedence

This matrix records the current public Adapter `0.8.0` and workspace contracts,
checked against the published declarations and the Core, Cesium, and Three
implementations. Public Playground consumes the exact npm `0.8.0` release; its
manifest exposes its current supported option subset. The
[Workbench coverage matrix](/api/workbench#workbench-capability-coverage) records host
boundaries. The compact URL examples below omit options that already have a
usable default.

### Layer and Core options

| Setting | Public type and requiredness | Effective default | Core | Cesium | Three | Resolution, impact, and disposition |
| --- | --- | --- | --- | --- | --- | --- |
| `url` | `CopcInputSource`, required | Required | Yes | Yes | Yes | Accepts a URL, browser `Blob`/`File`, or `RandomAccessByteSource`. A local source must still contain COPC hierarchy metadata; ordinary LAS/LAZ is unsupported. Keep. |
| `backend` | `CopcBackendSelection`, optional | `copc-js` | Yes | Yes | Yes | `rust` is explicit opt-in; a selected backend failure is surfaced without silent fallback. Custom backends remain supported. Keep and document. |
| `decoder` | `CopcPointDecoder`, optional | Built-in WASM decoder only when a source returns point views instead of direct buffers | Yes | Yes | Yes | Direct-buffer backends can bypass the decoder. An injected decoder is used for view-backed sources. Keep advanced. |
| `pointFields` | `CopcPointFieldSelection`, optional | `position` in Core; see `attributeLoading` in Cesium | Yes | Yes | No | Core callers and Cesium can request standard `rgb`, `intensity`, and `classification` fields. In Cesium required mode these fields are retained alongside the initial style requirements. Three requests fields required by `colorMode`. Extra dimensions remain separately explicit. |
| `colorMode` | `CopcColorMode`, optional | `fixed` (cyan fallback) | No | Yes | Yes | Other modes are `elevation`, `rgb`, `intensity`, `classification`, and `dimension`. Dimension mode requires a `dimension` style below. Keep. |
| `elevationRange` | `CopcElevationRange`, optional | Full dataset elevation range | No | Yes | Yes | Inclusive finite WGS 84 ellipsoidal display-height range in metres; requires `min < max`. Cesium `setStyle({ elevationRange: null })` restores the dataset range. |
| `elevationStyle` | `CopcElevationStyle`, optional | Existing five-stop elevation palette with linear interpolation | No | Yes | Yes | Uses the shared normalized RGB(A) stop model. Linear and step interpolation are supported; omitted alpha defaults to `0.9`. Cesium can update or clear it at runtime; Three takes it in the constructor. |
| `attributeLoading` | `'all'` or `'required'`, optional | `all` for Cesium | No | Yes | No | `all` preserves synchronous runtime restyling by retaining all standard fields. `required` retains the initial color mode's fields, classification for an initial filter, and any explicit `pointFields`. Changing to a mode that needs an unretained field throws before changing style or selection. |
| `classificationFilter` | `CopcClassificationFilter`, optional | No filter | No | Yes | No | Initial filter applied from the first rendered view. Classification is retained in `required` mode even when the initial color mode is different. |
| `dimension` | `CopcDimensionStyle`, optional | No dimension style | No | Yes | Yes | Requires an explicit dimension name and finite range. Supports LAS `Intensity` on both built-in backends and supported scalar Extra Bytes on `copc-js`. The named dimension is selected automatically. |
| `dimensionFilter` | `CopcDimensionFilter`, optional | No filter | No | Yes | No | Inclusive numeric range visibility filter, including initial Cesium rendering. The named dimension is selected automatically; missing and non-finite values are hidden. |
| `clippingVolume` | `CopcCesiumClippingVolume`, optional | No clipping | No | Yes | No | Renderer-space plane intersection (1–6 planes) or inclusive ECEF axis-aligned box. Coordinates are explicitly WGS 84 ECEF metres; clipping filters rendering and picking without reducing source reads. |
| `extraDimensions` | `readonly string[]`, optional | Only dimensions needed by the initial dimension style/filter | Yes | Yes | Yes | Extra Bytes names to retain for picking or later cached Cesium restyling. Omitted names are not decoded; selection does not request every field. Rust rejects non-empty Extra Bytes selections. |
| `coordinateCacheLayout` | `'A' | 'E'`, optional | `E` for Cesium/Three layers; direct `CopcStreamingCore` remains A-shaped | No | Yes | Yes | E retains ECEF F64 XYZ plus prepared-height F64 (32 coordinate bytes/point). Select A to retain exact Source and Geographic triples for synchronous inspection. E derives longitude/latitude from ECEF when Geographic is absent and omits source XYZ when Source is absent. |
| `retainSourceCoordinatesForQueries` | `boolean`, optional | `false` | No | Yes | Yes | With compact E, retains exact source XYZ in the shared point cache for `cache-only` queries. Adds 24 CPU-cache bytes per point and counts toward `maxPointCacheBytes`. No effect with coordinate layout A. |
| `pointSize` | `number`, optional | `3` pixels | No | Yes | Yes | Cesium uses CSS-pixel diameter; Three uses screen-facing pixel size. Keep. |
| `opacity` | `number`, optional | Omitted preserves each renderer's current appearance; Three defaults to `0.9` | No | Yes | Yes | Explicit values are the final uniform layer alpha in `[0, 1]`; runtime `setOpacity()` changes only this layer's rendered resources and does not fetch or decode point data. Alpha zero is not pickable. Keep opt-in. |
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

`decoder`, `pointFields`, `extraDimensions`, range limits, height offsets, and validation policy
are passed through the layer adapters to the shared core. `colorMode: 'rgb'`,
`'intensity'`, `'classification'`, or `'dimension'` controls which point
attributes the Three adapter requests. Cesium defaults to all standard style fields; set
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
| `CopcBackendOpenOptions` (root, `/cesium`, `/three`) | Optional `signal?: AbortSignal`, `rangeRequestDiagnostics?: RangeRequestDiagnosticsRecorder`, `rangeValidation?: RangeValidationPolicy`, `maxRangeBytes?: number`, `maxConcurrentRangeRequests?: number`, `heightOffsetMeters?: number`, and `extraDimensions?: CopcExtraDimensionSelection`. | Core backend boundary; forwarded by all layers | Source lifetime, HTTP security, range memory/concurrency, height preparation, and opt-in Extra Bytes selection. Rust rejects non-empty Extra Bytes selection. See [Extra schema dimensions](#extra-schema-dimensions). | Keep. |
| `CopcPointLoadOptions` (root, `/cesium`, `/three`) | Optional `signal?: AbortSignal`, `performanceObserver?: CopcPerformanceObserver \| null`. `undefined` inherits the source observer; `null` suppresses it. | Core backend boundary; adapters use these internally | Cancellation and diagnostic routing only. See [Backend and point contracts](#backend-and-point-contracts). | Keep. |
| `CopcHierarchyPageLoadOptions` (root, `/cesium`) | Optional `performanceObserver?: CopcPerformanceObserver \| null`; `undefined` inherits the source observer and `null` suppresses it. | Core hierarchy boundary; Three consumers can use source-wide diagnostics | Per-page diagnostic routing only. See [Backend and point contracts](#backend-and-point-contracts). | Keep. |
| `RangeReadOptions` (root, `/cesium`, `/three`) | Optional `signal?: AbortSignal`; omitted means no per-read cancellation override. | Shared source boundary | Cancels only that read; shared cached source work can remain reusable. See [Direct source utilities](#direct-source-utilities). | Keep. |
| `CopcJsBackendOptions` (root, `/cesium`, `/three`) | Optional `extraDimensions?: CopcExtraDimensionSelection`; omitted means no nonstandard dimensions are read. | All entrypoints; only `copc-js` | Extra decoded dimensions increase retained point-cache memory. See [Extra schema dimensions](#extra-schema-dimensions). | Keep opt-in. |
| `RustCopcBackendOptions` (root, `/cesium`, `/three`) | Optional `createByteSource?: RustByteSourceFactory`; omitted uses the backend's built-in source handling. | All entrypoints; only explicit `rust` | Advanced host/test source bridge. There is no silent backend fallback. See [Backend and point contracts](#backend-and-point-contracts). | Keep opt-in. |
| `GtxGeoidGridOptions` (root, `/cesium`, `/three`) | Required `gridId: string`, `sourceVerticalCrs: string`, `targetVerticalCrs: 'EPSG:4979'`, `horizontalCrs: 'EPSG:4326'`, `referenceEllipsoid: 'WGS84'`, `sha256: string`, `valueUnit: VerticalGridValueUnit`, `valueConvention: 'ellipsoidal-minus-orthometric'`, and `noDataValue: number \| null`. Optional `interpolation?: 'bilinear'` defaults to `bilinear`; `maxGridBytes?: number` defaults to `256 MiB` with `512 MiB` hard limit; `requiresMatchedEpoch?: boolean` defaults false; `sourceCoordinateEpoch?: number` and `gridReferenceEpoch?: number` are omitted unless applicable. | Shared coordinate pipeline | Caller assertions are verified against grid bytes and COPC WKT where possible; bad metadata or uncovered samples fail preparation. See [Explicit vertical CRS grid conversion](/api/coordinates#explicit-vertical-crs-grid-conversion). | Keep opt-in. |
| `NgaEgm2008GridOptions` (root, `/cesium`, `/three`) | Optional `maxGridBytes?: number`, default `256 MiB`, hard limit `512 MiB`. | Shared coordinate pipeline | Resource bound for the pinned NGA grid loader. See [NGA EGM2008 2.5-minute grid](/api/coordinates#nga-egm2008-25-minute-grid). | Keep opt-in. |
| `TerrainHeightAlignmentOptions` (root, `/cesium`) | Optional `groundConfirmed?: boolean` (defaults false), `terrainSourceId?: string`, `timeoutMs?: number` (defaults to 30 seconds, cap 60 seconds), and `signal?: AbortSignal`. | Cesium only | One-point opt-in diagnostic; no point correction is applied automatically. See [Explicit Cesium Terrain residual estimate](/api/coordinates#explicit-cesium-terrain-residual-estimate). | Keep opt-in. |
| `TerrainHeightAlignmentGroundCandidate` (`/cesium`) | Required current `anchor: CopcPointInspection`; optional per-anchor `groundConfirmed?: boolean`. | Cesium only | Class 2 is accepted as ground; every other or missing class requires caller confirmation. The point must still be visible in this layer's rendered cache. | Keep opt-in. |
| `TerrainHeightAlignmentBatchOptions` / `TerrainHeightAlignmentBatchEstimate` (`/cesium`) | Optional `maxAnchors?: number` (defaults 8, hard cap 12), `highSpreadWarningMeters?: number` (defaults 2 m), `timeoutMs?: number` (defaults 30 seconds, cap 60 seconds), `signal?: AbortSignal`, and `terrainSourceId?: string`. | Cesium only | One shared Terrain sample request produces per-anchor reasons, robust median/MAD diagnostics, coverage and an explicitly gated uniform-offset proposal. | Keep opt-in. |
| `CopcPointRendererOptions` (root, `/cesium`, `/three`) | Required `pointSize: number`; optional `colorMode?: CopcColorMode`, `dimension?: CopcDimensionStyle`, `elevationRange?: CopcValueRange`, `rgbMax?: 255 \| 65535`, `pointId?: (pointIndex: number) => unknown`, and `pointFilter?: (pointIndex: number) => boolean`. | Shared renderer seam | Renderer call contract, not another layer configuration location. See [Three.js API](/api/three#copcthreelayer). | Keep. |
| `CopcCesiumPointRendererOptions` (root, `/cesium`) | Extends shared per-node options; optional `pointSizeMode?: CopcCesiumPointSizeMode` defaults to `fixed`, `minPointSize?: number` / `maxPointSize?: number` default to `1` / `12` CSS pixels and cap at `64`, `pointSpacingMeters?: number`, `clippingPlanes?: readonly CopcCesiumClippingPlane[]`, `onPerformance?: callback`. | Cesium renderer extension | Renderer call contract, not another layer configuration location. See [CopcCesiumLayerOptions](/api/cesium#copccesiumlayeroptions). | Keep. |
| `ThreePointRendererOptions` (`/three`) | Extends shared per-node options; optional `onPerformance?: callback`. | Three renderer extension | Renderer call contract, not another layer configuration location. See [Three.js API](/api/three#copcthreelayer). | Keep. |
| `ThreePointRendererConstructorOptions` (`/three`) | Optional `localOrigin?: Wgs84EcefPoint` and `localFrame?: DatasetLocalFrame`; omitted direct-constructor origin is derived from the first nonempty node. | Three only | `CopcThreeLayer` supplies its dataset-local frame after metadata; see [Three.js API](/api/three#copcthreelayer). | Keep. |
| `CopcThreeLayerPickOptions` (`/three`) | Optional `raycaster?: THREE.Raycaster`; optional `threshold?: number` defaults to layer `pickingThreshold`, then `1` scene unit. | Three only | Per-call pick control; see [Three.js API](/api/three#copcthreelayer). | Keep. |
| `CopcPointStyleInput` / `CopcPointStyleOptions` (root, `/cesium`) | Input `colorMode?: CopcColorMode`, `dimension?: CopcDimensionStyle`, `elevationRange?: CopcElevationRange`, `intensityRange?: CopcValueRange`, and `rgbMax?: 255 \| 65535` are optional and infer from point buffers; resolved `CopcPointStyleOptions` fields are required. | Core styling helpers; not layer constructor options | Omitted color mode resolves to fixed cyan. See [Runtime styling](/api/cesium#runtime-styling). | Keep. |
| `CopcThreePointStyleOptions`, `CopcThreePointsMaterialOptions` (root) | `CopcThreePointStyleOptions` requires `pointSize: number`; the material helper requires `pointSize: number` and accepts optional `opacity` defaulting to `0.9`; it returns transparent vertex colors and disabled size attenuation. | Root compatibility helpers only | No hidden layer override or precedence relationship. See [Runtime styling](/api/cesium#runtime-styling). | Keep. |
| `ThreeStreamingViewOptions` (`/three`) | Required `camera: THREE.Camera` and `frame: DatasetLocalFrame`; optional `renderer?: ThreeViewportSource` and `maxRenderDistanceMeters?: number`. A finite positive camera far plane wins; otherwise the option or `12,000` m is used. | Three view helper only | Here `renderer` is only a viewport-size source, as distinguished in the renderer table above. | Keep. |

The packed consumers typecheck the minimal public `/cesium` and `/three`
layer options. Other specialized option contracts remain advanced API; they
are listed here to make their required inputs and defaults discoverable without
adding them to minimal examples.

The minimal Cesium and Three examples in this API, the [repository README](https://github.com/mors119/copc-adapter/blob/main/README.md),
the [package README](https://github.com/mors119/copc-adapter/blob/main/packages/adapter/README.md),
[Examples](../EXAMPLES.md), [Korean getting-started guide](../ko/getting-started.md),
and [Korean API guide](../ko/api.md) omit default-valued options. The full
advanced option combinations remain in [Examples](../EXAMPLES.md) and the later
API sections.

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
[issue 191 browser report](../benchmarks/issue-191-adaptive-view-distance.md).

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

## COPC Tiles compatibility audit

COPC Tiles is maintained as a separate npm package in
[FrilLab/copc-tiles](https://github.com/FrilLab/copc-tiles). This historical
compatibility audit documents the public Adapter Core contract, not a bundled
Tiles implementation. Current integration and packed-consumer tests are owned
by the standalone Tiles repository.

This audit records the published `@frillab/copc-adapter@0.6.0` baseline checked
for [issue #383](https://github.com/mors119/copc-adapter/issues/383). That
artifact exposes `.`, `./cesium`, and `./three`; the root remains the
backwards-compatible Cesium entrypoint. Version 0.7.0 adds `./core` for
renderer-neutral COPC access and node preparation. Version 0.7.1 adds
conservative source-cell ECEF bounds for a strictly limited transform subset
and fixes declarations for strict NodeNext consumers. The 0.8.0 candidate adds
explicit WKT2 projected WGS 84 ellipsoidal-height diagnostics for a narrowly
recognized 3D CRS form; it does not add projected source-cell bounds. The 0.6.0
artifact does not export this subpath.

The implemented optional connector uses the existing public Core contract, so
this audit does not add a Tiles-specific Adapter API. Its coverage is checked
against COPC Tiles [T1 input and attribute selection](https://github.com/FrilLab/copc-tiles/issues/1)
and [T2 requested-node reads](https://github.com/FrilLab/copc-tiles/issues/2).
The connector consumes the A-shaped prepared-node result directly; the
experimental Direct E cache remains internal and is neither exposed nor
rehydrated by this connector. The packed-package checks and separate
real-source integration are documented in
[Tiles Adapter API compatibility record](https://github.com/FrilLab/copc-tiles/blob/main/docs/adapter-api-compatibility.md#issue-383-public-contract-decision).

| Capability | Existing implementation | Public API in 0.8.0 candidate | Scope and limitation |
| --- | --- | --- | --- |
| Open HTTP and File/Blob sources | Existing `CopcBackend`, `CopcContext`, and Range sources | `createCopcContext()` returns `CopcNodeSource` from `@frillab/copc-adapter/core` | Built-in `copc-js` and opt-in Rust/WASM backends; caller-owned random access is supported |
| Traverse root and lazy hierarchy pages | Existing `CopcSource`, parser, and `HierarchyLoader` | `CopcContext` page methods plus `HierarchyLoader` | Page queries accept a hard `maxPages`; unresolved children remain `childrenComplete: false` |
| Load one node and select fields | Existing point view, buffer, and prepared paths | `loadPreparedNodeData(node, fields, options)` | Position is required; standard fields report actual availability; named Extra Bytes must be configured at open and may be narrowed per request |
| Prepare WGS84 ECEF Float64 | Rust fused preparation and existing JS transform pipeline | `CopcPreparedNodeData.pointData` | Returns the A-shaped `PreparedPointData` buffers without Direct layer cache conversion |
| Decoded-point ECEF bounds | Existing transformed point buffers | `CopcPreparedNodeData.ecefBounds` or `getPreparedEcefBounds()` | Encloses decoded, transformed points only; it does not bound an undecoded source cell |
| Conservative source-cell ECEF bounds | Analytic WGS 84 geodetic interval enclosure | `CopcConservativeNodeSource.getConservativeNodeEcefBounds(nodeKey)` | Metadata-only; supported for explicit WGS 84 geographic EPSG:4326/4979 degree axes with explicit ellipsoidal height or a validated, covered vertical grid without a NoData sentinel. Projected CRS, unknown datums/heights, unresolved epochs, and unverifiable grids return `unsupported`. Covers the full source cell and its spatial descendants; content encoders still need proven reconstruction padding. |
| CRS and vertical provenance | Existing immutable `CoordinateTransformPlan` and transform pipeline | `transformPlan` on the context and prepared-node result | A transform change requires opening a new context; its generation differs |
| Cancellation and invalidation | Range signals, Rust worker cancellation, Direct core generations | Request signals, `CopcContext.close()`, and `isCurrent()` | HTTP and Rust workers can stop supported in-flight work; started Blob reads and synchronous JS decode may finish, but stale results are rejected |
| A/E cache compatibility | A-shaped `PreparedPointData`; Direct layer caches can use E | Source reads return the A contract | This API does not expose or rehydrate Direct E cache entries and does not change Direct defaults |
| Renderer/package isolation | Core implementations are renderer-neutral | `@frillab/copc-adapter/core` | The entrypoint imports neither CesiumJS nor Three.js |
| Tiles content generation | COPC parsing, hierarchy, and point preparation are reusable | Source and prepared-node APIs | The consumer owns scheduling, tile selection, serialization, and glTF/GLB/3D Tiles generation; this API is not a complete 3D Tiles integration |

The three bounds contracts are intentionally distinct. `getNodeCellBounds()`
returns a cell in COPC source coordinates. `ecefBounds` encloses the decoded,
transformed points for one node. `getConservativeNodeEcefBounds()` derives a
WGS 84 ECEF bound for the full source-space octree cell and its spatial
descendant cells, without reading point chunks, only when its transform
preconditions can be verified. It returns `unsupported` for projected sources
such as Autzen EPSG:2992 and SoFi EPSG:32611, and for unresolved vertical
references or epochs. Autzen's NAVD88 US survey foot heights are not reconciled
to WGS 84 ellipsoidal height by this API. A supported cell bound does not
establish that hierarchy-page child discovery is complete, choose a leaf, or
include content-encoder reconstruction error. Arbitrary nonlinear CRS and
vertical operations remain unsupported; transformed corners alone cannot
prove a conservative region enclosure.

### Renderer-neutral source usage

```ts
import {
  createCopcContext,
  createCopcPointFieldSelection,
  HierarchyLoader,
} from '@frillab/copc-adapter/core';

const source = await createCopcContext('/data/autzen.copc.laz', 'copc-js', {
  extraDimensions: ['leg_id'],
  heightOffsetMeters: 0,
});
const abortController = new AbortController();
try {
  const metadata = source.getMetadata();
  const hierarchy = new HierarchyLoader(source, metadata.cube);
  const root = await hierarchy.loadRoot({ signal: abortController.signal });
  const node = root.nodes[0];
  if (!node) throw new Error('The root hierarchy page contains no point node');

  const cellBounds = source.getConservativeNodeEcefBounds(node.key);
  const result = await source.loadPreparedNodeData(
    node,
    createCopcPointFieldSelection(['position', 'rgb']),
    { signal: abortController.signal, extraDimensions: ['leg_id'] },
  );
  if (cellBounds.status === 'supported') {
    if (
      cellBounds.sourceIdentity !== result.sourceIdentity ||
      cellBounds.sourceGeneration !== result.sourceGeneration ||
      cellBounds.transformGeneration !== result.transformGeneration ||
      cellBounds.transformPlanIdentity !== result.transformPlan.identity.key
    ) {
      throw new Error('Cell bounds and prepared points belong to different source or transform generations');
    }
    console.log(cellBounds.coverage, cellBounds.boundsEcef, cellBounds.encoderErrorPaddingRequired);
  } else {
    console.warn(`No conservative source-cell ECEF bound: ${cellBounds.reasonCode}: ${cellBounds.reason}`);
  }
  console.log(result.pointData.world.coordinates, result.ecefBounds);
  console.log(result.transformPlan, result.sourceGeneration, node.childrenComplete);
} finally {
  source.close();
}
```

`HierarchyLoader.loadRoot()` reads only the root hierarchy page. Use its bounded
`query()` method or `CopcContext.loadHierarchyPage()` to continue lazily. The
loader derives available direct children and marks completeness only after
relevant hierarchy pages have resolved. It does not invoke the Direct
`NodeSelector`.

The prepared result's typed arrays are owned JavaScript buffers, not views into
WASM memory. Callers may retain and read them after closing the context, but
must not mutate or transfer them. Source metadata is returned as an immutable
snapshot, and the transform plan carries the evidence used to prepare the
coordinates. Empty point nodes have no ECEF content bound.
Standard fields absent from a source are omitted and listed as unavailable;
attributes are never zero-filled. Extra Dimension names are case-sensitive.
The `copc-js` path preserves unscaled 64-bit integer Extra Bytes as `bigint`
arrays where the source descriptor allows exact reads. Rust/WASM currently
rejects Extra Bytes requests explicitly.

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
  extraDimensions: ['leg_id', 'CE'],
  onPointPicked: (point) => console.log(point?.dimensions),
});
```

- `extraDimensions` is a list of dimension names, or `'*'` for every dimension
  outside the standard LAS point record. Names missing from a file's schema are
  skipped, so one configuration works across files with different schemas.
- Requested dimensions are decoded for every loaded point and retained in
  `CopcPointAttributes.extraDimensions`, which counts toward
  `maxPointCacheBytes`. Request only what you need.
- A dimension referenced by the constructor's `dimension` or
  `dimensionFilter` is requested automatically. Additional names in
  `extraDimensions` are useful for picking or later Cesium restyling. The
  existing `new CopcJsBackend({ extraDimensions })` configuration remains
  supported and is combined with names requested by the layer.
- The picked point reports them as `CopcPointInspection.dimensions`. Values are
  `number`, except 64-bit integer dimensions, which are `bigint` so identifiers
  above `Number.MAX_SAFE_INTEGER` stay exact. Scaled 64-bit integers are read
  through the scale and offset as `number`.
- `CopcMetadata.extraDimensions` reports the names, signed/unsigned/float
  primitive type, byte length, optional scale/offset, and numeric NoData
  sentinel provided by the selected parser. This list is absent when a backend
  cannot reliably supply those descriptors.
- `copc-js` supports numeric styling/filtering for scalar signed/unsigned
  8-/16-/32-bit integer and 32-/64-bit float Extra Bytes. Scale/offset are
  applied to both displayed and inspected values; numeric NoData is treated as
  missing automatically. 64-bit integer values remain `bigint` for exact
  inspection, but numeric style/filter requests reject them. Vector descriptors
  and untyped byte fields are unsupported by the current copc-js reader.
- Rust supports `Intensity` through its standard LAS attribute path. It does
  not decode Extra Bytes; non-empty `extraDimensions` selections are rejected
  explicitly and do not trigger a `copc-js` fallback.

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
guide](../source-hosting.md) for deployment examples and browser checks.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for implementation ownership and
[CONFORMANCE.md](../CONFORMANCE.md) for backend and CRS correctness strategy.

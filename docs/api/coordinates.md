# Coordinates and vertical CRS

Coordinate interpretation, bounds, terrain alignment, and explicit vertical transformations.

## CRS metadata diagnostics

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

### Bounded multi-anchor estimate

Use `estimateTerrainHeightAlignmentBatch()` when several current rendered
points have been inspected. The adapter verifies each `nodeKey + pointIndex +
ownerId` against this layer's live rendered cache, including its current style
and clipping visibility. Candidates from another layer, stale point buffers,
duplicate longitude/latitude pairs and unconfirmed non-ground classes are
rejected with a reason. It never chooses the lowest point as ground.

The default sample bound is 8 anchors and the hard limit is 12. Candidates
beyond `maxAnchors` are reported as rejected without sampling. All eligible
positions are passed together to one public
`sampleTerrainMostDetailed(provider, positions, true)` call. At least two finite
inlier samples are required for a batch proposal. Each residual is
`terrainHeightMeters - anchor.displayedHeightMeters`; the median and median
absolute deviation (MAD) identify outliers. Outliers use a 3.5 modified-z
cutoff, scaled by 1.4826, with a one-centimetre minimum cutoff. The reported
`robustSpreadMeters` is `1.4826 × MAD` after outlier rejection. A spread above
`highSpreadWarningMeters` returns `uncertain` and `actionable: false`, while
retaining the median proposal for review.

```ts
const anchors: TerrainHeightAlignmentGroundCandidate[] = inspectedPoints.map(
  (anchor) => ({
    anchor,
    // Set this only when ground status was independently confirmed.
    ...(anchor.classification === 2 ? {} : { groundConfirmed: true }),
  }),
);

const estimate = await layer.estimateTerrainHeightAlignmentBatch(anchors, {
  maxAnchors: 8,
  signal: estimateAbortController.signal,
});

if (
  estimate.status === 'ready' &&
  estimate.actionable &&
  layer.isTerrainHeightAlignmentBatchEstimateCurrent(estimate)
) {
  // This is the existing total heightOffsetMeters value. Rebuild only after
  // the application presents the proposal and the user explicitly approves.
  const approvedHeightOffsetMeters = estimate.proposedHeightOffsetMeters;
}
```

The proposal is `existingHeightOffsetMeters + medianResidualMeters` exactly
once. Retained `source` XYZ remains unchanged; compact E inspection may omit
source XYZ. `coverage` reports submitted, sampled and accepted counts;
`generationIdentity` records the source, layer-estimate,
TerrainProvider and vertical-transform generations used. The current-result
check becomes false after a new estimate, source/layer lifecycle change,
TerrainProvider replacement, transform change, or removal/change of any
sampled point. Different layers keep independent estimates even when they
share a Viewer. A status of `uncertain`, an unavailable result, cancellation,
or a false current-result check must never be applied.

The deterministic browser tests use a local fake `TerrainProvider` and a tiny
two-point WKT2 ellipsoidal COPC fixture; they make no network Terrain request.
An optional real-Terrain smoke can be run by configuring an application-owned
Cesium `TerrainProvider` and calling the same method. That smoke is opt-in,
provider-dependent and does not establish surveyed, geoid or datum accuracy.

The returned effective offset is `existing heightOffsetMeters + proposed
offset`. Recreating from the original COPC applies the validated vertical grid
first, then this single total additive offset. Estimating again after approval
does not add the same residual twice. A rebuild uses the existing coordinate
preparation path so displayed points, bounds, camera navigation and picking
share one transform; it can repeat source Range reads, LAZ decoding, worker
work, and renderer uploads. The dev-viewer stages a replacement session and
keeps the previous one until the candidate is ready.

The single-anchor method samples one anchor; the batch method samples at most
12 anchors in one shared request. Only one in-flight estimate per Viewer is
accepted, and the default caller wait deadline is 30 seconds (bounded to 60
seconds). Cesium’s sampler has no `AbortSignal`: cancelling or timing out
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
[issue #244 implementation record](../proposals/issue-244-vertical-crs-geoid-grid.md).

The projected EPSG:5186 Rust/JavaScript differential fixture checks longitude
and latitude within `1e-7` degrees, corrected height within `1e-9` metres, and
ECEF coordinates within `0.05` metres.

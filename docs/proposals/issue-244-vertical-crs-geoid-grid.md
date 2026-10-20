# Issue #244: Vertical CRS and geoid-grid decision

**Status:** Generic offline GTX conversion implemented; model-specific support is blocked by external evidence.
**Reviewed:** 2026-10-21.
**Scope:** Explicit orthometric-to-ellipsoidal conversion for COPC point heights.

Issue [#244](https://github.com/mors119/copc-adapter/issues/244) asks whether
COPC Adapter can safely convert known vertical datums with geoid grids. The
implementation now includes an opt-in offline GTX reader and shared height
sampler. This record documents the source review, implemented limits, test
evidence, and the external evidence still required for EGM2008 or KNGeoid24.

## Decision

Keep the current default as no vertical-datum transformation. Do not infer a
Korean vertical datum from country, horizontal CRS, coordinate values, or
visible Cesium terrain. Keep `heightOffsetMeters` as the caller's explicit
uniform correction from issue #237.

The implemented path accepts one caller-supplied GTX file with explicit source
and target vertical CRS metadata, a file SHA-256, units, sign convention,
NoData declaration, and interpolation rule. It currently requires a WKT1
compound source CRS with WGS 84 horizontal datum/ellipsoid and an explicit
`VERT_CS`, and targets ellipsoidal height EPSG:4979. WKT2 horizontal
transformation is not supported by the current coordinate path. The library
does not bundle, download, or redistribute EGM2008 or a Korean NGII grid. The
generic format support does not certify any model. A requested conversion
fails on missing or ambiguous CRS metadata, a missing/invalid grid, NoData, or
a coordinate outside coverage; it never renders that point as uncorrected.

An eventual `auto` mode may select a registered operation only when the input
compound CRS identifies a supported vertical CRS and the exact operation,
grid version, target frame, and coverage are available. It must not select a
model merely because the data falls in Korea. Until a licensed, verified
operation is shipped or supplied by the caller, `auto` must fail closed;
callers that want the current behavior can select no transformation.

## Height semantics

For an orthometric height `H` and geoid undulation `N` measured from the same
reference ellipsoid to the geoid associated with that height datum:

```text
h = H + N
```

This is the conventional height relationship; the sign follows the definition
of `N`, not a regional constant. NOAA's National Geodetic Survey describes the
same relationship and warns that height datums can differ in their definitions
([height relationship](https://www.ngs.noaa.gov/PUBS_LIB/gislis96.html)). A
geoid grid is meaningful only with its horizontal reference, vertical datum,
units, sign, and any applicable coordinate frame and epoch. The equation does
not make unrelated orthometric systems interchangeable. For high-accuracy
work, the chosen model's definition and its source-to-target operation must be
authoritative; a local vertical datum may also require a frame transformation.

The safe processing order is:

1. Decode the original COPC source XYZ and apply LAS scale/offset.
2. Convert source horizontal and vertical units using the source metadata.
3. Transform horizontal coordinates into the grid's declared coordinate frame
   and sampling axes, applying any required frame/epoch operation.
4. Apply the explicitly selected source-vertical-to-target-vertical operation
   once. For a geoid-undulation grid this is `h = H + N` in metres.
5. Apply `heightOffsetMeters`, if supplied, as a separate caller-chosen
   residual after the vertical CRS conversion.
6. Apply a separately requested terrain-placement residual, if that future
   feature is implemented, without treating terrain as a geoid or datum.
7. Prepare ECEF coordinates and all dependent bounds from the corrected height.

Steps 5 and 6 are independent offsets. The implementation must expose the
chosen operations and their order so callers can avoid adding an offset already
represented by their source heights or a geoid operation. Terrain placement
from issue [#305](https://github.com/mors119/copc-adapter/issues/305) remains a
separate viewer-specific residual alignment and is neither a prerequisite nor
evidence for this vertical CRS conversion.

## Source and target pairs reviewed

| Model | Source height | Target height | Research decision |
| --- | --- | --- | --- |
| EGM2008 | EGM2008 orthometric height (EPSG:3855) | WGS 84 ellipsoidal height (height component of EPSG:4979) | Technically identifiable as a global model-to-ellipsoid pair. Use only when source metadata says EGM2008; it is not Korea's national height datum. A horizontal datum/frame transformation is a separate step. |
| KNGeoid24 | Korean national orthometric height represented by the NGII model | The ellipsoidal height/frame used by the corresponding GNSS observations and model | NGII confirms the model converts GNSS ellipsoidal heights to Korean elevations and publishes KNGeoid24 as its current model. The accessible product metadata does not establish the exact file's CRS identifier, ellipsoid/frame realization, epoch, grid encoding, interpolation rule, or redistribution terms. Do not claim an EPSG pair or apply it to arbitrary WGS 84-labelled heights until those details are verified with the model file and NGII documentation. |
| KNGeoid18 | Historic Korean national orthometric height represented by KNGeoid18 | The ellipsoidal height/frame used by that model | Treat as an explicitly versioned legacy operation. NGII's current release recommends its latest model for new surveys. The public data record also restricts third-party transfer without permission and marks the data Attribution-NoDerivatives; it is not approved for bundling or conversion into distributed derivative grids. |

NGII identifies Korea's national elevation as height above Incheon mean sea
level. Its 2024 release names KNGeoid24 as the latest model, reports an average
model precision of 2.30 cm, and says it is available free through the National
Land Information Platform ([MOLIT release](https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=95090271&lcmspage=52)).
The release also reports 5,398 control-point results used for KNGeoid24. These
are model evaluation figures, not a guarantee of the error in an arbitrary
COPC source or of the final ellipsoidal height.

The official [KNGeoid18 data record](https://www.data.go.kr/data/15122553/fileData.do)
documents coverage from 33°N to 39°N and 124°E to 132°E, warns that areas with
sparse gravity observations can differ by about 10 cm, and says the data may
not be transferred to a third party without permission. The record specifies
free access and Public Nuri Type 3 (attribution, no derivatives). The accessible
record is for KNGeoid18; it does not grant rights to distribute KNGeoid24 or a
modified/cropped grid.

NGA publishes the EGM2008 worldwide 2.5-minute geoid-height grid and supporting
files ([EGM2008 data](https://earth-info.nga.mil/index.php?action=geoid&dir=wgs84)).
NGA describes EGM2008 geoid heights relative to the WGS 84 ellipsoid and lists
the grid archive as 128 MB. Its public data page does not state an explicit
redistribution licence for the grid. Free public download alone is not treated
as permission for COPC Adapter to redistribute it.

### Official access and metadata findings (reviewed 2026-10-21)

- **KNGeoid24:** the MOLIT release says the model is available free through
  the National Land Information Platform, but the release does not link the
  exact product record or document a click/API sequence, authentication
  requirement, or a file download. The exact KNGeoid24 grid was not obtained.
  Its horizontal CRS/frame, vertical CRS identifier, height reference/epoch,
  encoding, resolution, units, sign, NoData, interpolation, and reuse terms
  therefore remain unverified. Do not infer them from the model name or the
  separate KNGeoid18 record.
- **EGM2008:** NGA's WGS 84 data page provides a 2.5-minute worldwide
  interpolation-grid ZIP (listed as 128 MB), supporting code/docs, and a
  geoid-height calculator. The [current GeoGRAV application](https://earth-info.nga.mil/geograv)
  describes AOI grid export and point interpolation. The public landing pages
  establish global coverage and WGS 84 ellipsoid relation, but do not establish
  the exact grid archive's encoding, NoData, interpolation procedure, units,
  accuracy at a given location, or redistribution licence. The archive
  download was attempted from NGA but the transfer reset before completion, so
  its internal README and data files were not inspected. The source's model
  epoch/realization requirements for a specific COPC observation are also not
  established by these pages.
- **GTX:** the generic provider implements the documented GTX binary layout,
  not the NGA ZIP or the KNGeoid24 product format. A user must supply an
  already documented GTX file. Conversion from an official model archive to
  GTX is not implemented or validated.

### Coverage and memory estimates

The EGM2008 grid is global at 2.5 arc-minutes. A full regular grid at that
spacing is about 37.3 million nodes. If represented as one 32-bit float per
node, that is approximately 142 MiB; as 64-bit floats it is approximately 285
MiB, before decoder overhead or copies. These are calculated estimates, not a
verified description of the NGA archive's internal layout. A cropped regional
window with interpolation halos would be much smaller, but cropping is itself
a derived-data operation and inherits the source grid's distribution terms.

The MOLIT release gives KNGeoid18 a coverage of 33°N–39°N, 124°E–132°E, and
approximately 1.8 km resolution. At that scale, a regular regional array is
on the order of 0.7 MiB as float32 or 1.4 MiB as float64. The published release
does not give unambiguous KNGeoid24 file dimensions or binary representation;
the estimate is therefore only a sizing comparison, not KNGeoid24 metadata.
Before implementation, inspect the exact authorized file for dimensions,
spacing, axes, nodata, units, sign, and interpolation instructions.

## Distribution, cache, and Worker policy

- Do not bundle a grid or a generated/cropped derivative unless its licence
  permits redistribution and modification. KNGeoid24 terms and NGA EGM2008
  redistribution terms have not been verified.
- The caller supplies local `File`/`Blob`, `ArrayBuffer`, or typed-array bytes.
  Network URLs are not accepted. The caller remains responsible for lawful
  access and for assertions about model/version, CRS, sign, units, NoData,
  extent, and interpolation. The adapter does not persist or forward grid data.
- The loader verifies SHA-256 and decodes one immutable grid object. Default
  encoded/decoded grid cap is 256 MiB; callers may raise it to 512 MiB. The
  hard cap is per representation, so a `File`/`Blob` load uses about two
  grid-sized buffers (encoded bytes plus decoded values), besides runtime
  overhead. GTX does not store NoData in its 40-byte header, so finite
  sentinels must be declared by the caller.
- One layer/core retains the supplied grid reference. There is no separate
  persistent grid cache or Worker copy. The shared TypeScript stage applies
  correction after either JavaScript or Rust/WASM preparation; grid
  initialization does not repeat for points or chunks. Sampling currently runs
  synchronously in that stage, so large streamed batches add main-thread work.
- HTTP Range COPC reads, hierarchy requests, point budgets, node cancellation,
  decoded cache, and LOD selection continue through existing paths. Prepared
  corrected data follows the core cache lifecycle; unload/reload rebuilds it
  from original source coordinates and does not apply the grid twice. The grid
  is not downloaded per point or chunk.

## Implemented API and failure semantics

The public API is intentionally limited to `GtxGeoidGrid`:

```ts
const grid = await loadGtxGeoidGrid(file, {
  gridId: "documented local grid/version",
  sourceVerticalCrs: "exact vertical authority or WKT name",
  targetVerticalCrs: "EPSG:4979",
  horizontalCrs: "EPSG:4326",
  referenceEllipsoid: "WGS84",
  sha256: "64-hex-character digest",
  valueUnit: "metre",
  valueConvention: "ellipsoidal-minus-orthometric",
  noDataValue: null, // only when docs confirm no finite sentinel
  interpolation: "bilinear",
});
new CopcCesiumLayer({ url, verticalTransform: grid, heightOffsetMeters: 0 });
```

Omitting `verticalTransform` preserves existing behavior. There is no `auto`
mode. Only WGS 84 horizontal WKT and ellipsoid, an exact source vertical CRS
match, and WGS 84 ellipsoidal EPSG:4979 output are accepted. The declared grid
horizontal CRS is EPSG:4326. Other source frames fail until a verified frame
operation is available. Dynamic CRS declarations require equal source and grid
epochs; propagation is not implemented. Typed `VerticalTransformError`
failures cover missing vertical CRS, unsupported CRS pair, invalid metadata,
bad digest/format, resource limit, frame/epoch mismatch, unsupported
interpolation/direction, NoData, and out-of-coverage. The adapter never
switches to EGM2008, KNGeoid18, KNGeoid24, `heightOffsetMeters`, or no transform
after a requested grid conversion fails.

Grid sampling happens after horizontal projection and before ECEF preparation.
The corrected height drives display, inspection, ECEF, hierarchy/elevation
bounds, metadata bounds, camera queries, and fly-to calculations. Bounds expand
conservatively by the grid's decoded global minimum/maximum undulation.
Rust/WASM and JavaScript share the TypeScript grid sampler after backend
preparation and therefore use the same axes, interpolation, edge, NoData, sign,
and failure rules.

## Verification status and model gates

The generic engine is implemented and tested with synthetic grids. No
authoritative real-grid run is recorded. Synthetic tests establish header
decoding, checksum failure, interpolation, positive/negative shifts, unit
conversion, boundaries, antimeridian wrapping, NoData, CRS/epoch failures,
inverse height math, manual-offset composition, source immutability,
conservative bounds, reload behavior, and Rust/WASM versus JavaScript prepared
ECEF parity. They do not establish any real model's CRS, sign, licensing,
accuracy, or suitability.

### Implementation validation

- `cd packages && npm run typecheck` — passed.
- `npm --prefix packages test` — passed, 478/478 tests, no skips; prepares the
  Rust/WASM core before running the package suite.
- `cd packages && npm run build:library` — passed; package declarations and
  Rust/WASM assets built.
- `cd apps/dev-viewer && npm run typecheck` — passed.
- `cd apps/dev-viewer && npm run test:unit` — passed, 14/14 tests.
- `cd apps/dev-viewer && PLAYWRIGHT_TEST_PORT=4174 npm run test:e2e -- e2e/vertical-grid.spec.ts`
  — passed, 1/1 browser smoke test using a local synthetic GTX Blob.
- `cd apps/dev-viewer && npm run build` — passed.
- `npm run docs:build` — passed.
- `npm run test:pack` — passed; 6 Chromium scenarios each in root production,
  explicit Cesium production, and root development consumers (18/18 total).
- `npm run test:pack:three` — passed; clean packed Three.js/Vite consumer build.
- `git diff --check` — passed.

These checks validate the generic implementation and package integration only;
they do not substitute for real-grid model validation.

### Temporary streaming-preparation measurement

A temporary Node.js measurement transformed the same preallocated 50,000-point
WGS 84 batch seven times with and without an already-loaded synthetic global
361 × 181 float32 grid (261,364 decoded bytes). On Node v26.7.0, macOS 25.6,
Apple M2 arm64, median preparation time was 16.804 ms without correction and
17.183 ms with it (+0.379 ms, 2.3% in this run). The observed ranges were
14.225–22.945 ms and 15.457–26.879 ms. Holding one prepared batch increased
`process.memoryUsage().arrayBuffers` by 3.43 MiB; RSS stayed at 110.02 MiB at
the measurement's 0.01 MiB display precision. The decoded synthetic grid was
0.249 MiB. This is a local CPU micro-measurement of the shared preparation
function, not an end-to-end streamed browser or Worker benchmark; it does not
include network, COPC decoding, renderer/GPU work, loader peak memory, or a
variable real model. The timing difference is within this run's variation and
is not evidence of a general performance gain or loss.

For scale only, a 2.5-minute global node lattice would contain about 37.34
million nodes. At float32 that is about 142.4 MiB decoded; an encoded GTX and
decoded array together would be about 284.8 MiB during loading, before runtime
overhead. These dimensions are a spacing-based estimate, not a verified NGA
archive layout. A float64 representation would exceed the default 256 MiB cap
and require an explicit higher cap within the 512 MiB hard limit.

The GTX interpretation follows GDAL's implementation: a big-endian 40-byte
header with latitude/longitude origin and spacing, int32 row/column counts, and
float32 samples (the reader also accepts legacy float64 when file length
matches). Raw rows are stored south-to-north for this provider's lookup. GDAL
assigns WGS 84 latitude/longitude and uses -88.8888 as its default NoData value
unless auxiliary metadata overrides it. This provider does not infer that
sentinel: `noDataValue` must come from exact grid documentation or be `null`
when documentation confirms no finite sentinel. GTX itself contains no
source/target vertical CRS, units, license, epoch, sign convention, or model
identity. See the [GDAL GTX driver documentation](https://gdal.org/en/stable/drivers/raster/gtx.html)
and [GDAL GTX reader source](https://raw.githubusercontent.com/OSGeo/gdal/master/frmts/raw/gtxdataset.cpp).

The next model-specific implementation step still needs:

1. Archive the authorized model grid's source URL, version, checksum, licence,
   dimensions, coverage, spacing, axes, units, sign, NoData, and interpolation
   method. Confirm whether a consumer may redistribute or modify it.
2. Identify authoritative source/target vertical CRS, horizontal frame, and
   applicable epoch for each model. Establish a verified horizontal operation
   into the grid reference frame; WGS 84 labels alone are not enough for a
   different realization or epoch.
3. Obtain authorized NGII sample outputs and independent national-control-point
   fixtures across urban, mountainous, coastal, and island areas. Record
   provenance, coordinate/height CRS, model version, accuracy, and tolerance.
4. Measure real-world height residuals against official controls and report
   sample count, RMS, median, 95th percentile, maximum, and limitations. Do not
   treat KNGeoid24's published 2.30 cm model precision as end-to-end accuracy.
5. Compare model-specific JavaScript and Rust/WASM outputs; document the
   interpolation and floating-point tolerances separately from model accuracy.
6. Run an offline browser smoke test using a legally supplied grid and verify
   corrected bounds, picking, cancellation, cache invalidation, and memory at
   representative point batches.

Until those gates are met, EGM2008, KNGeoid24, and KNGeoid18 remain unsupported
as model-specific conversion paths. No global or Korean model is selected
automatically. Users may load an independently documented GTX only when they
verify its metadata and the source COPC meets the WGS 84 horizontal-frame
restriction.

## Sources

- [NGS: Converting GPS Height into NAVD88 Elevation with the GEOID96 Geoid Height Model](https://www.ngs.noaa.gov/PUBS_LIB/gislis96.html)
- [MOLIT / NGII: 2024 National Geoid Model announcement](https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=95090271&lcmspage=52)
- [Public Data Portal: NGII KNGeoid18 grid record and terms](https://www.data.go.kr/data/15122553/fileData.do)
- [NGA Office of Geomatics: EGM2008 data and grid](https://earth-info.nga.mil/index.php?action=geoid&dir=wgs84)
- [NGA GeoGRAV: current EGM data export and interpolation application](https://earth-info.nga.mil/geograv)
- [GDAL GTX driver documentation](https://gdal.org/en/stable/drivers/raster/gtx.html)
- [GDAL GTX reader implementation](https://raw.githubusercontent.com/OSGeo/gdal/master/frmts/raw/gtxdataset.cpp)
- [PROJ: vertical grid shift operation and supported grid formats](https://proj.org/en/stable/operations/transformations/vgridshift.html)
- [EPSG Geodetic Parameter Registry](https://epsg.org/)

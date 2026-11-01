# Issue #244: Vertical CRS and geoid-grid decision

**Status:** Caller-supplied offline GTX conversion and the pinned NGA EGM2008
2.5-minute profile are implemented for the supported WKT1/WKT2 compound
subset. WKT2 compound CRS behavior has a TypeScript/Rust differential fixture.
The profile matches official grid-node and bilinear reference values, but no
independent survey/control-point accuracy is claimed. GEOID18 is not applied to
Autzen because its source frame and coordinate epoch are unspecified;
KNGeoid24 remains unsupported pending verified file, CRS/frame, interpolation,
numerical-reference, and reuse evidence.
**Reviewed:** 2026-10-27.
**Scope:** Explicit orthometric-to-ellipsoidal conversion for COPC point heights.

Issue [#244](https://github.com/mors119/copc-adapter/issues/244) asks whether
COPC Adapter can safely convert known vertical datums with geoid grids. The
implementation includes an opt-in offline GTX reader, a pinned NGA EGM2008
grid decoder, and a shared height sampler. This record documents the official
source material, numerical comparisons, implementation limits, and remaining
evidence gaps for EGM2008 and KNGeoid24.

## Decision

Keep the current default as no vertical-datum transformation. Do not infer a
Korean vertical datum from country, horizontal CRS, coordinate values, or
visible Cesium terrain. Keep `heightOffsetMeters` as the caller's explicit
uniform correction from issue #237.

The generic path accepts one caller-supplied GTX file with explicit source and
target vertical CRS metadata, a file SHA-256, units, sign convention, NoData
declaration, and interpolation rule. A separate model-specific loader accepts
only the exact NGA EGM2008 2.5-minute small-endian file identified by a pinned
SHA-256. That profile fixes EGM2008 height EPSG:3855 to WGS 84 ellipsoidal
height EPSG:4979, samples WGS 84 longitude/latitude, and uses bilinear
interpolation. Both paths require a supported compound source CRS with WGS 84
horizontal datum/ellipsoid and an explicit vertical CRS, and target ellipsoidal
height EPSG:4979. Supported shapes include WKT1 `COMPD_CS` with `GEOGCS` or
`PROJCS` plus `VERT_CS`, and WKT2 `COMPOUNDCRS` with `GEOGCRS` or `PROJCRS`
plus `VERTCRS`. WKT2 units are read from the declared coordinate axes, and
explicit east/west and north/south axis order is normalized before projection.
This is a constrained subset, not general WKT2 or PROJ support. Unknown axis
directions, incompatible frames, unsupported projections, missing epochs, and
unrecognized syntax fail closed. The library does not bundle or download
EGM2008 or a Korean NGII grid. The caller must obtain the EGM2008 file from
NGA and extract it locally. A requested conversion fails on missing or
ambiguous CRS metadata, a missing/invalid grid, NoData, or a coordinate
outside coverage; it never renders that point as uncorrected.

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
of `N`, not a regional constant. EPSG's Geographic3D to GravityRelatedHeight
(EGM2008) operation supplies the forward ellipsoidal-to-gravity-related
operation; the inverse gives `h = H + N`. NOAA's National Geodetic Survey also
describes this relationship and warns that height datums can differ in their
definitions ([height relationship](https://www.ngs.noaa.gov/PUBS_LIB/gislis96.html)). A
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
| EGM2008 | EGM2008 gravity-related height (EPSG:3855) | WGS 84 ellipsoidal height (height component of EPSG:4979) | Implemented only for the pinned NGA 2.5-minute WGS84 Tide-Free small-endian grid. The source compound WKT must identify EPSG:3855 and a supported WGS 84 horizontal CRS. The adapter does no frame or epoch propagation and is not Korea's national height datum. |
| KNGeoid24 | Korean national orthometric height represented by the NGII model | The ellipsoidal height/frame used by the corresponding GNSS observations and model | NGII confirms the model converts GNSS ellipsoidal heights to Korean elevations and publishes KNGeoid24 as its current model. The accessible product metadata does not establish the exact file's CRS identifier, ellipsoid/frame realization, epoch, grid encoding, interpolation rule, or redistribution terms. Do not claim an EPSG pair or apply it to arbitrary WGS 84-labelled heights until those details are verified with the model file and NGII documentation. |
| KNGeoid18 | Historic Korean national orthometric height represented by KNGeoid18 | The ellipsoidal height/frame used by that model | Treat as an explicitly versioned legacy operation. NGII's current release recommends its latest model for new surveys. The public data record also restricts third-party transfer without permission and marks the data Attribution-NoDerivatives; it is not approved for bundling or conversion into distributed derivative grids. |

## Issue #322: Autzen NAVD88 validation gate (checked 2026-10-27)

The reviewed source-shape and operation support is:

| Source shape or operation | Metadata / horizontal path | Vertical conversion | Evidence and status |
| --- | --- | --- | --- |
| Real Autzen WKT1 `COMPD_CS`: EPSG:2992 + EPSG:6360 NAVD88 | Parsed; offline Rust and TypeScript horizontal controls agree | GEOID18 is not registered for this source | Unsupported pending realization and epoch evidence; header Z range and US survey-foot unit are recorded below |
| WKT2 standalone `PROJCRS` for UTM zone 11N | Parsed and transformed with east/north axes | None | Offline Rust/TypeScript control fixture passes |
| Synthetic WKT2 `COMPOUNDCRS`: north/east `PROJCRS` + EPSG:3855 `VERTCRS` | Axis order, declared linear units, and compound horizontal component are parsed | Existing EGM2008 operation with a synthetic 10 m grid | Native Rust, TypeScript, and browser Rust/WASM horizontal controls agree; browser also checks the TypeScript synthetic-grid forward/inverse round trip |
| EPSG:5186 KGD2002 / Central Belt 2010 | Existing horizontal transform fixture passes | Height datum remains local/unknown without a vertical CRS | Horizontal support only; no Korean vertical operation is registered |
| WKT2 axes outside east/west and north/south cardinal pairs | Rejected | Rejected before grid sampling | Structured unsupported-axis error; no axis direction is guessed |
| KNGeoid24 | Metadata and exact source frame remain unverified | No operation registered | Deferred; no EPSG pair or distributable grid is claimed |

The synthetic WKT2 grid row validates the conversion pipeline, axis handling,
and browser/runtime parity; it is not a model accuracy check. The existing
NGA EGM2008 profile retains its separate official-grid control evidence.

The first prioritized validation target is the public Autzen COPC. The existing
CRS fixture retains its real compound WKT, and now also records the values read
from the LAS 1.4 header. The object is 81,123,042 bytes with SHA-256
`db2d56cdfa058bffccdc5d6019dae2fc9c6a551df10a5523c06c76a3e25a27fa`, as
declared in the repository sample registry (`samples/datasets.json`). An HTTP
Range response for bytes `0-65535` returned `206` with that total size.

The header reports scale `0.01` for XYZ; Z offset `510.7`; and source Z bounds
`406.14`–`615.26`. The real WKT declares horizontal EPSG:2992 (NAD83 / Oregon
GIC Lambert, international-foot projected axes) and vertical EPSG:6360
(NAVD88 height, US survey foot, unit factor `0.304800609601219`). Applying that
explicit vertical unit factor to the header range gives `123.7917196`–
`187.5316231` m. The values remain NAVD88 orthometric heights after unit
conversion. The expanded header fixture is in
`crates/crs-audit/src/fixtures.json`.

The source horizontal WKT identifies EPSG datum EPSG:6269 (generic NAD83); it
does not identify a NAD83 realization or coordinate epoch. NOAA states that
GEOID18 must be used with NAD83(2011) epoch 2010.0 ellipsoidal coordinates and
that other NAD83 realizations are incompatible without conversion. Therefore,
the metadata is not enough to establish the required GEOID18 input frame or
the horizontal conversion into the grid's sampling frame. No source survey
epoch or independent Autzen control point was found in the COPC header/WKT.

The official NOAA GEOID18 `g2018u1.bin` grid is obtainable and covers Autzen's
region. The downloaded file was 4,933,728 bytes, SHA-256
`92d8960a11a6867903a34ab079883071f2c69798cbb8c8bd9249623bb78e48d3`. Its
official readme describes a little-endian float32 grid with header
`(40, 230, 1/60, 1/60, 1081 rows, 1141 columns, kind 1)`, ordered from the
southwest corner eastward then northward. At the official grid-check node
45°13′N, 122°46′W, local decoding returns `−23.0760002` m; NOAA's published
check value is `−23.076` m. This verifies the downloaded file's node
orientation and sample value at that control, but it does not prove that the
Autzen source is in the required NAD83(2011) frame.

The NGS Geoid API returns `−23.342` m with an `error` field of `0.034` m at the
Autzen location computed from the existing projection fixture
(`44.0563024781°N, 123.0664124403°W`). This location-only response is retained
as a reference query, not as a valid source-to-grid operation or an independent
survey comparison: its input coordinate frame is not established by the
Autzen WKT. Applying `h = H + N` to Autzen now would silently assume that the
source coordinates match GEOID18's required NAD83(2011) epoch 2010.0 input.

**Decision:** keep NAVD88 unsupported for Autzen until its source realization
and coordinate epoch, or a documented transformation from them to NAD83(2011)
epoch 2010.0, is established and validated. Do not substitute WGS 84 or the
current adapter output label for that frame operation. The GEOID18 grid is
available; the unresolved item is a verified compatible source/target pair
and the required horizontal frame conversion. The WKT2 work in this change
expands parsing and transform coverage for the already supported EGM2008
profile; it does not add GEOID18 or KNGeoid24 to the runtime operation registry.

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
the interpolation archive as 128 MB. The [EPSG registry entry for EGM2008
height](https://epsg.org/crs_3855/EGM2008-height.html) defines the zero-height
surface by applying EGM2008 to the WGS 84 ellipsoid. The NGA page, archive
README, and model PDF inspected for this work contain no explicit grid
redistribution or modification licence. Free public download alone is not
treated as permission for COPC Adapter to bundle or redistribute it.

### Official access and metadata findings (reviewed 2026-10-22; rechecked 2026-10-27)

**Rechecked 2026-10-27:** NGA's current page still lists the 2.5-minute
interpolation archive and GeoGRAV service. NGII's 2025 English brochure
confirms that KNGeoid24 was developed in 2024, but does not publish the model
file or its technical CRS metadata. The accessible Public Data Portal record
is specifically for KNGEOID18 (modified 2025-06-21); its Type 3 terms do not
establish KNGeoid24 reuse rights. The exact KNGeoid24 file and its terms remain
unverified.

- **KNGeoid24:** the MOLIT release says the model is available free through
  the National Land Information Platform, but the release does not link the
  exact product record or document a click/API sequence, authentication
  requirement, or a file download. The exact KNGeoid24 grid was not obtained.
  Its horizontal CRS/frame, vertical CRS identifier, height reference/epoch,
  encoding, resolution, units, sign, NoData, interpolation, and reuse terms
  therefore remain unverified. Do not infer them from the model name or the
  separate KNGeoid18 record.
- **EGM2008 archive and access (checked 2026-10-22):** the official download
  link resolves to
  [`https://earth-info.nga.mil/php/download.php?file=egm-08interpolation`](https://earth-info.nga.mil/php/download.php?file=egm-08interpolation),
  named `EGM2008_Interpolation_Grid.zip`. The downloaded archive was 134,295,643
  bytes (SHA-256 `0f65f16e6fd3f89a6b8022d7a89375d0c29fb275a551927175669bb610904cd0`);
  `unzip -t` passed. It contains the interpolation source and executable,
  sample `INPUT.DAT`/`OUTPUT3.DAT`, `Readme.txt`, `README_WGS84_2.pdf`, and the
  149,368,328-byte raw member
  `Und_min2.5x2.5_egm2008_isw=82_WGS84_TideFree_SE`. The downloaded archive has
  no separate published checksum. No executable from the ZIP was run.
- **EGM2008 model and CRS:** NGA's 2008 WGS 84 product is a worldwide
  2.5-arc-minute point grid precomputed from EGM2008 to degree/order 2190 with
  the zeta-to-N conversion expansion to degree 2160. Its values are geoid
  undulations in metres relative to the WGS 84 ellipsoid, in the Tide-Free
  permanent-tide system. The grid axes are WGS 84 geodetic latitude/longitude.
  EPSG:3855 is EGM2008 gravity-related height; EPSG:4979 is WGS 84 geographic
  3D with ellipsoidal height. The model is global and is not interchangeable
  with Korea's national vertical datum.
- **Binary layout inspected:** the `_SE` member is not GTX. It has 4,321 north-
  to-south latitude records, each containing 8-byte little-endian Fortran
  record markers around 8,640 little-endian IEEE float32 values. Each row's
  marker value is 34,560 bytes. Columns run west-to-east from 0° through
  359°57.5′; the 0° value is not duplicated at 360°. Grid points are at
  2.5-minute spacing from 90°N to 90°S, inclusive (4,321 × 8,640 =
  37,333,440 values). The official PDF says all land and ocean nodes are valid.
  The complete downloaded file was scanned: every marker matched, every value
  was finite, and no `9999` sentinel occurred. Its observed range is
  −106.9087296 m to +85.8237839 m.
- **Interpolation:** NGA's `interp_2p5min.f` describes its `BILIN` routine as
  bilinear. The sample executable sets a six-point spline window, so its
  off-grid sample output is not a bilinear reference. The [current GeoGRAV
  application](https://earth-info.nga.mil/geograv) exposes an explicit
  `lerpType=bilinear` point service. The implementation uses ordinary
  bilinear interpolation over the pinned grid; it does not implement NGA's
  six-point spline mode. NGA's `Readme.txt` says its supplied interpolation
  program agrees with harmonic-synthesis results within 1 cm. That statement
  describes interpolation against the harmonic model, not survey accuracy or
  a guarantee of point-cloud height accuracy.
- **Frame, epoch, and licensing:** the grid is documented for WGS 84 geodetic
  coordinates and the Tide-Free permanent-tide system. The inspected file and
  documentation do not state a coordinate observation epoch or a WGS 84 frame
  realization/epoch propagation procedure. The `2005` value in the WKT1
  `VERT_DATUM` is a datum-type code, not a coordinate epoch. The adapter
  requires source WKT matching its supported WGS 84 horizontal CRS and does
  not perform epoch or frame propagation. No explicit redistribution or
  modification permission was found in the official download page, archive
  README, or PDF. The grid is not committed or bundled; only the locally
  computed checksum and reference numbers are recorded.
- **GTX:** the generic provider still accepts caller-documented GTX files.
  The separate EGM2008 loader directly decodes this one fixed NGA format into
  the shared grid sampler. It rejects other grid shapes/layouts and does not
  select EGM2008 automatically.

### Coverage and memory estimates

The inspected EGM2008 file is 149,368,328 bytes (142.45 MiB) including Fortran
record markers. Its float32 samples occupy 149,333,760 bytes (142.42 MiB).
That is the model's sample-storage size, not a measured peak for its separate
NGA-format decoder. The generic GTX loader now creates its decoded typed-array
view over its owned input buffer after checksum verification, so it does not
allocate a second sample-sized array. A mutable `ArrayBuffer` or typed-array
input is still copied before verification; if the caller retains that source,
the caller-owned buffer remains an additional allocation. See the measured
GTX loader results below. The NGA-format loader was not benchmarked here.

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
  Network URLs are not accepted. The NGA loader verifies the pinned file
  digest and binary layout; callers remain responsible for lawful acquisition
  and compatible COPC metadata. The generic GTX caller remains responsible for
  its grid metadata. The adapter does not persist or forward grid data.
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
- Loading the pinned EGM2008 grid scans 37,333,440 samples on the caller's
  thread, but yields to the event loop after each 16 latitude rows (138,240
  samples) instead of running the full decode as one long task. This improves
  responsiveness; it is not a Worker offload or a measured performance claim.
- HTTP Range COPC reads, hierarchy requests, point budgets, node cancellation,
  decoded cache, and LOD selection continue through existing paths. Prepared
  corrected data follows the core cache lifecycle; unload/reload rebuilds it
  from original source coordinates and does not apply the grid twice. The grid
  is not downloaded per point or chunk.

## Implemented API and failure semantics

The public API has two explicit loading paths. Caller-documented GTX grids use
`loadGtxGeoidGrid`; the pinned NGA file uses `loadNgaEgm2008Grid`:

```ts
const grid = await loadGtxGeoidGrid(file, {
  gridId: "documented local grid/version",
  sourceVerticalCrs: "exact outer EPSG authority, or WKT name without authority",
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

For the NGA profile, provide the extracted small-endian file as a local
`File`/`Blob` or byte buffer. The loader verifies the pinned SHA-256 and the
exact 4,321 × 8,640 sequential record structure; it supplies the documented
EPSG:3855 → EPSG:4979, WGS 84, metre, `h - H`, and bilinear settings itself.
The COPC compound WKT must still identify that vertical CRS and the supported
WGS 84 horizontal frame. The helper does not make any CRS inference from
coordinates or country.

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

When WKT declares an outer EPSG vertical CRS authority, `sourceVerticalCrs` must
use its matching EPSG code; name matching is accepted only when the WKT has no
outer authority. Other authority namespaces are not currently configurable. An
explicitly declared vertical axis must be `UP`. Horizontal WKT
accepts the documented ESRI `D_WGS_1984` datum alias only with the validated
WGS 84 ellipsoid parameters ([Esri coordinate system reference](https://pro.arcgis.com/en/pro-app/2.9/help/mapping/properties/pdf/geographic_coordinate_systems.pdf)).

Grid sampling happens after horizontal projection and before ECEF preparation.
The corrected height drives display, inspection, ECEF, hierarchy/elevation
bounds, metadata bounds, camera queries, and fly-to calculations. Bounds expand
conservatively by the grid's decoded global minimum/maximum undulation.
Rust/WASM and JavaScript share the TypeScript grid sampler after backend
preparation and therefore use the same axes, interpolation, edge, NoData, sign,
and failure rules.

## EGM2008 numerical verification (2026-10-22)

The downloaded NGA raw `_SE` member was loaded through `loadNgaEgm2008Grid`
without conversion to a second on-disk format. The pinned extracted-file
SHA-256 is
`ab6f8b94076f78707d1cdae7b066b93a786a0c64b52449e20cf1a1a2f4e74daf`.
The loader reported 4,321 rows × 8,640 columns, 2.5-minute spacing, a
149,368,328-byte encoded file, a 149,333,760-byte decoded array, and the same
minimum/maximum values found by an independent full-file scan.

The official archive's `INPUT.DAT`/`OUTPUT3.DAT` pair includes the grid-node
results `37°N, 241°E → −26.151 m`, `37°N, −119° → −26.151 m`, and
`90°S, 0° → −30.150 m`, rounded to 0.001 m. The NGA loader returned
−26.150882720947266 m at 37°N/241°E and −30.14996910095215 m at 90°S/0°.
These agree at the published output precision and verify row orientation,
node indexing, sign, and longitude equivalence across 360°.

For off-node bilinear checks, the current NGA GeoGRAV service was queried with
`lerpType=bilinear` at San Francisco (longitude −122.4194°, latitude
37.7749°) and London (−0.1278°, 51.5074°). Both geoid signs were represented:

| Location | NGA GeoGRAV `bilinear` `gh` | Local EGM2008 grid | Difference |
| --- | ---: | ---: | ---: |
| San Francisco | −32.16355837944838 m | −32.16355837237304 m | +7.08×10⁻⁹ m |
| London | +46.09014668485165 m | +46.09014668810544 m | +3.25×10⁻⁹ m |

The recorded comparison tolerance is 0.000005 m, derived from the maximum
half-ULP of the file's float32 values (the inspected data range is within
±107 m); it is a representation and comparison tolerance, not a geodetic
accuracy claim.

At San Francisco, the arithmetic check `H=100 m`, `N=−32.16355837944838 m`
gives `h=67.83644162055162 m`. The local grid path returned
67.83644162762695 m, then `heightOffsetMeters=2` produced 69.83644162762695 m;
the inverse query recovered `H=100 m`. This is an equation and integration
check using a chosen input height, not a surveyed control point or authoritative
ellipsoidal-height observation. The existing synthetic regression continues
to check #237 offset-only behavior, and the shared sampler remains the single
JavaScript/Rust-WASM preparation path.

The official bundled off-node sample at 36°N/242.983333°E reports −29.171 m
from the shipped executable, whose source configures a six-point spline
window. The generic path intentionally implements bilinear interpolation, so
that spline result is not used as a bilinear acceptance value. The GeoGRAV
bilinear comparisons above are separate from the NGA statement that the
shipped interpolation program matches harmonic synthesis within 1 cm; no
model accuracy or survey/control-point validation is claimed here.

### Remaining model limits

- The exact NGA 2.5-minute grid and bilinear calculation are supported for
  EGM2008 gravity-related height (EPSG:3855) to WGS 84 ellipsoidal height
  (EPSG:4979), only when the source horizontal CRS meets the library's WGS 84
  restriction. EGM2008 is not Korea's national height datum.
- The model files identify WGS 84 geodetic axes and the Tide-Free permanent-
  tide system. They do not provide a source-coordinate epoch or a frame
  realization/epoch propagation operation. No propagation is performed.
- No independent survey/control points were tested. The comparison proves
  agreement with official model samples and the NGA bilinear service at these
  coordinates, not physical accuracy for an arbitrary COPC dataset.
- NGA's accessed page and archive materials do not include explicit
  redistribution/modification terms. The grid is therefore absent from the
  repository and package. The loader accepts only local user-supplied data.
- KNGeoid24 remains unsupported. Its exact grid, CRS/frame/epoch, format,
  interpolation, and redistribution terms were not obtained or verified.

The generic synthetic tests establish GTX header decoding, checksum failure,
interpolation, positive/negative shifts, unit conversion, boundaries,
antimeridian wrapping, NoData, CRS/epoch failures, inverse height math,
manual-offset composition, source immutability, conservative bounds, reload
behavior, and Rust/WASM versus JavaScript prepared ECEF parity. Synthetic
results do not establish model accuracy.

### Current EGM2008 adapter validation (2026-10-22)

- `cd packages && npm run typecheck` — passed.
- `cd packages && npm test` — passed, 492/492 tests, no skips; includes the
  Rust/WASM release build before the package test suite.
- `cd packages && npm run build:library` — passed; browser bundles, WASM assets,
  and TypeScript declarations built.
- `npm run docs:build` — passed.
- `npm run test:pack` — passed, 18/18 Chromium scenarios across root
  production, explicit Cesium production, and root development consumers
  (6/6 in each mode).
- `npm run test:pack:three` — passed; a clean packed Three.js consumer built.
- `git diff --check` — passed.
- Local official NGA raw-grid load — passed; pinned checksum, record markers,
  dimensions, full-sample finiteness, official node outputs, GeoGRAV bilinear
  references, forward/inverse height conversion, and frame rejection were
  checked as recorded above. No model data is part of CI or the package.

### Generic GTX PR baseline validation (historical, 2026-10-21)

- `cd packages && npm run typecheck` — passed.
- `npm test -w @frillab/copc-adapter` — passed, 487/487 tests, no skips; prepares the
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

These checks validate the generic implementation and package integration.
The local NGA validation above used a user-supplied official grid outside
ordinary CI; no network download or grid is required by the test suite.

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

The measured NGA file is float32. Its encoded record file and decoded sample
array are each below the default 256 MiB cap. The NGA-specific loader's actual
peak and retention were not measured in this benchmark. A hypothetical
float64 sample array would exceed the default per-representation cap and is
not accepted by the model-specific loader.

### GTX memory and browser streaming measurements (2026-10-22)

Reproduce the Node measurements with:

```sh
npm run benchmark:vertical-grid -w @frillab/copc-adapter
```

The script generated constant 25 m GTX files under the OS temporary directory
and removed them after each run. They are synthetic workload fixtures, not
geoid models or geodetic validation. Cold loads used a fresh Node child process
and a file-backed `Blob`; warm point batches were prepared with and without a
loaded grid. There were seven repetitions for the 361 × 181 and 2048 × 1024
grids, three for the 8640 × 4321 grid, two warmups, and 250,000 points for the
interpolation-only measurement. p95 uses nearest rank, so for three samples it
is the maximum observed value.

Environment: Node v26.7.0, macOS 26.6.2 (Darwin 25.6.0, build 25G83), Apple M2
arm64, 8 logical CPUs, 8 GiB RAM. Timing uses `performance.now()`. Memory uses
`process.memoryUsage().arrayBuffers` and `process.resourceUsage().maxRSS`; the
latter is reported by this Node/macOS build in KiB and is converted to bytes.
Its unit was cross-checked against `ps -o rss=`. Peak RSS is a process
high-water mark; array-buffer values are process deltas at the listed sample
point.

| Synthetic GTX | Encoded / decoded bytes | Cold load median (p95) | Peak RSS increase median | ArrayBuffers delta at loader return | Warm 250k transform without / with grid | Interpolation-only 250k |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 361 × 181 | 261,404 / 261,364 | 3.73 ms (4.39 ms) | 1,114,112 B | 522,824 B | 69.49 / 80.63 ms | 11.99 ms |
| 2048 × 1024 | 8,388,648 / 8,388,608 | 30.11 ms (38.12 ms) | 24,051,712 B | 16,777,312 B | 67.17 / 78.99 ms | 11.21 ms |
| 8640 × 4321, EGM-shaped synthetic | 149,333,800 / 149,333,760 | 430.63 ms (504.15 ms) | 447,791,104 B | 298,667,616 B | 69.40 / 78.81 ms | 10.88 ms |

The large GTX case is close to the NGA sample count, but it is a different,
constant-valued file and does not exercise the NGA Fortran-record decoder. Its
measured loader-return `arrayBuffers` delta and peak RSS increase are each
about 142 MiB lower than the pre-optimization run. Before the change, the
loader-return delta was 448,001,376 B and median peak RSS increase was
583,184 KiB (597,180,416 B after unit conversion); after the change these were
298,667,616 B and 447,791,104 B. This is one grid-sized allocation removed.
Cold-load medians were 444.15 ms before and 430.63 ms after (three samples per
run); this difference is not presented as a speed improvement. After dropping
the grid reference and collecting garbage, the final process ArrayBuffers
delta was 16 B. A 250,000-point batch increased ArrayBuffers by about 3.43 MiB
in the earlier measurement; the benchmark continues to include output-buffer
allocations in preparation timings.

The warm point-preparation median difference at 250,000 points was 9.41 ms
(78.81 ms with grid versus 69.40 ms without, about 13.6%). The isolated
interpolation median was 10.88 ms for 250,000 samples. A candidate that removed
temporary interpolation objects was measured but reverted because repeated
Node runs did not show a reproducible improvement. No streaming, cache, or
shared-memory architecture was added.

The browser workload uses the local Autzen sample; download it once if it is
absent:

```sh
npm run download-samples -- autzen
```

Then run the benchmark:

```sh
npm --prefix apps/dev-viewer run benchmark:vertical-grid
```

This opt-in Playwright benchmark used three repetitions per scenario, in
alternating order, each in a new browser context. It served the local Autzen
COPC (81,123,042 bytes) through a deterministic HTTP Range route, enabled the
Rust/WASM backend and four decode Workers, and compared correction disabled
with a synthetic 2048 × 1024 constant 25 m GTX. It captured time to first
visible points, initial range-stream settle, camera-motion observation,
same-layer reload, worker `ready` messages, preparation stages, CDP V8 heap
and backing storage, sampled aggregate Chromium process RSS, long tasks, and
frame gaps. Browser: HeadlessChrome 155.0.8059.85, Playwright's configured
Chromium build, on the same Apple M2/macOS environment. With three samples,
reported p95 is the maximum observed value.

| Browser metric | Correction disabled | Synthetic grid enabled |
| --- | ---: | ---: |
| First visible median (p95) | 1,857 ms (2,389 ms) | 2,248 ms (2,483 ms) |
| Load and initial settle median (p95) | 7,945 ms (10,095 ms) | 8,441 ms (8,504 ms) |
| Same-layer reload settle median (p95) | 5,391 ms (6,150 ms) | 5,474 ms (6,239 ms) |
| Vertical CRS stage median (p95) | 0 ms | 31.7 ms (32.8 ms) |
| Grid checksum/decode median (p95) | n/a | 16.7 ms (17.9 ms) |
| Worker ready median (24 observations) | 333.6 ms (435.7 ms) | 378.5 ms (497.0 ms) |
| Rendered points / nodes after initial settle | 233,383 / 8 | 233,383 / 8 |

The browser's wall-clock and first-visible distributions overlap and vary
substantially; these three repetitions do not establish a reliable end-to-end
slowdown. The geoid stage was measured separately at 30.0–32.8 ms for the
streamed point set, while the same requests, rendered-point count, and node
count were observed in both scenarios. Reload added nine range requests in
this setup, reused cached points, and created four replacement Workers after
terminating the original four; this is an observation of the existing reload
path, not a proposed optimization. The Worker pool does not receive or copy the
grid; geoid sampling follows the Rust prepared-point path in shared TypeScript.
The grid checksum/decode row was remeasured after moving benchmark-only
expected-checksum generation outside the timed loader call; its three samples
were 16.0, 16.7, and 17.9 ms. Other rows retain the original run's samples.

Browser memory must be interpreted cautiously. Immediately after the
8 MiB-grid load, CDP backing-storage accounting increased by about 16 MiB
before collection, consistent with temporary source/snapshot storage. After
explicit garbage collection the observed delta varied as other viewer
buffers were collected; after layer destruction, grid release, and another
collection, page backing storage was within roughly 6 MiB of the pre-grid
snapshot. Sampled aggregate Chromium RSS varied by 134–431 MB even without
correction and cannot be attributed to the grid. This harness does not expose
Worker-specific memory; no Worker memory figure is claimed. Main-thread Long
Task/frame observations span the whole Cesium/SwiftShader scenario and are not
attributed to geoid work.

The EGM2008 grid's 142.42 MiB decoded sample size is a known data-size fact.
The large synthetic GTX run provides a sizing measurement for this GTX path,
not an observed EGM2008 load or a peak-memory prediction for the separate NGA
decoder. No real geoid model or authoritative geodetic sample was used in
these performance runs.

### Issue #323: NGA sample storage and browser scheduling (2026-10-26)

The NGA loader now keeps its verified private byte snapshot as the sample
backing store. On little-endian hosts it creates one typed-array view per NGA
row and maps south-to-north grid row lookups onto the north-to-south source
rows. This preserves the caller snapshot and the SHA-256 check while avoiding
the additional 149,333,760-byte decoded sample allocation. The generic GTX
loader keeps its existing in-place decode path.

The check used the official extracted NGA raw member, whose SHA-256 matched the
pinned digest above. Reproduce the post-change Node run with:

```sh
COPC_VERTICAL_GRID_SAMPLES=3 \
COPC_NGA_EGM2008_FILE=/path/to/Und_min2.5x2.5_egm2008_isw=82_WGS84_TideFree_SE \
npm run benchmark:vertical-grid -w @frillab/copc-adapter
```

The existing script runs synthetic GTX float32 sizes and, when the NGA path is
set, the exact sequential EGM2008 file in fresh child processes. NGA scenarios
cover a file-backed `Blob`, a mutable `ArrayBuffer`, two layer references to
one shared grid object, and two independent grid loads. Each scenario has three
cold repetitions and nine 250,000-sample interpolation timings. The two-layer
case measures grid retention only; it does not include separate layer caches,
point buffers, or renderer resources.

For a before run, the same benchmark driver can run against the core source at
base commit `ad5104ea281fe632d4355c3cd64591599099e9df`:

That historical commit stored Adapter under `packages/core`. The commands
below archive that original path, then stage the source under the current
`packages/adapter` package layout so the moved benchmark driver resolves the
repository root correctly.

```sh
BASE=/tmp/copc-adapter-issue-323-before
mkdir -p "$BASE/packages/adapter/scripts"
git archive ad5104ea281fe632d4355c3cd64591599099e9df packages/core | tar -x -C "$BASE"
mv "$BASE/packages/core" "$BASE/packages/adapter/core"
cp packages/adapter/scripts/vertical-grid-performance-benchmark.mjs "$BASE/packages/adapter/scripts/"
cp packages/adapter/package.json "$BASE/packages/adapter/"
ln -s "$PWD/node_modules" "$BASE/node_modules"
COPC_VERTICAL_GRID_SAMPLES=3 \
COPC_NGA_EGM2008_FILE=/path/to/Und_min2.5x2.5_egm2008_isw=82_WGS84_TideFree_SE \
npm --prefix "$BASE/packages/adapter" run benchmark:vertical-grid
```

On Node v26.12.1, macOS 26.6 (Darwin 25.6), Apple M2 arm64, 8 logical CPUs,
and 8 GiB RAM, the 142.42 MiB sample array produced these median
`process.memoryUsage().arrayBuffers` deltas:

| NGA input and retained grids | At loader return before → after | After explicit GC before → after |
| --- | ---: | ---: |
| `ArrayBuffer`, one grid | 298,702,088 → 149,368,328 B | 149,333,760 → 149,368,328 B |
| `ArrayBuffer`, two references sharing one grid | 298,702,088 → 149,368,328 B | 149,333,760 → 149,368,328 B |
| `ArrayBuffer`, two independent grids | 448,035,848 → 298,736,656 B | 298,667,520 → 298,736,656 B |
| File-backed Node `Blob`, one grid | 298,702,104 → 298,736,672 B | 149,333,776 → 149,368,344 B |

For the one-grid `ArrayBuffer` case, the live ArrayBuffer delta at loader return
fell by exactly one logical sample array (149,333,760 B, 142.42 MiB). Two
references to the same immutable grid retained one unique grid object. Two
independent loads retained two grids; their return-time delta fell by one
sample array. After collection, retained memory remains one encoded snapshot
per unique grid, with 34,568 bytes of NGA row markers beyond the logical sample
size. In this Node version, the file-backed `Blob` did not show the same
return-time reduction; the browser `File` path is measured separately below.

The `ArrayBuffer` one-grid load median was 1,003 ms before and 732 ms after;
the three runs were 993–1,014 ms before and 645–746 ms after. The `Blob`
one-grid median was 1,030 ms before and 791 ms after. This local CPU profile
shows the direct little-endian row reads and conditional extrema checks
reduced cold scan time; three runs do not establish a cross-device speedup.
The one-grid `ArrayBuffer` interpolation median was 18.97 ms before and
15.52 ms after for 250,000 samples, with overlapping nine-sample tails, so no
general interpolation improvement is claimed. Two independent `ArrayBuffer`
loads measured 1,768 ms before and 1,570 ms after in total. Process high-water
RSS also varied and did not consistently track the ArrayBuffer delta. RSS
includes V8, native Web Crypto, and process memory outside the grid; it is not
attributed to the loader. GPU memory is not involved in the CPU grid storage
and is not observable through this benchmark.

The browser harness can load the exact local NGA file as either a `Blob` or an
`ArrayBuffer`, record load duration, Long Tasks, animation-frame gaps, timer
delay during loading, and 250,000-sample interpolation, then assert the pinned
digest and published bilinear reference. Run it with:

```sh
COPC_NGA_EGM2008_FILE=/path/to/Und_min2.5x2.5_egm2008_isw=82_WGS84_TideFree_SE \
npm --prefix apps/dev-viewer run test:e2e -- e2e/vertical-grid.spec.ts --grep "pinned NGA EGM2008"
```

This browser check observes main-thread scheduling while the loader's existing
bounded row loop yields every 16 rows. It does not move digest or row validation
to a Worker. The grid is not copied to decode Workers, GPU memory is not
measured as geoid storage, and `performance.measureUserAgentSpecificMemory`
is reported only when the browser exposes it. The exact-grid check streams
from a local HTTP server, so it does not measure an external network or time to
first rendered COPC points. The existing Cesium streaming benchmark still
measures first-visible points, reload, frame gaps, and worker startup with an
8 MiB synthetic GTX; it cannot stand in for a full EGM2008 browser load.

The exact-grid Chromium run passed in HeadlessChrome 155 on the same Apple M2
setup. It streamed the official 149,368,328-byte file from a local HTTP server
and used a blank browser fixture so a Cesium viewer and its GPU work were not
part of the measurement. In the final instrumented run, the Blob case measured
6 ms fetch, 219 ms body-to-Blob conversion, 1,658 ms loader time, and 16.1 ms
for 250,000 interpolations. The ArrayBuffer case measured 2.1 ms fetch,
354 ms body-to-buffer conversion, 1,858 ms loader time, and 21.4 ms for the
same interpolation batch. Both modes returned the pinned digest and the San
Francisco bilinear value above. The harness also timed 270 row-loop resume
chunks: the longest observed chunk was 1.4 ms for Blob and 4.5 ms for
ArrayBuffer. Long Task entries were 146 ms for Blob and 77 ms and 333 ms for
ArrayBuffer; maximum timer delays were 140 ms and 419 ms, and maximum
animation-frame gaps were 133 ms and 350 ms. The measured row chunks do not
account for those longer tasks. The browser profile does not isolate which
other loader operation caused them. It did not expose
`performance.measureUserAgentSpecificMemory`, and this direct loader harness
did not use decode Workers or render points. Its timings are a local
file-transfer and loader profile, not end-to-end startup latency.

The measured memory reduction is useful for mutable `ArrayBuffer` inputs, so
the shared row-view representation is retained. A Worker-backed loader,
transferable ownership mode, automatic cross-layer cache, and region/lazy
loading remain deferred. They need separate cancellation, teardown, concurrency,
stale-grid, package-worker, and format-random-access validation; the existing
shared immutable grid already avoids a second grid allocation when two layers
receive the same instance.

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

Remaining EGM2008 evidence and follow-up work:

1. The exact NGA grid and official model samples establish the tested EGM2008
   2.5-minute, Tide-Free, bilinear profile. They do not establish survey
   accuracy. Obtain independently surveyed points with compatible horizontal
   and vertical frames and epochs before making a control-point accuracy claim.
2. Confirm the applicable WGS 84 realization and observation epoch for a given
   COPC source. The current operation checks the WGS 84 datum name and ellipsoid
   but does not propagate epochs or transform between WGS 84 realizations.
3. Clarify NGA terms for redistribution or modification before bundling or
   publishing the model data or a derivative. The current loader uses only a
   caller-supplied local file and does not redistribute it.
4. Keep the EGM2008 profile pinned to its documented digest until NGA publishes
   a new grid and its format, sample outputs, and CRS profile are reviewed.
5. Obtain the exact KNGeoid24 product, authoritative CRS/frame/epoch and
   interpolation metadata, reuse terms, sample outputs, and compatible control
   points before implementing or claiming Korean national-datum support. The
   published 2.30 cm KNGeoid24 model precision is not end-to-end accuracy.

The pinned NGA EGM2008 grid is supported as an opt-in conversion from EGM2008
gravity-related height (EPSG:3855) to WGS 84 ellipsoidal height (EPSG:4979),
subject to the stated WGS 84 horizontal-CRS and no-epoch-propagation limits.
Official node samples and GeoGRAV bilinear outputs verify grid decoding,
orientation, sign, interpolation, and equation behavior at the listed points;
no independent survey/control-point accuracy is claimed. KNGeoid24 and
KNGeoid18 remain unsupported as model-specific conversion paths. No model is
selected automatically. The generic GTX provider still permits an operator to
supply a separately documented grid when its metadata and source COPC meet
the implemented CRS restrictions.

## Browser, Worker, and Cesium integration validation (2026-10-22)

The Playwright suite `apps/dev-viewer/e2e/vertical-grid-cesium-integration.spec.ts`
was run in headless Chromium with the repository's SwiftShader WebGL path. Its
fixture uses the Autzen COPC sample downloaded by the repository's existing
sample script and served from the repository by a range-aware test route. The
test rewrites only the sample's projection WKT VLR to label the horizontal CRS
as WGS 84 for the supported CRS-pair checks. Point records are unchanged, and
the resulting metadata combination is synthetic; it is not a geodetic
reclassification of the Autzen survey. Local runs need
`npm run download-samples -- autzen`; CI already downloads this sample.

The test creates tiny 4 × 4 GTX grids in memory with constant positive,
negative, and zero values. It checks grid opt-in/default behavior, the
`heightOffsetMeters` composition, source/displayed heights, WGS 84 ECEF
positions, bounding-sphere containment, `zoomTo`, actual Cesium point picking,
frustum culling and return to view, node reload, range loading, cache reuse,
source replacement, independent layers, layer disposal, and fail-closed
missing-grid, CRS-pair, and coverage errors. A real Rust/WASM worker queue is
also cancelled and worker termination on layer destruction is observed.

Three preparation paths were exercised in the browser: the default JavaScript
backend, Rust/WASM with a real Worker, and Rust/WASM with Worker creation
disabled. The Rust layer snapshots confirm the selected backend and whether a
Worker was created; the test does not accept JavaScript fallback as Rust
coverage. The suite also prepares the same decoded COPC node through JavaScript
and Rust independently, applies the same synthetic grid and offset, and checks
that source coordinates are exactly equal, height differences are below
0.01 m, and ECEF differences are below 0.05 m. Those are cross-implementation
regression bounds, not geodetic accuracy claims. The Cesium ECEF assertions
allow 0.02 m per component against `Cesium.Cartesian3.fromDegrees`; the observed
point is checked against the layer's bounding sphere with a 0.05 m margin.

The Three.js regression remains covered separately by the existing default
local ENU renderer browser test and the packed Three.js consumer build. Those
paths require no vertical CRS or grid. The clean packed-consumer tests also
exercise the root and explicit Cesium package entries.

Validation commands and results for this integration change:

- `npm --prefix apps/dev-viewer run test:e2e -- e2e/vertical-grid-cesium-integration.spec.ts --reporter=line`
  — passed, 3/3 browser scenarios in 2.1 minutes.
- `npm --prefix apps/dev-viewer run test:e2e -- e2e/dev-viewer-controls.spec.ts -g 'switches renderer and backend' --reporter=line`
  — passed, 1/1 existing Three.js renderer/backend regression scenario.
- `npm test -w @frillab/copc-adapter` — passed, 493/493 tests.
- `npm run typecheck -w @frillab/copc-adapter` and
  `npm --prefix apps/dev-viewer run typecheck` — passed.
- `npm run test:pack` — passed, 6/6 Chromium cases each for root production,
  explicit Cesium production, and root development consumers.
- `npm run test:pack:three` — passed, clean packed Three.js consumer build.
- `npm --prefix apps/dev-viewer run build` and `npm run docs:build` — passed.

This browser suite validates correction plumbing with synthetic grids only. It
does not independently verify an EGM2008 or KNGeoid24 model, survey control
points, Cesium Terrain alignment, Firefox/WebKit behavior, or performance under
large streamed grids. The separate official EGM2008 grid and reference-sample
validation recorded above is not repeated by this browser fixture; no
authoritative validation is inferred from the synthetic WKT or grid. The
browser test consumes the repository's existing Autzen sample and does not
depend on a developer-specific path or require an external grid download.

## Sources

- [NGS: Converting GPS Height into NAVD88 Elevation with the GEOID96 Geoid Height Model](https://www.ngs.noaa.gov/PUBS_LIB/gislis96.html)
- [MOLIT / NGII: 2024 National Geoid Model announcement](https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=95090271&lcmspage=52)
- [NGII: 2025 English brochure, including KNGeoid24 overview](https://www.ngii.go.kr/lib/file/2025_ENG-%EA%B5%AD%ED%86%A0%EC%A7%80%EB%A6%AC%EC%A0%95%EB%B3%B4%EC%9B%90%20%EB%B8%8C%EB%A1%9C%EC%8A%88%EC%96%B4.pdf)
- [Public Data Portal: NGII KNGeoid18 grid record and terms](https://www.data.go.kr/data/15122553/fileData.do)
- [NGA Office of Geomatics: EGM2008 data and grid](https://earth-info.nga.mil/index.php?action=geoid&dir=wgs84)
- [NGA official EGM2008 interpolation ZIP](https://earth-info.nga.mil/php/download.php?file=egm-08interpolation)
- [NGA GeoGRAV: current EGM data export and interpolation application](https://earth-info.nga.mil/geograv)
- [NGA GeoGRAV EGM2008 bilinear point response: San Francisco](https://earth-info.nga.mil/geograv/api/v1/egm-interpolation/EGM2008/lerp/point?lerpType=bilinear&point=%7B%22type%22%3A%22Point%22%2C%22coordinates%22%3A%5B-122.4194%2C37.7749%5D%7D)
- [EPSG:3855 EGM2008 height CRS](https://epsg.org/crs_3855/EGM2008-height.html)
- [EPSG method 1025: Geographic3D to GravityRelatedHeight (EGM2008)](https://epsg.org/coord-operation-method_1025/Geographic3D-to-GravityRelatedHeight-EGM2008.html)
- [EPSG:4979 WGS 84 geographic 3D CRS](https://epsg.org/crs_4979/WGS-84.html)
- [NGS GEOID18 technical details and NAD83(2011) epoch requirement](https://www.ngs.noaa.gov/GEOID/GEOID18/geoid18_tech_details.shtml)
- [NGS GEOID18 downloads and binary grid definitions](https://www.ngs.noaa.gov/GEOID/GEOID18/downloads.shtml)
- [NGS GEOID18 readme](https://www.ngs.noaa.gov/GEOID/GEOID18/files/geoid18_readme.txt)
- [NGS GEOID18 official grid check points](https://www.ngs.noaa.gov/GEOID/GEOID18/files/geoid18_grid_check_points.pdf)
- [NGS Geoid Height Service API](https://www.ngs.noaa.gov/web_services/geoid.shtml)
- [NGS GEOID18 coordinate computation and coverage](https://www.ngs.noaa.gov/GEOID/GEOID18/computation.html)
- [GDAL GTX driver documentation](https://gdal.org/en/stable/drivers/raster/gtx.html)
- [GDAL GTX reader implementation](https://raw.githubusercontent.com/OSGeo/gdal/master/frmts/raw/gtxdataset.cpp)
- [PROJ: vertical grid shift operation and supported grid formats](https://proj.org/en/stable/operations/transformations/vgridshift.html)
- [EPSG Geodetic Parameter Registry](https://epsg.org/)

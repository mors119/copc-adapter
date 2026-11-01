# Issue #404: Dataset-relative and height-above-ground color semantics

**Status:** Research recommendation; awaiting maintainer review. No production
API or renderer behavior is changed by this proposal.
**Reviewed:** 2026-10-31.
**Scope:** Optional height-derived display colors after the absolute elevation
palette in [issue #395](https://github.com/mors119/copc-adapter/issues/395).

## Decision

- **GO, separately, for dataset-relative height coloring.** Define its value as
  `h_display - h_reference`, in metres, using the prepared point height after
  the existing vertical transform and `heightOffsetMeters`. Use a fixed
  dataset-wide reference captured from source metadata, or an explicitly
  supplied known reference in the same displayed height frame. Never use the
  minimum of currently decoded/visible points: that changes with LoD, camera,
  filtering, and cache eviction. Keep this calculation in the color path; it
  must not change source XYZ, displayed coordinates, ECEF, picking, bounds, or
  LoD. Dataset-relative height is a vertical difference, not ground clearance.
- **NO-GO for generic Cesium-Terrain-derived HAG coloring.** A Cesium
  `TerrainProvider` is an external, versioned surface model, not proof of the
  ground surface for a particular survey. Resolution, capture date, coverage,
  bridge/building treatment, and vertical model may differ. Calling that result
  HAG would overstate its meaning. If exposed later, it must be explicitly
  named as relative to the selected Terrain source, carry provider/version and
  vertical-frame provenance, and stay Cesium-only and opt-in.
- **Conditional GO for a ground-surface-backed HAG mode**, only after a
  separate issue validates a provenance-bearing surface, bounds, interpolation
  and uncertainty policy, and cache/request limits. Prefer a companion ground
  surface derived from the same survey, or a precomputed surface made from
  ground-classified returns. Do not generate a global HAG surface by scanning
  the COPC at load time, infer it from the lowest point, or issue Terrain
  requests per point.

The numerical definitions are:

```text
h_display = prepared WGS 84 ellipsoidal point height in metres
             after the configured vertical transform and heightOffsetMeters

dataset-relative(point) = h_display - h_reference
HAG(point)              = h_display - h_ground(longitude, latitude)
```

Both expressions are display values only. Existing `heightOffsetMeters`
remains the caller's uniform geometry correction. Because it applies to COPC
points, it changes HAG by the same amount unless the supplied ground surface is
independently transformed/aligned into the same display frame. It is not
automatically folded into a ground model or treated as a datum operation.

## Existing implementation boundary

The current absolute elevation style uses prepared point heights and a range
computed once from COPC metadata. `getDatasetElevationRange()` applies source
vertical-unit conversion, the configured grid's conservative undulation
extrema, and `heightOffsetMeters`; it is independent of currently visible
nodes. It is therefore a useful stable range source, but its lower bound is a
metadata envelope, not a surveyed ground height and not necessarily the exact
minimum after a spatially varying vertical transform.

The Cesium Terrain alignment estimator already enforces a bounded diagnostic:
up to 8 anchors by default, 12 maximum, submitted in one
`sampleTerrainMostDetailed()` call. It verifies height-reference compatibility,
rejects unconfirmed non-ground anchors, reports missing samples, and does not
modify geometry. That contract is appropriate for an explicit diagnostic; it
does not make per-point Terrain sampling an acceptable coloring strategy.

Relevant current code is in `packages/adapter/core/point/style/pointStyle.ts`,
`packages/adapter/cesium/terrain/terrainHeightAlignmentBatch.ts`, and
`docs/API.md` (the absolute elevation and Terrain alignment sections).

## Reference-height choice for dataset-relative color

| Candidate reference | Assessment |
| --- | --- |
| Full-source metadata minimum envelope | Recommended default if source height units and displayed frame are established. Stable across views and LoD. Label it as the dataset metadata minimum/reference; do not imply that it is ground or an observed point minimum. Existing metadata bounds and grid extrema can be conservative. |
| Explicit known numeric height or stable source anchor | Recommended for reproducible workflows that have a survey datum/anchor. Require metres in the same displayed frame and capture the value for the source generation. A picked anchor may be evicted later; retain its captured value rather than looking it up from the current LoD. |
| Minimum of currently selected, visible, or decoded points | Reject. It moves when nodes load, unload, or are filtered, so the same point changes color as the camera/LoD changes. |
| Arbitrary regional minimum | Reject as an implicit reference. A region can be an explicit, fixed user input with its own identity, bounds, and saved numeric result; silently following the current view is still unstable. |

If the source vertical frame is unverified, the value may still be a numeric
within-source difference, but it must not be described as metres above ground,
sea level, or a verified WGS 84 ellipsoidal difference. The future public
contract should either preserve an explicit unverified label or disable the
mode where no consistent vertical unit/frame can be established. An explicit
reference is interpreted after the same unit conversion, vertical transform,
and manual offset as its point values. A metadata-derived reference and a
source anchor re-evaluated through that same transform therefore shift with a
uniform `heightOffsetMeters`, leaving their dataset-relative differences
unchanged. If an anchor is stored as a displayed numeric height, changing the
offset must update that stored value or invalidate the reference.

## HAG source comparison

| Source | Strength | Limits and required policy |
| --- | --- | --- |
| Ground-classified COPC returns | Can be survey-specific. ASPRS class 2 denotes Ground, and point-cloud processing tools derive HAG by interpolating a surface from marked ground points. | Classification is input evidence, not a guarantee of correct ground labels. Ground can be sparse or absent under canopy/buildings; bridges, retaining walls, breaklines, scan gaps, and tile boundaries need care. Delaunay interpolation needs at least three non-collinear nearby returns and neighbors across node boundaries; nearest-neighbor extrapolation can create large slope errors. Require a declared algorithm, parameters, class/provenance, surface frame, spatial coverage, resolution, and no-data/extrapolation rule. HAG is only defined where the ground model has sufficient points/coverage; regions outside its geographic bounds remain unavailable. Prefer precomputing a bounded ground surface over rebuilding it from every loaded node. |
| Consumer-owned Cesium TerrainProvider | Cesium provides an async maximum-available-detail sampler; sampled Cartographic heights are ellipsoidal, and unavailable heights can be undefined. Existing Cesium-only layers can access the consumer's provider without taking ownership. | The result is the provider's model at its available resolution/date, not necessarily survey ground. It can disagree at buildings, bridges, water, and changed sites; provider coverage/availability and remote requests vary. It is unavailable to Three-only or offline consumers unless they independently supply a compatible provider. Batch/caching is mandatory, and missing values must remain missing. |
| Arbitrary uniform Terrain alignment residual | Existing API can propose a robust uniform display offset from confirmed anchors. | This corrects a placement residual, not a spatially varying ground surface. Applying it to HAG conflates placement with ground clearance. It cannot replace `h_ground(lon,lat)`. |

Dataset-relative calculation is O(1) per point and O(1) reference storage;
its fixed reference comes from the full metadata extent, independent of how
many points are currently decoded. It needs no geographic sample or additional
source-point count. Ground interpolation instead depends on local ground-point
density and coverage in the point's neighborhood; the minimum count for a
triangulation is not a quality guarantee. Cesium Terrain is bounded by its
provider's geographic coverage and availability; a returned height is the
provider sample at its maximum available level, not proof of the survey's
surface. Neither ground model may dynamically widen/change the COPC LoD
selector to find points: future surface-tile requests must follow the existing
active view and be independently bounded.

For a validated HAG surface, compare point and surface heights only after both
are represented in the same horizontal coordinates and vertical frame. Record
surface identity/version or content hash, source survey/date, producing
algorithm and parameters, vertical CRS/grid and transform, interpolation,
resolution, coverage, and any known uncertainty. Outside coverage, at NoData,
on failed requests, or with unverified incompatible frames, return HAG as
unavailable. Do not silently substitute absolute elevation, zero, nearest
ground, Cesium ellipsoid height, or the current Terrain alignment offset.
Negative HAG values are valid diagnostics for below-surface points and should
not be clamped to zero by the measurement definition.

LAS classification values are specified by ASPRS; a value of class 2 means
Ground, while class 6 means Building and class 17 means Bridge Deck for LAS
1.4 point formats 6–10. The flag is useful input metadata, but it does not
attest how a classifier performed or make an interpolated surface complete.
PDAL's `filters.hag_delaunay` likewise requires marked ground returns, builds a
local triangulation, and documents fallback/extrapolation behavior. Those
choices change HAG and must be explicit in any surface provenance.

## Tiny deterministic fixture

Use a local metric tangent fixture with source metadata declaring WGS 84
ellipsoidal height (EPSG:4979), no vertical grid, and
`heightOffsetMeters = 0`. Define a sloped ground surface in metres:

```text
h_ground(x, y) = -4 + 0.125x + 0.25y
```

The four marked ground returns are `(0,0,-4)`, `(8,0,-3)`, `(0,8,-2)`, and
`(8,8,-1)`; all are class 2. Add a tree point `(4,4,7.5)`, a building roof
point `(8,8,8)` (class 6), a point at ellipsoidal height `0` over `(8,0)`, and
a low outlier `(0,0,-5)`. Let the known dataset-relative reference be the
ground anchor height `-4 m`. The sloped surface is planar and the fixture's
coordinates and heights use exact binary fractions/integers, so triangular
interpolation is exact for the interior tree sample.

| Point | `h_display` (m) | True ground (m) | HAG from same-source ground surface (m) | Relative to `-4 m` (m) |
| --- | ---: | ---: | ---: | ---: |
| Ground at `(0,0)` | -4 | -4 | 0 | 0 |
| Ground at `(8,0)` | -3 | -3 | 0 | 1 |
| Ground at `(0,8)` | -2 | -2 | 0 | 2 |
| Ground at `(8,8)` | -1 | -1 | 0 | 3 |
| Point at zero height, `(8,0)` | 0 | -3 | 3 | 4 |
| Tree at `(4,4)` | 7.5 | -2.5 | 10 | 11.5 |
| Building roof at `(8,8)` | 8 | -1 | 9 | 12 |
| Below-reference outlier at `(0,0)` | -5 | -4 | -1 | -1 |

This distinguishes relative height from HAG even on a plane: the tree is
`11.5 m` above the fixed dataset anchor but `10 m` above its local ground.
The zero and negative display heights are valid numeric inputs. For this exact
fixture the expected Float64 arithmetic error is `0 m`; keep a `1e-12 m`
assertion tolerance if the interpolation is evaluated in Float64 so an
implementation can use ordinary floating-point operations without making a
survey-accuracy claim.

For the mismatch case, let a provider surface return `h_ground + 2 m` at every
sample. Cesium-provider-derived values for the tree, building, zero-height
point, and low outlier become `8`, `7`, `1`, and `-3 m`, each exactly `2 m`
below same-source HAG. This proves the color cannot reveal that the supplied
surface is vertically/survey mismatched: its bias transfers one-for-one as
`error_HAG = error_point - error_ground`. A real validation must add
non-planar terrain, a gap, an outside-coverage point, a bridge/building-base
case, and an actual known vertical-grid conversion before making accuracy
claims.

A direct Float64 barycentric interpolation over triangle
`(0,0,-4)`, `(8,0,-3)`, `(8,8,-1)` returned ground `-2.5 m` at the tree,
HAG `10 m`, and dataset-relative height `11.5 m`. With the synthetic Terrain
bias, it returned HAG `8 m` and error `-2 m`, within the stated
`1e-12 m` floating-point tolerance for the unbiased fixture.

## Initial cost and request budget

### Dataset-relative arithmetic microbenchmark

An ephemeral Node loop evaluated one million Float64 displayed heights around
`290–340 m`, subtracted a fixed `300 m` reference, normalized/clamped the value,
and wrote the same three-channel Float32 output shape as a point color buffer.
It used no COPC file, renderer, network, or additional point buffer. Environment:
Apple M2, macOS 26.6.2 arm64, Node v26.12.1. One first relative pass took
`4.56 ms`; after eight warm-up passes, 30 alternating measurements had p50
`2.22 ms` for the absolute subtraction control and `2.39 ms` for relative
subtraction. The relative p95 was `8.51 ms` versus `4.86 ms` for the control,
showing enough timing noise that these are feasibility numbers, not a stable
performance claim. No color difference was observed in the equivalent
arithmetic check.

The fixture used an 8,000,000-byte input `Float64Array` and one
12,000,000-byte output `Float32Array`; the reference is one 8-byte scalar.
Therefore relative mode needs **zero extra per-point storage** if subtraction
happens while the existing color buffer is generated. Materializing a second
Float64 height array would cost another 8 bytes per point (8 MB per million)
and is unnecessary. The microbenchmark excludes actual ramp interpolation,
Cesium/Three uploads, GPU memory, garbage-collection peaks, and end-to-end
streaming.

### HAG source and bounded work

- Dataset-relative coloring adds **0 network requests** and one fixed reference
  value. It must not trigger a COPC range read or LAZ decode.
- The current Terrain diagnostic provides an existing upper bound of one
  `sampleTerrainMostDetailed()` API call for at most 12 anchors (8 default).
  This is not a bound of one HTTP request: Cesium may need several terrain
  tiles, and actual tile requests depend on provider, locations, availability,
  and cache state. Its current timeout is 30 seconds by default (60-second
  hard cap), too long for a synchronous color path. Keep it diagnostic-only.
- Candidate starting budget for a future precomputed ground-grid source: at
  most 16 unique surface tiles requested for one active-view update, at most 4
  tile fetches in flight, and an LRU of 16 resident `256 × 256` Float32 height
  tiles plus one validity bit per cell. That is `264 KiB` per tile and
  `4.125 MiB` for 16 tiles, excluding decoder/runtime overhead. A warm hit in
  the resident cache costs 0 requests; a cold miss costs at most one request
  per missing tile. This is a proposed cap, not a measured implementation.
  HAG must not block initial COPC visibility; absent or late surface coverage
  stays unavailable until the tile arrives. A future browser benchmark must
  measure actual cold/warm tile latency, transfer bytes, queueing, CPU
  interpolation, memory peak, and eviction under camera motion.

These figures are initial design constraints, not production guarantees. The
repository does not currently contain a provenance-bearing ground surface
source to measure end-to-end HAG latency or survey error.

## Backend and renderer portability

Dataset-relative coloring is backend-neutral: both JS and Rust preparation
already expose displayed-height buffers/statistics, and the reference
subtraction belongs in the shared style/color preparation contract. It must
not add a second height transform or modify coordinates. Cesium can recolor
through its renderer path; Three currently receives style at construction and
rebuilds color data when a new style is applied. A future public API must
preserve those current renderer lifecycle rules and keep generated declarations
and released consumers in sync.

HAG needs an explicit surface sampler independent of renderer ownership if it
is to work in Cesium, Three, and offline consumers. A Cesium `Viewer` or
`TerrainProvider` cannot be a shared-core dependency. A caller-supplied,
provenance-bearing surface resource could be portable, but is not currently a
supported public contract. Surface identity/version, vertical-transform
generation, and source generation must invalidate cached HAG values when any
input changes.

## Follow-up boundary

The validated dataset-relative definition and zero-request budget are enough
to justify a separate implementation issue after maintainer review. That issue
should own a shared-style option, Cesium/Three parity, absolute-vs-relative
legend wording, invalid-frame policy, stable reference capture, and tests for
LoD stability, negative/zero values, metadata envelope, and height-offset
cancellation. Keep it separate from #395's absolute custom palette and from
Workbench/schema/code generation until a released public API is approved.
After a public version is released, register its mode and legend in #397/#314
and verify the applied configuration in #399; do not wire unreleased research
semantics into those Workbench/codegen surfaces.

Do not open an HAG implementation issue yet. First select and validate an
actual ground surface, its source rights/provenance, uncertainty, coverage and
NoData behavior, and cold/warm resource budget. If that evidence supports a
portable source, open a separate HAG issue; otherwise retain HAG as a
documented limitation. No issue or released API has been created by this
research change.

## References

- [Issue #404](https://github.com/mors119/copc-adapter/issues/404)
- [Issue #395: configurable absolute elevation ramps](https://github.com/mors119/copc-adapter/issues/395)
- [Issue #244: vertical CRS and geoid-grid decision](issue-244-vertical-crs-geoid-grid.md)
- [Cesium `sampleTerrainMostDetailed` reference](https://cesium.com/learn/cesiumjs/ref-doc/global.html#sampleTerrainMostDetailed)
- [ASPRS LAS 1.4 R16 classification table](https://github.com/ASPRSorg/LAS/releases/download/1.4.R16/LAS_1_4_r16.pdf)
- [PDAL `filters.hag_delaunay` documentation](https://pdal.io/en/stable/stages/filters.hag_delaunay.html)

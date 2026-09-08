# Issue #171: `proj4rs` / `proj4wkt` compatibility audit

Validation date: 2026-09-08

## Decision

`proj4rs` + `proj4wkt` can reproduce the current adapter's horizontal
source-to-WGS84 path for Autzen and SoFi when the existing adapter boundary
first extracts the horizontal `PROJCS`. The candidate is not a drop-in
replacement for the current WKT/CRS path yet.

Recommendation: **RUST CRS READY WITH FOCUSED UPSTREAM/FOLLOW-UP**.

The production Rust path should remain behind the current opt-in architecture
until the geographic/WKT2 adapter boundary is extended and the SoFi full
compound-WKT parser gap is either fixed upstream or deliberately kept behind
the same removable horizontal-extraction compatibility step. `proj4js` remains
the runtime reference and dependency for this issue.

## Method

The checked-in matrix is [`crates/crs-audit/src/fixtures.json`](../../crates/crs-audit/src/fixtures.json).
It contains WKT and representative coordinates only; no COPC binary is
committed. Autzen and SoFi WKT were extracted from the public
`LASF_Projection/2112` VLR using a 64 KiB HTTP Range read from the public
[Autzen](https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz) and
[SoFi](https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz) objects.

The candidate pipeline is:

```text
fixture WKT
  -> existing horizontal PROJCS extraction where the adapter uses it
  -> proj4wkt 0.1.1
  -> proj4rs 0.1.10
  -> WGS84 geographic output
  -> existing vertical unit multiplication
```

For projected fixtures, four points cover the metadata horizontal center,
horizontal minimum/maximum corners, and a mixed-sign height. The geographic fixture adds
negative/positive longitude and latitude values. This catches axis/order
mistakes that a single center point would miss.

The differential reference is `proj4js 2.22.0`, using the same extracted
horizontal WKT for Autzen and SoFi. `proj4js` is treated as a differential
reference, not as the specification. The WKT2 UTM definition is also checked
against the [EPSG:32611 definition](https://epsg.io/32611).

## Compatibility matrix

`proj4wkt full WKT` reports conversion of the complete fixture. `Adapter input`
reports whether the current project-owned WKT boundary can supply the
horizontal definition to the candidate. `proj4rs` reports the projection
operation after conversion. The audit runner emits the issue classifications
`SUPPORTED`, `ADAPTER INTEGRATION ISSUE`, `PROJ4WKT GAP`, and `PROJ4RS GAP` in
its JSON output; `OUT OF UPSTREAM SCOPE` is reserved for a follow-up that is
not a useful library contribution.

| Fixture / CRS | WKT | `proj4wkt` full WKT | Adapter input | `proj4rs` | Differential max error (`lon`, `lat`, `height`) | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Autzen / EPSG:2992 + NAVD88 height | WKT1 `COMPD_CS` | PASS | PASS: nested `PROJCS` | PASS | `0`, `9.43e-10°`, `0 m` | READY |
| SoFi / EPSG:32611 + ellipsoidal height | WKT1 `COMPD_CS` | **FAIL: WKT parse error** | PASS: nested `PROJCS` | PASS | `2.84e-14°`, `1.42e-14°`, `0 m` | READY with focused upstream follow-up |
| WGS84 geographic / EPSG:4326 | WKT1 `GEOGCS` | PASS | **ADAPTER INTEGRATION ISSUE**: current helper only extracts `PROJCS` | PASS | `0`, `7.11e-15°`, `0 m` | Candidate supported; adapter follow-up required |
| UTM 11N / EPSG:32611 | WKT2 `PROJCRS` | PASS | **ADAPTER INTEGRATION ISSUE**: current helper does not recognize `PROJCRS` | PASS | `4.26e-14°`, `1.42e-14°`, `0 m` | Candidate supported; adapter follow-up required |

The explicit tolerances are `1e-7°` longitude/latitude and `1e-9 m` height
for the projected datasets. `1e-7°` is approximately centimetre-scale at the
Earth's surface and catches projection or axis-order errors; height uses a
tighter tolerance because both paths perform the same direct unit
multiplication. The geographic fixture uses `1e-12` for all three values.

Representative candidate output for the first point in each fixture:

| Fixture | Longitude | Latitude | Height (m) |
| --- | ---: | ---: | ---: |
| Autzen | `-123.0664124403113` | `44.056302478080184` | `155.66167132334255` |
| SoFi | `-118.33772305286695` | `33.95374438756227` | `545.1945` |
| WGS84 geographic | `-122.67839999999998` | `45.5231` | `123.5` |
| UTM 11N WKT2 | `-118.33772305286695` | `33.95374438756227` | `545.1945` |

### Unit and height semantics

- Autzen's horizontal `foot` unit is converted by `proj4wkt` to
  `+to_meter=0.3048`.
- Autzen's vertical `US survey foot` scale is applied separately as
  `z * 0.304800609601219`.
- SoFi's horizontal and vertical units are metres, so its Z value is
  unchanged.
- No geoid, datum-grid, orthometric, or 3D vertical transformation is being
  added. Autzen's `NAVD88 height` is treated exactly as the current adapter
  contract treats it: unit scaling only. A complete vertical datum operation
  is a separate follow-up.
- Geographic input is in degrees at the adapter boundary. The Rust candidate
  converts geographic source degrees to the radians expected by `proj4rs`
  before transforming, then returns degrees. This is covered by the WGS84
  fixture.

## SoFi upstream candidate

The real SoFi full `COMPD_CS` fails in `proj4wkt 0.1.1` with `WKT parse error`,
while the same WKT's nested projected horizontal definition converts and
transforms successfully. The failure is therefore kept visible in the audit
instead of being hidden by changing the tolerance or silently treating the
full WKT as supported.

Focused contribution candidate for
[`3liz/proj4wkt-rs`](https://github.com/3liz/proj4wkt-rs): add a regression
fixture containing the SoFi `COMPD_CS` shape and identify the exact parser token
that causes the failure; preserve the existing horizontal conversion result
while making the full compound behavior explicit. The repository currently
has no local compatibility workaround beyond the existing removable
`PROJCS` extraction. The upstream project had no issue or PR duplicate found
during this audit, so this remains a follow-up proposal rather than an
unbounded private fork.

`proj4rs` itself supports the required LCC, Transverse Mercator, and geographic
operations in this matrix. Its documented scope remains lightweight PROJ.4
style 2D transformation; it does not provide full 3D/orthometric semantics.
See the [proj4rs WKT and transformation documentation](https://docs.rs/proj4rs/0.1.10/proj4rs/)
and the [`proj4wkt` conversion API](https://docs.rs/proj4wkt/0.1.1/proj4wkt/).

## Performance benchmark

The benchmark transforms the same repeated source points five times after one
transformer initialization. Values below are total wall time for the five
iterations, not per-point time. Output is three `f64` values per point, so the
output size is `24 * pointCount` bytes. The JS and WASM measurements include
their normal per-point output-array creation; the WASM call also copies a
`Float64Array` into and out of the module.
Allocator-level counts were not instrumented; the recorded allocation fact is
the output buffer size, and the benchmark includes the output allocation in
the transform wall time.
The native Rust benchmark runs with Cargo's `--release` profile, and the WASM
benchmark invokes the release build on every run so Cargo can refresh a stale
artifact before it is measured.

Hardware/runtime context: Apple Mac14,15, arm64, 8 CPU cores; Node.js
`v26.7.0`; Rust `1.92.0`; `proj4js 2.22.0`; `proj4rs 0.1.10`; `proj4wkt 0.1.1`.
The numbers are a local audit snapshot, not a release performance guarantee.

| Fixture | Points | `proj4js` (ms) | native Rust (ms) | Rust/WASM (ms) |
| --- | ---: | ---: | ---: | ---: |
| Autzen LCC | 10k | 40.3 | 47.6 | 45.4 |
| Autzen LCC | 100k | 316.1 | 245.1 | 429.8 |
| Autzen LCC | 250k | 783.8 | 593.3 | 1,070.9 |
| Autzen LCC | 500k | 1,651.2 | 1,191.5 | 2,145.5 |
| SoFi UTM | 10k | 24.2 | 11.4 | 18.6 |
| SoFi UTM | 100k | 228.6 | 115.0 | 180.7 |
| SoFi UTM | 250k | 589.2 | 287.7 | 454.0 |
| SoFi UTM | 500k | 1,164.3 | 576.6 | 939.3 |

Initialization was measured separately from the repeated transform loop:

| Pipeline | Initialization observation |
| --- | --- |
| `proj4js` | 0.43–0.59 ms per projection construction |
| native Rust | 0.01–0.24 ms per construction |
| Rust/WASM transformer | 0.10–0.25 ms after module startup; first Autzen constructor was 3.47 ms in this Node run |

The candidate does not win every raw transform benchmark. Native Rust was
slightly slower than `proj4js` for the smallest Autzen run but faster at the
larger sizes and for SoFi; WASM was slower for Autzen and faster for SoFi. A
Worker/fused decode+CRS path may still reduce main-thread work and boundary
crossings, but this audit does not justify changing the runtime dependency by
itself.

## WASM and resource checks

- `cargo build -p crs-audit --target wasm32-unknown-unknown --release` passed.
- The release `crs_audit.wasm` artifact was 810,771 bytes before any optional
  external post-processing.
- The audit embeds its small WKT fixture matrix. Neither `proj4wkt` nor
  `proj4rs` loads a file, grid, or network resource in this path.
- The exported WASM transformer initializes deterministically from a fixture
  string and accepts/returns typed `Float64Array` buffers, so it can be moved
  into the existing Worker architecture without adding browser I/O.
- The production `copc-wasm` crate and browser runtime were not changed by
  this audit; `proj4js` remains in the package and current runtime path.

## Reproduction

```bash
npm ci --prefix apps/viewer-web
npm run audit:crs -- --json
npm run audit:crs -- --wasm --benchmark --json
cargo test -p crs-audit
cargo build -p crs-audit --target wasm32-unknown-unknown --release
```

The second command requires the `wasm-bindgen` CLI. This audit used
`wasm-bindgen 0.2.126`, matching the pinned Rust dependency used to make the
generated binding format reproducible.

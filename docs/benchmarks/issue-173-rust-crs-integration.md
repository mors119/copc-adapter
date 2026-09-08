# Issue #173 Rust CRS integration

This document records the production Rust CRS capability added to
`copc-core`. It builds on the compatibility evidence in
[issue #171](issue-171-proj4rs-compatibility.md).

## Implemented boundary

`copc-core::CrsTransform` initializes a reusable source-WKT to WGS84
transformation. Initialization performs:

```text
COPC WKT
  -> proj4wkt 0.1.1
  -> proj4rs 0.1.10 projection state
  -> reusable source -> WGS84 geographic transform
```

Per-point work applies the existing project semantics:

```text
source XYZ
  -> WGS84 longitude/latitude in degrees
  -> vertical unit scaling for Z
  -> WGS84 ECEF metres
```

The `transform_buffer_to_ecef` method returns both interleaved geographic and
ECEF `f64` buffers. Projection and WKT initialization do not occur inside the
point loop. `geographic_to_ecef` and `geographic_buffer_to_ecef` are also
available as pure Rust numeric operations.

`copc-wasm` exposes a reusable opaque transform handle:

- `create_crs_transform_json` initializes one handle from UTF-8 WKT;
- `create_geographic_crs_transform_json` supports the existing no-WKT
  geographic-bounds case;
- `transform_crs_points_json` fills host-provided geographic and ECEF buffers;
- `free_crs_transform` releases the handle.

The TypeScript `RustCrsTransformer` wrapper is an opt-in public API from the
root, Cesium, and Three.js package entry points. The existing `proj4js` runtime
path and backend selection policy remain unchanged while migration conformance
is collected.

## Fixture and error behavior

The checked-in matrix from #171 is executed through `copc-core`, including
Autzen, SoFi, WGS84 geographic WKT1, and UTM WKT2. The resulting behavior is:

| Fixture | WKT conversion | Rust transform | Height semantics |
| --- | --- | --- | --- |
| Autzen LCC + NAVD88 | full WKT supported | supported | Z multiplied by US survey-foot scale |
| SoFi UTM + ellipsoidal height | full compound WKT has the known `proj4wkt` parse gap | supported through nested `PROJCS` compatibility path | Z unchanged |
| WGS84 geographic | supported | supported with degree/radian boundary conversion | Z unchanged |
| UTM WKT2 | supported | supported | Z unchanged |

The SoFi path is explicit: the full WKT is attempted first, and only when
that conversion fails does the core extract a balanced nested `PROJCS` section.
It does not fall back to `proj4js`. The original WKT still supplies vertical
unit semantics. The focused upstream follow-up remains tracked by the #171
audit; the compatibility path is intended to be removed after an upstream
`proj4wkt` fix is released.

Core and WASM errors retain stable categories for missing/malformed WKT,
conversion and initialization failures, unsupported axes, non-finite input or
output, invalid buffers, and projection failures. No geoid, grid, orthometric,
or full 3D vertical datum transformation is claimed.

## Performance sample

The following native release run used the checked-in Autzen and SoFi points,
repeated for five iterations. Times are total wall time in milliseconds for
the requested point count; output is the combined geographic + ECEF buffer
(`48 * pointCount` bytes).

| Fixture | Points | CRS transform | Geographic -> ECEF | Combined |
| --- | ---: | ---: | ---: | ---: |
| Autzen LCC | 10k | 62.6 | 15.7 | 63.8 |
| Autzen LCC | 100k | 573.0 | 111.3 | 641.1 |
| Autzen LCC | 250k | 1,253.0 | 254.4 | 1,532.9 |
| Autzen LCC | 500k | 2,749.4 | 495.5 | 3,141.9 |
| SoFi UTM | 10k | 41.2 | 8.7 | 49.4 |
| SoFi UTM | 100k | 412.5 | 90.3 | 494.0 |
| SoFi UTM | 250k | 1,034.4 | 219.4 | 1,259.3 |
| SoFi UTM | 500k | 2,057.3 | 435.6 | 2,441.6 |

Initialization was 0.28–1.33 ms in this run. These are local audit samples,
not correctness assertions or release performance guarantees.

## Dependency and resource review

- `proj4rs 0.1.10` and `proj4wkt 0.1.1` are used with default features
  disabled and `wasm-strict` enabled.
- The release `copc-wasm` target builds for `wasm32-unknown-unknown`.
- The raw release `copc_wasm.wasm` is `934,468` bytes and the shipped
  name-section-stripped asset is `805,240` bytes in this checkout after adding
  the CRS dependencies and ABI; these are the current artifact-size baselines
  for subsequent migration work.
- The supported path is deterministic and offline. It does not load grids,
  files, or network resources.
- The WASM handle keeps projection state alive across multiple point-buffer
  calls, so Worker-side reuse does not repeat WKT parsing.
- The main-thread and Worker raw-WASM loaders share the numeric parser imports
  needed by proj4rs's direct Rust API; proj4rs's optional wasm-bindgen
  projection wrappers are not exposed through the adapter ABI.
- `proj4js` remains in the package as the differential/runtime reference until
  a later migration issue changes that policy.

## Reproduction

```bash
cargo test --workspace
cargo build -p copc-wasm --target wasm32-unknown-unknown --release
cargo test -p crs-audit
cargo run -p crs-audit -- --benchmark
npm run audit:crs -- --json
```

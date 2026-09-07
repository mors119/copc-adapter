# Architecture

## Project goal

COPC Adapter is a browser library for directly streaming and visualizing Cloud
Optimized Point Cloud (COPC) data without preprocessing it into another tile
format.

It supports renderer adapters such as CesiumJS and Three.js while keeping COPC
streaming and point-processing concerns separate from renderer-specific
presentation. The application owns its viewer, scene, camera, render loop, and
other engine resources.

## Current architecture

The current implementation has a project-owned backend boundary with two
production choices. `copc-js` is the default. Rust/WASM is an explicit opt-in
backend whose browser point decoding uses a bounded worker path when workers
are available.

```text
Browser-readable COPC URL
        ↓
HTTP Range / project-owned RandomAccessByteSource
        ↓
CopcJsBackend (default) or RustCopcBackend (opt-in)
        ↓
metadata / hierarchy / project-owned point buffers
        ↓
renderer-neutral TypeScript streaming core
        ├─ view-driven hierarchy loading
        ├─ NodeSelector and mixed-LoD selection
        ├─ screen-space error, gaze priority, and hysteresis
        ├─ node/point workload budgets
        ├─ cache, generations, and stale-work handling
        └─ public lifecycle and diagnostics
        ↓
TypeScript point preparation
        ├─ source coordinates → WGS84 geographic coordinates
        ├─ WGS84 geographic → WGS84 ECEF/world coordinates
        └─ project-owned typed buffers and attributes
        ↓
renderer adapter
        ├─ CesiumJS
        └─ Three.js
```

### Current processing ownership

- Browser TypeScript owns HTTP Range requests, CORS-visible response
  validation, source factories, worker scheduling, cancellation, and stale
  generation handling.
- `CopcJsBackend` uses the `copc` implementation for metadata, hierarchy, and
  point-view loading. The project-owned TypeScript boundary selects requested
  fields and converts point views into typed buffers.
- `copc-core` owns renderer-neutral LAS/COPC metadata and hierarchy parsing,
  LAZ node decompression, supported point-format interpretation, requested
  field selection, and source-coordinate buffer creation. It returns typed Rust
  results and errors and has no WebAssembly or browser dependency.
- `copc-wasm` is the thin ABI wrapper around `copc-core`. It owns pointer/length
  validation, WASM allocation and deallocation, copying core-owned buffers into
  host-provided memory, JavaScript-safe integer checks, and JSON/status
  encoding. TypeScript still fetches the exact byte ranges, owns the reader and
  worker orchestration, and maps results into project-owned types.
- `CopcStreamingCore` and `CopcStreamingController` own hierarchy lifecycle,
  view-driven selection, `NodeSelector`, SSE/refinement policy, hysteresis,
  workload budgets, cache policy, generations, cancellation, and diagnostics.
- The current CRS path is still TypeScript. It uses the project WKT parsing
  helpers and `proj4js` where a projected CRS is present, then computes WGS84
  ECEF/world coordinates in JavaScript. The shared buffers retain source,
  WGS84 geographic, and WGS84 ECEF values as `Float64Array`s.
- Cesium and Three.js adapters convert the shared data into engine-specific
  resources. Cesium owns `Viewer` and primitive integration; Three.js owns
  `THREE.Group`, `THREE.Points`, `BufferGeometry`, materials, and its fixed
  dataset-local ENU frame. Neither adapter parses COPC or owns streaming policy.

The current Rust path does not own CRS transformation, WGS84/ECEF preparation,
point-level statistics or reductions, or fused point preparation. Those remain
TypeScript responsibilities until the target processing architecture is
implemented and validated.

The repository contains `crates/copc-core` and `crates/copc-wasm`. The former
is the native-testable domain implementation; the latter exposes the existing
Rust/WASM ABI without owning COPC parsing or decoding rules. This extraction is
the first phase of the broader processing-core direction: CRS transformation,
WGS84/ECEF preparation, statistics, and fused point preparation remain future
work.

### Current data and streaming contracts

The backend boundary returns project-owned metadata, hierarchy nodes, point
views, and point buffers. The public point fields are `position`, `intensity`,
`classification`, and `rgb`; absent or unrequested fields are unavailable
rather than zero-filled.

The shared streaming core accepts a plain `StreamingView`, not a Cesium or
Three.js camera. It loads the root hierarchy first, follows relevant hierarchy
pages, and keeps page and decoded point caches separate. Selection preserves
coarse coverage while finer replacements are prepared, and a newer view
generation invalidates stale work. Node count and estimated point count are
independent safety limits.

The shared output currently retains the following coordinate spaces:

```text
COPC/source XYZ (`copc-source`)
        ↓ current TypeScript CRS path
WGS84 geographic (`wgs84-geographic`)
        ↓ current TypeScript ECEF conversion
WGS84 ECEF/world (`wgs84-ecef-meters`)
        ↓ renderer-owned origin/frame
renderer-local coordinates
```

The Three.js adapter currently uses an immutable dataset-local East/North/Up
frame whose origin is derived from the metadata cube centre. It converts to
renderer/GPU-friendly values only after subtracting that origin. This is a
renderer concern, not a shared streaming coordinate system.

## Target processing architecture

The intended long-term processing structure is:

```text
HTTP Range / browser I/O
        ↓
Rust Worker
        ↓
pure Rust COPC processing core
        ├─ COPC/LAS parsing
        ├─ hierarchy binary interpretation
        ├─ LAZ decompression
        ├─ point-record interpretation
        ├─ supported WKT/CRS transformation
        ├─ WGS84/world-coordinate preparation
        ├─ renderer-independent numeric reductions/statistics
        └─ typed point-buffer preparation
        ↓
thin Rust/WASM ABI layer
        ↓
renderer-neutral TypeScript streaming core
        ├─ HTTP/browser orchestration
        ├─ asynchronous scheduling
        ├─ cache policy
        ├─ generations and cancellation
        ├─ hierarchy lifecycle
        ├─ NodeSelector
        ├─ SSE and refinement influence
        ├─ hysteresis
        └─ node/point workload budgets
        ↓
renderer adapters
        ├─ CesiumJS
        └─ Three.js
```

The Rust core is a domain and processing core. It is not a renderer, browser
runtime, or streaming controller. The WASM crate is only the browser ABI and
runtime boundary around that core. TypeScript remains responsible for
browser/streaming policy and lifecycle even after more point-level work moves
to Rust.

### Rust and TypeScript ownership rule

Point-level binary and numeric work belongs in Rust when doing so provides a
clear reusable processing boundary. Node- and view-level streaming policy
remains in TypeScript.

Rust-oriented responsibilities include:

- binary COPC/LAS interpretation;
- LAZ decompression;
- per-point coordinate arithmetic;
- supported CRS transformations;
- WGS84/ECEF and other world-coordinate preparation;
- point-level statistics and reductions; and
- numeric typed-buffer preparation.

TypeScript responsibilities include:

- HTTP Range and browser I/O ownership;
- Worker scheduling and asynchronous orchestration;
- cancellation and stale-generation policy;
- hierarchy lifecycle and page/cache management;
- `NodeSelector`, SSE, refinement influence, and hysteresis;
- node and point workload budgets;
- camera/view contracts; and
- the public JavaScript lifecycle and diagnostics.

Renderer responsibilities are limited to engine-specific work:

- CesiumJS integrates with `Viewer` and `Scene`, creates Cesium-native render
  objects, performs Cesium picking, and converts camera state.
- Three.js integrates with `Scene` and `Camera`, creates `THREE.Points` and
  `BufferGeometry`, manages renderer-local representation and GPU resources,
  performs Three.js picking, and disposes resources it owns.

Neither renderer should understand COPC compression or CRS parsing. The
renderer-neutral streaming core must not return Cesium or Three.js objects.

### Pure Rust core and WASM wrapper

The current crate separation is:

```text
crates/
  copc-core/
  copc-wasm/
```

`copc-core` is pure Rust. It has no JavaScript, WebAssembly-specific pointer
ABI, browser, Cesium, or Three.js dependency. Its native tests exercise the
same metadata, hierarchy, and point-decoding behavior used by the WASM path.

`copc-wasm` is a thin wrapper around that core. It owns memory allocation and
deallocation, ABI validation, JS/WASM result transfer, and WebAssembly-specific
error/result encoding. COPC domain rules remain in `copc-core`; renderer
behavior remains outside both crates.

## CRS architecture

### Current CRS path

The current JavaScript path is:

```text
COPC/source coordinates
        ↓ project WKT parsing + proj4js where applicable
WGS84 geographic longitude/latitude/height
        ↓ JavaScript WGS84 conversion
WGS84 ECEF/world coordinates
        ↓ renderer adapter
renderer-specific local representation
```

Projected COPC metadata is currently expected to provide usable WKT. The
current parser handles the project’s supported WKT shape and reports malformed
or unsupported CRS metadata during loading; it does not promise general PROJ
coverage.

### Target CRS path

The target processing pipeline is:

```text
COPC/source coordinates
        ↓ Rust CRS layer
WGS84 geographic coordinates
        ↓ Rust world-coordinate preparation
WGS84/world coordinates and prepared buffers
        ↓ renderer adapter
renderer-specific local representation
```

`proj4rs` and `proj4wkt` are currently evaluated Rust implementation choices,
not permanent architectural requirements. The eventual Rust CRS layer must be
abstracted from renderer code and adopted only for the supported CRS behavior
that has been measured against real COPC metadata and fixtures.

Existing `proj4js` behavior is useful as a differential reference. Reference
output is not automatically the specification: authoritative CRS definitions
and source metadata determine correctness. When implementations disagree, the
project should inspect the WKT and metadata, consult the authoritative CRS
definition, identify the incorrect implementation, and add a deterministic
project-owned regression. Unsupported WKT or projection behavior must be
reported explicitly; silent fallback must not hide Rust-path incompatibility.

CRS validation should cover WKT1 and WKT2 as supported, projected and
geographic CRS forms, axis and coordinate order, horizontal coordinates,
height and unit handling, source-to-WGS84 transformation, and WGS84/world
preparation. Full PROJ functionality must not be promised unless the selected
Rust implementation actually provides it.

## Point preparation pipeline

The target performance shape is one coarse-grained Worker operation per useful
node or batch:

```text
compressed node
        ↓
Rust decode
        ↓
point interpretation
        ↓
CRS transformation
        ↓
WGS84/world-coordinate preparation
        ↓
statistics/reductions
        ↓
typed-buffer packing
        ↓
transferable renderer-neutral result
```

The target avoids a pipeline shaped like:

```text
JS → WASM decode → JS → WASM CRS → JS → WASM ECEF → JS
```

The goal is to reduce repeated full-buffer passes, unnecessary JavaScript
object allocation, WASM boundary crossings, main-thread numeric work, and
duplicated coordinate conversion. “Rust is faster” by itself is not the
architecture; a reusable processing boundary and measured end-to-end behavior
are the goals.

## Renderer-neutral data contract

The shared prepared-data concept may expose, as needed:

- point count;
- source coordinates;
- WGS84 geographic coordinates;
- WGS84/world coordinates;
- requested attributes;
- reusable numeric statistics; and
- coordinate-space metadata.

This describes the intended data shape without fixing an exact future
TypeScript interface. Existing public buffers remain the compatibility contract
while the internal preparation boundary evolves. A renderer consumes prepared
numeric data and chooses its own local origin, GPU representation, resources,
and picking integration.

## Package boundary

### Current distribution

The current distribution is one npm package with renderer subpath exports:

```text
@frillab/copc-adapter         → backwards-compatible Cesium root
@frillab/copc-adapter/cesium  → explicit Cesium entrypoint
@frillab/copc-adapter/three   → Three.js entrypoint
```

The root entry remains backwards compatible with existing Cesium consumers.
Cesium and Three.js are optional peer dependencies; an application installs the
renderer it uses. The package currently carries the browser decoder runtime
assets and exposes the project-owned shared streaming/data contract through
the renderer entrypoints.

Single-package distribution is a current release/distribution choice, not a
permanent architectural constraint. Internal boundaries should allow a future
package arrangement such as:

```text
shared core/runtime
        + Cesium adapter package
        + Three.js adapter package
```

That split is optional and should happen only if it is justified by consumer
needs and validation. It must not require duplicate COPC, CRS, or streaming
implementations.

## Migration invariants

Architecture changes should preserve these properties:

- Public root, Cesium, and Three.js entrypoints remain compatible unless a
  deliberate API change is documented.
- The `CopcBackend` boundary continues to expose project-owned types rather
  than decoder- or renderer-specific types.
- HTTP Range semantics remain explicit and structured; a source that ignores
  Range is not silently treated as an efficient stream.
- Rust backend failures are surfaced as Rust/backend errors and are never
  silently retried through `copc-js`.
- Requested point fields remain explicit, and unavailable source attributes
  remain unavailable.
- Coordinate-space labels and high-precision intermediate values are preserved
  until a renderer deliberately chooses its local/GPU representation.
- Streaming policy remains renderer-neutral, coverage-preserving, generation
  aware, and bounded by node and point workload limits.
- The current JavaScript implementations remain useful differential references
  during Rust migration, but reference behavior is not accepted blindly as the
  specification.

The public surface is documented in [API.md](API.md), conceptual development
stages are in [ROADMAP.md](ROADMAP.md), and correctness and differential
validation are in [CONFORMANCE.md](CONFORMANCE.md).

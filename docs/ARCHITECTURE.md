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
point preparation (Rust fused path or TypeScript copc-js path)
        ├─ source coordinates → WGS84 geographic coordinates
        ├─ WGS84 geographic → WGS84 ECEF/world coordinates
        └─ project-owned typed buffers, attributes, and statistics
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
- `copc-adapter-core` owns renderer-neutral LAS/COPC metadata and hierarchy parsing,
  LAZ node decompression, supported point-format interpretation, requested
  field selection, source-coordinate buffer creation, the opt-in reusable
  `CrsTransform`, and WGS84 geographic/ECEF numeric preparation. It returns
  typed Rust results and errors and has no WebAssembly or browser dependency.
- `copc-adapter-wasm` is the thin ABI wrapper around `copc-adapter-core`. It owns pointer/length
  validation, WASM allocation and deallocation, copying core-owned buffers into
  host-provided memory, JavaScript-safe integer checks, and JSON/status
  encoding. TypeScript still fetches the exact byte ranges, owns the reader and
  worker orchestration, and maps results into project-owned types.
- `CopcStreamingCore` and `CopcStreamingController` own hierarchy lifecycle,
  view-driven selection, `NodeSelector`, SSE/refinement policy, hysteresis,
  adaptive current-view distance, workload budgets, cache policy, generations,
  cancellation, and diagnostics. The adaptive distance uses only plain
  perspective-frustum values, so Cesium and Three.js feed the same footprint,
  overscan, hard-cap, and hysteresis policy.
- The `copc-js` path uses the project WKT parsing helpers and `proj4js` where a
  projected CRS is present, then computes WGS84 ECEF/world coordinates in
  TypeScript. The opt-in Rust path performs decode, CRS, ECEF preparation, and
  point reductions in one Worker job. Both paths return the same
  `PreparedPointData` contract, retaining source, WGS84 geographic, and WGS84
  ECEF values as `Float64Array`s.
  The `proj4rs`/`proj4wkt` compatibility audit is recorded in
  [issue-171-proj4rs-compatibility.md](benchmarks/issue-171-proj4rs-compatibility.md);
  it does not change this runtime boundary or remove `proj4js`.
- Cesium and Three.js adapters convert the shared data into engine-specific
  resources. The Cesium compatibility renderer owns one root
  `Cesium.PrimitiveCollection` per attached layer and keeps node point
  collections below it; the application owns its `Viewer`, camera, scene, and
  canvas. Three.js owns `THREE.Group`, `THREE.Points`, `BufferGeometry`,
  materials, and its fixed dataset-local ENU frame. Neither adapter parses
  COPC or owns streaming policy.

### Browser thread ownership for the production backends

`async` I/O does not move parsing or decoding off the main thread. The current
production ownership is:

| Stage | `backend: 'copc-js'` | `backend: 'rust'` | Cesium / GPU boundary |
| --- | --- | --- | --- |
| Open, metadata, and hierarchy | Main thread: `Copc.create` and hierarchy loading/parsing through `copc`. | Main thread: `RustCopcReader` performs metadata and hierarchy parsing through Rust/WASM. | Not involved. |
| Range I/O and streaming policy | Main thread owns Range requests, response validation, hierarchy selection, scheduling, cancellation, and caches. | Same; the Worker does not fetch source bytes or choose nodes. | Camera/view updates enter through the main-thread Cesium adapter. |
| LAZ decode and point preparation | Main thread: `Copc.loadPointDataView`, followed by TypeScript coordinate preparation and typed-buffer creation. These decode events are marked `blocksMainThread: true`. | When browser `Worker` is available, the bounded Rust Worker pool decodes LAZ and prepares source/geographic/ECEF buffers, requested fields, and statistics. Input chunks and results cross the Worker boundary as transferred buffers. | Renderer-facing data is returned to the main thread. |
| Renderer preparation and submission | Main thread. | Main thread, after Worker results arrive. | Cesium layer and node `PrimitiveCollection` creation, `Cartesian3` wrapping, `PointPrimitiveCollection` updates, and styling run on the main thread. Cesium submits WebGL work for browser/GPU execution; this does not make adapter-side primitive preparation a Worker task. |

The default Rust pool size is derived from `navigator.hardwareConcurrency` and
capped at four Workers. Dispatch never assigns more active jobs than the
configured pool size; the streaming scheduler separately bounds node loads.

The trace follows `CopcJsSource.loadPointDataView` in
`packages/core/copc/backend/copcJsBackend.ts`, Rust range reads and
prepared-node dispatch in `packages/core/copc/rustCopcReader.ts`, Worker
jobs in `packages/core/copc/rustCopcDecodeWorker.ts` and
`rustCopcDecodeWorkerPool.ts`, streaming/cache/render handoff in
`packages/core/streaming/CopcStreamingController.ts`, and Cesium
primitive updates in `packages/cesium/render/CopcPointRenderer.ts`.

If `Worker` is unavailable, the Rust backend uses its Rust/WASM decode and
preparation path on the main thread. This is an environment capability path,
not a retry through `copc-js`; Worker failures are surfaced as backend errors.
Neither backend moves Cesium rendering or camera controls into a Worker.

The designated-task validation path is the public Cesium entrypoint with an
explicit `backend: 'rust'` selection, exercised from a packed external Vite
consumer. This selects the Worker-isolated Rust decode/preparation path without
changing the default (`copc-js`) or removing either backend. The Autzen
camera-input and Worker diagnostics run is recorded in
[`issue-208-worker-responsiveness.md`](benchmarks/issue-208-worker-responsiveness.md).

`copc-js` remains the default backend and uses the TypeScript reference
preparation path. The opt-in Rust backend uses the fused Rust preparation path;
its failure is reported to the caller and is not silently retried through the
TypeScript transform path.

The repository contains `crates/core` and `crates/wasm`. The former
is the native-testable domain implementation; the latter exposes the existing
Rust/WASM ABI without owning COPC parsing or decoding rules. This extraction is
complete for the supported release scope, including fused point preparation and
statistics. Broader processing-core coverage and backend migration remain
future work.

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
        ↓ backend-selected CRS path
WGS84 geographic (`wgs84-geographic`)
        ↓ backend-selected ECEF preparation
WGS84 ECEF/world (`wgs84-ecef-meters`)
        ↓ renderer-owned origin/frame
renderer-local coordinates
```

The Three.js adapter currently uses an immutable dataset-local East/North/Up
frame whose origin is derived from the metadata cube centre. It converts to
renderer/GPU-friendly values only after subtracting that origin. This is a
renderer concern, not a shared streaming coordinate system.

The shared prepared-point contract is `PreparedPointData`. The current path
constructs it after the Rust/JS source decode and retains tagged Float64 source,
WGS84 geographic, and WGS84 ECEF buffers, requested typed attributes, and
small reusable point statistics. The decoded CPU cache stores this contract,
not renderer objects. Its flat geographic fields are compatibility aliases to
the named buffers. Rust/WASM marks its returned source buffer as
`copc-source`; the Worker transfers owned ArrayBuffers and TypeScript copies
out of WASM linear memory before cache insertion. This is the stable seam for
the backend-neutral renderer boundary. Rust/WASM returns the same contract
directly from its fused decode/CRS/ECEF/statistics operation, while copc-js
continues to use the TypeScript reference implementation.

### Coordinate Transform Plan (version 1)

`CoordinateTransformPlan` is the immutable, renderer-neutral description of a
dataset's logical coordinate path. `createCoordinateTransformPlan` exposes a
snapshot for diagnostics, and the TypeScript forward and inverse transformers
carry the same plan on their `plan` property. The streaming core resolves the
memoized plan once per metadata/operation input tuple and uses it to coordinate
the Rust prepared-point post-processing path.

The version 1 order is:

```text
decode LAS scale/offset
  → normalize source axes and units
  → transform horizontal reference to WGS 84 geographic
  → apply a verified vertical grid once, when configured
  → apply manual ellipsoidal height offset once
  → apply separately approved terrain placement residual in the viewer
  → prepare WGS 84 ECEF
```

Rust may fuse decode, source CRS conversion, unit conversion, the manual offset,
and ECEF preparation. For a configured grid, TypeScript removes any offset
already fused by Rust, samples the grid, then applies the requested offset and
rebuilds ECEF in one shared post-processing pass. This preserves the plan order
without an extra per-point allocation pass. Source coordinates remain intact.
No-grid plans retain the existing height pass-through and record unknown
vertical-reference reasons from the source CRS diagnostic. A plan's confidence
describes metadata evidence; backend transform support remains
backend-dependent.

Each plan records source and target CRS identities, source axis/unit evidence,
manual offset, WKT selection provenance, optional grid id and SHA-256, grid
coverage/extrema, matched grid epochs, inverse-query requirements, and stable
unsupported reasons. Its identity key is the exact JSON tuple of source WKT and
selection, source bounds and LAS scale/offset, grid identity/extent/epochs, and
height offset. The key is an identity value, not a content checksum.

Prepared/cache lifetime supplies the remaining identity dimensions. A
streaming core owns one transform configuration and node cache for a source
generation; reload replaces that cache and stale worker results are rejected
by the existing generation checks. Experimental compact-E cache entries also
retain source identity, source WKT, transform generation, height offset, and
grid id/hash. Any future TerrainProvider or approved placement-residual change
must advance the owning layer generation. Terrain residuals stay outside the
geodetic plan and are never represented as datum conversion.

The inverse plan requires camera/LoD bounds to reverse manual offsets, vertical
grid conversion, and horizontal projection when supported. Synthetic query
bounds use conservative grid extrema rather than sampling artificial corners.
The plan describes required inverse semantics; actual CRS inverse support is
reported as backend-dependent and failures remain fail-closed.

## Future processing direction

The current architecture above already provides the pure Rust processing core,
thin WASM boundary, fused Rust point preparation, shared TypeScript streaming
core, and Cesium/Three.js adapters. Future processing work should extend those
boundaries without moving view-level streaming policy into Rust or renderer
concerns into the processing crates. The intended direction is:

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
browser/streaming policy and lifecycle as broader point-level coverage evolves.

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
  core/
  wasm/
```

`copc-adapter-core` is pure Rust. It has no JavaScript, WebAssembly-specific pointer
ABI, browser, Cesium, or Three.js dependency. Its native tests exercise the
same metadata, hierarchy, and point-decoding behavior used by the WASM path.

`copc-adapter-wasm` is a thin wrapper around that core. It owns memory allocation and
deallocation, ABI validation, JS/WASM result transfer, and WebAssembly-specific
error/result encoding. COPC domain rules remain in `copc-adapter-core`; renderer
behavior remains outside both crates.

## CRS architecture

### TypeScript CRS path

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
coverage. This is the reference path used by copc-js and injected decoders.

### Rust CRS path

The Rust processing pipeline used by the opt-in prepared-point path is:

```text
COPC/source coordinates
        ↓ Rust CRS layer
WGS84 geographic coordinates
        ↓ Rust world-coordinate preparation
WGS84/world coordinates and prepared buffers
        ↓ renderer adapter
renderer-specific local representation
```

`proj4rs` and `proj4wkt` are the current implementation choices behind the
renderer-independent core abstraction. They are used only for the supported
CRS behavior measured against real COPC metadata and fixtures; full PROJ
coverage is not implied.

The current audit result is **RUST CRS READY WITH FOCUSED UPSTREAM/FOLLOW-UP**:
Autzen and SoFi's extracted horizontal CRS paths pass differential validation,
while full SoFi compound-WKT parsing and the current `PROJCS`-only adapter
boundary remain explicit follow-up items. The production core uses a focused
nested-`PROJCS` compatibility path for the SoFi parser gap and reports whether
it was used. See
[issue-171-proj4rs-compatibility.md](benchmarks/issue-171-proj4rs-compatibility.md)
for the compatibility matrix and
[issue-173-rust-crs-integration.md](benchmarks/issue-173-rust-crs-integration.md)
for the core/WASM API and integration evidence.

Existing `proj4js` behavior is useful as a differential reference for the
copc-js path. Reference output is not automatically the specification:
authoritative CRS definitions
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

The Rust backend uses one coarse-grained Worker operation per useful node:

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

The Worker initializes one `CopcNodePreparer` per source. That state retains
validated LAS/LAZ metadata and the initialized CRS transform, so node jobs
transfer only the compressed chunk, point count, and field mask. The core
decodes the chunk, transforms each point, computes elevation/intensity/RGB
reductions, and packs the prepared buffers in the same point traversal. The
result reports separate decode and point-preparation timings.

The TypeScript boundary copies every returned typed array out of WASM linear
memory before transferring it from the Worker. The cache owns the transferred
source, geographic, ECEF, and requested attribute arrays; no WASM view is
retained. The existing decode-only API remains available for backend
conformance and reference consumers, while Rust streaming uses the fused
prepared result. Worker scheduling, stale generations, cancellation, and
renderer lifecycle remain TypeScript responsibilities.

## Renderer-neutral data contract

The implemented shared prepared-data contract is `PreparedPointData`:

- point count;
- tagged `Float64Array` source (`copc-source`), geographic
  (`wgs84-geographic`), and world (`wgs84-ecef-meters`) coordinate buffers;
- requested attributes;
- reusable elevation/intensity ranges and RGB value scale when available; and
- compatibility aliases for the existing flat geographic buffer API.

Source and geographic buffers are retained for inspection and differential
validation; ECEF/world is the primary shared render buffer. The Cesium adapter
wraps those ECEF triples directly as `Cartesian3` values; it does not call
`Cartesian3.fromDegrees` for prepared data. Three.js derives its stable
dataset-local ENU/Float32 representation from the same ECEF buffer. These are
adapter-owned secondary representations. The cache owns the transferred typed
arrays for the lifetime of the entry, while renderers only read them and own
any derived engine/GPU resources. A renderer consumes prepared numeric data and
chooses its own local origin, GPU representation, resources, and picking
integration.

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

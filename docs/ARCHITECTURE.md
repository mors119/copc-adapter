# Architecture

## Goal

The project goal is to visualize COPC source data directly in CesiumJS without
preprocessing it into another point-cloud tile format. The current MVP obtains
metadata, hierarchy pages, and selected point chunks from a COPC resource, then
converts those points into Cesium primitives in the browser.

## Runtime Flow

```text
Browser-readable COPC URL
  -> project-owned CopcBackend / CopcSource boundary
  -> copc-js (default) or Rust/WASM (explicit opt-in)
  -> CopcStreamingController
  -> metadata and incremental hierarchy-page queries
  -> streaming hierarchy and camera-based node selection
  -> selected project-owned point buffers and update intents
  -> coordinate transformation to WGS84
  -> engine adapter / CopcPointRenderer boundary
  -> PointPrimitiveRenderer (Cesium PointPrimitiveCollection compatibility path)
```

The root hierarchy page is loaded before point streaming begins. Each camera
update gives the stateful `HierarchyLoader` a project-owned bounds/max-level
query. It fetches intersecting page references only, retains page promises and
decoded entry metadata per layer/source instance, and exposes the currently
available nodes to the streaming manager. Point-buffer caching remains a
separate concern.

## Module Boundaries

| Area | Location | Responsibility |
| --- | --- | --- |
| COPC backend boundary | `apps/viewer-web/src/copc/backend/` | Define project-owned source capabilities and isolate the `copc.js` and Rust/WASM adapters |
| COPC loading | `apps/viewer-web/src/copc/` | Consume backend-neutral metadata, hierarchy, and point-view types |
| Coordinate transformation | `apps/viewer-web/src/coordinates/` | Convert COPC coordinates to WGS84 longitude, latitude, and height |
| WASM decoder | `crates/copc-wasm/`, `apps/viewer-web/src/wasm/` | Convert XYZ values into an interleaved point buffer |
| Streaming core | `apps/viewer-web/src/viewer/streaming/` | Own source/context, metadata and hierarchy lifecycle, view-driven selection, generations, point loading, update intents, diagnostics, and the bounded point cache |
| Cesium rendering | `apps/viewer-web/src/cesium/` | Consume geographic point buffers through the renderer boundary; the baseline uses point primitive collections |
| Renderer boundary | `apps/viewer-web/src/cesium/render/CopcPointRenderer.ts` | Own node add/update/remove/clear/destroy and optional point identity; no COPC or selection logic |
| Renderer-neutral controller | `apps/viewer-web/src/viewer/streaming/CopcStreamingController.ts` | Coordinate loading, hierarchy queries, selection, point streaming, lifecycle, generations, and engine-independent diagnostics |
| Cesium compatibility controller | `apps/viewer-web/src/viewer/CopcViewer.ts` | Existing Cesium attachment, camera conversion, point rendering, picking, and coverage-safe renderer reconciliation; migration to the shared core is the follow-up adapter work |
| Public API | `apps/viewer-web/src/api/`, `apps/viewer-web/src/index.ts` | Expose `CopcCesiumLayer` and its public types |

External `copc.js` types stay inside `copcJsBackend.ts`. The context, loaders,
streaming controller, and decoder communicate through project-owned interfaces.
Cesium types are
used only by the rendering and public attachment boundary, not by core COPC
domain types.

## Renderer-neutral streaming core (#132)

`CopcStreamingController` is the shared lifecycle seam for future rendering
engines. It owns the opened `CopcSource`, metadata, incremental
`HierarchyLoader`, `StreamingManager`, decoded point cache, load/view
generations, current selected node keys, replacement intents, and diagnostics.
It emits `StreamingProgress` as selected geographic point buffers become ready;
an adapter may submit each buffer to its renderer and use the replacement
groups to preserve coverage while a refinement or collapse is prepared.

The controller accepts only the project-owned `StreamingView` contract. A view
contains geographic camera position, a view-distance limit, and an optional
plain perspective `ViewFrustum` in WGS84 ECEF metres. It contains no engine
camera, viewer, scene, render-loop callback, or frame-rate state. Adapters are
responsible for converting camera state and deciding when to call
`updateView(view)`.

The existing Cesium controller remains the compatibility attachment path while
the renderer-specific migration is staged separately in #135. The new core is
independently usable by a future adapter and is covered by tests that do not
import Cesium; #135 will make the existing Cesium path consume it so the
repository has one streaming engine.

## Rust Decode Worker Pool (#46)

The existing Rust backend remains the only COPC loading pipeline. In a browser,
`RustCopcReader` keeps ownership of exact byte-range requests on the main
thread through `HttpRangeByteSource`; this preserves the established range
semantics, request diagnostics, and source factories. It transfers the fetched
metadata/chunk bytes to a worker pool only after the range has completed. The
workers perform Rust/WASM LAZ decode and requested-field extraction, then return
the same project-owned `CopcPointBuffer` contract.

Each opened Rust source owns its own pool, so layer instances do not share WASM
or queue state. The default pool is bounded to at most four workers and one
fewer than `navigator.hardwareConcurrency` (with a minimum of one). Jobs enter
a deterministic FIFO queue; callers may remove obsolete queued jobs or apply a
priority comparator. An active WASM call is allowed to finish when it cannot be
aborted, but its result is ignored when the streaming generation is stale.
Worker failures become `CopcBackendError` values with `stage: 'decode'` and
`code: 'worker'`. Unload/destroy terminates workers and rejects pending work.

WASM is initialized lazily in each worker on its first assigned job. The worker
imports the package's `copcWasm` module, which resolves the emitted WASM asset
relative to the built worker module via `import.meta.url`; it never uses
`/public`, `target/`, or repository-relative paths. Vite therefore emits both
the worker chunk and its package-local WASM dependency for an installed
consumer.

Decode output uses transferable `ArrayBuffer`s for XYZ and each requested
attribute (RGB remains three `Uint16Array`s, intensity `Uint16Array`, and
classification `Uint8Array`). The pool copies a non-owned input view before
transfer, so a detached sender buffer cannot be reused accidentally. No large
point array is serialized through JSON; the only JSON crossing the worker is
the small Rust status response inside the worker runtime.

## Backend Boundary

`CopcBackend.open(url)` returns a reusable `CopcSource`. A source exposes only
the capabilities the runtime needs: metadata, the root hierarchy page,
hierarchy-page loading, and project-owned point data. `CopcJsBackend` remains
the default production implementation. `RustCopcBackend` is selected with
`backend: 'rust'`; it uses `HttpRangeByteSource` and `RustCopcReader`, and
returns the same metadata, hierarchy, point count, coordinate, and optional
attribute semantics. Neither backend creates a Cesium viewer.

The public selection is additive:

```ts
new CopcCesiumLayer({ url, backend: 'rust', colorMode: 'elevation' });
```

Omitting `backend` or passing `'copc-js'` selects the stable implementation.
An injected `CopcBackend` remains supported for tests and host-owned sources.
There is no automatic Rust-to-JS fallback: a Rust source or decode error is
reported with its backend error category so validation cannot be masked.

Callers may inject a backend for an alternative implementation or unit tests.
There is intentionally no second placeholder production backend.

## Public Layer Lifecycle

`CopcCesiumLayer` accepts a COPC URL, optional point size, debug flag, and
streaming overrides. It deliberately does not create or own a Cesium viewer.

1. `load()` creates the COPC context, reads metadata, and loads only the root
   hierarchy page.
2. `attachTo(viewer)` registers the camera listener, flies to the dataset once,
   and starts a streaming update. The adapter converts its camera envelope into
   a project-coordinate hierarchy query and supplies the configured target
   depth.
3. Camera movement schedules another hierarchy query and streaming update;
   previously loaded pages are reused and newly intersecting pages are added.
4. `detachFrom()` removes this layer's primitives and listener but preserves
   loaded COPC state and the caller-owned viewer.
5. `unload()` clears loaded state and cached point requests.
6. `reload()` performs `unload()` followed by `load()`.
7. `destroy()` releases layer resources and still does not destroy the viewer.

## Current Selection and Cache Behavior

The current selection policy uses node bounds, camera distance, a maximum
depth, and a render-distance limit. `StreamingManager` loads missing selected
nodes and removes deselected primitives. The node cache is bounded and evicts
least-recently-used entries.

`CopcHierarchyQuery` contains only project-coordinate bounds and an optional
`maxLevel`; it has no Cesium camera, culling, or screen-space-error types. The
adapter owns the camera envelope and target-depth policy. `HierarchyLoader`
owns page-reference traversal and its per-source page cache, while the Rust
and copc.js sources own byte/page decoding. Hierarchy diagnostics report page
requests, cache hits, fetched hierarchy bytes, and loaded entry counts.

The selector uses a project-owned perspective screen-space-error policy. COPC
`spacing` is the distance between points at the root level and halves at every
octree level. Since COPC does not provide a per-node geometric-error field, the
adapter uses `max(spacing / 2^level, nodeExtent / 2)` as a conservative detail
scale in metres. For a visible node it projects that scale with:

```text
SSE_pixels = detailScaleMeters * viewportHeightPixels /
             (2 * distanceToNodeBoundsMeters * tan(verticalFovRadians / 2))
```

The node refines when `SSE_pixels > maxScreenSpaceError` (default `8`). The
distance is clamped to at least the node detail scale when the camera is
inside a node volume, preventing a singular near-field projection.
viewport height and vertical FOV come from the Cesium camera adapter; the
selector consumes only plain project-owned values. Frustum filtering happens
before SSE, and `maxDepth`/`maxNodes` remain safety caps. This is intentionally
not a copy of Cesium3DTileset traversal or private SSE implementation, nor is
it a worker-based loader or GPU-specific point-cloud renderer.

After frustum/SSE selection, the adapter applies a rendered-point workload
budget using each hierarchy node's `pointCount` as its estimated cost. The
default `maxRenderedPoints` is an experimental conservative `250000`: the
issue-48 benchmark measured roughly 30 ms of renderer preparation at 100k
points and severe near-view pressure at 418k points. Budget priority is
projected SSE, then bounds distance and level, with prior selection continuity
and decoded-cache availability used only as deterministic tie-breakers. Nodes
that do not fit are deferred before point fetch/decode begins; a single node is
not partially rendered. `maxNodes` remains an independent node-count safety
cap, and `maxDepth` remains the hierarchy traversal cap.

`StreamingManager` processes only budgeted nodes in bounded sequential batches.
Camera generations invalidate stale work and cancel queued worker decodes; stale
completion is ignored. The controller also checks actual decoded point counts
before renderer submission, so cache hits and custom sources cannot push the
active renderer over the configured budget. Debug snapshots expose the
configured budget, candidate and active points, deferred node/point counts,
utilization, budget defer/drop count, range bytes, stage timings, and Rust
worker queue/concurrency metrics. This is rendered workload backpressure, not
a claim about exact Cesium/WebGL memory.

Occlusion culling is intentionally not part of the current selection contract.
The Issue #60 investigation found no stable public Cesium API that can prove a
COPC node is fully hidden by terrain or arbitrary scene geometry. Depth and
height sampling are incomplete whole-node evidence, and Cesium private depth
internals are outside the supported boundary. Until a repeatable workload
demonstrates a material hidden-node cost and supplies conservative visibility
evidence, uncertain nodes follow the existing visible path. See
[`docs/benchmarks/issue-60-occlusion.md`](benchmarks/issue-60-occlusion.md).

## Point Field Contract

The project-owned `CopcPointFieldSelection` contains `position`, `intensity`,
`classification`, and `rgb`. Styling maps deterministically to the minimum
selection: fixed/elevation request position only; RGB, intensity, and
classification request position plus their corresponding field. The selection
crosses the backend boundary without Cesium or `copc.js` types.

`CopcPointView.availableFields` contains only fields that were both requested
and found in the source point format. An absent or unrequested field is not
represented by a zero-filled array. A field whose getter fails propagates the
decoder error. RGB remains `Uint16Array` in `CopcPointBuffer` and is normalized
only by the Cesium styling boundary.

`CopcPointDecoder.decode(view)` remains available for injected decoders and
legacy source implementations. Both production backends also expose the
optional direct `loadPointDataBuffer()` capability; the default point-loading
path uses that capability, so Rust decodes the selected node once and returns
project-owned typed arrays. Buffer validation rejects coordinate or attribute
length mismatches before transformation/rendering. Coordinate transformation
retains the same attribute arrays, keeping the decoder boundary replaceable
without changing the streaming or Cesium layers.

The current `copc.js` release still returns a complete point view internally,
so `CopcJsBackend` enforces the selection by filtering the project-owned view.
The Rust backend passes the same request to its selective LAZ decode path.

`StreamingManager` owns the selected-node protection set for the decoded point
cache, while `createNodePointCache` owns its byte accounting and eviction. A
resolved entry is charged the sum of the actual `byteLength` values of its
project-owned typed arrays (including coordinates and present attributes).
Inactive entries are evicted least-recently-used when either the 48-node safety
cap or configured `maxPointCacheBytes` budget is exceeded. Selected entries are
protected; a single oversized selected entry is retained deterministically.
The diagnostics describe decoded CPU point-buffer memory only, not exact
Cesium/WebGL/browser memory.

## Random-Access Byte Source

`apps/viewer-web/src/copc/range/` defines the project-owned
`RandomAccessByteSource` boundary for the future Rust/WASM reader. Its core
operation is `readRange(offset, length)`, with `readRanges()` for a logical
batch and `size()` for an optional known source length. The boundary is
backend-neutral and can be implemented by a browser HTTP source, an in-memory
source, or a future worker/local-file bridge.

`HttpRangeByteSource` owns browser network I/O. It sends one `Range:
bytes=start-end` request per read and runs `readRanges()` requests concurrently.
Every partial response must be HTTP 206, include a matching `Content-Range`,
and contain exactly the requested number of bytes. A 200 whole-resource
response, 404/416 response, malformed range metadata, short body, invalid
range, and network failure become a structured `RangeSourceError`; a server
that ignores Range is never counted as efficient streaming. `Content-Range`
also supplies a cached total size when available.

`probeCopcSource()` builds diagnostics on the same content-range parser and
exact body-length contract. It requests a bounded prefix, optionally reads
only the missing LAS VLR bytes, and never participates in normal layer loads.
Its result is a project-owned summary for application diagnostics and the demo
debug panel; the panel does not own networking.

Callers pass an `AbortSignal` for cancellation. The camera/streaming owner can
create a controller per generation and abort the previous generation when a
new camera state supersedes it; the source does not retain camera or Cesium
state. This keeps staleness policy in the caller while making cancellation
observable as `RangeSourceError` with code `aborted`.

Browser deployment requires the COPC host to allow the `Range` request header
and expose `Content-Range` (and any application request headers) through CORS;
`Access-Control-Allow-Origin` must allow the consuming origin. A server must
also return byte ranges rather than silently returning 200 for the whole
resource. The `InMemoryByteSource` provides the same bounds-checked semantics
without a browser, so Rust-facing parsing tests can use deterministic bytes.

This boundary is additive: the existing `copc.js` backend remains the default
runtime backend. Rust consumes the source contract without taking a dependency
on Cesium; browser HTTP range I/O is isolated in `HttpRangeByteSource`.

## Rust COPC Header and Root Reader

`apps/viewer-web/src/copc/rustCopcReader.ts` is the first consumer of the
random-access boundary. `RustCopcReader.open()` reads the LAS 1.4 header and
VLR area, passes those bytes to `copc-wasm`, then reads the COPC root hierarchy
page by the offset and length returned by the COPC info VLR. TypeScript owns
range I/O and maps the compact parser result into project-owned metadata and
hierarchy values; Rust owns little-endian interpretation, COPC validation, and
structured parse errors.

`RustCopcReader.loadPointDataBuffer()` is the focused node-decoding proof path.
It requests only `pointDataOffset..pointDataOffset + pointDataLength` for one
hierarchy entry and passes that exact chunk, together with the metadata bytes,
to the Rust decoder, either directly for non-browser runtimes or through the
per-source worker pool in a browser. The Rust ABI returns project-owned XYZ,
intensity, classification, and RGB buffers. LAS scale/offset is applied once
in Rust while converting raw integer coordinates to the existing
projected-coordinate contract.

The decoder dependency is `laz 0.13.0`, used through its public layered
point-record decompressor. It supports the COPC layered chunks used by LAS
1.4 point formats 6, 7, and 8, including the crate's selective field
decompression API. The crate builds for `wasm32-unknown-unknown` in this
repository. `360-geo/copc-streaming` is intentionally not a dependency and no
reference source is vendored. Rust is opt-in; `copc.js` remains the default,
but errors from the selected Rust backend are never silently retried in JS.

Backend errors expose a project-owned `CopcBackendError` with a stage and
category such as `source-range`, `header-parse`, `hierarchy`, `point-chunk`,
`laz-decode`, `unsupported`, or `wasm`. The original range/parser/decoder
error is retained as `cause`, and point failures include the hierarchy node key.

The metadata and hierarchy parser ABI uses a small NUL-terminated JSON
response. The node decoder uses the same bounded status/error envelope while
writing its project-owned typed output buffers directly. Parser responses are
bounded by the header/VLR area and one root page; point output is bounded by
the selected node's point count.
Root entries with `pointCount == -1` are returned as `pages`, while all
non-negative point counts are returned as point-data `nodes`. Offsets and
lengths are checked against JavaScript's safe-integer range before they cross
the boundary.

The implementation was checked against the COPC 1.0 specification's LAS/VLR,
COPC info VLR, and hierarchy-page entry definitions, and against the
`copc_types.rs`, `header.rs`, and `hierarchy.rs` concepts in the 360-geo
projects. The code and tests independently reimplement those concepts and do
not require an external repository at build or test time.

Point styling consumes these transformed buffers directly. RGB channels are
normalized from their detected 8-bit or 16-bit range, intensity is normalized
per loaded node buffer, and classification values use a fixed categorical
palette. Missing attributes select the backward-compatible fixed cyan color.

## Package Boundary

`apps/viewer-web/src/index.ts` is the only public source entrypoint. The viewer
package also has an ESM declaration and bundle build configuration. Library
builds include the Rust/WASM decoder and package-local LAZ decoder runtime in
the `npm pack` artifact, while Cesium remains an external peer dependency owned
by the consuming application.

## Browser Acceptance Coverage

`apps/viewer-web/e2e/copc-viewer.spec.ts` starts the real Vite application in
Chromium with `?backend=rust`, loads the local Autzen COPC sample, and verifies
metadata, decoded point rendering, actual Cesium point primitive collections,
and camera-driven streaming updates. The application installs
`window.__COPC_DEBUG__` only in Vite development mode to make those runtime
states observable; it is not a production API.

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
  -> default copc.js backend and getter
  -> metadata and recursive hierarchy loading
  -> streaming hierarchy and camera-based node selection
  -> selected COPC point-data views
  -> Rust/WASM XYZ interleaved buffer decoder
  -> coordinate transformation to WGS84
  -> Cesium PointPrimitiveCollection
```

The hierarchy is loaded before point streaming begins. The streaming manager
then requests point chunks only for the nodes selected by the current camera
state.

## Module Boundaries

| Area | Location | Responsibility |
| --- | --- | --- |
| COPC backend boundary | `apps/viewer-web/src/copc/backend/` | Define project-owned source capabilities and isolate the default `copc.js` adapter |
| COPC loading | `apps/viewer-web/src/copc/` | Consume backend-neutral metadata, hierarchy, and point-view types |
| Coordinate transformation | `apps/viewer-web/src/coordinates/` | Convert COPC coordinates to WGS84 longitude, latitude, and height |
| WASM decoder | `crates/copc-wasm/`, `apps/viewer-web/src/wasm/` | Convert XYZ values into an interleaved point buffer |
| Streaming | `apps/viewer-web/src/viewer/streaming/` | Build selection data, choose nodes, and maintain the bounded point cache |
| Cesium rendering | `apps/viewer-web/src/cesium/` | Create viewers and render point primitive collections |
| Internal controller | `apps/viewer-web/src/viewer/CopcViewer.ts` | Coordinate loading, camera events, streaming, and primitive lifecycle |
| Public API | `apps/viewer-web/src/api/`, `apps/viewer-web/src/index.ts` | Expose `CopcCesiumLayer` and its public types |

External `copc.js` types stay inside `copcJsBackend.ts`. The context, loaders,
streaming controller, and decoder communicate through project-owned interfaces.
Cesium types are
used only by the rendering and public attachment boundary, not by core COPC
domain types.

## Backend Boundary

`CopcBackend.open(url)` returns a reusable `CopcSource`. A source exposes only
the capabilities the runtime needs: metadata, the root hierarchy page,
hierarchy-page loading, and point-data-view loading. `CopcJsBackend` is the
default production implementation and adapts all `copc.js` values before they
cross this boundary. A future Rust/WASM metadata or hierarchy reader can
implement the same interfaces without changing `CopcLayerController`, the
streaming manager, or Cesium rendering.

Callers may inject a backend for an alternative implementation or unit tests.
There is intentionally no second placeholder production backend.

## Public Layer Lifecycle

`CopcCesiumLayer` accepts a COPC URL, optional point size, debug flag, and
streaming overrides. It deliberately does not create or own a Cesium viewer.

1. `load()` creates the COPC context, reads metadata, and traverses hierarchy
   pages.
2. `attachTo(viewer)` registers the camera listener, flies to the dataset once,
   and starts a streaming update.
3. Camera movement schedules further streaming updates.
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

This is intentionally a basic streaming policy. It is not screen-space-error
selection, worker-based loading, or a GPU-specific point-cloud renderer.

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

`CopcPointDecoder.decode(view)` is independent of the source backend. The
default decoder uses Rust/WASM for XYZ interleaving and reads only available
requested attributes into optional typed arrays. Buffer validation rejects
coordinate or attribute length mismatches before transformation/rendering.
Coordinate transformation retains the same attribute arrays, keeping the
decoder boundary replaceable without changing the streaming or Cesium layers.
Tests may inject a decoder without loading WebAssembly.

The current `copc.js` release still returns a complete point view internally,
so `CopcJsBackend` enforces the selection by filtering the project-owned view.
It makes no selective-LAZ performance claim; a future Rust backend can use the
same request to skip unneeded decode layers.

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

This boundary is additive in the current issue: the existing `copc.js`
backend remains the default runtime backend. The next Rust/WASM reader can
consume the source contract without taking a dependency on `fetch` or Cesium,
while the current viewer and package asset model remain unchanged.

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
to Rust. The Rust ABI returns project-owned XYZ, intensity, classification, and
RGB buffers. LAS scale/offset is applied once in Rust while converting raw
integer coordinates to the existing projected-coordinate contract.

The decoder dependency is `laz 0.13.0`, used through its public layered
point-record decompressor. It supports the COPC layered chunks used by LAS
1.4 point formats 6, 7, and 8, including the crate's selective field
decompression API. The crate builds for `wasm32-unknown-unknown` in this
repository. `360-geo/copc-streaming` is intentionally not a dependency and no
reference source is vendored. The existing `copc.js` backend remains the
default and stable fallback while this Rust path is differentially validated.

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
Chromium, loads the local Autzen COPC sample, and verifies metadata, decoded
point rendering, actual Cesium point primitive collections, and camera-driven
streaming updates. The application installs `window.__COPC_DEBUG__` only in
Vite development mode to make those runtime states observable; it is not a
production API.

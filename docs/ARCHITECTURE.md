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

## Decoder Boundary

`CopcPointDecoder.decode(view)` is independent of the source backend. The
default decoder uses Rust/WASM: it receives the X, Y, and Z values and returns a project-owned
interleaved point buffer. The TypeScript side reads available intensity,
classification, and RGB dimensions into optional typed arrays. Coordinate
transformation retains the same attribute arrays, keeping the decoder boundary
replaceable without changing the streaming or Cesium rendering layers.
Tests may inject a decoder without loading WebAssembly.

Point styling consumes these transformed buffers directly. RGB channels are
normalized from their detected 8-bit or 16-bit range, intensity is normalized
per loaded node buffer, and classification values use a fixed categorical
palette. Missing attributes select the backward-compatible fixed cyan color.

## Package Boundary

`apps/viewer-web/src/index.ts` is the only public source entrypoint. The viewer
package also has an ESM declaration and bundle build configuration. It is not
published to npm yet; runtime asset packaging remains future work.

## Browser Acceptance Coverage

`apps/viewer-web/e2e/copc-viewer.spec.ts` starts the real Vite application in
Chromium, loads the local Autzen COPC sample, and verifies metadata, decoded
point rendering, actual Cesium point primitive collections, and camera-driven
streaming updates. The application installs `window.__COPC_DEBUG__` only in
Vite development mode to make those runtime states observable; it is not a
production API.

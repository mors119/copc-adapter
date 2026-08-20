# Architecture

## Goal

The project goal is to visualize COPC source data directly in CesiumJS without
preprocessing it into another point-cloud tile format. The current MVP obtains
metadata, hierarchy pages, and selected point chunks from a COPC resource, then
converts those points into Cesium primitives in the browser.

## Runtime Flow

```text
Browser-readable COPC URL
  -> CopcContext and copc.js getter
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
| COPC adapters and loading | `apps/viewer-web/src/copc/` | Isolate `copc.js`, expose project-owned metadata, hierarchy, and point types |
| Coordinate transformation | `apps/viewer-web/src/coordinates/` | Convert COPC coordinates to WGS84 longitude, latitude, and height |
| WASM decoder | `crates/copc-wasm/`, `apps/viewer-web/src/wasm/` | Convert XYZ values into an interleaved point buffer |
| Streaming | `apps/viewer-web/src/viewer/streaming/` | Build selection data, choose nodes, and maintain the bounded point cache |
| Cesium rendering | `apps/viewer-web/src/cesium/` | Create viewers and render point primitive collections |
| Internal controller | `apps/viewer-web/src/viewer/CopcViewer.ts` | Coordinate loading, camera events, streaming, and primitive lifecycle |
| Public API | `apps/viewer-web/src/api/`, `apps/viewer-web/src/index.ts` | Expose `CopcCesiumLayer` and its public types |

External `copc.js` types stay behind the COPC adapter boundary. Cesium types are
used only by the rendering and public attachment boundary, not by core COPC
domain types.

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

`copc.js` currently reads COPC metadata, hierarchy, and point data views.
Rust/WASM receives the X, Y, and Z values and returns a project-owned
interleaved point buffer. This keeps the decoder boundary replaceable without
changing the streaming or Cesium rendering layers.

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

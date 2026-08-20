# Cesium/Vite manual test environment

This is a real browser integration environment for the repository's public
`@mors119/copc-cesium` package. It creates an actual CesiumJS `Viewer`, loads a
real COPC file through browser range requests, runs the adapter's Rust/WASM
decoder, and renders point primitives with WebGL. It does not use viewer or
Cesium mocks.

## Run it

Node.js 22.12 or later, npm, Rust, and the `wasm32-unknown-unknown` Rust target
are required by the currently pinned Vite and Cesium versions.

```bash
rustup target add wasm32-unknown-unknown
cd tests/environments/cesium-vite
npm install
npm run dev
```

Open the local URL printed by Vite. `npm install` builds the local adapter
package and decoder, downloads the repository's registered Autzen sample when
it is not already present, and stages ignored runtime assets under `public/`.
The browser does not depend on a remote COPC service after setup.

The other Vite workflows are:

```bash
npm run build
npm run preview
```

## Package and asset boundary

The environment declares this local dependency:

```json
"@mors119/copc-cesium": "file:../../../apps/viewer-web"
```

Application code imports `CopcCesiumLayer` from that package's public export.
The setup script builds its ESM `dist` entry instead of aliasing or importing
internal TypeScript files.

`vite-plugin-cesium` provides Cesium's workers, widgets, and static assets and
sets Cesium's runtime base URL. The page imports Cesium's widgets CSS directly.
The adapter decoder is served at `/wasm/copc_wasm.wasm`, laz-perf is served at
`/laz-perf.wasm`, and the sample is served at
`/samples/autzen.copc.laz`, matching the real adapter's browser URLs.

## What to test

The page initially loads and attaches the layer. Use the controls as follows:

1. **Unload** removes all rendered node collections while leaving the
   caller-owned Cesium Viewer alive.
2. **Load COPC** loads the layer again after an unload.
3. **Reload** exercises the adapter's public unload/load lifecycle in one
   operation.
4. **Fly Far** moves to 100 km above the current dataset location.
5. **Fly Near** moves to 800 m and should cause a different node selection as
   the camera move ends.
6. **Reset Camera** returns to the view selected by the adapter after load.

Watch the metadata point count, selected/rendered node counts, rendered point
count, streaming update count, and camera coordinates. The public snapshot does
not expose cache occupancy, so **Loaded nodes** deliberately reports currently
rendered node collections rather than inspecting adapter internals.

To use another browser-readable COPC resource with HTTP range and CORS support:

```text
http://localhost:5173/?copc=https://example.test/cloud.copc.laz
```

The local Autzen path remains the default and remote access is optional.

## Errors and limitations

Load, hierarchy, decoder, rendering, global browser, and unhandled promise
errors are printed to the browser console and shown under **Last error**.
WebGL must be enabled, and browser/GPU limits can affect large point counts.
Private browsing policies or strict corporate browser policies may block WASM.
Remote URLs must support CORS and byte-range requests. Runtime assets and build
output are generated/ignored and are not committed.

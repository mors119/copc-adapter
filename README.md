# COPC Adapter

COPC Adapter is an MVP for visualizing a Cloud Optimized Point Cloud (COPC)
directly in CesiumJS. It reads the original COPC resource through HTTP range
requests, traverses its hierarchy, loads selected point chunks, transforms them
to WGS84 coordinates, and renders Cesium point primitives. No preprocessing or
conversion to a Cesium-specific tile format is required.

## MVP Status

The repository currently provides:

- A browser viewer built with Vite and CesiumJS.
- `CopcCesiumLayer`, a typed API for loading a COPC URL and attaching it to a
  caller-owned `Cesium.Viewer`.
- Metadata loading, recursive COPC hierarchy traversal, and point-chunk loading.
- Camera-driven node selection, basic LOD limits, and a bounded node cache.
- CRS transformation to WGS84 plus a Rust/WASM interleaved point-buffer decoder.
- Fixed-color and dataset-normalized elevation-gradient point styling.

The repository also builds a self-contained ESM npm package. The package keeps
Cesium external so the host application owns its Cesium version, while the
COPC and decoder runtime assets are included in the packed artifact.

## Requirements

- Node.js 18 or later
- Rust toolchain with the `wasm32-unknown-unknown` target

```bash
rustup target add wasm32-unknown-unknown
```

## Run the Local Demo

Install the root script dependency and the viewer dependencies:

```bash
npm ci
npm ci --prefix apps/viewer-web
```

Download the default COPC sample and make it available to the Vite app:

```bash
npm run download-samples -- autzen
mkdir -p apps/viewer-web/public/samples
cp samples/local/autzen.copc.laz apps/viewer-web/public/samples/autzen.copc.laz
```

Start the viewer:

```bash
npm --prefix apps/viewer-web run dev
```

Open the local URL printed by Vite. The demo uses
`/samples/autzen.copc.laz`; after it loads, move the Cesium camera to trigger
streaming selection and point rendering.

No repository-owned screenshot or GIF is available, so this README does not
include a visual asset.

## Public API

The browser demo uses the API below from `apps/viewer-web/src/index.ts`:

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  pointSize: 2,
  colorMode: 'elevation',
  debug: true,
});

await layer.load();
layer.attachTo(viewer);

// These methods do not destroy the caller-owned Cesium Viewer.
layer.detachFrom();
await layer.reload();
layer.unload();
layer.destroy();
```

`url` must be readable by the browser and support the range requests made by
the COPC reader. Cross-origin URLs therefore need compatible CORS headers.

`load()` rejects with a project-owned `CopcLoadError` when source access,
metadata/CRS validation, or hierarchy loading fails. Applications can inspect
its `stage` (`'source'`, `'metadata'`, or `'hierarchy'`) and `source` fields,
while `cause` retains the underlying failure for diagnostics. Error messages
omit URL credentials, query strings, and fragments, so they are suitable for a
user-facing debug panel.

```ts
import { CopcLoadError } from './src';

try {
  await layer.load();
} catch (error) {
  if (error instanceof CopcLoadError) {
    debugPanel.textContent = error.message;
  }
  throw error;
}
```

`colorMode` defaults to `'fixed'`, which preserves the original cyan rendering.
The supported modes are `'fixed'`, `'elevation'`, `'rgb'`, `'intensity'`, and
`'classification'`. Elevation uses the transformed dataset height range, RGB
uses source color channels, intensity uses a grayscale range, and classification
uses a stable categorical palette. Attribute modes fall back to fixed cyan when
their source dimensions are unavailable.

```ts
const fixedLayer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  colorMode: 'fixed',
});

const elevationLayer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  colorMode: 'elevation',
});

const rgbLayer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  colorMode: 'rgb',
});
```

## Architecture

```text
COPC URL
  -> metadata and hierarchy loading (copc.js adapter)
  -> point-data view loading
  -> Rust/WASM XYZ interleaved buffer decoding
  -> CRS transformation to WGS84
  -> streaming selection and bounded cache
  -> Cesium point primitives
```

`CopcCesiumLayer` owns the COPC and streaming lifecycle. The application owns
the Cesium `Viewer`; attaching and detaching a layer does not destroy it. See
[the architecture guide](docs/ARCHITECTURE.md) for module responsibilities.

## Verification Commands

From the repository root:

```bash
npm --prefix apps/viewer-web run typecheck
npm --prefix apps/viewer-web run test
npm --prefix apps/viewer-web run coverage
npm --prefix apps/viewer-web run build
npm --prefix apps/viewer-web run test:e2e
```

To generate the ESM library entry, declarations, and package-local WASM assets:

```bash
npm --prefix apps/viewer-web run build:library
npm --prefix apps/viewer-web pack
```

The package declares Cesium as a peer dependency because the consuming
application owns the Cesium `Viewer` instance:

```bash
npm install @frillab/copc-adapter cesium
```

For a repeatable packed-consumer check, the repository includes a clean
Cesium/Vite fixture. It builds and installs the generated `.tgz`, then its
Playwright smoke test loads the local Autzen sample and verifies rendered
points:

```bash
cd tests/environments/cesium-vite
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser acceptance test uses Playwright Chromium with SwiftShader so it can
exercise WebGL in headless environments. Install its browser once with:

```bash
npx --prefix apps/viewer-web playwright install chromium
```

## Known Limitations

- The viewer fully traverses hierarchy metadata before streaming point chunks.
- LOD uses distance, bounds, and maximum-depth heuristics; it does not use
  screen-space error.
- Rendering uses Cesium point primitives with fixed, elevation, RGB, intensity,
  and classification color modes. When present in the LAS point format,
  `intensity`, `classification`, `red`, `green`, and `blue` are preserved in
  typed attribute arrays alongside the XYZ point buffer. Attribute modes fall
  back to fixed cyan when the required dimensions are unavailable.
- Loading and decoding run on the main thread; Web Worker offloading is not
  implemented.
- Rust/WASM currently converts XYZ values to an interleaved buffer. COPC
  metadata and hierarchy parsing still use `copc.js`.
- The local demo and consumer fixture require a downloaded sample COPC file;
  there is no hosted demo or checked-in visual asset.
- Vite reports browser-externalized `node:` module warnings while bundling
  `copc.js` fallback imports. The Playwright browser acceptance test exercises
  the browser path successfully; these warnings are not a demonstrated runtime
  failure.

## Future Work

1. Add screen-space-error-based refinement and improve selection heuristics.
2. Move suitable loading and decoding work to Web Workers.
3. Expand the Rust/WASM boundary to metadata and hierarchy parsing.
4. Publish the library after broader consumer compatibility validation.

## Submission Summary

This MVP demonstrates the core project goal: a browser can visualize a COPC
file in CesiumJS directly from the source data, selecting and loading point
chunks as the camera changes. The project deliberately documents the remaining
scalability and packaging work rather than presenting those items as complete.

## Related Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Examples](docs/EXAMPLES.md)
- [Roadmap](docs/ROADMAP.md)
- [Sample datasets](samples/README.md)

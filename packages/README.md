# @frillab/copc-adapter

`@frillab/copc-adapter` streams COPC point clouds directly into CesiumJS and
Three.js through renderer-specific entrypoints. It uses HTTP Range requests
and does not require preprocessing into renderer-specific tiles.

## Install

```bash
npm install @frillab/copc-adapter cesium
```

Cesium and Three.js are optional peer dependencies. Install only the renderer
used by the application. The package includes its browser decoder runtime
assets, including the opt-in Rust/WASM backend assets.

## Minimal usage

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo(viewer);
```

The historical root import remains supported for existing Cesium consumers:

```ts
import { CopcCesiumLayer } from '@frillab/copc-adapter';
```

Three.js consumers install only the renderer they use and import the isolated
Three.js entrypoint:

```bash
npm install @frillab/copc-adapter three
```

```ts
import { CopcThreeLayer } from '@frillab/copc-adapter/three';
```

The COPC URL must be browser-readable, support byte Range requests, and
provide compatible CORS headers. To inspect a source before loading a layer,
call `probeCopcSource(url)`; it performs a bounded prefix probe and returns
structured Range, CORS-observability, LAS/COPC, and warning fields without
downloading the whole file. Supported color modes are `fixed`,
`elevation`, `rgb`, `intensity`, and `classification`. Use
`backend: 'rust'` to opt into the Rust/WASM path; the default is `copc-js`.

The layer does not create or destroy the Cesium `Viewer`. Call
`detachFrom()`, `unload()`, `reload()`, or `destroy()` according to the
application lifecycle.

Full API, architecture, examples, limitations, and development instructions
are in the [repository documentation](https://github.com/mors119/copc-adapter#readme):

- [API](https://github.com/mors119/copc-adapter/blob/main/docs/API.md)
- [Architecture](https://github.com/mors119/copc-adapter/blob/main/docs/ARCHITECTURE.md)
- [Examples](https://github.com/mors119/copc-adapter/blob/main/docs/EXAMPLES.md)
- [Roadmap](https://github.com/mors119/copc-adapter/blob/main/docs/ROADMAP.md)

# @frillab/copc-adapter

`@frillab/copc-adapter` streams COPC point clouds directly into a
caller-owned CesiumJS `Viewer`. It uses HTTP Range requests and does not
require preprocessing into Cesium 3D Tiles.

## Install

```bash
npm install @frillab/copc-adapter cesium
```

Cesium is a peer dependency. The package includes its browser decoder
runtime assets, including the opt-in Rust/WASM backend assets.

## Minimal usage

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo(viewer);
```

The COPC URL must be browser-readable, support byte Range requests, and
provide compatible CORS headers. Supported color modes are `fixed`,
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

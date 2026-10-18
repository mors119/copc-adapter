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

An opt-in batched renderer is available through the Cesium entrypoint. The
default remains `PointPrimitiveRenderer`:

```ts
import {
  BatchedGeometryPointRenderer,
  CopcCesiumLayer,
} from '@frillab/copc-adapter/cesium';

const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
  renderer: new BatchedGeometryPointRenderer(),
});
```

The batched renderer passes the prepared absolute ECEF `Float64Array` to the
public Cesium geometry pipeline, which creates high/low GPU position buffers.
It keeps a node-relative `Float32Array` for CPU point resolution after
Cesium's scene pick. Point identity resolution is supported in 3D mode;
2D, Columbus View, and morphing scenes return no selection. Ambiguous overlap,
including equal-depth ties, also returns no selected point. Browser validation
covers Cesium 1.142.0 and 1.146.0; these checks do not establish behavior for
every version accepted by the package's unchanged `cesium >=1.142.0` peer range.

Spacing-aware point sizing is opt-in and requires a renderer that advertises
shader support. The public batched renderer supports it; other renderers keep
the fixed-size path:

```ts
const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
  renderer: new BatchedGeometryPointRenderer(),
  pointSizeMode: 'attenuated',
  minPointSize: 1,
  maxPointSize: 12,
});
```

The shader projects nominal COPC spacing (`metadata.spacing / 2^level`) through
the current perspective or orthographic camera and clamps the diameter to the
configured CSS-pixel bounds. Bounds default to 1–12 CSS pixels, and the maximum
cannot exceed 64. Device pixel ratio and Cesium resolution scaling are applied
when converting CSS pixels to drawing-buffer pixels. Source spacing is
transformed at each node center and measured in metres; geographic angular
units use their local WGS84 ground distance. If spacing is absent or cannot be
converted, that node uses fixed sizing. Camera-only changes update the shader
projection without rebuilding node geometry. CPU point picking uses the same
projected-size calculation.

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

URL sources must be browser-readable, support byte Range requests, and
provide compatible CORS headers. Local files can be passed as a `File` or
`Blob`; only requested slices are read, and file contents are not uploaded:

```ts
const file = fileInput.files?.[0];
if (file) {
  const layer = new CopcCesiumLayer({ url: file });
  await layer.load();
  layer.attachTo(viewer);
}
```

Local input must contain COPC hierarchy metadata. Ordinary LAS/LAZ files are
not converted or supported. Range/CORS/HTTP status diagnostics apply only to
URL sources. To inspect a URL source before loading a layer, call
`probeCopcSource(url)`; it performs a bounded prefix probe and returns
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

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
});

await layer.load();
layer.attachTo(viewer);
```

## Renderer-neutral COPC source

The `@frillab/copc-adapter/core` entrypoint opens HTTP, `File`, or `Blob`
sources through `createCopcContext()`, which returns the `CopcNodeSource`
contract. It loads hierarchy pages lazily and prepares selected node data as
WGS84 ECEF `Float64Array` buffers. It has no CesiumJS or Three.js runtime
dependency. A consumer such as COPC Tiles can own its node scheduler and output
format while reusing the adapter's COPC, LAS, and coordinate operations. This
entrypoint does not generate glTF, GLB, or 3D Tiles content.

The `/core` subpath is available in version 0.7.0. The published
`@frillab/copc-adapter@0.6.0` does not export `./core`.

Introduced in Adapter 0.7.1,
`CopcConservativeNodeSource.getConservativeNodeEcefBounds(nodeKey)` is a
synchronous, metadata-only operation for the full source-space octree cell. A supported
result is a WGS 84 ECEF axis-aligned box in metres, tagged with source identity,
source and transform generations, transform-plan identity, the source cell,
height offset, and vertical-grid provenance. Its `coverage` includes all
spatial descendant cells because COPC octree cells partition their parent
cell. It does not certify hierarchy-page completeness or point-content
availability; load the required hierarchy pages before declaring a Tiles leaf.
The method reads no point chunks, makes no network requests, and retains no
per-node bounds cache. Closing the context invalidates it with
`CopcStaleSourceError`; as a synchronous metadata operation, it has no separate
per-call cancellation signal.
`CopcConservativeNodeSource` extends the existing `CopcNodeSource` contract;
the original interface remains unchanged for structural implementations.

The supported transform subset is intentionally narrow: explicit WGS 84
geographic EPSG:4326 or EPSG:4979 coordinates in degrees with a declared
longitude/latitude axis mapping. WKT1 EPSG:4326 without `AXIS` clauses follows
the point transform's established X=longitude, Y=latitude convention. Source
height must be explicitly ellipsoidal, or use a validated bilinear vertical
grid with a matching vertical CRS, no declared NoData sentinel, and coverage of
the full cell. The supported affine operations are axis permutation/sign
normalization, declared source height-unit conversion, and uniform
`heightOffsetMeters`. The WGS 84 geodetic equations are enclosed with outward
interval arithmetic, including interior angular extrema; transformed corners
and point samples are not used to derive the result. Projected sources such as
EPSG:5186, EPSG:2992 (Autzen), and SoFi's EPSG:32611, unknown vertical
references, unresolved epochs, inferred/no-WKT horizontal CRS, and unverifiable
grid regions return an explicit `unsupported` result. WGS 84 datum ensembles
are supported only when the source and ECEF target use that same ensemble, so
the operation is direct geodetic-to-ECEF math with no frame or epoch shift. WKT
that declares a dynamic CRS or an unresolved coordinate epoch is unsupported.
A grid that declares a NoData sentinel is currently unsupported even when the
sentinel may lie outside a particular cell.

The returned cell bound is suitable as a conservative spatial volume for a
Tiles hierarchy when the consumer also verifies child topology. It does not
provide a content encoder's reconstruction-error padding or decide geometric
error/refinement policy. `loadPreparedNodeData().ecefBounds` remains a bound
over only the decoded points in that node and is not a replacement for a cell
bound. The API does not make unsupported Autzen heights ellipsoidal: the real
Autzen source declares EPSG:6360 NAVD88 height in US survey feet and the
compatibility point transform has no configured geoid grid, so its vertical
datum remains unreconciled with WGS 84 ellipsoidal height.

Core also recognizes one projected 3D height declaration for point preparation
and CRS diagnostics: WKT2 `PROJCRS` with a Cartesian 3-axis system, ordered
east/north/up axes, a `BASEGEOGCRS` identified as EPSG:4979, an explicitly
named ellipsoidal-height UP axis, and a declared linear unit. This establishes
explicit WGS 84 ellipsoidal-height semantics for those prepared points; the
vertical operation is identity. It does not make projected
`getConservativeNodeEcefBounds()` supported, establish a coordinate epoch, or
claim survey-grade accuracy. Other projected 3D Z axes and unknown datums
remain unverified.

```ts
import { createCopcContext } from '@frillab/copc-adapter/core';

const source = await createCopcContext('/data/source.copc.laz');
try {
  const bounds = source.getConservativeNodeEcefBounds('0-0-0-0');
  if (bounds.status === 'unsupported') {
    throw new Error(`${bounds.reasonCode}: ${bounds.reason}`);
  }
  // bounds.boundsEcef is a full source-cell bound in WGS 84 ECEF metres.
  // Compare generations before combining it with points from another result.
  console.log(bounds.transformPlanIdentity, bounds.boundsEcef);
} finally {
  source.close();
}
```

```ts
import {
  createCopcContext,
  createCopcPointFieldSelection,
  HierarchyLoader,
} from '@frillab/copc-adapter/core';

const source = await createCopcContext('/data/autzen.copc.laz');
try {
  const hierarchy = new HierarchyLoader(source, source.getMetadata().cube);
  const root = await hierarchy.loadRoot();
  const node = root.nodes[0];
  if (!node) throw new Error('COPC root page contains no point node');

  const prepared = await source.loadPreparedNodeData(
    node,
    createCopcPointFieldSelection(['position', 'rgb']),
  );
  // prepared.pointData.world.coordinates is WGS84 ECEF Float64 XYZ.
  // prepared.ecefBounds encloses these decoded points.
} finally {
  source.close();
}
```

Hierarchy pages are fetched on demand; `HierarchyLoader.query()` accepts a
page limit and reports incomplete child discovery. Returned typed arrays are
caller-retained, read-only by contract, and remain readable after source close.
The API exposes source-space octree cells and decoded-point ECEF bounds; it
does not claim that transformed cell corners bound nonlinear CRS operations.
See the [public API contract](https://mors119.github.io/copc-adapter/API#copc-tiles-compatibility-audit)
for field availability, Extra Dimensions, provenance, and cancellation rules.

The default appearance is fixed cyan at 3 pixels. `url` also accepts a local
browser `File` or `Blob`; the adapter reads requested slices without uploading
the file.

Three.js minimal usage:

```ts
import * as THREE from 'three';
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
const renderer = new THREE.WebGLRenderer();
const layer = new CopcThreeLayer({
  url: 'https://example.com/data.copc.laz',
});

await layer.load();
layer.attachTo({ scene, camera, renderer });

function animate() {
  requestAnimationFrame(animate);
  void layer.update();
  renderer.render(scene, camera);
}
animate();
```

Three.js `url` accepts the same local `File` and `Blob` inputs. The
application owns and renders the scene, camera, and WebGL renderer.

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

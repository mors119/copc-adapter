# Examples

## Browser App Example

실행 가능한 최소 예제는
[`apps/dev-viewer/src/main.ts`](https://github.com/mors119/copc-adapter/blob/main/apps/dev-viewer/src/main.ts) 이다.

동작 흐름:

1. Cesium `Viewer` 생성
2. `CopcCesiumLayer.load()` 호출
3. `attachTo(viewer)`로 layer 연결
4. camera 기반 streaming selection 시작
5. 선택한 backend의 project-owned point buffer 경유

## HTML Skeleton

```html
<div id="cesium-container"></div>
<script type="module" src="/src/main.ts"></script>
```

## Minimal Cesium Example

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({ url: '/samples/autzen.copc.laz' });

await layer.load();
layer.attachTo(viewer);
```

The same `url` field accepts an HTTP(S) URL or a browser `File`/`Blob`.
Omitting appearance options uses fixed cyan points at 3 pixels.

### Custom elevation colors

Both renderer layers accept the same normalized elevation ramp. The default
range is the transformed dataset elevation range; `elevationRange` can set an
explicit displayed-height range in metres.

```ts
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  colorMode: 'elevation',
  elevationRange: { min: 20, max: 120 },
  elevationStyle: {
    interpolation: 'step',
    palette: [
      { position: 0, color: { red: 0, green: 0, blue: 0.3 } },
      { position: 0.5, color: { red: 0, green: 0.8, blue: 0.3 } },
      { position: 1, color: { red: 1, green: 0, blue: 0 } },
    ],
  },
});
```

Cesium can update these values through `setStyle()` using cached prepared
points. Three.js takes them in `CopcThreeLayer`'s constructor; create a
replacement layer to change its style. Both use absolute displayed ellipsoidal
height after configured vertical transformation and offset, not height above
ground.

## Per-layer Opacity

Set the initial opacity in either layer constructor, then update only that
layer at runtime. The value is the final alpha in `[0, 1]`; omitting it keeps
the current renderer default.

```ts
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const cesiumOverlay = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  opacity: 0.5,
});
cesiumOverlay.setOpacity(0.25);

const threeOverlay = new CopcThreeLayer({
  url: '/samples/autzen.copc.laz',
  opacity: 0.5,
});
threeOverlay.setOpacity(0.25);
```

Opacity updates do not request or decode COPC data. Alpha zero disables picking
for that layer. Blending and depth behavior remain renderer-specific; the
adapter does not sort transparent points or implement order-independent
transparency.

## Cesium Plane and Box Clipping

Clipping uses WGS 84 ECEF metres after the source coordinates have been
transformed. Use the batched renderer to clip in its fragment shader:

```ts
import * as Cesium from 'cesium';
import {
  BatchedGeometryPointRenderer,
  CopcCesiumLayer,
} from '@frillab/copc-adapter/cesium';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  renderer: new BatchedGeometryPointRenderer(),
});
await layer.load();
layer.attachTo(viewer);

// After selecting a point, make a 50 m box around it.
const point = layer.getSelectedPoint()?.world;
if (!point) throw new Error('Pick a rendered point first');
layer.setClippingVolume({
  type: 'box',
  coordinateSystem: 'wgs84-ecef-meters',
  minimum: [point.x - 25, point.y - 25, point.z - 25],
  maximum: [point.x + 25, point.y + 25, point.z + 25],
});

// Change the volume or clear it without reloading the COPC.
layer.setClippingVolume(undefined);
```

`planes` volumes intersect one to six half-spaces; the non-negative side of
each plane and each box face remains visible. Clipping composes with style
filters and excludes clipped points from picking. It only filters rendering
and picking, so it does not reduce hierarchy or point-range reads or alter
other layers.

## Minimal Three.js Example

```ts
import * as THREE from 'three';
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
const renderer = new THREE.WebGLRenderer();
const layer = new CopcThreeLayer({ url: '/samples/autzen.copc.laz' });

await layer.load();
layer.attachTo({ scene, camera, renderer });

function animate() {
  requestAnimationFrame(animate);
  void layer.update();
  renderer.render(scene, camera);
}
animate();
```

The Three.js adapter uses the same default appearance and accepts a `File` or
`Blob` source. The application owns the scene, camera, renderer, and loop.

## Advanced Cesium Integration Example

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  backend: 'rust',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo(viewer);

console.log(layer.getSnapshot());
console.log(layer.getSelectedPoint()); // undefined until a rendered point is picked

layer.detachFrom();
layer.destroy();
```

For explicit appearance and workload control, use the top-level point budget.
It takes precedence over the compatibility field
`streaming.maxRenderedPoints`:

```ts
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  backend: 'rust',
  colorMode: 'rgb',
  maxRenderedPoints: 200_000,
  streaming: {
    maxNodes: 24,
    maxDepth: 6,
    refinementAlgorithm: 'foveated',
  },
});
```

Three.js accepts the same shared backend, styling, point-budget, and streaming
controls:

```ts
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const layer = new CopcThreeLayer({
  url: '/samples/autzen.copc.laz',
  backend: 'rust',
  colorMode: 'rgb',
  maxRenderedPoints: 200_000,
  streaming: {
    maxNodes: 24,
    maxDepth: 6,
    refinementAlgorithm: 'foveated',
  },
});
```

기존 cyan rendering을 유지하려면 `colorMode: 'fixed'`를 지정하거나
`colorMode`를 생략한다. 높이 차이를 시각화하려면 `colorMode: 'elevation'`을
사용한다. Elevation mode는 streaming node마다 색 범위가 바뀌지 않도록 COPC
metadata의 전체 Z 범위를 transformed Cesium height로 변환해 사용한다.
source RGB를 사용하려면 `rgb`, 반사 강도를 grayscale로 보려면 `intensity`,
LAS classification을 categorical palette로 보려면 `classification`을 사용한다.
필요한 source attribute가 없는 경우 기존 cyan으로 fallback한다. Intensity
범위는 각 streaming node의 loaded point buffer에서 계산한다.

## Generic Caller-Supplied GTX Grid (CesiumJS)

The API guide has a complete offline `File` example for loading a documented
GTX grid, verifying its SHA-256, and enabling it through
`CopcCesiumLayerOptions.verticalTransform`. Supply only a grid whose source
vertical CRS, WGS 84 horizontal frame, `h - H` sign, units, NoData value,
coverage, and usage terms are documented. No EGM2008 or KNGeoid24 model is
bundled or automatically selected. See [Explicit vertical CRS grid
conversion](API.md#explicit-vertical-crs-grid-conversion).

## NGA EGM2008 in the Workbenches

Playground and Dev Viewer expose one explicit vertical-grid workflow for the
exact pinned NGA EGM2008 2.5-minute WGS 84 Tide-Free file. Choose an extracted
local file in the **Vertical Grid** control, wait for SHA-256 and layout
verification, then apply the pending configuration. The control displays the
operation, CRS pair, frames, units and sign, coverage, NoData behavior,
interpolation, resolution, digest, memory bound, epoch behavior, and source
terms. It does not download or retain the file, and the grid bytes and local
path are never placed in a share URL.

Copy code emits a `loadNgaEgm2008Grid` setup that prompts the consuming page to
choose its own local file and verifies that file before constructing the
layer. NGA's accessed product page and archive do not state redistribution
terms, so obtain and use the file only under terms that apply to you. The
Workbench and package do not bundle it. This is a specific EGM2008 profile,
not a generic datum selector or a Korean national height conversion. See
[NGA EGM2008 2.5-minute grid](API.md#nga-egm2008-25-minute-grid) for the
operation limits and memory details.

## Opt-in Cesium Terrain Height Estimate

Terrain is independent from imagery and the ellipsoid. Configure an application
owned TerrainProvider before creating the Viewer; an unauthenticated local
quantized-mesh service can expose a `layer.json` endpoint under a service root:

```ts
const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
  'http://localhost:8080/terrain',
);
const viewer = new Cesium.Viewer('cesium-container', { terrainProvider });
```

After the layer is loaded and attached, explicitly pick a ground point and
request an estimate. The result is read-only. Present its heights, delta,
datum, provider label and warnings; after a separate approval, recreate the
layer from the same source using the returned effective `heightOffsetMeters`.
The adapter checks that the estimate still belongs to the selected point and
active TerrainProvider. See [Explicit Cesium Terrain residual estimate in the
API guide](API.md#explicit-cesium-terrain-residual-estimate) for the vertical
reference checks, error cases, cancellation semantics and composition with
`verticalTransform`.

In the Dev Viewer, enter the Terrain service root (the folder containing
`layer.json`), press **Apply Settings**, pick a COPC point, confirm ground
status when needed, then use **Estimate
residual** and review the preview. **Apply proposed correction** is enabled
only for a current, actionable estimate. The default remains ellipsoid-only.

## Build Note

The dev viewer prepares the `copc-adapter-wasm` asset before running. Package
unit tests use `packages`; library builds include the decoder
assets in `dist`.
The default browser URL requires the downloaded Autzen sample at
`apps/dev-viewer/public/samples/autzen.copc.laz`.

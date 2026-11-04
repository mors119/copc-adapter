# Three.js API

The Three.js layer adapter and its renderer-specific integration contract.

## `CopcThreeLayer`

`CopcThreeLayer` is exported from `@frillab/copc-adapter/three`. It attaches to
an application-owned scene and camera and does not own the renderer or render
loop.

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

This uses fixed cyan points at 3 pixels by default. `url` also accepts a
browser `File` or `Blob`. The application owns the scene, camera, renderer, and
render loop.

Current options include `url`, `pointSize` (default `3`), `colorMode`,
`elevationRange`, `elevationStyle`,
`opacity` (optional; omitted preserves the existing Three material default of
`0.9`),
`coordinateCacheLayout` (default `E`; choose `A` to retain exact source and
geographic inspection coordinates),
`heightOffsetMeters` (default `0`), `verticalTransform` (omitted by default),
`maxRenderedPoints`, `streaming`, `backend`, `decoder`,
`maxPointCacheBytes`, `debug`, `pickingThreshold` (default `1` scene unit),
an optional compatible `renderer`, and `onPointPicked`.

`update()` reads the attached camera and drives the shared streaming core. It
does not render or schedule the application loop; equivalent views are not
submitted repeatedly. The layer creates one root `THREE.Group` and owns the
point objects, geometries, and materials below it. The application owns the
scene, camera, WebGL renderer, controls, and loop.

Three.js takes `elevationRange` and `elevationStyle` in the constructor. To
change them, create a replacement layer with the updated options and reconnect
it; Three has no runtime style setter. The palette colors use the same prepared
displayed ellipsoidal heights and alpha rules as Cesium.

The loaded dataset uses a fixed local ENU frame in metres: +X east, +Y north,
and +Z up. `pick({ x, y })` accepts normalized device coordinates and returns a
`CopcPointInspection` or `undefined`. With layout E, height/world are exact,
longitude/latitude are derived from ECEF, and source XYZ is omitted; choose A
for the previous exact coordinate inspection values. An optional
`THREE.Raycaster` and threshold can be supplied. `detachFrom()`, `unload()`,
`reload()`, and `destroy()` do not dispose application-owned Three.js
resources.

The default Three.js path keeps this local-coordinate workflow and does not
require vertical CRS metadata or a geoid grid. It never selects or applies a
grid automatically. Supply `verticalTransform` only when the application
explicitly needs geographic alignment; correction uses the shared coordinate
pipeline before Three converts the corrected ECEF positions into its local ENU
frame.

For a native bounds query, call `layer.getRoot().updateWorldMatrix(true, true)`
and use `new THREE.Box3().setFromObject(layer.getRoot())`. This is the
currently instantiated root geometry's world-space bound, not a full-source
COPC extent.

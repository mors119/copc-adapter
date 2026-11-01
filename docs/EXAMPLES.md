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

## Workbench Capability Matrix

The workspace Dev Viewer uses local workspace APIs. The Playground uses the
published `@frillab/copc-adapter@0.7.1` package and gates controls against that
release. “Both” below means Cesium and Three unless a renderer is named.

| Capability | Cesium API | Three API | Dev Viewer | Playground 0.7.1 |
| --- | --- | --- | --- | --- |
| Focus Lens screen circle and `setRefinementFocus()` | Yes | No | Cesium only; Follow Cursor is a host preference | Cesium only; Follow Cursor is a host preference |
| Fixed, RGB, elevation, intensity, classification color modes | Yes | Yes | Both renderers | Both renderers |
| Dimension coloring and numeric dimension filtering | Coloring: both; filtering: Cesium | Coloring only | Exposed when runtime capability allows | Deliberately hidden by the published-package Workbench manifest |
| Classification include/exclude | Cesium | No | Cesium | Cesium |
| ECEF box/plane clipping | Cesium | No | Cesium; selected-point box assist | Cesium; selected-point box assist |
| Height Offset and validated EGM2008 vertical-grid profiles | Both | Both | Both renderers | Both renderers |
| Terrain estimate / preview / apply | Cesium single and workspace batch APIs | No | Cesium; workspace batch when available | Cesium; published single-anchor API |

Follow Cursor is not an Adapter constructor option. Generated code uses the
configured static Focus Lens center and displays a warning when continuous
tracking is enabled. The Playground does not import workspace-only APIs.

## Workbench Demonstration Guide

These steps describe reproducible recording actions; they do not claim a
rendered result without running the selected source and browser. For data-based
recordings, run `npm run download-samples -- autzen`, then choose the resulting
`autzen.copc.laz` file in the host. Keep
access tokens and signed source URLs out of recordings and copied examples.

### 1. Focus Lens follows the pointer

- **Source:** Any readable COPC source; Autzen is suitable for a local demo.
- **Renderer / API:** Cesium only; public `setRefinementFocus()` is in npm and
  workspace 0.7.1. Three has no Focus Lens method.
- **Expected behavior:** Enable Focus Lens, set its radius and detail bias,
  enable Follow Cursor, then move inside the Cesium viewport. The screen-circle
  center follows normalized viewport coordinates. Turning it off restores the
  saved manual center.
- **Limitations:** This is host interaction state. Copy code keeps the static
  manual center and warns that pointer tracking needs host event code. It does
  not reload or replace the active layer as the pointer moves.
- **GIF sequence:** Show the manual center and radius, turn on Follow Cursor,
  sweep across opposite viewport corners, turn it off, and show the preserved
  manual coordinates and code warning.

### 2. Switch Color Modes

- **Source:** A COPC source with the attributes for the modes being shown;
  select a source with RGB, intensity, and classification when demonstrating
  all modes.
- **Renderer / API:** Cesium and Three, npm/workspace 0.7.1; the mode is a
  public constructor option, with Cesium `setStyle()` for supported runtime
  changes.
- **Expected behavior:** Choose Fixed, RGB, Elevation, Intensity, and
  Classification. Only controls relevant to the selected mode should be
  visible. Narrow the sidebar and verify every mode remains readable.
- **Limitations:** RGB/intensity/classification require retained source fields.
  Dimension coloring is in Dev Viewer when its workspace API profile permits
  it; the published Playground 0.7.1 manifest hides it. Custom elevation ramps
  are not exposed in either host.
- **GIF sequence:** Record each available mode in a full sidebar, resize to a
  narrow sidebar, then use arrow keys on the Color Mode radio group.

### 3. Classification and numeric filtering

- **Source:** A COPC source with Classification and, for numeric filtering,
  an available numeric field such as Intensity. Keep standard attribute
  loading enabled or request the field before loading.
- **Renderer / API:** Classification filtering is Cesium only on npm/workspace
  0.7.1. Numeric Dimension coloring is available in Dev Viewer; numeric
  Dimension filtering is Cesium workspace-only in the current Workbench.
  Playground 0.7.1 hides Dimension controls.
- **Expected behavior:** Use a standard LAS catalog name to add its code to an
  include/exclude list, or enter codes directly. For an available numeric
  field, set an inclusive range; non-finite/missing values remain hidden.
- **Limitations:** Catalog names are standard LAS 1.4 labels, not a claim that
  the selected source contains that class. Starting numeric bounds are field
  representable limits, not observed full-source minima/maxima unless explicit
  metadata says otherwise.
- **GIF sequence:** Show an inspected point's class, add that code to Include,
  switch to Exclude and clear it, then select a numeric field and adjust both
  range ends while showing its units and starting-bound note.

### 4. Spatial clipping on a supported source

- **Source:** A readable COPC source with a point that can be picked in the
  active Cesium viewport.
- **Renderer / API:** Cesium only; public `setClippingVolume()` and
  `getClippingVolume()` are available in npm/workspace 0.7.1.
- **Expected behavior:** Pick a point, enter a positive half-width in metres,
  and center an axis-aligned box around its WGS 84 ECEF coordinates. Apply the
  pending box; the rendering and picking results reflect the clipping volume.
- **Limitations:** The helper creates only a 3D box centered on one selected
  ECEF point. It does not interpret a screen rectangle as a 3D volume. Exact
  ECEF box and plane editing remains under Advanced. Three has no clipping API.
- **GIF sequence:** Pick a point, show the selected-point box assist and ECEF
  metres label, apply it, demonstrate a clipped pick, then Clear and show the
  point can be picked again.

### 5. Manual Height Offset

- **Source:** A readable COPC source whose displayed vertical placement can be
  inspected against a known reference.
- **Renderer / API:** Cesium and Three, npm/workspace 0.7.1;
  `heightOffsetMeters` is an additive display-height adjustment.
- **Expected behavior:** Apply a small positive and negative offset and show
  the displayed layer position change.
- **Limitations:** The value is metres and does not transform a datum, alter
  source COPC coordinates, or mean height above ground. It is separate from a
  validated vertical-grid conversion and from a Terrain estimate.
- **GIF sequence:** Record the current value, increase by a known amount,
  return to zero, and apply a negative value while showing the units.

### 6. Validated Vertical Grid

- **Source:** COPC metadata with a declared vertical CRS compatible with one of
  the Workbench's checksum-pinned EGM2008 profiles, plus the exact local grid
  file for that profile.
- **Renderer / API:** Cesium and Three, npm/workspace 0.7.1; public vertical
  transform support. Grid setup is in the shared advanced Coordinates section.
- **Expected behavior:** Select the validated profile, load the exact grid,
  review its CRS/units/checksum metadata, then apply the transform and verify
  its status.
- **Limitations:** Unknown datums are not inferred. An arbitrary grid is not
  accepted as a verified profile; keep local grid bytes and paths out of URLs
  and copied code. This is a coordinate transformation, not Height Offset.
- **GIF sequence:** Expand Advanced Coordinates, show source CRS and profile,
  load the local grid, show the validation status, and contrast the transform
  with the separate Height Offset control.

### 7. Terrain Estimate / Preview / Apply

- **Source:** A COPC source with selectable ground evidence (LAS class 2, or
  an explicitly confirmed ground point), a compatible declared/validated
  vertical reference, and a ready real Cesium Terrain provider.
- **Renderer / API:** Cesium only, npm/workspace 0.7.1. Playground calls the
  published single-anchor estimator; workspace Dev Viewer can use the robust
  batch estimator with multiple anchors.
- **Expected behavior:** Select ground candidate(s), Estimate, inspect sample
  coverage, residual, spread, vertical reference and final
  `heightOffsetMeters`, adjust by centimetres if useful, and explicitly Apply.
  The active offset changes only after the runtime confirms Apply succeeded.
- **Limitations:** Preview is numerical only; it does not temporarily move the
  layer. Provider readiness alone is not Terrain sample evidence. Unverified
  vertical references or unavailable samples must leave the proposal
  non-actionable. Cancel estimate or Reset anchors to discard it.
- **GIF sequence:** Show provider status, add a ground point (and a second
  point in Dev Viewer), estimate, read the numerical preview and total, move
  fine adjustment, then Apply. Make a second recording that cancels and shows
  no offset was applied.

### 8. Reset or cancel adjustments

- **Source:** Any loaded source; use a mock source for deterministic UI-state
  recordings or a local COPC for visual changes.
- **Renderer / API:** Both renderers for Height Offset; Cesium only for Focus
  Lens, clipping, and Terrain actions; APIs are gated by the host's installed
  package profile.
- **Expected behavior:** Cancel an in-flight Terrain estimate, reset anchor
  candidates, clear clipping, restore Focus Lens's manual center, or set
  `heightOffsetMeters` back to zero and Apply.
- **Limitations:** Cancel stops the estimate workflow; an outstanding Cesium
  tile sample may finish before the promise returns. Reset does not undo an
  already approved offset; set the explicit Height Offset value to restore it.
- **GIF sequence:** Start an estimate and cancel it, show the unapplied state,
  then clear clipping and restore the known Height Offset and manual Focus
  Lens center.

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

## EGM2008 in the Workbenches

Playground and Dev Viewer share one explicit vertical-grid workflow for either
the exact pinned NGA EGM2008 2.5-minute WGS 84 Tide-Free raw file or the exact
OSGeo PROJ-DATUMGRID-WORLD `egm08_25.gtx` file. Choose a local file in the
**Vertical Grid** control, wait for SHA-256, CRS, and layout verification, then
apply the pending configuration. The control displays the operation, CRS pair,
frames, units and sign, coverage, NoData behavior, interpolation, resolution,
digest, memory bound, epoch behavior, and source/license provenance. It does
not download or retain the file, and grid bytes and local paths are never
placed in a share URL.

Copy code prompts the consuming page to choose its own local file and emits
the exact public loader and metadata for the last applied profile. The NGA
product page does not state redistribution terms, so obtain and use that raw
file only under terms that apply to you. The OSGeo world-grid README marks its
EGM2008 GTX as Public Domain, attributes the model to NGA, and documents its
GeographicLib generation ([source and license metadata](https://github.com/OSGeo/proj-datumgrid/blob/master/world/README.WORLD)). Neither
file is bundled or downloaded. These are two fixed EGM2008 profiles, not a
generic datum selector or a Korean national height conversion. See [NGA
EGM2008 2.5-minute grid](API.md#nga-egm2008-25-minute-grid) for operation
limits and memory details.

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

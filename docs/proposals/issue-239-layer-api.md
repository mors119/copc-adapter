# Issue #239: Layer API semantics matrix

**Status:** Implemented in the Issue #239 release candidate branch; awaiting
maintainer review.
**Scope:** Additive CesiumJS and Three.js layer ergonomics. Existing public
signatures and streaming defaults are preserved.

Issue [#239](https://github.com/mors119/copc-adapter/issues/239) asks for a
small API alignment pass. The maintainer authorized implementation before the
2026-10-20 functional validation so the new API can be exercised from a
released package.

## Naming and semantics matrix

| Concern | CesiumJS façade | Three.js façade | Shared meaning and limits |
| --- | --- | --- | --- |
| Load lifecycle | Keep existing lifecycle methods. `metadataReady` fires when metadata and the root hierarchy are ready. | Keep existing lifecycle methods. `metadataready` fires at the same core readiness point. | Metadata readiness and `load()` Promise settlement are distinct. Cesium `load()` still awaits its initial streaming view when attached; Three `load()` does not drive `update()`. Neither Promise means the full COPC source is downloaded. |
| Attachment | Keep `attachTo(viewer: Cesium.Viewer)` and `detachFrom()`. The layer owns its primitive container; the application owns the Viewer. | Keep `attachTo({ scene, camera, renderer? })` and `detachFrom()`. The layer attaches its `THREE.Group`; the application owns the scene, camera, renderer, controls, and frame loop. | Attachment signatures stay engine-specific because the engines require different inputs and ownership. |
| Visibility | Keep the existing `show: boolean`, backed by this layer's owned `Cesium.PrimitiveCollection`. | Use the existing `getRoot().visible: boolean`; do not add `layer.show`. | Rendering visibility only. Hiding preserves source, cache, and selection and does not pause streaming or alter workload policy. It must not affect another layer or the globe. |
| Source bounds | `boundingSphere` returns a clone of the full metadata-bounds sphere in WGS84 ECEF metres. | Do not add `getBoundingBox()`. `new THREE.Box3().setFromObject(layer.getRoot())` reports bounds of currently instantiated geometry after world matrices are updated. | Cesium uses supported WKT1 geographic/projected transforms and geographic bounds without WKT. Projected local extents are limited to 2,000 km per axis and 1,000 km vertical span. A bounded grid samples edges and cell interiors, checks sampled discontinuities, and pads by cell spacing and observed curvature. This does not establish universal behavior for arbitrary projection singularities; unsupported or invalid cases return `undefined`. Three's Box3 is only the current root geometry bound. |
| Camera framing | `zoomTo(offset?: Cesium.HeadingPitchRange)` uses Cesium `Camera.flyToBoundingSphere`; resolves `true` on completion and `false` on cancellation or layer invalidation. | Add no camera helper; the application owns camera placement and controls. | Preserve legacy automatic initial `flyToDataset()` framing. `layer.zoomTo()` is caller-initiated. Native `viewer.zoomTo(...)` is separate; `viewer.zoomTo(layer)` is not supported. |
| Progress surface | Add `loadProgress: Cesium.Event`, plus `metadataReady`, `firstVisible`, `viewSettled`, `viewCancelled`, and `error` events, each also a `Cesium.Event`. | Add typed `addEventListener` / `removeEventListener` methods for `progress`, `metadataready`, `firstvisible`, `viewsettled`, `viewcancelled`, and `error`. Keep this a small dispatcher-compatible façade; do not inherit `THREE.Object3D` or all of `THREE.EventDispatcher`. | Adapter events derive from the shared core lifecycle and current-view generations. Remove listeners cleanly; dispatch stops after `destroy()`. Do not add polling or depend on the application's animation loop. |
| Refinement budget | Keep existing streaming options and defaults. | Keep existing streaming options and defaults. | Keep `maxDepth: 6` as a documented cap until measured dense-source evidence supports a separate default-change decision. |

## Event contract

Cesium events use the following argument shapes. Three.js dispatches typed
event objects with `type` set to the event name and the listed fields.

| Event | Arguments / event fields | Fires when |
| --- | --- | --- |
| `loadProgress` / `progress` | Cesium args: `(queuedNodeCount, activeNodeCount, viewGeneration)`. Three fields: `{ queuedNodeCount, activeNodeCount, viewGeneration }`. | The current view's queued or active COPC node work changes. A node job covers its range/decode/preparation work; these are node counts, not HTTP request counts, bytes, or whole-source download progress. |
| `metadataReady` / `metadataready` | Cesium args: `(metadata, loadGeneration)`. Three fields: `{ metadata, loadGeneration }`. | Metadata and root hierarchy are ready. Cesium emits before the attached initial view completes; Three emits after its local-frame setup. It does not imply point data is ready. |
| `firstVisible` / `firstvisible` | Cesium args: `(loadGeneration, viewGeneration)`. Three fields: `{ loadGeneration, viewGeneration }`. | The first nonempty point node for that load was committed to the renderer while attached, regardless of the layer's `show` / root `visible` setting. At most once per load. It does not guarantee a GPU frame, visible pixel, terrain visibility, or viewport coverage. |
| `viewSettled` / `viewsettled` | Cesium args: `(viewGeneration, selectedNodeKeys)`. Three fields: `{ viewGeneration, selectedNodeKeys }`. | Selected work completed and ready results were applied. A replacement group still waiting on required renderer commits does not settle. An empty view can settle. This does not mean the source is fully downloaded or the next GPU frame completed. |
| `viewCancelled` / `viewcancelled` | Cesium args: `(viewGeneration, reason)`. Three fields: `{ viewGeneration, reason }`. | An active view is superseded or invalidated. `reason` is `camera-change`, `detach`, `unload`, `reload`, or `destroy`. No `viewSettled` is emitted for that generation. |
| `error` | Cesium arg: `{ error, phase, loadGeneration?, viewGeneration? }`. Three fields: `{ error, phase, loadGeneration?, viewGeneration? }`. | A load or background current-view operation fails. `phase` is `load` or `view`, with only the corresponding generation field set. `load()` and `reload()` continue to reject their promises; the event does not swallow errors. A failed view does not also emit `viewSettled`. |

Public load and view generation numbers are monotonically increasing and
independent from core and adapter counters. Progress, settlement, cancellation,
and view errors use the same public view generation. Each active view has one
terminal outcome: settled, cancelled, or failed. Cancelled and failed views
cannot later settle. No events are delivered after `destroy()` completes.
Listener exceptions are caught and reported with `console.error`; metadata and
event snapshots do not expose mutable internal state.

## Consumer examples

Register listeners before `load()` if the initial milestones matter. Cesium
consumers can observe node work and explicitly frame the full metadata extent:

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';

const layer = new CopcCesiumLayer({ url });
const removeProgressListener = layer.loadProgress.addEventListener(
  (queuedNodeCount, activeNodeCount, viewGeneration) => {
    console.log({ queuedNodeCount, activeNodeCount, viewGeneration });
  },
);
layer.metadataReady.addEventListener((metadata, loadGeneration) => {
  console.log({ metadata, loadGeneration });
});
layer.attachTo(viewer);
await layer.load();

if (layer.boundingSphere) {
  const completed = await layer.zoomTo(
    new Cesium.HeadingPitchRange(0, -0.5, 0),
  );
  console.log({ completed });
}
removeProgressListener();
layer.destroy();
```

Three consumers use the exported event interfaces and native root bounds:

```ts
import * as THREE from 'three';
import {
  CopcThreeLayer,
  type CopcThreeLayerViewSettledEvent,
} from '@frillab/copc-adapter/three';

const layer = new CopcThreeLayer({ url });
const onViewSettled = (event: CopcThreeLayerViewSettledEvent) => {
  console.log(event.viewGeneration, event.selectedNodeKeys);
};
layer.addEventListener('viewsettled', onViewSettled);
layer.attachTo({ scene, camera, renderer });
await layer.load();

layer.getRoot().visible = false;
layer.getRoot().visible = true;
layer.getRoot().updateWorldMatrix(true, true);
const renderedWorldBounds = new THREE.Box3().setFromObject(layer.getRoot());
// This is the current root geometry's world-space bound, not the full COPC extent.
layer.removeEventListener('viewsettled', onViewSettled);
layer.destroy();
```

Import `CopcThreeLayerViewSettledEvent` from
`@frillab/copc-adapter/three`. The separate `/cesium` and `/three` exports
remain in place.

## Review and implementation gates

1. Review the implementation and release candidate against this matrix.
2. Keep Cesium and Three types out of the shared streaming core; derive adapter
   events from shared lifecycle/progress callbacks.
3. Test layer visibility isolation, listener removal/destruction, bounds and
   CRS failure behavior, view-generation cancellation, and concurrent layers.
   Verify both `/cesium` and `/three` consumer entrypoints and packed artifacts.
4. Keep the existing `CopcLayerController` automatic framing behavior intact.
   Do not raise `maxDepth` without separate dense-source evidence.
5. Preserve public compatibility now. The issue comment schedules a separate
   v0.8.0 review of overlapping legacy APIs, with usage evidence and migration
   notes before any removal.

## Engine references

- [Cesium3DTileset](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- [Cesium Camera](https://cesium.com/learn/cesiumjs/ref-doc/Camera.html)
- [Cesium Viewer](https://cesium.com/learn/cesiumjs/ref-doc/Viewer.html)
- [Cesium CustomDataSource](https://cesium.com/learn/cesiumjs/ref-doc/CustomDataSource.html)
- [Three.js Object3D](https://threejs.org/docs/pages/Object3D.html)
- [Three.js Box3](https://threejs.org/docs/pages/Box3.html)
- [Three.js EventDispatcher](https://threejs.org/docs/pages/EventDispatcher.html)
- [Three.js LoadingManager](https://threejs.org/docs/pages/LoadingManager.html)

# Issue #60 occlusion-culling investigation

This report records the bounded investigation required before adding
occlusion-aware COPC node culling. The result is **defer / not currently
justified**. The current adapter keeps the #58 frustum, #44 screen-space-error,
and #59 rendered-point budget paths unchanged.

## Scope and baseline

The investigation was run after the Issue #68 streaming validation gate. The
baseline is the browser-side `NodeSelector` and `StreamingManager`:

```text
hierarchy bounds -> frustum culling -> SSE refinement -> maxNodes
                 -> rendered-point budget -> range/decode/transform/render
```

The near Autzen run showed useful frustum filtering: 166 hierarchy candidates
were visited and 40 were rejected by the frustum. The selected workload was
bounded to 242,601 rendered points by the 250,000-point budget, while
1,227,442 estimated points were deferred. The run did not establish how many
of the remaining in-frustum candidates were hidden by terrain or other scene
geometry.

That distinction matters: a frustum candidate is not evidence of an occluded
node, and a point-count reduction from the existing budget is not an
occlusion benefit.

## Cesium public-API assessment

| Approach | Public and stable enough for the adapter? | Finding |
| --- | --- | --- |
| `Cesium.Occluder` | Yes, for an explicitly supplied bounding-sphere occluder | Useful for synthetic sphere-vs-sphere visibility, but it does not discover terrain or arbitrary already-rendered scene geometry. Constructing a globe or terrain proxy sphere would either be incomplete or risk false-positive culling. |
| Ellipsoid horizon culling | No for a new adapter contract | Cesium's ellipsoid-specific implementation is not part of the current public API/types. Depending on it would violate the issue's public-API constraint and could change without notice. |
| `Scene.pickPosition` / depth picking | Public where supported | Samples one window position from the depth buffer. A node needs many samples and a conservative screen-space coverage rule; missing depth support or an uncovered part of the node must mean visible. This is not a reliable whole-node occlusion proof. |
| `Scene.sampleHeight` / `clampToHeight` | Public where supported | These are height/clamping queries for rendered globe, 3D Tiles, or primitives, not general visibility tests. They require depth support and can return no result. They cannot prove that every projected part of a COPC node is hidden. |
| GPU occlusion queries / Hi-Z | Not through the current stable boundary | They would require renderer and asynchronous readback work that the current `PointPrimitiveCollection` boundary does not expose. Pending results also need generation-aware conservative fallback. |
| Cesium private frame/depth internals | No | Private internals are explicitly outside this issue's scope. |

The only immediately viable public primitive is an injected occluder volume.
It is appropriate for a future, explicitly modeled occluder, but the current
adapter has no authoritative terrain/scene occluder volume to inject.

## Decision

Do not add an `occlusion` option or hide nodes based on depth, terrain samples,
or Cesium private state at this time. This is a deliberate implementation of
the issue's allowed “not currently justified” outcome:

- uncertain, partially visible, and unsupported-depth cases remain visible;
- no stale visibility state can suppress a newer camera view;
- the Rust/backend contracts remain Cesium-agnostic;
- the existing frustum/SSE/budget behavior is unchanged;
- the current measurement does not claim an occlusion-related network or
  decode saving.

This is not a claim that occlusion is impossible. It means the current public
Cesium boundary cannot produce the required conservative whole-node evidence,
and the measured workload does not yet justify expanding that boundary.

## Re-entry criteria

Re-open the prototype when a repeatable terrain or structure scenario records
all of the following for the same camera sequence with occlusion disabled and
enabled:

1. an in-frustum candidate count and estimated point/fetch workload;
2. a conservative, node-level visibility signal with an explicit “unknown”
   result;
3. avoided range bytes, decoded points, and render preparation work;
4. camera-generation and recovery checks after rapid movement; and
5. an image/correctness check showing no holes or persistent under-rendering.

If that evidence appears, the next prototype should live between the Cesium
camera/scene adapter and `StreamingManager`. It should return visible,
occluded, or unknown; only the first two may be acted on, and unknown must
follow the existing visible path. No scene/depth logic should move into Rust.

## Validation

The baseline evidence and repeatable commands are documented in
[`issue-68-streaming.md`](./issue-68-streaming.md). That gate passed its unit,
Rust, browser, build, and packed-consumer checks. No occlusion behavior is
claimed by those results.

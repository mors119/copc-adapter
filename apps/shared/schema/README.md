# Workbench option schema

`options.ts` is the authoritative user-facing configuration inventory. Each
option definition declares its state and public API paths, control, validation
rules, renderer and capability requirements, application lifecycle,
code-generation form, serialization behavior, and defaults keyed by package
origin and version.

This is a schema-driven contract, not reflection over TypeScript interfaces.
Maintainers register each user-facing option here. The shared Workbench derives
controls, validation, configuration application, share-state serialization,
and generated integration code from that definition instead of maintaining
separate Playground and Dev Viewer option lists.

`apps/shared/config/` owns normalized pending/applied option maps and derives
constructor options and runtime method calls from this registry. It validates
before edits and again before application, uses a candidate for constructor or
host changes, and commits the applied snapshot only after activation succeeds.
Runtime-only updates reuse the active runtime and attempt to restore prior
values if a setter fails. Host adapters provide runtime creation, activation,
and disposal; the shared layer does not import Cesium, Three.js, or either app.
Safe share-state serialization goes through the same schema functions and only
serializes the requested pending or applied snapshot.

`manifests.ts` resolves only audited package profiles. The Playground's npm
profile is an explicit allowlist for the exact published release. The workspace
profile follows the current audited schema so new local options do not need a
second option-ID list. Renderer-specific exceptions remain explicit. For
example, npm `0.6.0` supports `maxConcurrentNodeLoads` in Three but not Cesium,
and it does not support layer `verticalTransform` or Cesium Terrain alignment;
the current workspace source supports those features. Update the workspace
profile version when `packages/package.json` changes. Unknown versions resolve
to no profile and must not receive controls or generated code.

The workspace `0.7.1` profile exposes numeric dimension ramps in both
renderers. Cesium applies ramp and inclusive filter edits through `setStyle()`;
Three.js receives the ramp as a constructor option and has no runtime dimension
filter. Controls use Intensity and exact scalar Extra Bytes descriptors from
loaded metadata. Only explicitly selected Extra Bytes fields are requested
before decode. Rust/WASM exposes Intensity but not named Extra Bytes, and 64-bit
integer descriptors stay unavailable to numeric styling because their values
remain `BigInt`. Structured ramp and filter share state uses bounded JSON.
The Playground's pinned npm `0.6.0` profile does not advertise these options, so
its controls and code generator omit them.

Playground and Dev Viewer typechecks compile the schema against their actual
package declarations. These checks compare constructor paths and nested
streaming options, enum choices, renderer-specific methods and exported
capabilities. Deprecated selector fields, lower-level scheduler batching,
duplicate nested point budgets, and host-injection callbacks/debug properties
are excluded intentionally because they are not ordinary Workbench settings.
The npm check resolves the exact locked published package; the Dev Viewer
check resolves workspace aliases. Compile-time contracts verify explicit
defaults fit their public property types. Tests compare exported runtime
defaults directly; values the package does not expose for introspection remain
explicit, versioned entries covered by regression tests.

`actions.ts` describes host operations such as probing/loading a source and
Cesium Terrain alignment. These are capability-gated actions, not persistent
layer settings. Specialized controls are named in the option/action metadata;
their DOM renderers belong to the shared Workbench.

Schema validation protects UI and URL boundaries. The adapter's constructor
and runtime checks remain authoritative. Conditional values are distinguished
from package support and are omitted while inactive. Explicit runtime clears
for classification and Focus Lens are represented separately from omitted
values. Source URLs and File/Blob values are never serialized. GTX grids are
accepted only through a host validator that recognizes a loaded verified grid;
grid resources themselves are never serialized.

Candidate tarballs have a distinct provenance value but no automatic schema
profile, so they fail closed instead of inheriting npm or workspace support.
They remain an isolated consumer-validation path under
[issue #315](https://github.com/mors119/copc-adapter/issues/315).

# COPC Adapter Dev Viewer

The Dev Viewer is an internal development workbench for visualizing, debugging,
and regression-testing `@frillab/copc-adapter`. It is separate from the public
Playground and is not a production consumer interface. It imports the workspace
package source and keeps development diagnostics and local Range middleware out
of the published package.

## Workbench

The full-window Cesium or Three.js canvas sits behind two independently
collapsible panels:

- **Controls** on the left groups source selection, rendering engine and backend,
  camera presets, appearance, streaming, and advanced settings.
- **Inspector** on the right groups current source status, the selected point,
  streaming metrics, source and hierarchy diagnostics, cache and Worker
  information, performance data, and advanced internal diagnostics. Detailed
  metrics use collapsible subsections and scroll within the panel.

Each panel has a keyboard-operable toggle that remains visible while collapsed.
The panels do not reserve space when closed. At narrow widths they become
viewport-sized drawers, with the canvas remaining full-window. The compact
version label reads the workspace adapter package version; it does not indicate
the version currently published to npm.

## Sources and configuration

Supported sources are the local Autzen fixture, public Autzen and Chicago URLs,
a custom HTTP/HTTPS URL, and a user-selected COPC File. Remote URLs load directly
from their host. Local Files use bounded Blob reads, so HTTP Range validation is
not applicable to them.

Selecting a different source and pressing **Load selected source** probes and
loads that source with the visible settings. The active source remains available
while the candidate is checked and loaded. Changes to settings that require a
new layer are staged until **Apply Settings** is pressed. These include the
rendering engine, backend, refinement algorithm, HTTP Range policy for remote
sources, Cesium point-renderer implementation, point size, and constructor-time
streaming limits. **Reload current source** explicitly rebuilds the current
source with the applied settings. Camera presets and Cesium color mode apply
live; camera distance is adjustable under Advanced settings.

Rendering engine and point renderer are separate choices. Cesium supports the
public PointPrimitive and Batched Geometry implementations; the point-renderer
choice is hidden when Three.js is active. The JavaScript and Rust/WASM backends
are available where supported by the selected renderer.

The **Refinement Algorithm** control selects `foveated` or `screen-projection`.
If omitted, the library default remains `foveated`. The algorithm is applied
when the layer is rebuilt and is shown in Inspector diagnostics alongside
selected and rendered nodes, points, and visible LoD levels.

The **HTTP Range Validation** control selects `head-fallback` or `strict` for
HTTP/HTTPS sources. A readable, valid `Content-Range` is validated strictly under
either policy. `head-fallback` uses limited compatibility checks only when
JavaScript cannot read `Content-Range` and a valid HEAD response is available;
the Inspector reports the actual probe validation level and warnings. HEAD
metadata is not cryptographic integrity verification. `strict` requires a
readable matching `Content-Range` and does not fall back to HEAD.

## Development and browser tests

From the repository root:

```bash
npm ci
npm ci --prefix packages
npm ci --prefix apps/dev-viewer
npm run download-samples -- autzen
npm run dev
```

`npm run dev` prepares the Rust/WASM decoder and laz-perf assets before starting
Vite. Download the local Autzen fixture once with the command above when it is
not already present. Public remote sources and custom URLs continue to load
directly from their original hosts.

Useful validation commands are:

```bash
npm --prefix apps/dev-viewer run typecheck
npm --prefix apps/dev-viewer run test:unit
npm --prefix apps/dev-viewer run build:ci
npm --prefix apps/dev-viewer run test:e2e
npm --prefix apps/dev-viewer run test:functional
```

Playwright uses `debugPanel=0` (also `false` or `off`) to start with the Inspector
collapsed while leaving its toggle available. `renderer=public-batched` remains
supported for renderer benchmarks. Existing `source`, `backend`, refinement,
Range-policy, camera, and issue-scenario query parameters remain available for
browser regression cases.

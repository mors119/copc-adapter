# COPC Adapter Playground

The public Playground is a separate Vite application for trying COPC Adapter
with public datasets or a user-provided URL. It supports Cesium and Three.js,
the JavaScript and Rust/WASM backends, point styling, streaming and cache
budgets, LoD controls, classification filters, source metadata, and point
inspection. Internal diagnostics, benchmark controls, fixtures, and test
harnesses remain in `apps/dev-viewer`.

Both apps render controls from the shared option schema and use its
configuration engine. Their package inputs stay separate: the Playground uses
the exact published npm version in its manifest and lockfile, while the Dev
Viewer aliases the workspace package source and keeps its fixture middleware
and developer modules in its own entrypoint. CI separately packs the working
commit and installs that candidate into isolated consumers.

## Terrain placement estimate

The Playground is pinned to published `@frillab/copc-adapter` 0.7.1. That
release exposes the single-anchor Cesium Terrain estimate API, so the shared
Coordinates command can estimate one selected COPC point. It does not expose
the batch API; Dev Viewer uses the workspace build for multi-anchor estimates.
Three.js and the ellipsoid-only Cesium viewer cannot sample Terrain, and the
command explains that state instead of estimating against a placeholder.

To enable an estimate, enter a consumer-owned Cesium quantized-mesh service
root URL (the folder containing `layer.json`) in **Terrain provider**, then
apply the settings. The Playground loads it into its own Cesium Viewer. This
URL stays out of share links and copied adapter configuration. Select a point,
confirm ground status unless it is LAS class 2, and choose **Estimate Terrain**.
The shared preview shows the provider, source and vertical-reference status,
sample result, residual, current manual `heightOffsetMeters`, and proposed
total. You can adjust the proposal by up to ±100 cm and must choose **Approve
and apply** to rebuild the active layer. Reset clears the estimate without
changing the applied offset. Estimates never modify source XYZ or apply by
themselves.

Terrain alignment is a visual placement estimate, not a geoid correction or
survey-grade vertical conversion. Orthometric or unknown source heights remain
uncertain until a verified vertical conversion is configured. The generated
code panel derives its applied settings from the successfully rebuilt layer;
Terrain placement provenance appears only after explicit approval and while
the approved source, provider, and final offset remain active.

Refinement can use the public `foveated` strategy (the default) or the legacy
`screen-projection` strategy. In Cesium, Focus Lens modes can prioritize the
center, follow the pointer, or keep a pinned screen-space circle. Lens movement,
radius, and detail-bias changes update the active layer; changing algorithms
reapplies the layer because the strategy is a constructor option. The guide is
visual only, and focus prioritizes detail without clipping the point cloud.
## Source and settings workflow

For an HTTP(S) source, choose or enter a URL and select **Probe source**. The
probe calls the installed package's public `probeCopcSource()` API without
creating or replacing a layer. Review HTTP status, CORS readability, byte
ranges, COPC detection, point format, resource size, validation level, and
warnings when available. Unknown results stay unknown. Known HTTP, CORS,
Range, or non-COPC failures explain what to check and disable **Load source**.
If a returned probe has unknown checks, Load remains a deliberate attempt and
the subsequent load may still fail. Retry Probe explicitly to repeat a check.
Editing the URL invalidates that probe. A local `File` can load directly; HTTP
CORS and Range checks do not apply to it.

After a successful load, the source panel shows point count, point format,
source-coordinate bounds, whether the source supplied WKT, and the active
backend and renderer. Bounds are in the dataset's source CRS units. The UI
does not infer a CRS, vertical datum, or height reference from a location.

Settings edits are **Pending** until applied. Backend, point size, rendered
point budget, point-cache budget, max nodes, max depth, screen-space error,
render distance, refinement algorithm, and renderer changes use **Apply
changes**. The current layer stays active if its replacement fails; a
successful replacement commits Active settings and preserves the camera when
the renderer permits it. Point-cache input is displayed in MiB and converted
to the exact integer byte count passed to the package. The rendered-point
budget estimates the active-view workload; it is not a GPU memory limit. The
CPU cache budget covers retained decoded point buffers. Max nodes limits
frontier pressure, max depth caps refinement, lower SSE generally requests
finer LoD, and render distance limits far visibility. Defaults follow the
Playground defaults audited against the installed public package.

Cesium color changes and classification filters use the public `getStyle()` /
`setStyle()` API on the active layer. They do not recreate the layer. Filters
accept LAS class codes 0–255; an empty include list hides all points, excludes
are applied after includes, and **Clear filter** removes the filter. If the
layer cannot apply a style to its retained buffers, the Playground shows a
recoverable error and keeps the prior Active style. The installed Three.js
layer has no equivalent public runtime style setter, so its color changes use
Apply and classification filters are unavailable there. A Cesium filter must
be cleared before applying a Three.js renderer. If a color is changed while a
Three.js renderer is pending and the selected renderer returns to the active
Cesium layer, the Playground reconciles that color through `setStyle()` without
replacing the layer.

For a dataset with numeric Extra Bytes, select the dimension under **Extra
Dimensions** before loading so its values are retained in the point cache. A
Cesium layer can then color and filter those cached values without another
point read:

```ts
const layer = new CopcCesiumLayer({
  url: source,
  extraDimensions: ["CanopyHeight"],
});
layer.attachTo(viewer);
await layer.load();
layer.setStyle({
  colorMode: "dimension",
  dimension: {
    name: "CanopyHeight",
    range: { min: 0, max: 50 },
    palette: [
      { position: 0, color: { red: 0.05, green: 0.2, blue: 0.65 } },
      { position: 1, color: { red: 0.85, green: 0.1, blue: 0.05 } },
    ],
  },
  dimensionFilter: { name: "CanopyHeight", min: 2, max: 40 },
});
```

This example requires a scalar dimension supported by the selected backend.
The JavaScript backend applies LAS scale and offset before styling. Missing
values use the fixed fallback color, and a matching range filter hides them.
64-bit integer dimensions remain exact in point inspection but are not
converted to display numbers.

**Reset to defaults** restores Playground settings without clearing the active
source, including a local `File` already backing the active layer.
Runtime-compatible Cesium styles are reset immediately; constructor changes remain Pending until
**Apply changes**. A local file is never added to a share URL.

During replacement, a hidden candidate runtime loads while the current runtime
stays visible. The Playground swaps to the candidate after success and then
disposes the previous runtime. Cesium becomes ready after `layer.load()`;
automatic camera zoom starts after the candidate is visible so a camera flight
cannot keep the hidden runtime in Loading. Failed or superseded candidates are
disposed; Cesium replacements may briefly use two viewer instances.

The Generated code panel provides Minimal and Explicit TypeScript examples for
the selected Cesium or Three.js renderer. It reads only the last successfully
applied configuration and runtime style; pending constructor settings are not
represented as active. Cesium style changes are emitted as public `setStyle()`
calls, while Three.js settings remain constructor options. Examples are typed
against the public entrypoint types from the exact installed npm release.
Three.js output includes an app-owned render loop and camera updates. Code and
install commands can be copied, and copy feedback follows the clipboard
result.

Renderer, backend, color, point-size, rendered-point and cache budgets, all
streaming and LoD settings, classification, and Focus Lens settings are
normalized in canonical share URLs. A copied share link excludes the source
by default; the source checkbox explicitly includes only a query-free HTTP(S)
URL. Credentials, query parameters, and fragments are treated as sensitive,
and are never copied to a share URL. Generated code uses a placeholder for
such URLs unless the explicit exact-source option is selected; copying that
code requires confirmation. Local file paths and bytes are never serialized.
Refreshing a link restores configuration as settings only. If a safe source
URL was included, it is filled into the source control and still requires a
fresh Probe and explicit Load. A link without a source never claims a layer is
loaded.

HTTP sources are requested directly by the browser. A source must provide
browser-readable CORS and usable HTTP Range responses. The Playground does not
rewrite URLs through a proxy, upload data, or weaken the package's response
validation. The probe reports what this browser could establish; it does not
prove that a remote file is authentic or immutable. If the browser blocks a
request, the exact cause may remain unknown; check host CORS, Range handling,
and access policy. RGB mode is available even when attributes are unavailable;
the package applies its documented missing-attribute behavior.

The app has no mandatory Cesium ion token. Its basic Cesium viewer uses the
ellipsoid and local background. Any remote source data remains in the browser,
and local files are read from the selected `File` without upload.

The package card shows the installed package version and origin. Public Pages
requires an exact npm release whose registry tarball and integrity match both
the lockfile and installed metadata. Local packed candidates are labeled
`Packed candidate`; workspace links are labeled `Workspace/local`.

## Local development

From the repository root, install the root, package, Dev Viewer, and Playground
dependencies and the Rust WASM target once:

```bash
npm ci
npm ci --prefix packages
npm ci --prefix apps/dev-viewer
npm ci --prefix apps/playground
rustup target add wasm32-unknown-unknown
```

Start the Playground against the exact released npm version pinned in its
manifest and lockfile:

```bash
npm run playground:dev
```

The development server uses the same base path as production:

```text
http://localhost:5173/copc-adapter/playground/
```

Playground E2E tests include three real-streaming Autzen smoke tests alongside
local-file and intercepted HTTP fixtures. Those smoke tests exercise the
public host's current CORS, Range, and point-streaming behavior.

## Production build

The Pages consumer checks that the pinned version exists in npm and that its
registry tarball and integrity match the committed lockfile and installed
package. Run the release check, typecheck, and build with:

```bash
npm run playground:verify-release
npm run playground:typecheck
npm run playground:build
```

To build and validate the complete Pages site locally, including VitePress,
the released npm consumer, and the combined artifact, run:

```bash
npm run pages:build
```

The complete static output is written to the ignored
`.ci-artifacts/pages-dist/` directory. VitePress owns the artifact root and
the Playground is assembled under `playground/`. The existing
`.github/workflows/docs-pages.yml` is the single Pages workflow: pull requests
build and validate without deploying, while `main` assembles and deploys the
complete artifact once.

## Release and validation paths

| Path | Package source | Validation |
| --- | --- | --- |
| Public Playground / Pages | Exact published npm version and integrity in `apps/playground/package-lock.json` | `npm run playground:verify-release`, `npm run playground:typecheck`, `npm --prefix apps/playground run test:e2e`, `npm run playground:build`, then `npm run pages:build` |
| Dev Viewer | Local TypeScript source through Vite workspace aliases | `npm --prefix apps/dev-viewer run typecheck`, `npm --prefix apps/dev-viewer run test:e2e`, and `npm --prefix apps/dev-viewer run build:ci` |
| Release candidate | `npm pack` tarball from the working commit, installed in isolated consumers | `npm run test:pack` and `npm run test:pack:three`; CI also runs Cesium and Three consumer gates |

Release order is candidate validation, npm publication by the maintainer,
registry verification, then an exact Playground pin and lockfile update. For a
new release, update the pin and lockfile with:

```bash
npm install --package-lock-only --save-exact @frillab/copc-adapter@VERSION --prefix apps/playground
npm ci --prefix apps/playground
npm run playground:verify-release
npm --prefix apps/playground run typecheck
npm --prefix apps/playground run test:e2e
npm run pages:build
```

`VERSION` must already be published. The release check compares npm registry
metadata with the exact tarball URL and SHA-512 integrity in the lockfile; an
unavailable version, a changed integrity, or any local package source blocks
the Pages build. To roll back a bad released dependency, pin the previous
published version and rerun the consumer checks:

```bash
npm install --package-lock-only --save-exact @frillab/copc-adapter@PREVIOUS --prefix apps/playground
npm ci --prefix apps/playground
npm run playground:verify-release
npm --prefix apps/playground run test:e2e
npm run pages:build
```

`PREVIOUS` must be a published version with a matching registry integrity.

## Public URLs

- Documentation: https://mors119.github.io/copc-adapter/
- Korean documentation: https://mors119.github.io/copc-adapter/ko/
- Playground: https://mors119.github.io/copc-adapter/playground/

The Playground accepts local `.copc.laz` files through its file picker. The
browser reads requested byte slices from the selected `File`; it does not
upload or store the dataset. Ordinary LAS/LAZ files without COPC hierarchy
metadata are unsupported. Point inspection shows only attributes present in
the selected point's decoded data.

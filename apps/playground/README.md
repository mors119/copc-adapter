# COPC Adapter Playground

The public Playground is a separate Vite application for trying COPC Adapter
with public datasets or a user-provided URL. It supports Cesium and Three.js,
the JavaScript and Rust/WASM backends, point styling, basic streaming limits,
and point inspection. Internal diagnostics, benchmark controls, fixtures, and
test harnesses remain in `apps/dev-viewer`.

The two apps reuse the public control widgets and normalized layer-option
mapping under `apps/shared`. Their package inputs stay separate: the Playground
uses the exact published npm version in its manifest and lockfile, while the
Dev Viewer aliases the workspace package source and keeps its fixture
middleware and developer modules in its own entrypoint. CI separately packs
the working commit and installs that candidate into isolated consumers.

Refinement can use the public `foveated` strategy (the default) or the legacy
`screen-projection` strategy. In Cesium, Focus Lens modes can prioritize the
center, follow the pointer, or keep a pinned screen-space circle. Lens movement,
radius, and detail-bias changes update the active layer; changing algorithms
reapplies the layer because the strategy is a constructor option. The guide is
visual only, and focus prioritizes detail without clipping the point cloud.
The Generated code panel provides Minimal and Explicit TypeScript examples for
the selected Cesium or Three.js renderer. It reads the last successfully
applied settings; constructor settings waiting for Apply are not shown. The
options object is checked against the public entrypoint types from the exact
installed npm release. Three.js output includes an app-owned render loop and
camera updates; Cesium classification filters use the public `setStyle()` API.
Code and install commands can be copied, and copy feedback follows the
clipboard result.

Renderer, backend, color, point-size, streaming, and focus settings are
normalized in share URLs. A copied share link excludes the source by default;
the source checkbox explicitly includes a query-free HTTP URL. URLs with
credentials, query parameters, or fragments are treated as potentially
sensitive: generated code shows a placeholder until the exact-source option is
enabled, and copying that URL requires confirmation. Local files are emitted
as a file-input example and are never placed in a URL. Refreshing a share link
restores those settings to the controls, then loads a shared source when one
was explicitly included.

HTTP sources are requested directly by the browser. A source must provide
browser-readable CORS and HTTP Range responses. The Playground does not rewrite
URLs through a proxy. The source probe reports what the browser could validate;
it does not prove that a remote file is authentic or immutable. RGB mode is
available only when the LAS point format advertises RGB attributes. Sliders
preview while dragging and apply after release; applying a value reloads the
current layer while keeping its camera view when possible.

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

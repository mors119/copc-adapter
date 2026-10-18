# COPC Adapter Playground

The public Playground is a separate Vite application for trying COPC Adapter
with public datasets or a user-provided URL. It supports Cesium and Three.js,
the JavaScript and Rust/WASM backends, point styling, basic streaming limits,
and point inspection. Internal diagnostics, benchmark controls, fixtures, and
test harnesses remain in `apps/dev-viewer`.

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

The package card shows the actual package version and install source read by
Vite from the installed package and lockfile. `Local package tarball` identifies
the repository's packed consumer workflow; it is not presented as an npm
Registry release.

## Local development

From the repository root, install the package, dev viewer, and Playground
dependencies and the Rust WASM target once:

```bash
npm ci
npm ci --prefix packages
npm ci --prefix apps/dev-viewer
npm ci --prefix apps/playground
rustup target add wasm32-unknown-unknown
```

Build and pack the adapter candidate, install that tarball into the Playground,
then start Vite:

```bash
npm run playground:package
npm run playground:dev
```

The development server uses the same base path as production:

```text
http://localhost:5173/copc-adapter/playground/
```

## Production build

The Playground build requires the packed adapter from
`npm run playground:package`. Typecheck and build with:

```bash
npm run playground:typecheck
npm run playground:build
```

To build and validate the complete Pages site locally, including VitePress,
the packed package consumer, and the combined artifact, run:

```bash
npm run pages:build
```

The complete static output is written to the ignored
`.ci-artifacts/pages-dist/` directory. VitePress owns the artifact root and
the Playground is assembled under `playground/`. The existing
`.github/workflows/docs-pages.yml` is the single Pages workflow: pull requests
build and validate without deploying, while `main` assembles and deploys the
complete artifact once.

## Public URLs

- Documentation: https://mors119.github.io/copc-adapter/
- Korean documentation: https://mors119.github.io/copc-adapter/ko/
- Playground: https://mors119.github.io/copc-adapter/playground/

The Playground accepts local `.copc.laz` files through its file picker. The
browser reads requested byte slices from the selected `File`; it does not
upload or store the dataset. Ordinary LAS/LAZ files without COPC hierarchy
metadata are unsupported. Point inspection shows only attributes present in
the selected point's decoded data.

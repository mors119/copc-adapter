# COPC Adapter Playground

The public Playground is a separate Vite application. It keeps
`apps/viewer-web` as the internal regression, E2E, and benchmark harness.

## Local development

From the repository root, install the three dependency sets and the Rust WASM
target once:

```bash
npm ci
npm ci --prefix apps/viewer-web
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

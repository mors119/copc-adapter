# COPC Adapter Dev Viewer

This Vite application is the development, browser regression, and performance
harness for `@frillab/copc-adapter`. The app imports the package's public source
entrypoint and keeps its debug panels and local sample Range middleware out of
the published package.

From the repository root, install dependencies and prepare the Rust/WASM target:

```bash
npm ci
npm ci --prefix packages/copc-adapter
npm ci --prefix apps/dev-viewer
rustup target add wasm32-unknown-unknown
```

Start the viewer with `npm run dev`, run the unit tests with
`npm test --prefix apps/dev-viewer`, and run browser tests with
`npm run test:e2e --prefix apps/dev-viewer`.

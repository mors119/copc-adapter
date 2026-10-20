# Scripts

This directory contains automation scripts for setting up and maintaining the development environment.

## Currently Supported Scripts

- **`download-samples`**
  - Run `npm run download-samples` to download the recommended sample datasets.
  - To download a specific dataset, provide its ID, such as `npm run download-samples -- autzen`.

- **`benchmark:streaming`**
  - Run `npm run benchmark:streaming --prefix apps/dev-viewer` to validate Autzen streaming performance, resource budgets, stale-work handling, and decoded CPU cache behavior.

- **`audit:crs`**
  - Run `npm run audit:crs -- --wasm --benchmark` to perform differential comparisons of checked-in WKT fixtures against `proj4js` and execute native Rust/WASM CRS benchmarks.

Commands for package builds, Rust/WASM setup, testing, conformance checks, and browser validation are maintained in the respective package scripts and the [Contributing Guide](../CONTRIBUTING.md).

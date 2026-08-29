# Contributing to COPC Adapter

Thank you for helping improve COPC Adapter. Bug reports, documentation
improvements, tests, and focused code changes are welcome.

## Before you start

- Search existing [issues](https://github.com/mors119/copc-adapter/issues) and
  pull requests before opening a new one.
- For a substantial change, open an issue first so the scope and design can be
  discussed.
- Please do not include downloaded sample datasets or generated build output
  in a commit. The repository downloads samples on demand and ignores generated
  artifacts.

## Local setup

Requirements:

- Node.js 18 or later
- Rust and the `wasm32-unknown-unknown` target

```bash
rustup target add wasm32-unknown-unknown
npm ci
npm ci --prefix apps/viewer-web
```

The viewer tests and examples use the Autzen sample. Download it when needed:

```bash
npm run download-samples -- autzen
mkdir -p apps/viewer-web/public/samples
cp samples/local/autzen.copc.laz apps/viewer-web/public/samples/autzen.copc.laz
```

## Development guidelines

Keep changes aligned with the layered architecture described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the project rules in
[docs/AGENTS.MD](docs/AGENTS.MD):

- Keep COPC parsing, hierarchy traversal, point loading, coordinate
  transformation, and Cesium rendering in their respective layers.
- Keep external library types behind project-owned interfaces where practical.
- Add or update tests for behavior changes.
- Update the relevant documentation when public behavior, limitations, or
  commands change.

## Validation

Before opening a pull request, run the checks relevant to your change. These
are the main validation commands used by the project:

```bash
npm --prefix apps/viewer-web run typecheck
npm --prefix apps/viewer-web test
npm --prefix apps/viewer-web run test:conformance:unit
npm --prefix apps/viewer-web run test:conformance:integration
npm --prefix apps/viewer-web run coverage
npm --prefix apps/viewer-web run build
npm run test:pack
cargo test --workspace
```

If a check cannot be run locally, explain why in the pull request.

## Pull requests

Please keep each pull request focused and include:

- a concise description of the problem and the approach;
- tests or other verification performed;
- documentation updates, when applicable;
- known limitations or follow-up work.

Keep commits small enough to review and use clear, imperative commit messages.
Pull requests should target `main`. A maintainer may ask for changes before
merging.

## Licensing

By submitting a contribution, you agree that it is provided under the
[Apache License 2.0](LICENSE), unless a separate written agreement says
otherwise. Do not submit code or assets that you do not have the right to
contribute, and preserve applicable third-party attribution notices.

Please follow the project's [Code of Conduct](CODE_OF_CONDUCT.md) when
participating.

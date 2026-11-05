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

- Node.js 20.19 or later in the 20.x line, or 22.12 or later (Vite 8 requirement)
- Rust and the `wasm32-unknown-unknown` target

```bash
rustup target add wasm32-unknown-unknown
npm ci
npm ci --prefix apps/dev-viewer --workspaces=false
npm ci --prefix apps/playground --workspaces=false
```

The root install owns the Adapter and Tiles workspaces. The Dev Viewer and
public Playground keep separate application lockfiles because they have
different package origins: the Viewer consumes the local Adapter package and
the Playground consumes the exact published Adapter release.

The viewer tests and examples use the Autzen sample. Download it when needed:

```bash
npm run download-samples -- autzen
mkdir -p apps/dev-viewer/public/samples
cp samples/local/autzen.copc.laz apps/dev-viewer/public/samples/autzen.copc.laz
```

## Development guidelines

Keep changes aligned with the layered architecture described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the correctness model in
[docs/CONFORMANCE.md](docs/CONFORMANCE.md), and the permanent coding rules in
[AGENTS.md](AGENTS.md):

- Keep renderer-neutral COPC streaming and point processing in shared layers.
- Keep engine-specific integration in its renderer adapter. CesiumJS and
  Three.js adapters must not duplicate COPC, hierarchy, or streaming policy.
- Place Rust and TypeScript work according to the ownership boundaries in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Keep external library types behind project-owned interfaces where practical.
- Add or update tests for behavior changes.
- Update the relevant documentation when public behavior, limitations, or
  commands change.

### Dependency maintenance

- Prefer the latest stable security, patch, and compatible minor releases.
  Review major upgrades separately; treat minor updates to `0.x` packages as
  possible breaking changes.
- Preserve exact pins that define a tested runtime or package contract. The
  public Playground stays on its exact published adapter release; candidate
  packages are validated through the isolated pack consumers.
- Exact pins under `tests/environments` are compatibility baselines; change
  them only as a reviewed compatibility or security update, then run the
  corresponding packed-consumer checks.
- Keep each npm installation's lockfile reproducible with `npm ci`. Review
  resolved versions and compatibility evidence before accepting an update.
- Dependabot runs weekly. Its SemVer update-type exclusions defer routine
  major changes and selected `0.x` minor changes; GitHub still creates security
  update pull requests regardless of those update-type exclusions.

## Validation

Run only the checks relevant to the changed area. Documentation-only changes
normally need `git diff --check` and validation of changed Markdown links.

- TypeScript or shared runtime changes:

```bash
npm run typecheck -w @frillab/copc-adapter
npm test -w @frillab/copc-adapter
npm run typecheck -w @frillab/copc-tiles
npm test -w @frillab/copc-tiles
```

- Rust changes:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

- Rust/WASM boundary changes: build for `wasm32-unknown-unknown` in release
  mode and run the relevant integration tests.
- Browser or renderer changes: run the relevant Playwright/browser tests.
- Package or export changes: run the relevant packed-consumer validation,
  such as `npm run test:pack` or `npm run test:pack:three`.
- Backend or CRS contract changes: run the fast conformance suite and, when
  applicable, the integration suite described in
  [docs/CONFORMANCE.md](docs/CONFORMANCE.md).

If a check cannot be run locally, explain why in the pull request.


### Codecov coverage reports

The CI reuses its **existing** test executions to upload three independent
source coverage reports to a single [Codecov dashboard](https://app.codecov.io/github/mors119/copc-adapter):

- **Adapter Node:** the `viewer-fast` job invokes
  `npm run coverage:raw -w @frillab/copc-adapter` once and uploads
  `packages/adapter/coverage/lcov.info` with flag `adapter-node`.
- **COPC Tiles Node:** the `tiles-package` job runs
  `COPC_TILES_COVERAGE=1 npm run verify -w @frillab/copc-tiles`.
  Its isolated staging runner replaces the existing unit-test invocation with
  `test:coverage` (it does not run both). Before deleting the staged copy, it
  exports `packages/tiles/coverage/lcov.info` for the `tiles-node` upload.
  Local runs of the normal `verify` command do not collect coverage.
- **Native Rust:** the `rust` job runs `cargo llvm-cov --workspace --lcov`
  **instead of** the original `cargo test --workspace`. It uploads
  `target/coverage/rust.lcov` with flag `rust-native`. Because llvm-cov
  does not run Rust documentation tests by default, `cargo test --workspace
  --doc` preserves those separate tests without rerunning native unit tests.

Each report is uploaded once, from its original CI job, using GitHub OIDC;
no separate coverage test job or permanent `CODECOV_TOKEN` is required.
The Codecov configuration waits for all **three uploads** before notifying on
code changes. Enable the repository in Codecov to see results. Project/patch
checks are initially informational and upload failures do not block the
existing required test gates.

The [README badge](README.md) displays Codecov's combined result for the
tracked reports on the default branch. It is **not** total application
execution coverage: browser E2E, Dev Viewer, Playground, Rust/WASM, and modules
not loaded by the Node test runners are not measured. In particular, the
currently emitted LCOV files do not establish 0% coverage for unloaded files,
so the dashboard must not be interpreted as covering every tracked source
line. The Rust figure covers native tests, not browser WASM.

The existing `viewer-web` aggregate remains the required gate; coverage
collection does not introduce duplicate full-suite runs. Pure docs-only
changes still skip product tests, so no new coverage reports are uploaded.

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

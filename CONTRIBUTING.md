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

Adapter unit tests already run once with Node's built-in coverage in the
`viewer-fast` CI job. The same test invocation also writes a Git-root-relative
LCOV file at `packages/adapter/coverage/lcov.info`:

```bash
npm run coverage:raw -w @frillab/copc-adapter
```

The runner uses paired `spec` and `lcov` reporters in **one** test execution.
Its report normalizer excludes tests, tooling, and other workspaces; the report
contains executed Adapter source modules only. Unloaded modules are not
automatically included in this first-pass coverage baseline.

Codecov receives this file from the existing `viewer-fast` job, using GitHub
OIDC and the `adapter-node` flag. No separate coverage test job or permanent
`CODECOV_TOKEN` is needed. Maintainers must first enable
`mors119/copc-adapter` in Codecov. Initially the project and patch checks are
informational and the upload does not block CI, so baseline collection cannot
weaken existing required test gates.

**Scope:** This upload does not measure Rust native/WASM, the Tiles workspace,
Dev Viewer, Playground, or browser E2E execution. Add independent collection
only when existing jobs can reuse their test invocations; do not run the same
suite twice just for a coverage badge.

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

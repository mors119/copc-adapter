# Agent instructions

Repository-wide rules for coding agents working on COPC Adapter.

## Change rules

- Work from the relevant GitHub issue when one exists.
- Keep one clear purpose per branch and pull request.
- Inspect the existing implementation and relevant documentation before changing
  architecture.
- Implement the smallest complete change that satisfies the request.
- Add or update tests when behavior changes.
- Do not delete, weaken, or skip tests to make validation pass.
- Do not include unrelated refactoring.
- Do not silently change public behavior.
- Record unrelated findings as separate follow-up issue candidates.

## Repository safety

Do not commit credentials or access tokens, downloaded COPC datasets,
generated build output, local environment files, or editor/operating-system
temporary files.

Do not perform destructive or history-rewriting Git operations without explicit
approval.

## Required validation

Run the checks relevant to the changed area before considering the work
complete. Documentation-only changes normally require `git diff --check` and
validation of any changed Markdown links.

- TypeScript/shared runtime: `npm --prefix apps/viewer-web run typecheck` and
  the relevant tests.
- Rust: `cargo fmt --all -- --check`, `cargo test --workspace`, and
  `cargo clippy --workspace --all-targets -- -D warnings`.
- Rust/WASM boundary: the `wasm32-unknown-unknown` release build and relevant
  integration tests.
- Browser/renderer changes: relevant browser tests.
- Package/export changes: relevant packed-consumer tests.

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

## Rust panic safety

Production Rust code must not rely on panics for recoverable input, format,
parsing, decoding, CRS, WASM-boundary, or runtime errors.

In production/runtime code:

- Do not use `unwrap()` or `expect()`.
- Do not use `panic!()`, `todo!()`, `unimplemented!()`, or reachable
  `unreachable!()` for recoverable failures.
- Do not use `assert!()` or similar assertions to validate external or
  user-controlled input.
- Prefer `Result`, `Option`, checked arithmetic, and project-owned errors.
- Treat COPC, LAS, LAZ, WKT, CRS, HTTP-derived bytes, and WASM inputs as
  untrusted.
- Bounds-check byte ranges before slicing, indexing, decoding, allocating, or
  copying.
- Prefer checked access such as `.get()` when offsets or indices originate from
  external data.
- Use `checked_add`, `checked_mul`, and equivalent checked conversions when
  calculating byte offsets, lengths, counts, or allocation sizes.
- Do not rely on an earlier validation step as the only reason a later
  unchecked conversion or index "cannot fail" when a checked alternative is
  practical.
- Do not use `unsafe`, `unwrap_unchecked`, unchecked pointer arithmetic, or
  unchecked conversions unless they are strictly necessary and the safety
  invariant is documented and tested.
- WASM/FFI boundaries must convert recoverable failures into structured errors
  or status results rather than allowing a panic to cross the boundary.
- Preserve the original error cause and useful context when mapping failures.
- Do not introduce silent fallback to hide an error.

Tests may use `unwrap()`, `expect()`, assertions, and deliberate panics when
they make the expected invariant clearer.

Development-only benchmarks and audit tools may use assertions for fixed
repository-owned fixture invariants, but user-, file-, or externally supplied
input should still return an error instead of panicking.
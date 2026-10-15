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

## Benchmark and evidence documentation policy

- The Pull Request is the default record for implementation-specific measurements,
  test outcomes, commands, environments, limitations and decisions; the Issue
  carries the problem and acceptance criteria.
- Do NOT create `docs/benchmarks/issue-*.md` or standalone validation files by
  default, even for performance work. Do not add files merely to report CI passes.
- A new standalone benchmark file is allowed **only if all** conditions hold:
  1. The maintainer explicitly requests or approves a separate benchmark record.
  2. It is a reproducible baseline needed for comparison across future versions,
     not a one-time validation or an issue-closeout report.
  3. It includes measured results, inputs, environment, versions, methodology,
     reproduction commands, and limitations.
  4. No suitable existing canonical document exists and PR-only evidence would
     materially impair future comparison.
- Current architecture and package decisions belong in architecture docs, Issues
  and PRs, not in new benchmark files.
- Update existing benchmark records when they remain useful; do not silently
  overwrite old results with measurements from different conditions.
- Deletion or relocation of existing records requires maintainer approval and
  correction of all inbound repository links. Never auto-delete closed-issue
  records.

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

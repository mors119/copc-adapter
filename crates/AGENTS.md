# Rust Instructions

Scope: `crates/`. Supplements root [`AGENTS.md`](http://AGENTS.md).

## Rust Safety

- Treat COPC, LAS/LAZ, WKT/CRS, HTTP bytes, and WASM inputs as untrusted.
- Never panic on recoverable errors in production code.
- Avoid `unwrap()`, `expect()`, `panic!()`, `todo!()`, and `unimplemented!()` in recoverable runtime paths.
- Prefer `Result`, `Option`, checked arithmetic, and structured errors.
- Validate bounds, offsets, lengths, indices, and allocations before access.
- Avoid `unsafe` unless necessary, documented, and tested.
- Preserve error causes; never silently fall back to another backend.
- Convert WASM/FFI failures into structured errors without unwinding across boundaries.

## Rust Documentation

- Use Rustdoc (`///`, `//!`) for public APIs.
- Explain contracts, errors, safety invariants, and ownership.
- Document `# Errors`, `# Panics`, and `# Safety` where applicable.
- Avoid redundant comments.

## Validation

- `cargo fmt --all -- --check`
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- Verify WASM release builds and integration tests when affected.
- Tests may use assertions and `unwrap()` when appropriate.


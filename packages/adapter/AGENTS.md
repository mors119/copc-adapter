# COPC Adapter Package Instructions

Scope: TypeScript library, tests, and build code under `packages/adapter/`. Supplements the repository-wide [`AGENTS.md`](../../AGENTS.md).

## TypeScript & JSDoc

- Document public classes, methods, functions, types, interfaces, and properties.
- Explain enum/union values, constants, errors, events, and configuration options.
- Include units, defaults, ranges, coordinate systems, lifecycle, and ownership semantics.
- Use `@param`, `@returns`, `@throws`, `@example`, `@defaultValue`, and `@deprecated` when useful.
- Describe behavior, not redundant TypeScript type information.
- Document complex internal invariants, especially streaming, LoD, cancellation, and memory ownership.
- Keep public JSDoc in English and verify generated `.d.ts` declarations.

## Refactoring

- Split large modules by responsibility, not line count.
- Extract cohesive logic without duplicating implementations.
- Preserve public APIs, imports, behavior, and performance.
- Keep Cesium/Three dependencies out of the shared streaming core.
- Separate broad refactoring from feature development.

## Validation

- Run TypeScript typecheck and relevant tests.
- Verify generated declarations and packed-consumer compatibility.
- Run browser tests for renderer or lifecycle changes.
- Do not generate separate Markdown reports for code documentation.


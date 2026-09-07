# Conformance

Conformance protects the project-owned contracts while implementations move
between TypeScript and Rust. It compares observable semantic results, not
private decoder structure or incidental array ordering.

The COPC specification is the normative format reference. Reference
implementations are comparison tools and do not automatically define the
correct result.

## COPC backend conformance

The backend contract is exercised against the available production backends:
the default `copc-js` implementation and the opt-in Rust/WASM implementation.
The comparison should cover:

- metadata, including LAS scale/offset, bounds, COPC cube, spacing, and WKT;
- root and nested hierarchy interpretation;
- node identity, point counts, offsets, lengths, and page references;
- decoded point values and requested attributes;
- field selection and absent-field behavior;
- exact HTTP Range semantics and byte accounting; and
- structured source, metadata, hierarchy, point, decode, worker, and WASM
  errors.

The current Rust implementation is intentionally a supported LAS 1.4 subset,
including point formats 6, 7, and 8. Rust remains opt-in until broader format,
dataset, and browser validation is sufficient to justify a default change. A
Rust failure must be reported as a Rust/backend failure; it must not be
silently retried through `copc-js`.

The shared assertions belong at the project-owned `CopcBackend`/`CopcSource`
boundary. They should not require Cesium or Three.js, and they should not
assert decoder-specific allocation or internal traversal choices.

## CRS differential conformance

The current JavaScript CRS implementation and a candidate Rust CRS
implementation must be compared at the project-owned coordinate boundary.
The intended comparison covers:

- WKT1 and WKT2 parsing where supported;
- projected CRS;
- geographic CRS;
- axis and coordinate-order behavior;
- horizontal coordinates;
- height and unit handling;
- source coordinates to WGS84 geographic coordinates; and
- WGS84 geographic coordinates to world/WGS84 ECEF preparation.

The current path uses the project WKT helpers and `proj4js` for applicable
projected CRS transformations. A Rust CRS pipeline is a candidate target, not
an already-complete parity guarantee. `proj4rs` and `proj4wkt` may be useful
comparison or implementation choices, but neither is the specification.

If results disagree:

1. Inspect the source metadata and WKT.
2. Consult authoritative CRS definitions and axis/unit rules.
3. Identify which implementation is incorrect or which behavior is
   unsupported.
4. Add a deterministic project-owned regression for the decision.
5. Do not simply increase tolerance until both implementations pass.

Unsupported projection or WKT behavior must be explicit. A fallback that hides
Rust-path incompatibility is a conformance failure.

## Fixture strategy

Use deterministic, project-owned fixtures for the fast suite. Fixtures should
include:

- small valid and malformed COPC metadata and hierarchy pages;
- multiple CRS families and representative WKT forms;
- scale, offset, axis, and unit cases;
- requested point fields and missing-attribute cases; and
- real COPC datasets where the data is legally and publicly available.

The fast unit suite must not depend on a network or a downloaded dataset. Real
datasets belong in an explicit integration or browser suite, with provenance
and setup documented separately. The repository's local Autzen sample is used
for integration coverage when it has been downloaded; it is not committed to
the repository.

`test/support/copc-fixture.mjs` constructs the deterministic LAS 1.4/COPC byte
fixture inside the test process. It covers metadata, COPC info, WKT, hierarchy
entries, page references, and malformed input. It is not a valid compressed
point file, so compressed point decoding and end-to-end CRS behavior require
the real-dataset integration path.

## Commands

Fast deterministic backend checks:

```bash
npm --prefix apps/viewer-web run test:conformance:unit
```

Integration checks use the local Autzen copy:

```bash
npm run download-samples -- autzen
npm --prefix apps/viewer-web run test:conformance:integration
```

The complete application test command also discovers the conformance tests:

```bash
npm --prefix apps/viewer-web test
```

Use the change-specific Rust, WASM, TypeScript, browser, and packed-consumer
checks described in [CONTRIBUTING.md](../CONTRIBUTING.md). The fast unit suite
is the default regression signal for backend and CRS contract changes; it must
remain deterministic and network-independent.

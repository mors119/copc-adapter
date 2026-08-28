# Backend Conformance

The backend conformance suite extends the shared contract harness in
`apps/viewer-web/test/support/backend-contract.mjs`. The same semantic
assertions run against `CopcJsBackend` and `RustCopcBackend`; tests do not
compare decoder internals or array ordering that is not part of the public
contract.

## Baseline audit before Issue #42

| Area | Existing coverage before #42 |
| --- | --- |
| Metadata | Partial: Rust parser fields and one deterministic parity check; Autzen parity was root-only and skipped without a local sample |
| Hierarchy | Partial: root normalization and Rust incremental-loader tests; no shared recursive page/node contract |
| Point data | Partial: one Autzen Rust path compared selected XYZ/RGB values; no shared multi-index all-attribute contract |
| Coordinate semantics | Partial: positive Autzen transform and unit tests; no differential regression assertions for raw scale/offset and axis/height mistakes |
| Range behavior | Partial: Rust exact node range and loader byte counters; no single contract covering header, page, and chunk requests |
| Structured errors | Partial: Rust mappings and generic application errors; no equivalent stages/categories asserted for both backends |
| Fixtures and CI | Partial: generated metadata fixture and optional Autzen sample; no explicit conformance commands or fixture provenance note |

## Commands

Fast deterministic checks do not require a public URL or the Autzen sample:

```bash
npm --prefix apps/viewer-web run test:conformance:unit
```

The integration checks use the repository's local Autzen copy. Download it
once, then run the repeatable local test:

```bash
npm run download-samples -- autzen
npm --prefix apps/viewer-web run test:conformance:integration
```

The complete application test command also discovers the conformance file:

```bash
npm --prefix apps/viewer-web test
```

## Fixture policy

`test/support/copc-fixture.mjs` constructs a small LAS 1.4/COPC byte fixture
inside the test process. Its stable header, COPC info, WKT, hierarchy entries,
page reference, and malformed variants are defined locally; no fixture or
expected-value table is copied from a reference repository. It is deliberately
not a valid point-compressed file, so point decoding is tested against the
official Autzen sample in the integration suite.

Autzen is registered in `samples/datasets.json` as the public sample
`https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz`. The local
download is ignored by Git and public internet access is needed only for that
explicit setup step, never by the fast unit suite.

The normative behavior cross-check is the [COPC specification](https://copc.io/).
`copc-js` remains the application baseline; other COPC projects are design
references only and are not sources for copied tests or expected values.

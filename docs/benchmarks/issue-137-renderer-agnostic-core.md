# Issue #137 renderer-agnostic core validation

Validation date: 2026-09-06

## Gate result

No blocking Cesium regression was found after the renderer-agnostic core
extraction. Issue #137 is ready to close together with parent issue #131.

| Gate | Result | Evidence |
| --- | --- | --- |
| Core import direction | PASS | No Cesium import in `src/viewer/streaming`, `src/copc`, or `src/coordinates` |
| Duplicate implementation audit | PASS | One `HierarchyLoader`, `NodeSelector`, and `StreamingManager` implementation |
| View, renderer, and coordinate boundaries | PASS | Renderer contract, view/query, and coordinate conformance tests |
| Public API and lifecycle | PASS | Typecheck, unit tests, picking/lifecycle browser checks |
| #99/#100/#101/#128 regression coverage | PASS | Unit and browser regression suites |
| copc-js and Rust/WASM backends | PASS | Backend conformance and Rust workspace tests |
| Packed consumer | PASS | Production 2/2 and development 2/2 Chromium smoke tests |
| Fake renderer | PASS | Renderer-contract unit suite |
| Performance and resource budgets | PASS | Chromium E2E 11/11; renderer and streaming budget assertions passed |

## Validation commands

- `npm run typecheck` — passed
- `npm test` — 213 passed, 0 failed
- `npm run test:conformance:unit` — 4 passed, 4 intentional integration skips
- `npm run test:conformance:integration` — 8 passed
- `npm run coverage` — 213 passed; 94.33% lines, 83.53% branches, 93.54% functions
- `npm run build` — passed
- `npm run test:e2e` — 11 passed
- `cargo test --workspace` — 10 passed
- `npm run test:pack` — production consumer 2/2 and development consumer 2/2

## Strengthening applied during validation

- The browser sample Range middleware now serves the downloaded
  `samples/local` file in local and CI runs, while retaining support for a
  staged `public/samples` file.
- Cesium camera events are serialized and materially equivalent views are
  coalesced; a materially changed `moveEnd` invalidates stale adapter progress
  without turning noisy `changed` events into repeated cancellations.
- The layer snapshot accounts for progress rendered before the core update
  promise resolves, keeping diagnostics consistent with visible points.
- Chromium installation and the browser E2E gate are now part of CI.

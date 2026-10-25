# Agent Instructions

Repository-wide rules for COPC Adapter.

## Development

- Follow the relevant Issue and keep one purpose per PR.
- Prefer minimal changes; avoid unrelated refactoring.
- Preserve public APIs and existing behavior unless explicitly approved.
- Add or update regression coverage for behavior changes. Tests may be removed, consolidated, or rewritten when they are genuinely redundant, obsolete, or superseded; preserve unique behavioral coverage and never manipulate tests to hide failures.
- Record unrelated findings as follow-up Issue candidates.
- Stop at `AWAITING MAINTAINER REVIEW`; do not merge or publish without approval.

## Internal Cleanup

- Remove obsolete or duplicated internal implementations when their consumers and replacements have been verified.
- Keep tests when they provide distinct coverage for supported behavior; existing tests do not automatically require permanent preservation. Assess redundancy within the same validation boundary. Unit, integration, browser, and packed-consumer tests can cover different failure modes for the same feature, so tests at different layers are not duplicates by default.
- Retain developer diagnostics, benchmarks, fixtures, and scripts when they serve a demonstrated purpose. Before removing a unique validation capability or historical measurement, verify that its purpose is retired or adequately covered elsewhere.
- Give every meaningful removal a clear reason and validate the affected behavior with the relevant surviving regression checks.
- Prefer direct, understandable implementations over speculative extension points and unnecessary compatibility layers.
- Review public API removals separately for compatibility; do not remove a public API without explicit approval.

## Safety

- Never commit secrets, datasets, build artifacts, or local files.
- Never rewrite Git history or perform destructive operations without approval.

## Documentation

- Record implementation, tests, measurements, and limitations in PRs.
- Do not create standalone benchmark or validation files by default.
- New benchmark files require **all**: maintainer approval, reusable cross-version baseline, reproducible measurements with environment/method/limitations, and no adequate existing record.
- Preserve historical results that still inform current decisions. Remove an obsolete record only after checking its continued value and updating affected links.

## Validation

- Run relevant unit, integration, and browser tests.
- Validate package changes with packed-consumer tests.
- Check Rust/WASM builds when affected.
- For documentation changes, run `git diff --check` and verify links.
- Report actual results; never claim unexecuted checks passed.


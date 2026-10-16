# Agent Instructions

Repository-wide rules for COPC Adapter.

## Development

- Follow the relevant Issue and keep one purpose per PR.
- Prefer minimal changes; avoid unrelated refactoring.
- Preserve public APIs and existing behavior unless explicitly approved.
- Add tests for behavior changes; never remove, skip, or weaken tests.
- Record unrelated findings as follow-up Issue candidates.
- Stop at `AWAITING MAINTAINER REVIEW`; do not merge or publish without approval.

## Safety

- Never commit secrets, datasets, build artifacts, or local files.
- Never rewrite Git history or perform destructive operations without approval.

## Documentation

- Record implementation, tests, measurements, and limitations in PRs.
- Do not create standalone benchmark or validation files by default.
- New benchmark files require **all**: maintainer approval, reusable cross-version baseline, reproducible measurements with environment/method/limitations, and no adequate existing record.
- Preserve historical results; obtain approval before deleting records and fix affected links.

## Validation

- Run relevant unit, integration, and browser tests.
- Validate package changes with packed-consumer tests.
- Check Rust/WASM builds when affected.
- For documentation changes, run `git diff --check` and verify links.
- Report actual results; never claim unexecuted checks passed.


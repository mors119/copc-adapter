# [AGENTS.md](http://AGENTS.md)

Repository-wide rules for coding agents working on COPC Adapter.

## Change Rules

- Work from the relevant GitHub Issue when one exists.

- Keep one clear purpose per branch and Pull Request.

- Implement the smallest complete change that satisfies the issue.

- Inspect the existing implementation and relevant documentation before changing architecture.

- Add or update tests when behavior changes.

- Do not delete, weaken, or skip tests merely to make validation pass.

- Do not include unrelated refactoring in an issue branch.

- Do not silently change public behavior.

- Record unrelated findings as follow-up issue candidates instead of expanding scope.

## Repository Safety

Do not commit:

- credentials or access tokens

- downloaded COPC datasets

- generated build output

- local environment files

- editor or operating-system temporary files

Do not perform destructive or history-rewriting Git operations without explicit approval.

## Required Validation

Run the validation relevant to the changed area before considering the work complete.

### TypeScript / shared runtime

```bash

npm --prefix apps/viewer-web run typecheck

npm --prefix apps/viewer-web test
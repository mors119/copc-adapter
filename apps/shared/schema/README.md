# Workbench option schema

options.ts is the shared configuration inventory. Each option definition
declares its state and public API paths, control, validation rules, renderer and
capability requirements, application lifecycle, code-generation form,
serialization behavior, and defaults keyed by package origin and version.

manifests.ts resolves only audited package profiles. The Playground's npm
profile is an explicit allowlist for the exact published release. The workspace
profile follows the current audited schema so new local options do not need a
second control list. Update its version when packages/package.json changes.
Unknown package versions resolve to no profile and must not receive generated
controls or code.

actions.ts describes host operations such as probing/loading a source and
Cesium Terrain alignment. These are capability-gated actions, not persistent
layer settings. Specialized controls are named in the option/action metadata;
their DOM renderers belong to the shared Workbench.

Schema validation protects UI and URL boundaries. The adapter's constructor
and runtime checks remain authoritative. Source values are never serialized;
callers pass the active configuration explicitly when generating share state.

Candidate tarballs are not a package origin for either app. They remain an
isolated consumer-validation path under [issue #315](https://github.com/mors119/copc-adapter/issues/315).

# Packed Cesium/Vite consumer

This checked-in template is copied into a disposable directory by
`npm run test:pack`. The test installs the generated `@frillab/copc-adapter`
tarball by package name, builds this external Vite/Cesium app, and runs
Chromium against the packaged runtime in both production preview and normal
Vite development mode. The development check uses Vite's default dependency
optimization and contains no adapter-specific `optimizeDeps` configuration.

The browser loads the repository-local Autzen sample only from the consumer's
own `public/samples` directory. The package is imported only through its public
`@frillab/copc-adapter` export.

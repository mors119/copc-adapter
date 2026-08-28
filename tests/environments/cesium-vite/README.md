# Packed Cesium/Vite consumer

This checked-in template is copied into a disposable directory by
`npm run test:pack`. The test installs the generated `@frillab/copc-adapter`
tarball by package name, builds this external Vite/Cesium app, serves its
production bundle, and runs Chromium against the packaged runtime.

The browser loads the repository-local Autzen sample only from the consumer's
own `public/samples` directory. The package is imported only through its public
`@frillab/copc-adapter` export.

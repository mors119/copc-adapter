# Packed Three.js/Vite consumer

This checked-in template is copied into a disposable directory by
`npm run test:pack:three`. The test installs the generated
`@frillab/copc-adapter` tarball by package name, installs `three`, and builds
an ordinary Vite app that imports only `@frillab/copc-adapter/three`.

The fixture is build-focused while the Three camera, renderer, styling, and
layer façade issues are implemented. It intentionally has no Cesium
dependency, alias, or source deep-import.

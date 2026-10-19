# COPC Adapter Dev Viewer

This Vite application is the development, browser regression, and performance
harness for `@frillab/copc-adapter`. The app imports the package's public source
entrypoint and keeps its debug panels and local sample Range middleware out of
the published package.

## UI와 검증 범위

Dev Viewer는 공개 Playground의 디자인 토큰과 조작 방식을 공유하지만,
내부 검증 기능은 별도로 유지합니다. Cesium/Three.js와 JavaScript/Rust-WASM을
전환할 수 있고, 로컬 파일·공개 샘플·사용자 URL을 로드합니다. Controls 패널은
Source, Renderer and Backend, Camera presets, Appearance, Streaming, Advanced
settings로 나뉩니다. Inspector 패널은 현재 상태, 선택한 점, streaming metrics와
source, hierarchy, cache, worker, performance 및 내부 진단을 표시합니다.

상단 패키지 표시는 Vite가 읽은 workspace 패키지 버전입니다. 이 화면은 로컬
소스를 직접 alias해 개발하므로 npm Registry에 게시된 버전이라는 뜻은 아닙니다.
실제 tarball 소비 검증은 기존 packed-consumer 테스트를 사용합니다.

## Workbench DOM contract for Task 3

The panel toggles are `#controls-toggle` and `#inspector-toggle`. They control
`#controls-panel` and `#inspector-panel`, remain visible while their panels are
collapsed, and keep `aria-expanded` in sync with each panel's `hidden` state.
`debugPanel=0`, `false`, or `off` starts the Inspector collapsed while keeping its
toggle available.

The canonical source status is `#source-status` inside the Inspector. The selected
point lives in the `COPC point inspector` region within that panel. Streaming
metrics and runtime diagnostics are grouped under `#inspector-content`; the former
floating `.dev-stream-hud` is no longer part of the DOM. Camera presets and color
mode each have one segmented control in the Controls panel at `#camera-control`
and `#color-control`. Browser regression tests for the next task should use these
controls and panel toggles instead of the removed floating HUD, camera/style
buttons in diagnostics, or standalone point-inspector landmark.

From the repository root, install dependencies and prepare the Rust/WASM target:

```bash
npm ci
npm ci --prefix packages
npm ci --prefix apps/dev-viewer
rustup target add wasm32-unknown-unknown
```

Start the viewer with `npm run dev`, run the unit tests with
`npm test --prefix apps/dev-viewer`, and run browser tests with
`npm run test:e2e --prefix apps/dev-viewer`.

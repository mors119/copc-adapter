# COPC Adapter Dev Viewer

This Vite application is the development, browser regression, and performance
harness for `@frillab/copc-adapter`. The app imports the package's public source
entrypoint and keeps its debug panels and local sample Range middleware out of
the published package.

## UI와 검증 범위

Dev Viewer는 공개 Playground의 디자인 토큰과 조작 방식을 공유하지만,
내부 검증 기능은 별도로 유지합니다. Cesium/Three.js와 JavaScript/Rust-WASM을
전환할 수 있고, 로컬 파일·공개 샘플·사용자 URL을 로드합니다. 기본 패널은
색상 모드, point size, 선택 node/point 한도를 제공하며 Advanced Settings에서
depth, SSE, 카메라 거리, 최대 렌더 거리를 조절합니다. 우측 Advanced Diagnostics에는
기존 metadata, hierarchy, scheduler, cache, HTTP Range, worker와 성능 정보가
남아 있습니다.

상단 패키지 표시는 Vite가 읽은 workspace 패키지 버전입니다. 이 화면은 로컬
소스를 직접 alias해 개발하므로 npm Registry에 게시된 버전이라는 뜻은 아닙니다.
실제 tarball 소비 검증은 기존 packed-consumer 테스트를 사용합니다.

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

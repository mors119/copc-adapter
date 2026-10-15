# 문서 수정 방법

이 페이지는 VitePress 문서를 직접 고칠 때 **어디를 수정해야 하는지 빠르게 찾기 위한 메모**입니다.

## 기본 원칙

문서는 두 층으로 유지하는 것을 권장합니다.

```text
docs/*.md
  → 상세 기술 문서 / canonical reference

docs/ko/*.md
  → 한글 학습 가이드 / 사용 흐름 설명
```

즉 영문 technical reference를 모두 복사해 번역하기보다:

- 정확한 타입/계약: 기존 영문 문서
- 이해하기 쉬운 설명: 한글 문서

로 나누면 중복 수정이 줄어듭니다.

## 어떤 파일을 고치면 되나

| 바꾸고 싶은 내용 | 문서 |
| --- | --- |
| 사이트 첫 화면 | `docs/index.md`, `docs/ko/index.md` |
| 설치/첫 사용 | `docs/ko/getting-started.md` |
| Range/LoD 설명 | `docs/ko/streaming.md` |
| 서버/CORS 문제 | `docs/ko/source-requirements.md` |
| 색상/필터/picking | `docs/ko/styling-and-picking.md` |
| API 요약 | `docs/ko/api.md` |
| 코드 구조 공부 | `docs/ko/architecture.md` |
| 검증 수치/근거 | `docs/ko/validation.md` |
| 실제 API 전체 | `docs/API.md` |
| 실제 설계 전체 | `docs/ARCHITECTURE.md` |
| backend/CRS conformance | `docs/CONFORMANCE.md` |
| 대회 시연 절차 | `docs/CONTEST-FUNCTIONAL-TEST.md` |

## VitePress에서 자주 쓰는 Markdown

### 일반 제목

```md
# 큰 제목
## 중간 제목
### 작은 제목
```

### 코드

````md
```ts
const value = 1;
```
````

### 안내 박스

```md
::: tip
도움말
:::

::: warning
주의사항
:::
```

### 내부 링크

```md
[빠른 시작](/ko/getting-started)
[Public API](../API)
```

파일 확장자 `.md`를 링크에 꼭 적을 필요는 없습니다.

## 새 한글 페이지 추가 순서

예를 들어 `docs/ko/cache.md`를 추가한다면:

1. Markdown 파일 생성
2. 한글 navbar/sidebar에 링크 추가
3. 관련 기존 페이지에서 링크 연결
4. `npm run docs:dev`로 확인
5. broken link가 없는지 build 확인

현재 VitePress 설정은 `docs/.vitepress/config.mts`에 있고, 저장소 루트 `package.json`의 `docs:dev`, `docs:build`, `docs:preview` script를 사용합니다.


## 로컬에서 문서 확인하기

저장소 루트에서 실행합니다.

```bash
npm ci
npm run docs:dev
```

개발 서버가 뜨면 터미널에 표시된 주소를 엽니다. GitHub Pages와 같은 base path를 사용하므로 기본 로컬 주소는 대략 다음 형태입니다.

```text
http://localhost:5173/copc-adapter/
```

한글 문서는:

```text
http://localhost:5173/copc-adapter/ko/
```

에서 확인할 수 있습니다.

배포 전에 반드시 production build도 확인합니다.

```bash
npm run docs:build
```

VitePress는 이 단계에서 잘못된 내부 링크도 검사하므로 dead link가 있으면 먼저 수정합니다.

## GitHub Pages 배포

배포 workflow는 다음 파일에서 관리합니다.

```text
.github/workflows/docs-pages.yml
```

동작은 다음과 같습니다.

```text
Pull Request
  → VitePress와 Playground 전체 빌드/배치 검증
  → 배포하지 않음

main에 merge
  → VitePress 문서 build
  → Playground와 packed adapter build
  → 문서를 artifact root에, Playground를 /playground/에 assemble
  → 완성된 단일 Pages artifact 배포
```

문서는 Pages root를 계속 소유하며 한글 문서는 `/ko/`에 유지됩니다. 두 사이트가
각각 배포되어 서로를 덮어쓰지 않도록 완성된 정적 사이트를 한 번만 배포합니다.
`docs/.vitepress/dist`와 `.ci-artifacts/pages-dist`는 직접 commit하지 않습니다.

Repository Settings → Pages → Build and deployment의 Source는 **GitHub Actions**로
설정합니다. 수동 실행은 Actions의 **GitHub Pages** workflow에서 할 수 있습니다.

GitHub Pages 주소:

```text
Documentation: https://mors119.github.io/copc-adapter/
한국어 문서:   https://mors119.github.io/copc-adapter/ko/
Playground:    https://mors119.github.io/copc-adapter/playground/
```

변경된 사이트 입력이 main에 merge된 뒤 Actions의 **GitHub Pages** workflow가 성공하면
문서와 Playground가 함께 배포됩니다.


## 문서를 업데이트해야 하는 시점

다음 변경은 문서 수정도 같이 보는 것이 좋습니다.

- public option 추가/삭제
- public method 추가/삭제
- default 값 변경
- backend 지원 범위 변경
- CRS 지원 범위 변경
- Range/CORS 요구사항 변경
- benchmark 결과 갱신
- known limitation 변경

## 검증 숫자 수정 규칙과 벤치마크 파일 생성 조건

구현 결과, 측정값, 재현 명령어와 CI 근거는 **기본적으로 해당 Pull Request 본문**에 기록합니다. 문제 정의와 조사 결론은 Issue에 기록합니다.

새로운 `docs/benchmarks/issue-*.md` 파일은 다음 조건을 **모두** 만족할 때만 생성합니다.

1. 메인테이너가 별도 파일 생성을 명시적으로 요청하거나 승인했습니다.
2. 일회성 검증이 아니라 **이후 커밋·릴리스와 다시 비교할 수 있는 재현 가능한 기준**입니다.
3. 실제 측정값, 입력 데이터, 실행 환경과 버전, 방법, 재현 명령어, 한계가 있습니다.
4. 기존 기준 문서가 없고 PR만으로는 장기 비교가 실질적으로 어렵습니다.

테스트 통과 목록, 작업 완료 보고서, 아키텍처 결정, 구현 보류 결론만으로 새 벤치마크 파일을 만들지 않습니다. 이런 내용은 Issue/PR 또는 기존 아키텍처 문서에 기록합니다.

권장 흐름:

```text
실제 재측정
  ↓
PR에 원본 측정 조건·수치·한계 기록
  ↓
필요하면 기존 기준 벤치마크 갱신
  ↓
docs/ko/validation.md 등 공개 요약 갱신 및 근거 링크
```

측정 조건이 다른 수치를 직접 비교하거나 이전 측정값을 무단 덮어쓰지 않습니다. 기존 문서 삭제·이동은 메인테이너 승인을 받은 후 참조 링크와 함께 수정합니다.

## VitePress 설정과 콘텐츠를 분리하기

VitePress 설정은 보통 다음을 담당합니다.

- 사이트 제목
- locale
- navbar
- sidebar
- GitHub link
- 검색
- base path

Markdown 페이지는 다음을 담당합니다.

- 설명
- 코드 예제
- 검증 결과
- 학습 내용

사이트 디자인을 바꾸려다가 기술 설명까지 한 파일에 섞지 않는 것이 유지보수에 좋습니다.

## 한글화 방향

추천 구조:

```text
/        영어 technical docs
/ko/    한글 guide
```

처음에는 핵심 guide만 한글화하고, 실제 사용자 요청이 많은 페이지부터 번역 범위를 늘리는 편이 좋습니다.

이렇게 하면 기존 영문 오픈소스 문서를 유지하면서도 직접 공부하고 수정하기 쉬운 한글 문서가 함께 존재할 수 있습니다.

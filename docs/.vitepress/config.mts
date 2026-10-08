import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'COPC Adapter',

  description:
    'Stream and visualize COPC point clouds directly in CesiumJS.',

  base: '/copc-adapter/',

  cleanUrls: true,

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      title: 'COPC Adapter',
      description: 'Direct COPC streaming for CesiumJS',
    },

    ko: {
      label: '한국어',
      lang: 'ko-KR',
      title: 'COPC Adapter',
      description:
        'COPC 데이터를 별도 타일 변환 없이 CesiumJS에서 직접 스트리밍합니다.',
    },
  },

  themeConfig: {
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/mors119/copc-adapter',
      },
    ],

    locales: {
      root: {
        nav: [
          { text: 'API', link: '/API' },
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Validation', link: '/CONFORMANCE' },
        ],

        sidebar: [
          {
            text: 'Documentation',
            items: [
              { text: 'Public API', link: '/API' },
              { text: 'Architecture', link: '/ARCHITECTURE' },
              { text: 'Examples', link: '/EXAMPLES' },
              { text: 'Conformance', link: '/CONFORMANCE' },
              { text: 'Roadmap', link: '/ROADMAP' },
            ],
          },
        ],
      },

      ko: {
        nav: [
          { text: '시작하기', link: '/ko/getting-started' },
          { text: '사용 가이드', link: '/ko/streaming' },
          { text: '검증 결과', link: '/ko/validation' },
        ],

        sidebar: [
          {
            text: '시작하기',
            items: [
              { text: 'COPC Adapter', link: '/ko/' },
              { text: '빠른 시작', link: '/ko/getting-started' },
            ],
          },
          {
            text: '핵심 개념',
            items: [
              {
                text: '스트리밍과 LoD',
                link: '/ko/streaming',
              },
              {
                text: 'HTTP Range / CORS',
                link: '/ko/source-requirements',
              },
            ],
          },
          {
            text: '사용법',
            items: [
              {
                text: '색상 표현과 점 선택',
                link: '/ko/styling-and-picking',
              },
              {
                text: 'API 빠른 참조',
                link: '/ko/api',
              },
            ],
          },
          {
            text: '프로젝트 이해하기',
            items: [
              {
                text: '아키텍처와 코드 위치',
                link: '/ko/architecture',
              },
              {
                text: '검증 결과',
                link: '/ko/validation',
              },
              {
                text: '문서 수정 방법',
                link: '/ko/editing-docs',
              },
            ],
          },
        ],

        outline: {
          label: '이 페이지에서',
        },

        docFooter: {
          prev: '이전 페이지',
          next: '다음 페이지',
        },

        returnToTopLabel: '맨 위로',
        sidebarMenuLabel: '메뉴',
        darkModeSwitchLabel: '테마',
        langMenuLabel: '언어 변경',
      },
    },
  },
});
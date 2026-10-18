import {
  runSyntheticRendererPerformanceBenchmark,
} from '../../apps/dev-viewer/src/rendererPerformanceBenchmark.ts';

const renderers = ['point-primitive', 'batched-geometry'];
const results = Object.fromEntries(renderers.map((renderer) => [
  renderer,
  runSyntheticRendererPerformanceBenchmark({ renderer }),
]));

console.log(JSON.stringify({
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    timing: 'performance.now(); warmup=2, samples=7; ranges are min/median/max ms',
  },
  conditions: {
    pointCounts: [1_000, 10_000, 50_000, 100_000],
    warmups: 2,
    repetitions: 7,
    note: 'synchronous preparation only; GPU execution and frame time require browser benchmark',
  },
  results,
}, null, 2));

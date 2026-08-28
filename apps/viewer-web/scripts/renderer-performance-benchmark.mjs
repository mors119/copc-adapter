import {
  runSyntheticRendererPerformanceBenchmark,
} from '../src/cesium/render/rendererPerformanceBenchmark.ts';

const rows = runSyntheticRendererPerformanceBenchmark();

console.log(JSON.stringify({
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    timing: 'performance.now(); warmup=2, samples=7; ranges are min/median/max ms',
  },
  rows,
}, null, 2));

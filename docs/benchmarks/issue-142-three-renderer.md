# Issue #142 Three.js renderer observation

The renderer preparation path was measured with the same node lifecycle used by
the unit tests: create one `THREE.BufferGeometry` and `THREE.PointsMaterial`,
replace the node once, then remove it. This is a CPU scene-object benchmark; it
does not create a WebGL context or claim GPU upload/frame performance.

Command:

```sh
npm run benchmark:three-renderer --prefix apps/viewer-web
```

Representative local run (Node `v26.7.0`, macOS arm64, 100,000 points,
warmup=2, samples=7):

| operation | min ms | median ms | max ms |
| --- | ---: | ---: | ---: |
| add | 14.91 | 17.87 | 42.15 |
| update/replace | 14.15 | 15.84 | 19.57 |
| remove/dispose | 0.006 | 0.007 | 0.023 |

The initial implementation keeps the straightforward replace-and-dispose path
for correctness. A future optimization issue should measure browser/WebGL
uploads before introducing pooled geometries or shared materials.

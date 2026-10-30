import assert from "node:assert/strict";
import test from "node:test";

import * as CesiumApi from "@frillab/copc-adapter/cesium";
import {
  NPM_0_7_1_MANIFEST,
  resolveOptionDefault,
} from "../../shared/schema/index.ts";

test("npm 0.7.1 schema defaults match the package's exported runtime defaults", () => {
  assert.equal(
    resolveOptionDefault("source.maxRangeBytes", NPM_0_7_1_MANIFEST),
    CesiumApi.DEFAULT_MAX_RANGE_BYTES,
  );
  assert.equal(
    resolveOptionDefault("source.maxConcurrentRangeRequests", NPM_0_7_1_MANIFEST),
    CesiumApi.DEFAULT_MAX_CONCURRENT_RANGE_REQUESTS,
  );
  assert.equal(
    resolveOptionDefault("streaming.refinementAlgorithm", NPM_0_7_1_MANIFEST),
    CesiumApi.DEFAULT_REFINEMENT_ALGORITHM,
  );
  assert.equal(
    resolveOptionDefault("rendering.minPointSize", NPM_0_7_1_MANIFEST),
    CesiumApi.DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  );
  assert.equal(
    resolveOptionDefault("rendering.maxPointSize", NPM_0_7_1_MANIFEST),
    CesiumApi.DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  );
});

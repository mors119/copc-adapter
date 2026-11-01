import assert from "node:assert/strict";
import test from "node:test";

import * as CesiumApi from "../../../packages/adapter/cesium.ts";
import {
  WORKSPACE_CURRENT_MANIFEST,
  resolveOptionDefault,
} from "../../shared/schema/index.ts";

test("workspace schema defaults match the package's exported runtime defaults", () => {
  assert.equal(
    resolveOptionDefault("source.maxRangeBytes", WORKSPACE_CURRENT_MANIFEST),
    CesiumApi.DEFAULT_MAX_RANGE_BYTES,
  );
  assert.equal(
    resolveOptionDefault("source.maxConcurrentRangeRequests", WORKSPACE_CURRENT_MANIFEST),
    CesiumApi.DEFAULT_MAX_CONCURRENT_RANGE_REQUESTS,
  );
  assert.equal(
    resolveOptionDefault("streaming.refinementAlgorithm", WORKSPACE_CURRENT_MANIFEST),
    CesiumApi.DEFAULT_REFINEMENT_ALGORITHM,
  );
  assert.equal(
    resolveOptionDefault("rendering.minPointSize", WORKSPACE_CURRENT_MANIFEST),
    CesiumApi.DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  );
  assert.equal(
    resolveOptionDefault("rendering.maxPointSize", WORKSPACE_CURRENT_MANIFEST),
    CesiumApi.DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  );
});

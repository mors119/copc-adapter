import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchConfigurationState } from "../../shared/config/index.ts";
import { generateIntegrationCodeResult } from "../src/integrationCode.ts";
import { PLAYGROUND_DEFAULTS } from "../src/playgroundConfig.ts";

for (const [renderer, resetValue] of [["cesium", 1], ["three", 0.9]]) {
  const options = {
    config: {
      ...PLAYGROUND_DEFAULTS,
      renderer,
      schemaOptionValues: { "rendering.opacity": undefined },
    },
    refinementConfig: {},
    adapterVersion: "0.8.0",
  };

  test(`${renderer} generated code preserves the Playground opacity reset`, () => {
    const { code } = generateIntegrationCodeResult(options);
    assert.ok(code.includes(`layer.setOpacity(${resetValue});`), code);
    assert.ok(!code.includes("layer.setOpacity(undefined);"), code);
  });

  test(`${renderer} applied code preserves the Playground opacity reset`, () => {
    const values = {
      "renderer.engine": renderer,
      "source.url": "https://example.test/area.copc.laz",
      "rendering.opacity": undefined,
    };
    const appliedState = createWorkbenchConfigurationState(values, values);
    const { code } = generateIntegrationCodeResult({ ...options, appliedState });

    assert.ok(code.includes(`layer.setOpacity(${resetValue});`), code);
    assert.ok(!code.includes("layer.setOpacity(undefined);"), code);
  });
}

import assert from "node:assert/strict";
import test from "node:test";

import { applyNpmRuntimeOperations } from "../src/npmRuntimeOperations.ts";

function opacityOperation(argument) {
  return {
    method: "setOpacity",
    kind: "argument",
    argument,
    rollbackArgument: undefined,
    optionIds: ["rendering.opacity"],
  };
}

test("initial Three.js opacity operations reach the layer, including zero", async () => {
  const calls = [];
  await applyNpmRuntimeOperations(
    { setOpacity: (opacity) => calls.push(opacity) },
    "three",
    [opacityOperation(0)],
  );

  assert.deepEqual(calls, [0]);
});

test("initial opacity resets use numeric defaults accepted by npm 0.7.1", async () => {
  const cesiumCalls = [];
  const threeCalls = [];
  await applyNpmRuntimeOperations(
    { setOpacity: (opacity) => cesiumCalls.push(opacity) },
    "cesium",
    [opacityOperation(undefined)],
  );
  await applyNpmRuntimeOperations(
    { setOpacity: (opacity) => threeCalls.push(opacity) },
    "three",
    [opacityOperation(undefined)],
  );

  assert.deepEqual(cesiumCalls, [1]);
  assert.deepEqual(threeCalls, [0.9]);
});

test("initial non-opacity operations keep calling the original layer", async () => {
  const calls = [];
  const layer = {
    setOpacity() {},
    setStyle(update) {
      assert.equal(this, layer);
      calls.push(update);
    },
  };
  const update = { colorMode: "elevation" };
  await applyNpmRuntimeOperations(layer, "cesium", [
    {
      method: "setStyle",
      kind: "patch",
      argument: update,
      rollbackArgument: {},
      optionIds: ["rendering.colorMode"],
    },
  ]);

  assert.deepEqual(calls, [update]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorkbenchConfiguration,
  buildSchemaApplicationPlan,
  createWorkbenchConfigurationState,
  discardWorkbenchPending,
  getChangedWorkbenchOptionIds,
  isWorkbenchConfigurationDirty,
  materializeWorkbenchConstructorOptions,
  normalizeWorkbenchOptionValues,
  resolveSchemaBackendSelection,
  restoreWorkbenchConfiguration,
  serializeWorkbenchConfiguration,
  transitionRendererOptionValues,
  updateWorkbenchConfiguration,
  validateWorkbenchConfiguration,
} from "../index.ts";
import {
  NPM_0_6_CAPABILITIES,
  NPM_0_6_MANIFEST,
  NPM_0_7_1_CAPABILITIES,
  NPM_0_7_1_MANIFEST,
  WORKSPACE_CURRENT_CAPABILITIES,
  WORKSPACE_CURRENT_MANIFEST,
} from "../../schema/index.ts";

const cesiumContext = {
  manifest: NPM_0_6_MANIFEST,
  renderer: "cesium",
  runtimeCapabilities: NPM_0_6_CAPABILITIES,
};

const focus = {
  type: "screen-circle",
  center: { x: 0.4, y: 0.6 },
  radius: 0.2,
  detailBias: 1.5,
};

function validValues(overrides = {}) {
  return {
    "renderer.engine": "cesium",
    "source.url": "https://example.test/data.copc.laz",
    "adapter.backend": "copc-js",
    "rendering.colorMode": "elevation",
    "streaming.maxNodes": 16,
    "streaming.maxScreenSpaceError": 8,
    ...overrides,
  };
}

test("configuration state keeps pending and applied snapshots detached", () => {
  const initial = validValues({
    "style.classificationFilter": { include: [2, 6] },
  });
  const state = createWorkbenchConfigurationState(initial, initial);
  initial["style.classificationFilter"].include.push(7);
  assert.deepEqual(state.pending["style.classificationFilter"], { include: [2, 6] });
  assert.equal(isWorkbenchConfigurationDirty(state), false);

  const update = updateWorkbenchConfiguration(
    state,
    { "rendering.colorMode": "intensity" },
    cesiumContext,
  );
  assert.equal(update.ok, true);
  assert.equal(update.state.pendingRevision, 1);
  assert.equal(update.state.applied["rendering.colorMode"], "elevation");
  assert.equal(isWorkbenchConfigurationDirty(update.state), true);
  assert.deepEqual(
    getChangedWorkbenchOptionIds(update.state.pending, update.state.applied),
    ["rendering.colorMode"],
  );
  assert.equal(isWorkbenchConfigurationDirty(discardWorkbenchPending(update.state)), false);
});

test("legacy nested and flat controls normalize into stable schema option IDs", () => {
  const values = normalizeWorkbenchOptionValues({
    renderer: "three",
    backend: "rust",
    maxNodes: 12,
    streaming: { maxDepth: 5 },
    maxRenderDistanceMeters: 42_000,
  });
  assert.deepEqual(values, {
    "renderer.engine": "three",
    "adapter.backend": "rust",
    "streaming.maxNodes": 12,
    "streaming.maxDepth": 5,
    "streaming.maxRenderDistanceMeters": 42_000,
  });
});

test("pending edits reject invalid and unsupported values without changing state", () => {
  const state = createWorkbenchConfigurationState(validValues());
  const invalid = updateWorkbenchConfiguration(
    state,
    { "streaming.maxNodes": Number.POSITIVE_INFINITY },
    cesiumContext,
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(" "), /finite number/);
  assert.equal(invalid.state, state);

  const unsupported = updateWorkbenchConfiguration(
    state,
    { "streaming.maxConcurrentNodeLoads": 3 },
    cesiumContext,
  );
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.errors.join(" "), /unsupported/);
  assert.equal(unsupported.state, state);
});

test("renderer and backend changes cannot make retained unsupported values valid", () => {
  const withFilter = createWorkbenchConfigurationState(
    validValues({ "style.classificationFilter": { include: [2] } }),
  );
  const rendererChange = updateWorkbenchConfiguration(
    withFilter,
    { "renderer.engine": "three" },
    cesiumContext,
  );
  assert.equal(rendererChange.ok, false);
  assert.match(rendererChange.errors.join(" "), /unsupported/);

  const extraDimensions = createWorkbenchConfigurationState(
    validValues({ "attributes.extraDimensions": ["gps-time"] }),
  );
  const backendChange = updateWorkbenchConfiguration(
    extraDimensions,
    { "adapter.backend": "rust" },
    cesiumContext,
  );
  assert.equal(backendChange.ok, false);
  assert.match(backendChange.errors.join(" "), /unavailable/);
});

test("renderer choices require the host runtime to advertise the renderer", () => {
  const unavailable = {
    ...cesiumContext,
    runtimeCapabilities: ["renderer.cesium", "cesium.runtime-style"],
  };
  const validation = validateWorkbenchConfiguration(
    validValues({ "renderer.engine": "three" }),
    unavailable,
  );
  assert.match(validation.errors.join(" "), /unavailable in the active host/);
});

test("plan maps nested constructor paths and keeps library-derived defaults omitted", () => {
  const plan = buildSchemaApplicationPlan(
    validValues({
      "streaming.maxScreenSpaceError": 5,
      "style.classificationFilter": { include: [2, 6] },
      "streaming.refinementFocus": focus,
    }),
    cesiumContext,
  );
  assert.deepEqual(plan.constructorOptions, {
    url: "https://example.test/data.copc.laz",
    backend: "copc-js",
    streaming: { maxNodes: 16, maxScreenSpaceError: 5 },
  });
  assert.equal(
    Object.hasOwn(plan.constructorOptions.streaming, "screenSpaceErrorHysteresis"),
    false,
  );
  assert.deepEqual(plan.hostOptions, { "renderer.engine": "cesium" });
  assert.deepEqual(plan.runtimeOperations, [
    {
      method: "setStyle",
      kind: "patch",
      argument: {
        colorMode: "elevation",
        classificationFilter: { include: [2, 6] },
      },
      rollbackArgument: { colorMode: undefined, classificationFilter: undefined },
      optionIds: ["rendering.colorMode", "style.classificationFilter"],
    },
    {
      method: "setRefinementFocus",
      kind: "argument",
      argument: focus,
      rollbackArgument: undefined,
      optionIds: ["streaming.refinementFocus"],
    },
  ]);
});

test("materializes Cesium pointFields as a Set and replaces the layer for cache policy changes", () => {
  const context = {
    manifest: NPM_0_7_1_MANIFEST,
    renderer: "cesium",
    runtimeCapabilities: NPM_0_7_1_CAPABILITIES,
  };
  const values = validValues({
    "attributes.attributeLoading": "required",
    "attributes.pointFields": ["intensity", "classification"],
    "style.classificationFilter": { include: [2, 6] },
    "cache.coordinateCacheLayout": "E",
    "cache.retainSourceCoordinatesForQueries": true,
  });
  const plan = buildSchemaApplicationPlan(values, context);
  assert.equal(Object.hasOwn(plan.constructorOptions, "pointFields"), false);
  assert.equal(plan.constructorOptions.colorMode, "elevation");
  assert.deepEqual(plan.constructorOptions.classificationFilter, { include: [2, 6] });
  const constructorOptions = materializeWorkbenchConstructorOptions(plan);
  assert.ok(constructorOptions.pointFields instanceof Set);
  assert.deepEqual([...constructorOptions.pointFields], ["intensity", "classification"]);
  assert.equal(constructorOptions.attributeLoading, "required");
  assert.equal(constructorOptions.coordinateCacheLayout, "E");
  assert.equal(constructorOptions.retainSourceCoordinatesForQueries, true);

  const changedLayout = buildSchemaApplicationPlan(
    { ...values, "cache.coordinateCacheLayout": "A" },
    context,
    values,
  );
  assert.equal(changedLayout.requiresLayerReplacement, true);
  assert.equal(
    Object.hasOwn(materializeWorkbenchConstructorOptions(changedLayout), "retainSourceCoordinatesForQueries"),
    false,
  );
});

test("conditional settings stay out of constructor options when their condition is false", () => {
  const plan = buildSchemaApplicationPlan(
    validValues({
      "rendering.pointSizeMode": "fixed",
      "rendering.minPointSize": 4,
      "rendering.maxPointSize": 12,
    }),
    cesiumContext,
  );
  assert.equal(Object.hasOwn(plan.constructorOptions, "minPointSize"), false);
  assert.equal(Object.hasOwn(plan.constructorOptions, "maxPointSize"), false);
});

test("renderer-specific options are emitted only for the selected supported renderer", () => {
  assert.throws(
    () => buildSchemaApplicationPlan(
      validValues({ "streaming.maxConcurrentNodeLoads": 2 }),
      cesiumContext,
    ),
    /unsupported/,
  );
  const three = buildSchemaApplicationPlan(
    validValues({
      "renderer.engine": "three",
      "streaming.maxConcurrentNodeLoads": 2,
    }),
    { ...cesiumContext, renderer: "cesium" },
  );
  assert.equal(three.renderer, "three");
  assert.equal(three.constructorOptions.streaming.maxConcurrentNodeLoads, 2);
  assert.equal(three.requiresLayerReplacement, true);
});

test("renderer changes stash and restore renderer-exclusive schema values", () => {
  const schemaOnlyValues = {
    "rendering.pointSizeMode": "attenuated",
    "rendering.minPointSize": 2,
    "rendering.maxPointSize": 16,
  };
  const optionIds = Object.keys(schemaOnlyValues);
  const values = validValues({ ...schemaOnlyValues });
  const inactiveValues = new Map();

  values["renderer.engine"] = "three";
  transitionRendererOptionValues(
    values,
    schemaOnlyValues,
    "cesium",
    "three",
    inactiveValues,
    { support: { manifest: NPM_0_6_MANIFEST, runtimeCapabilities: NPM_0_6_CAPABILITIES } },
  );
  for (const id of optionIds) {
    assert.equal(Object.hasOwn(values, id), false, id + " must not reach Three.js");
    assert.equal(Object.hasOwn(schemaOnlyValues, id), false, id + " must leave active schema state");
  }
  assert.equal(inactiveValues.size, 3);

  values["renderer.engine"] = "cesium";
  transitionRendererOptionValues(
    values,
    schemaOnlyValues,
    "three",
    "cesium",
    inactiveValues,
    { support: { manifest: NPM_0_6_MANIFEST, runtimeCapabilities: NPM_0_6_CAPABILITIES } },
  );
  assert.deepEqual(schemaOnlyValues, {
    "rendering.pointSizeMode": "attenuated",
    "rendering.minPointSize": 2,
    "rendering.maxPointSize": 16,
  });
  assert.equal(inactiveValues.size, 0);
});

test("renderer transitions account for package-specific renderer exclusions", () => {
  const optionId = "streaming.maxConcurrentNodeLoads";
  const schemaOnlyValues = { [optionId]: 7 };
  const values = validValues({
    "renderer.engine": "three",
    [optionId]: 7,
  });
  const inactiveValues = new Map();

  transitionRendererOptionValues(
    values,
    schemaOnlyValues,
    "three",
    "cesium",
    inactiveValues,
    { support: { manifest: NPM_0_6_MANIFEST, runtimeCapabilities: NPM_0_6_CAPABILITIES } },
  );
  assert.equal(Object.hasOwn(values, optionId), false);
  assert.equal(Object.hasOwn(schemaOnlyValues, optionId), false);
  assert.equal(inactiveValues.get(optionId).value, 7);

  values["renderer.engine"] = "three";
  transitionRendererOptionValues(
    values,
    schemaOnlyValues,
    "cesium",
    "three",
    inactiveValues,
    { support: { manifest: NPM_0_6_MANIFEST, runtimeCapabilities: NPM_0_6_CAPABILITIES } },
  );
  assert.equal(values[optionId], 7);
  assert.equal(schemaOnlyValues[optionId], 7);
  assert.equal(inactiveValues.has(optionId), false);

  const workspaceValues = validValues({
    "renderer.engine": "three",
    [optionId]: 9,
  });
  transitionRendererOptionValues(
    workspaceValues,
    {},
    "three",
    "cesium",
    new Map(),
    {
      support: {
        manifest: WORKSPACE_CURRENT_MANIFEST,
        runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
      },
    },
  );
  assert.equal(workspaceValues[optionId], 9);
});

test("specialized constructor options are kept out of generic API mapping", () => {
  const plan = buildSchemaApplicationPlan(
    validValues({
      "attributes.extraDimensions": ["gps-time"],
      "rendering.cesiumPointRenderer": "batched-geometry",
    }),
    cesiumContext,
  );
  assert.equal(Object.hasOwn(plan.constructorOptions, "backend.extraDimensions"), false);
  assert.deepEqual(plan.specializedOptions, [
    {
      optionId: "attributes.extraDimensions",
      handler: "copc-js-extra-dimensions",
      apiPath: "backend.extraDimensions",
      value: ["gps-time"],
    },
    {
      optionId: "rendering.cesiumPointRenderer",
      handler: "cesium-point-renderer",
      apiPath: "renderer",
      value: "batched-geometry",
    },
  ]);
});

test("specialized Extra Dimensions instantiate the host-selected copc-js backend", () => {
  const plan = buildSchemaApplicationPlan(
    validValues({ "attributes.extraDimensions": ["gps-time", "leg_id"] }),
    cesiumContext,
  );
  const factoryCalls = [];
  const backend = resolveSchemaBackendSelection(plan, (options) => {
    factoryCalls.push(options);
    return { type: "configured-copc-js", ...options };
  });

  assert.deepEqual(factoryCalls, [{ extraDimensions: ["gps-time", "leg_id"] }]);
  assert.deepEqual(backend, {
    type: "configured-copc-js",
    extraDimensions: ["gps-time", "leg_id"],
  });

  const plainPlan = buildSchemaApplicationPlan(validValues(), cesiumContext);
  assert.equal(resolveSchemaBackendSelection(plainPlan, () => {
    throw new Error("The backend factory must not run without specialized options.");
  }), "copc-js");
});

test("runtime style edits avoid layer recreation and reset nullable filters explicitly", async () => {
  const values = validValues({ "style.classificationFilter": { include: [2] } });
  const state = createWorkbenchConfigurationState(values, values);
  const changed = updateWorkbenchConfiguration(
    state,
    {
      "rendering.colorMode": "intensity",
      "style.classificationFilter": null,
    },
    cesiumContext,
  );
  assert.equal(changed.ok, true);

  const calls = [];
  const runtime = {
    setStyle(value) { calls.push(value); },
    setRefinementFocus() {},
  };
  let creations = 0;
  let active = runtime;
  const result = await applyWorkbenchConfiguration(changed.state, cesiumContext, {
    getActiveRuntime: () => active,
    async createRuntime() { creations += 1; return runtime; },
    activateRuntime(candidate) { active = candidate; },
    disposeRuntime() {},
  });
  assert.equal(result.replaced, false);
  assert.equal(creations, 0);
  assert.deepEqual(calls, [{ colorMode: "intensity", classificationFilter: null }]);
  assert.equal(result.state.applied["rendering.colorMode"], "intensity");
  assert.equal(isWorkbenchConfigurationDirty(result.state), false);
});

test("runtime setter failure rolls back attempted operations and leaves applied state unchanged", async () => {
  const oldFocus = { ...focus, center: { x: 0.3, y: 0.7 } };
  const oldValues = validValues({ "streaming.refinementFocus": oldFocus });
  const state = createWorkbenchConfigurationState(oldValues, oldValues);
  const changed = updateWorkbenchConfiguration(
    state,
    { "rendering.colorMode": "rgb", "streaming.refinementFocus": focus },
    cesiumContext,
  );
  assert.equal(changed.ok, true);
  const styleCalls = [];
  const focusCalls = [];
  const runtime = {
    setStyle(value) { styleCalls.push(value); },
    setRefinementFocus(value) {
      focusCalls.push(value);
      if (value?.center?.x === focus.center.x) throw new Error("rejected focus");
    },
  };
  await assert.rejects(
    applyWorkbenchConfiguration(changed.state, cesiumContext, {
      getActiveRuntime: () => runtime,
      async createRuntime() { throw new Error("should reuse runtime"); },
      activateRuntime() {},
      disposeRuntime() {},
    }),
    /previous values were restored/,
  );
  assert.deepEqual(styleCalls, [
    { colorMode: "rgb" },
    { colorMode: "elevation" },
  ]);
  assert.deepEqual(focusCalls, [focus, oldFocus]);
  assert.equal(changed.state.applied["rendering.colorMode"], "elevation");
});

test("constructor changes build and activate a candidate before committing applied state", async () => {
  const pending = validValues({ "streaming.maxNodes": 20 });
  const state = createWorkbenchConfigurationState(pending);
  const calls = [];
  const candidate = {
    setStyle(value) { calls.push(value); },
    setRefinementFocus() {},
  };
  let active;
  let disposed = 0;
  const result = await applyWorkbenchConfiguration(state, cesiumContext, {
    getActiveRuntime: () => active,
    async createRuntime(plan) {
      assert.equal(plan.constructorOptions.streaming.maxNodes, 20);
      return candidate;
    },
    activateRuntime(value, previous) {
      assert.equal(previous, undefined);
      active = value;
    },
    disposeRuntime() { disposed += 1; },
  });
  assert.equal(result.replaced, true);
  assert.equal(result.runtime, candidate);
  assert.equal(result.state.applied["streaming.maxNodes"], 20);
  assert.equal(disposed, 0);
  assert.deepEqual(calls, [{ colorMode: "elevation" }]);
});

test("failed candidate application disposes the candidate and does not commit", async () => {
  const state = createWorkbenchConfigurationState(validValues());
  const candidate = {
    setStyle() { throw new Error("style rejected"); },
    setRefinementFocus() {},
  };
  let disposed = 0;
  await assert.rejects(
    applyWorkbenchConfiguration(state, cesiumContext, {
      getActiveRuntime: () => undefined,
      async createRuntime() { return candidate; },
      activateRuntime() { assert.fail("failed candidate must not activate"); },
      disposeRuntime(value) { assert.equal(value, candidate); disposed += 1; },
    }),
  );
  assert.equal(disposed, 1);
  assert.equal(state.applied, undefined);
});

test("share state uses pending or applied values and excludes source values", () => {
  const applied = validValues({ "rendering.colorMode": "elevation" });
  const state = createWorkbenchConfigurationState(
    { ...applied, "rendering.colorMode": "intensity" },
    applied,
  );
  const pendingParams = serializeWorkbenchConfiguration(state, cesiumContext);
  const appliedParams = serializeWorkbenchConfiguration(state, cesiumContext, "applied");
  assert.equal(pendingParams.get("colorMode"), "intensity");
  assert.equal(appliedParams.get("colorMode"), "elevation");
  assert.equal(pendingParams.has("sourceUrl"), false);
  assert.equal(pendingParams.toString().includes("example.test"), false);

  const restored = restoreWorkbenchConfiguration(
    new URLSearchParams("renderer=cesium&colorMode=rgb&pointSize=bad"),
    cesiumContext,
    applied,
  );
  assert.equal(restored.values["rendering.colorMode"], "rgb");
  assert.equal(restored.values["rendering.pointSize"], 3);
  assert.ok(restored.warnings.some((warning) => /Invalid Point Size/.test(warning)));
});

test("workspace and published package origins retain distinct support and version boundaries", () => {
  assert.throws(
    () => buildSchemaApplicationPlan(
      validValues({ "coordinates.verticalTransform": {} }),
      cesiumContext,
    ),
    /unsupported/,
  );
  assert.throws(
    () => buildSchemaApplicationPlan(
      validValues({ "coordinates.verticalTransform": {} }),
      {
        manifest: WORKSPACE_CURRENT_MANIFEST,
        renderer: "cesium",
        runtimeCapabilities: WORKSPACE_CURRENT_MANIFEST.capabilities,
      },
    ),
    /loaded and verified GTX grid/,
  );
});

test("unverified origin/version manifests fail closed even when their fields look supported", () => {
  assert.throws(
    () => buildSchemaApplicationPlan(
      validValues(),
      {
        ...cesiumContext,
        manifest: { ...NPM_0_6_MANIFEST, version: "0.6.1" },
      },
    ),
    /verified Workbench profile/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import { prepareCopcPointColorBuffer } from "../../../core/point/style/pointStyle.ts";
import { createPreparedPointData } from "../../../core/point/preparedPoint.ts";
import { createCompactEPointCacheNode } from "../../../core/point/compactEPointCache.ts";
import { packRelativeEcef } from "../../../cesium/render/relativeEcef.ts";

import { BatchedGeometryPointRenderer } from "../../../cesium/render/BatchedGeometryPointRenderer.ts";

for (const globalName of [
  "HTMLCanvasElement",
  "HTMLImageElement",
  "ImageBitmap",
  "OffscreenCanvas",
]) {
  globalThis[globalName] ??= class {};
}

function createPreparedPoints() {
  return {
    pointCount: 2,
    coordinates: new Float64Array([-123, 44, 100, -123.00001, 44.00001, 101]),
    worldCoordinates: new Float64Array([
      -2615000.25, -3930000.5, 3638000.75, -2615000.24, -3930000.49, 3638000.76,
    ]),
    worldCoordinateSystem: "wgs84-ecef-meters",
  };
}

function createPreparedWorldPoints(worldCoordinates) {
  return {
    pointCount: worldCoordinates.length / 3,
    coordinates: new Float64Array(worldCoordinates),
    worldCoordinates: new Float64Array(worldCoordinates),
    worldCoordinateSystem: "wgs84-ecef-meters",
  };
}

function createCenterPickScene() {
  const viewMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  viewMatrix[14] = -10;
  const projectionMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  projectionMatrix[0] = 100;
  projectionMatrix[10] = 0;
  projectionMatrix[14] = 0;
  return {
    mode: Cesium.SceneMode.SCENE3D,
    camera: {
      viewMatrix,
      frustum: { projectionMatrix, near: 1, far: 100 },
    },
    canvas: { clientWidth: 100, clientHeight: 100 },
    drawingBufferWidth: 100,
    drawingBufferHeight: 100,
  };
}

function createPerspectiveCenterPickScene(logarithmicDepthBuffer) {
  const viewMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  viewMatrix[14] = -10;
  const near = 1;
  const far = 100;
  const projectionMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  projectionMatrix[0] = 1;
  projectionMatrix[5] = 1;
  projectionMatrix[10] = -(far + near) / (far - near);
  projectionMatrix[11] = -1;
  projectionMatrix[14] = -(2 * far * near) / (far - near);
  projectionMatrix[15] = 0;
  return {
    mode: Cesium.SceneMode.SCENE3D,
    logarithmicDepthBuffer,
    camera: {
      viewMatrix,
      frustum: { projectionMatrix, near, far },
    },
    canvas: { clientWidth: 100, clientHeight: 100 },
    drawingBufferWidth: 100,
    drawingBufferHeight: 100,
  };
}

test("BatchedGeometryPointRenderer removes owned nodes and preserves scene primitives", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const applicationPrimitive = new Cesium.PrimitiveCollection();
  scenePrimitives.add(applicationPrimitive);

  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const rendererContainer = scenePrimitives.get(1);

  renderer.addOrUpdateNode("node-a", createPreparedPoints(), {
    pointSize: 2,
    colorMode: "fixed",
  });
  assert.equal(renderer.hasNode("node-a"), true);
  assert.equal(renderer.getRenderedPointCount(), 2);
  assert.equal(rendererContainer.length, 1);
  const removedPrimitive = rendererContainer.get(0);
  assert.equal(removedPrimitive.appearance.material.uniforms.u_layerOpacity, 1);

  renderer.removeNode("node-a");
  assert.equal(rendererContainer.length, 0);
  assert.equal(renderer.hasNode("node-a"), false);
  assert.equal(removedPrimitive.isDestroyed(), true);

  renderer.addOrUpdateNode("node-b", createPreparedPoints(), {
    pointSize: 2,
    colorMode: "fixed",
  });
  const clearedPrimitive = rendererContainer.get(0);
  renderer.clear();
  assert.equal(rendererContainer.length, 0);
  assert.equal(clearedPrimitive.isDestroyed(), true);
  renderer.destroy();

  assert.equal(scenePrimitives.length, 1);
  assert.equal(scenePrimitives.get(0), applicationPrimitive);
  assert.equal(applicationPrimitive.isDestroyed(), false);
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer updates layer alpha through its shared material uniform", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  renderer.addOrUpdateNode("node-a", createPreparedPoints(), {
    pointSize: 2,
    colorMode: "fixed",
  });

  const parent = scenePrimitives.get(0);
  const primitive = parent.get(0);
  const geometry = primitive.geometryInstances.geometry;
  const material = primitive.appearance.material;
  assert.equal(material.uniforms.u_layerOpacity, 1);
  assert.equal(primitive.appearance.isTranslucent(), false);
  assert.equal(primitive.appearance.getRenderState().depthMask, true);
  assert.match(
    primitive.appearance.getFragmentShaderSource(),
    /czm_getMaterial\(czm_materialInput\(/,
  );
  assert.match(
    primitive.appearance.getFragmentShaderSource(),
    /opacityMaterial\.alpha/,
  );

  renderer.setOpacity(0.25);
  assert.equal(material.uniforms.u_layerOpacity, 0.25);
  assert.equal(primitive.appearance.isTranslucent(), true);
  assert.equal(primitive.appearance.getRenderState().depthMask, false);

  const otherRenderer = new BatchedGeometryPointRenderer();
  otherRenderer.attachTo({ scene: { primitives: scenePrimitives } });
  otherRenderer.setOpacity(0.75);
  otherRenderer.addOrUpdateNode("other-node", createPreparedPoints(), {
    pointSize: 2,
    colorMode: "fixed",
  });
  const otherPrimitive = scenePrimitives.get(1).get(0);
  assert.equal(otherPrimitive.appearance.material.uniforms.u_layerOpacity, 0.75);

  renderer.setOpacity(0.5);
  assert.equal(material.uniforms.u_layerOpacity, 0.5);
  assert.equal(otherPrimitive.appearance.material.uniforms.u_layerOpacity, 0.75);
  assert.equal(parent.get(0), primitive);
  assert.equal(primitive.geometryInstances.geometry, geometry);

  renderer.setOpacity(0);
  assert.equal(parent.show, false);
  renderer.setShow(false);
  renderer.setOpacity(1);
  assert.equal(parent.show, false);
  renderer.destroy();
  otherRenderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer reuses absolute ECEF doubles for Cesium precision and degenerate bounds", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const points = createPreparedWorldPoints([
    6_378_137.125, 0.25, -0.5, 6_378_137.125, 0.25, -0.5,
  ]);
  const originalWorldCoordinates = points.worldCoordinates.slice();

  renderer.addOrUpdateNode("coincident-node", points, {
    pointSize: 2,
    colorMode: "fixed",
  });

  const primitive = scenePrimitives.get(0).get(0);
  const geometry = primitive.geometryInstances.geometry;
  assert.equal(
    geometry.attributes.position.componentDatatype,
    Cesium.ComponentDatatype.DOUBLE,
  );
  assert.equal(geometry.attributes.position.values, points.worldCoordinates);
  assert.deepEqual(
    Array.from(points.worldCoordinates),
    Array.from(originalWorldCoordinates),
  );
  assert.equal(
    Cesium.Matrix4.equals(primitive.modelMatrix, Cesium.Matrix4.IDENTITY),
    true,
  );
  assert.equal(geometry.boundingSphere.center.x, 6_378_137.125);
  assert.ok(geometry.boundingSphere.radius >= 0.01);

  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer resolves the current node generation to original point identity", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  renderer.addOrUpdateNode(
    "node-a",
    createPreparedWorldPoints([0, 0, 0, 0.1, 0, 0]),
    {
      pointSize: 3,
      colorMode: "fixed",
      pointId: (pointIndex) => ({
        nodeKey: "node-a",
        pointIndex,
        ownerId: "owner-a",
      }),
    },
  );

  const scene = createCenterPickScene();
  const nodePrimitive = scenePrimitives.get(0).get(0);
  const pickId = nodePrimitive.geometryInstances.id;
  const resolved = renderer.resolvePointPick(
    scene,
    new Cesium.Cartesian2(50, 50),
    { id: pickId },
  );
  assert.deepEqual(resolved, {
    nodeKey: "node-a",
    pointIndex: 0,
    ownerId: "owner-a",
  });
  const non3dScene = { ...scene, mode: Cesium.SceneMode.SCENE2D };
  assert.equal(
    renderer.resolveCpuPointPick(non3dScene, new Cesium.Cartesian2(50, 50), {
      id: pickId,
    }).reason,
    "unsupported-scene-mode",
  );
  assert.equal(
    renderer.resolvePointPick(non3dScene, new Cesium.Cartesian2(50, 50), {
      id: pickId,
    }),
    undefined,
  );

  const stalePick = { id: pickId };
  renderer.addOrUpdateNode("node-a", createPreparedWorldPoints([0, 0, 0]), {
    pointSize: 3,
    colorMode: "fixed",
    pointId: (pointIndex) => ({
      nodeKey: "node-a",
      pointIndex,
      ownerId: "owner-a",
    }),
  });
  assert.equal(
    renderer.resolvePointPick(scene, new Cesium.Cartesian2(50, 50), stalePick),
    undefined,
  );
  assert.equal(
    renderer.resolvePointPick(scene, new Cesium.Cartesian2(50, 50), {
      id: { ...pickId, ownerId: "owner-b" },
    }),
    undefined,
  );
  renderer.removeNode("node-a");
  assert.equal(
    renderer.resolvePointPick(scene, new Cesium.Cartesian2(50, 50), stalePick),
    undefined,
  );
  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer fails closed when GPU depth values may tie", () => {
  for (const logarithmicDepthBuffer of [false, true]) {
    const scenePrimitives = new Cesium.PrimitiveCollection();
    const renderer = new BatchedGeometryPointRenderer();
    renderer.attachTo({ scene: { primitives: scenePrimitives } });
    renderer.addOrUpdateNode(
      "depth-node",
      createPreparedWorldPoints([0, 0, 0, 0, 0, -0.00001]),
      { pointSize: 3, colorMode: "fixed" },
    );
    const pickId = scenePrimitives.get(0).get(0).geometryInstances.id;
    const result = renderer.resolveCpuPointPick(
      createPerspectiveCenterPickScene(logarithmicDepthBuffer),
      new Cesium.Cartesian2(50, 50),
      { id: pickId },
      0.5,
    );
    assert.equal(result.picked, false);
    assert.equal(result.reason, "ambiguous-depth");
    renderer.destroy();
    scenePrimitives.destroy();
  }
});

test("BatchedGeometryPointRenderer resolves a clear foreground point over ambiguous background points", () => {
  for (const logarithmicDepthBuffer of [false, true]) {
    const scenePrimitives = new Cesium.PrimitiveCollection();
    const renderer = new BatchedGeometryPointRenderer();
    renderer.attachTo({ scene: { primitives: scenePrimitives } });
    renderer.addOrUpdateNode(
      "depth-node",
      createPreparedWorldPoints([0, 0, -0.00001, 0, 0, 0, 0, 0, 6]),
      { pointSize: 3, colorMode: "fixed" },
    );
    const pickId = scenePrimitives.get(0).get(0).geometryInstances.id;
    const result = renderer.resolveCpuPointPick(
      createPerspectiveCenterPickScene(logarithmicDepthBuffer),
      new Cesium.Cartesian2(50, 50),
      { id: pickId },
      0.5,
    );
    assert.equal(result.picked, true);
    assert.equal(result.pointIndex, 2);
    renderer.destroy();
    scenePrimitives.destroy();
  }
});

test("BatchedGeometryPointRenderer projects original ECEF centers for the pick footprint", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const points = createPreparedWorldPoints([0, 0, 0, 33_554_434, 0, 0]);
  assert.equal(packRelativeEcef(points.worldCoordinates).maxAbsoluteError, 1);
  renderer.addOrUpdateNode("wide-node", points, {
    pointSize: 2,
    colorMode: "fixed",
  });
  const pickId = scenePrimitives.get(0).get(0).geometryInstances.id;
  const result = renderer.resolveCpuPointPick(
    createCenterPickScene(),
    new Cesium.Cartesian2(50, 50),
    { id: pickId },
    0.5,
  );
  assert.equal(result.picked, true);
  assert.equal(result.pointIndex, 0);
  assert.deepEqual(result.worldPosition, [0, 0, 0]);
  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer keeps committed nodes when replacement preparation fails", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  renderer.addOrUpdateNode("node-a", createPreparedPoints(), {
    pointSize: 2,
    colorMode: "fixed",
  });
  const parent = scenePrimitives.get(0);
  const originalPrimitive = parent.get(0);

  assert.throws(
    () =>
      renderer.addOrUpdateNode(
        "node-a",
        {
          pointCount: 1,
          coordinates: new Float64Array([0, 0, 0]),
        },
        { pointSize: 2, colorMode: "fixed" },
      ),
    /requires prepared WGS84 ECEF/,
  );
  assert.throws(
    () =>
      renderer.addOrUpdateNode(
        "node-a",
        {
          pointCount: 0,
          coordinates: new Float64Array(),
          worldCoordinates: new Float64Array(),
          worldCoordinateSystem: "wgs84-ecef-meters",
        },
        { pointSize: 2, colorMode: "fixed" },
      ),
    /requires a nonempty point buffer/,
  );
  assert.throws(
    () =>
      renderer.addOrUpdateNode("node-a", createPreparedPoints(), {
        pointSize: Number.NaN,
        colorMode: "fixed",
      }),
    /requires a positive finite point size/,
  );
  assert.equal(renderer.hasNode("node-a"), true);
  assert.equal(parent.length, 1);
  assert.equal(parent.get(0), originalPrimitive);
  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer preserves shared color modes and point filtering", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const points = {
    pointCount: 3,
    coordinates: new Float64Array([0, 0, 5, 0, 0, 10, 0, 0, 15]),
    worldCoordinates: new Float64Array([
      6_378_137, 0, 0, 6_378_137.01, 0, 0, 6_378_137.02, 0, 0,
    ]),
    worldCoordinateSystem: "wgs84-ecef-meters",
    attributes: {
      intensity: new Uint16Array([0, 100, 200]),
      classification: new Uint8Array([2, 6, 6]),
      red: new Uint16Array([255, 0, 64]),
      green: new Uint16Array([0, 255, 128]),
      blue: new Uint16Array([0, 0, 255]),
    },
  };
  const nodeKey = "styled-node";
  const modes = ["fixed", "rgb", "elevation", "intensity", "classification"];
  for (const colorMode of modes) {
    const options = {
      pointSize: 4,
      colorMode,
      elevationRange: { min: 0, max: 20 },
      rgbMax: 255,
      pointFilter: (index) => index !== 1,
    };
    renderer.addOrUpdateNode(nodeKey, points, options);
    const geometry = scenePrimitives.get(0).get(0).geometryInstances.geometry;
    assert.deepEqual(
      Array.from(geometry.attributes.a_color.values),
      Array.from(prepareCopcPointColorBuffer(points, options)),
      `color mode ${colorMode}`,
    );
    assert.deepEqual(
      Array.from(geometry.attributes.a_pointSize.values),
      [4, -4, 4],
    );
    assert.equal(renderer.getRenderedNodePointCount(nodeKey), 2);
  }

  renderer.updateNodeStyle(nodeKey, points, {
    pointSize: 4,
    colorMode: "classification",
    pointFilter: (index) => points.attributes.classification[index] === 6,
  });
  assert.equal(renderer.getRenderedNodePointCount(nodeKey), 2);
  assert.deepEqual(
    Array.from(
      scenePrimitives.get(0).get(0).geometryInstances.geometry.attributes
        .a_pointSize.values,
    ),
    [-4, 4, 4],
  );
  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer preserves dimension palette alpha unless layer opacity overrides it", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const points = {
    ...createPreparedPoints(),
    attributes: {
      extraDimensions: {
        canopy_height: new Float64Array([0, 50]),
      },
    },
  };
  const options = {
    pointSize: 2,
    colorMode: "dimension",
    dimension: {
      name: "canopy_height",
      range: { min: 0, max: 50 },
      palette: [
        { position: 0, color: { red: 0, green: 0, blue: 1, alpha: 0 } },
        { position: 1, color: { red: 1, green: 0, blue: 0, alpha: 0.8 } },
      ],
    },
  };
  renderer.addOrUpdateNode("alpha-node", points, options);

  const primitive = scenePrimitives.get(0).get(0);
  const colorAttribute = primitive.geometryInstances.geometry.attributes.a_color;
  const material = primitive.appearance.material;
  assert.equal(colorAttribute.componentsPerAttribute, 4);
  assert.deepEqual(
    Array.from(colorAttribute.values),
    [0, 0, 1, 0, 1, 0, 0, Math.fround(0.8)],
  );
  assert.equal(material.uniforms.u_layerOpacity, 1);
  assert.equal(material.uniforms.u_overridePointAlpha, 0);
  assert.equal(primitive.appearance.isTranslucent(), true);
  assert.match(
    primitive.appearance.getFragmentShaderSource(),
    /opacityMaterial\.diffuse\.r > 0\.5 \? opacityMaterial\.alpha : v_color\.a/u,
  );

  renderer.setOpacity(0.25);
  assert.equal(material.uniforms.u_layerOpacity, 0.25);
  assert.equal(material.uniforms.u_overridePointAlpha, 1);
  assert.equal(primitive.appearance.isTranslucent(), true);
  renderer.setOpacity(1);
  assert.equal(primitive.appearance.isTranslucent(), false);

  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer applies custom elevation palette alpha", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const options = {
    pointSize: 2,
    colorMode: "elevation",
    elevationRange: { min: 100, max: 101 },
    elevationStyle: {
      palette: [
        { position: 0, color: { red: 0, green: 0, blue: 1, alpha: 0.2 } },
        { position: 1, color: { red: 1, green: 0, blue: 0, alpha: 0.8 } },
      ],
    },
  };
  renderer.addOrUpdateNode("elevation-alpha-node", createPreparedPoints(), options);

  const primitive = scenePrimitives.get(0).get(0);
  const colorAttribute = primitive.geometryInstances.geometry.attributes.a_color;
  assert.equal(colorAttribute.componentsPerAttribute, 4);
  assert.deepEqual(
    Array.from(colorAttribute.values),
    [0, 0, 1, Math.fround(0.2), 1, 0, 0, Math.fround(0.8)],
  );
  assert.equal(primitive.appearance.material.uniforms.u_overridePointAlpha, 0);

  renderer.setOpacity(0.25);
  assert.equal(primitive.appearance.material.uniforms.u_layerOpacity, 0.25);
  assert.equal(primitive.appearance.material.uniforms.u_overridePointAlpha, 1);
  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer consumes compact E buffers without geographic triples", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const prepared = createPreparedPointData({
    pointCount: 2,
    sourceCoordinates: new Float64Array([500, 600, 7, 501, 601, 8]),
    geographicCoordinates: new Float64Array([0, 0, 5, 0, 0, 10]),
    worldCoordinates: new Float64Array([6_378_142, 0, 0, 6_378_147, 0, 0]),
    attributes: {
      classification: new Uint8Array([2, 6]),
      intensity: new Uint16Array([10, 200]),
    },
  });
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "compact-batched",
    provenance: {
      sourceIdentity: "memory://compact-batched.copc.laz",
      transformGeneration: 1,
      heightOffsetMeters: 0,
      verticalDatum: { status: "no-validated-grid-correction" },
    },
  });
  const options = {
    pointSize: 4,
    colorMode: "elevation",
    elevationRange: { min: 0, max: 10 },
  };

  assert.equal("coordinates" in compact, false);
  assert.equal("sourceCoordinates" in compact, false);
  renderer.addOrUpdateNode("compact-batched", compact, options);
  assert.equal(renderer.getRenderedPointCount(), compact.pointCount);
  const geometry = scenePrimitives.get(0).get(0).geometryInstances.geometry;
  assert.deepEqual(
    Array.from(geometry.attributes.a_color.values),
    Array.from(prepareCopcPointColorBuffer(compact, options)),
  );
  assert.ok(renderer.getSelectionBoundingSphere());
  renderer.updateNodeStyle("compact-batched", compact, {
    ...options,
    colorMode: "classification",
    pointFilter: (pointIndex) => compact.attributes.classification[pointIndex] === 6,
  });
  assert.equal(renderer.getRenderedNodePointCount("compact-batched"), 1);
  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer computes bounded screen-space sizes from node spacing in the shader", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  assert.equal(renderer.supportsPointSizeAttenuation, true);
  renderer.addOrUpdateNode("spacing-node", createPreparedPoints(), {
    pointSize: 3,
    pointSizeMode: "attenuated",
    pointSpacingMeters: 0.25,
    minPointSize: 2,
    maxPointSize: 10,
    colorMode: "fixed",
    pointFilter: (index) => index === 0,
  });

  const primitive = scenePrimitives.get(0).get(0);
  const geometry = primitive.geometryInstances.geometry;
  assert.deepEqual(
    Array.from(geometry.attributes.a_spacingMeters.values),
    [0.25, 0.25],
  );
  assert.deepEqual(Array.from(geometry.attributes.a_pointSize.values), [3, -3]);
  assert.match(
    primitive.appearance.vertexShaderSource,
    /czm_projection\[1\]\[1\]/,
  );
  assert.match(
    primitive.appearance.vertexShaderSource,
    /czm_projection\[2\]\[3\]/,
  );
  assert.match(
    primitive.appearance.vertexShaderSource,
    /czm_viewport\.w \/ czm_pixelRatio/,
  );
  assert.match(
    primitive.appearance.vertexShaderSource,
    /clamp\([\s\S]*2\.00000000[\s\S]*10\.0000000/,
  );
  assert.match(
    primitive.appearance.vertexShaderSource,
    /boundedSizeCssPixels \* czm_pixelRatio/,
  );

  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer keeps missing node spacing on the fixed-size shader", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  renderer.addOrUpdateNode("no-spacing-node", createPreparedPoints(), {
    pointSize: 4,
    pointSizeMode: "attenuated",
    colorMode: "fixed",
  });

  const primitive = scenePrimitives.get(0).get(0);
  assert.equal(
    primitive.geometryInstances.geometry.attributes.a_spacingMeters,
    undefined,
  );
  assert.match(
    primitive.appearance.vertexShaderSource,
    /abs\(a_pointSize\) \* czm_pixelRatio/,
  );
  assert.doesNotMatch(
    primitive.appearance.vertexShaderSource,
    /a_spacingMeters/,
  );

  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer clips against node-relative shader planes without large ECEF uniform offsets", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const origin = 6_378_137;
  const points = createPreparedWorldPoints([
    origin,
    0,
    0,
    origin + 0.25,
    0,
    0,
    origin + 1,
    0,
    0,
  ]);
  renderer.addOrUpdateNode("clipped-node", points, {
    pointSize: 2,
    colorMode: "fixed",
    clippingPlanes: [
      {
        normal: [1, 0, 0],
        point: [origin + 0.25, 0, 0],
      },
    ],
    pointFilter: (index) => index > 0,
  });

  const primitive = scenePrimitives.get(0).get(0);
  const geometry = primitive.geometryInstances.geometry;
  const material = primitive.appearance.material;
  assert.deepEqual(
    Array.from(geometry.attributes.a_clippingPosition.values),
    [-0.5, 0, 0, -0.25, 0, 0, 0.5, 0, 0],
  );
  assert.equal(renderer.getRenderedNodePointCount("clipped-node"), 2);
  assert.equal(material.uniforms.u_clipPlane0.x, 1);
  assert.ok(material.uniforms.u_clipPlane0.w < -0.25);
  assert.ok(material.uniforms.u_clipPlane0.w > -0.2501);
  assert.match(primitive.appearance.vertexShaderSource, /v_clippingPosition = a_clippingPosition/u);
  assert.match(
    primitive.appearance.fragmentShaderSource,
    /copcGetClipPlane0\(\)/u,
  );

  renderer.setOpacity(0.4);
  assert.equal(material.uniforms.u_layerOpacity, 0.4);
  renderer.updateNodeStyle("clipped-node", points, {
    pointSize: 2,
    colorMode: "fixed",
  });
  assert.equal(material.isDestroyed(), true);
  assert.equal(
    "a_clippingPosition" in
      scenePrimitives.get(0).get(0).geometryInstances.geometry.attributes,
    false,
  );
  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer CPU picking follows attenuated sizes at high drawing-buffer scale", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  renderer.addOrUpdateNode(
    "attenuated-pick-node",
    createPreparedWorldPoints([0, 0, 0]),
    {
      pointSize: 2,
      pointSizeMode: "attenuated",
      pointSpacingMeters: 2,
      minPointSize: 1,
      maxPointSize: 12,
      colorMode: "fixed",
    },
  );
  const pickId = scenePrimitives.get(0).get(0).geometryInstances.id;
  const scene = {
    ...createPerspectiveCenterPickScene(false),
    drawingBufferWidth: 300,
    drawingBufferHeight: 300,
  };
  const result = renderer.resolveCpuPointPick(
    scene,
    new Cesium.Cartesian2(54, 50),
    { id: pickId },
    0.5,
  );
  assert.equal(result.picked, true);
  assert.equal(result.pointIndex, 0);
  renderer.destroy();
  scenePrimitives.destroy();
});

test("BatchedGeometryPointRenderer handles multiple nodes and repeated lifecycle operations", () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const applicationPrimitive = new Cesium.PrimitiveCollection();
  scenePrimitives.add(applicationPrimitive);
  const viewer = { scene: { primitives: scenePrimitives } };
  const renderer = new BatchedGeometryPointRenderer();
  const points = createPreparedPoints();

  renderer.attachTo(viewer);
  renderer.addOrUpdateNode("node-b", points, {
    pointSize: 2,
    colorMode: "fixed",
  });
  renderer.addOrUpdateNode("node-a", points, {
    pointSize: 2,
    colorMode: "fixed",
    pointFilter: (index) => index === 0,
  });
  assert.deepEqual(renderer.getRenderedNodeKeys(), ["node-a", "node-b"]);
  assert.equal(renderer.getRenderedNodePointCount("node-a"), 1);
  assert.equal(renderer.getRenderedNodePointCount("node-b"), 2);
  assert.equal(renderer.getRenderedPointCount(), 3);

  const firstContainer = scenePrimitives.get(1);
  const firstNodePrimitive = firstContainer.get(0);
  renderer.setShow(false);
  const hiddenResult = renderer.resolveCpuPointPick(
    { camera: {}, canvas: {} },
    new Cesium.Cartesian2(0, 0),
    { id: firstNodePrimitive.geometryInstances.id },
  );
  assert.equal(hiddenResult.reason, "hidden-node");
  renderer.setShow(true);
  renderer.removeNode("node-b");
  assert.deepEqual(renderer.getRenderedNodeKeys(), ["node-a"]);
  renderer.clear();
  renderer.clear();
  assert.equal(renderer.getRenderedPointCount(), 0);
  assert.equal(firstContainer.length, 0);

  renderer.detachFrom();
  renderer.detachFrom();
  assert.equal(scenePrimitives.length, 1);
  assert.equal(scenePrimitives.get(0), applicationPrimitive);
  assert.equal(applicationPrimitive.isDestroyed(), false);

  renderer.attachTo(viewer);
  renderer.addOrUpdateNode("after-reattach", points, {
    pointSize: 2,
    colorMode: "fixed",
  });
  renderer.destroy();
  renderer.destroy();
  assert.equal(scenePrimitives.length, 1);
  assert.equal(applicationPrimitive.isDestroyed(), false);
  scenePrimitives.destroy();
});

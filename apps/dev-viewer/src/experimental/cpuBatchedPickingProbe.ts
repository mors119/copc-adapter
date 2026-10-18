import * as Cesium from 'cesium';
import { BatchedGeometryPointRenderer } from '../../../../packages/cesium/render/BatchedGeometryPointRenderer';
import { PointPrimitiveRenderer } from '../../../../packages/cesium/render/CopcPointRenderer';
import { packRelativeEcef } from '../../../../packages/cesium/render/relativeEcef';

const cesiumRuntimeVersion = (Cesium as typeof Cesium & { VERSION: string }).VERSION;

type ResearchRenderer = BatchedGeometryPointRenderer;

type PreparedSyntheticPoints = {
  pointCount: number;
  coordinates: Float64Array;
  worldCoordinates: Float64Array;
  worldCoordinateSystem: 'wgs84-ecef-meters';
};

type SyntheticPickOptions = {
  ownerId: string;
  pointSize: number;
  pointFilter?: (index: number) => boolean;
};

function createPreparedPoints(positions: readonly Cesium.Cartesian3[]): PreparedSyntheticPoints {
  const coordinates = new Float64Array(positions.length * 3);
  const worldCoordinates = new Float64Array(positions.length * 3);
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    coordinates[index * 3] = Cesium.Math.toDegrees(cartographic.longitude);
    coordinates[index * 3 + 1] = Cesium.Math.toDegrees(cartographic.latitude);
    coordinates[index * 3 + 2] = cartographic.height;
    worldCoordinates[index * 3] = position.x;
    worldCoordinates[index * 3 + 1] = position.y;
    worldCoordinates[index * 3 + 2] = position.z;
  }
  return {
    pointCount: positions.length,
    coordinates,
    worldCoordinates,
    worldCoordinateSystem: 'wgs84-ecef-meters',
  };
}

function positionAlongRay(ray: Cesium.Ray, distance: number): Cesium.Cartesian3 {
  return Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3());
}

function addSyntheticNode(
  renderer: ResearchRenderer,
  nodeKey: string,
  points: PreparedSyntheticPoints,
  options: SyntheticPickOptions,
): void {
  renderer.addOrUpdateNode(nodeKey, points, {
    pointSize: options.pointSize,
    colorMode: 'fixed',
    ...(options.pointFilter === undefined ? {} : { pointFilter: options.pointFilter }),
    pointId: (pointIndex) => ({ nodeKey, pointIndex, ownerId: options.ownerId }),
  });
}

async function renderNextFrame(scene: Cesium.Scene): Promise<void> {
  await new Promise<void>((resolve) => {
    const remove = scene.postRender.addEventListener(() => {
      remove();
      resolve();
    });
    scene.requestRender();
  });
}

/**
 * Browser-only research scenarios for CPU point refinement. This lives in the
 * Dev Viewer and is not imported by the published library entry points.
 */
export async function runCpuBatchedPickingProbe(
  viewer: Cesium.Viewer,
  primaryRenderer: ResearchRenderer,
): Promise<Record<string, unknown>> {
  const scene = viewer.scene;
  const center = new Cesium.Cartesian2(
    scene.canvas.clientWidth / 2,
    scene.canvas.clientHeight / 2,
  );
  const ray = viewer.camera.getPickRay(center);
  if (!ray) {
    throw new Error('Could not create a Cesium pick ray for the CPU picking probe');
  }

  const layerA = new BatchedGeometryPointRenderer();
  const layerB = new BatchedGeometryPointRenderer();
  const edgeRenderer = new BatchedGeometryPointRenderer();
  const depthTieRenderer = new BatchedGeometryPointRenderer();
  const stagingPrecisionRenderer = new BatchedGeometryPointRenderer();
  const ownerA = 'cpu-pick-layer-a';
  const ownerB = 'cpu-pick-layer-b';
  const sharedKey = 'cpu-pick-shared';
  const farther = positionAlongRay(ray, 100);
  const nearer = positionAlongRay(ray, 75);
  const hiddenLayerPoint = positionAlongRay(ray, 125);
  const layerBPoint = positionAlongRay(ray, 50);
  const sharedPoints = createPreparedPoints([farther, nearer]);
  let result: Record<string, unknown> = {};
  let pointOracle: Cesium.PointPrimitiveCollection | undefined;

  primaryRenderer.setShow(false);
  try {
    layerA.attachTo(viewer);
    addSyntheticNode(layerA, sharedKey, sharedPoints, {
      ownerId: ownerA,
      pointSize: 8,
    });
    addSyntheticNode(layerA, 'cpu-pick-far-node', createPreparedPoints([hiddenLayerPoint]), {
      ownerId: ownerA,
      pointSize: 8,
    });
    await renderNextFrame(scene);

    const nodeLevelPick = scene.pick(center, 3, 3);
    const normalHit = layerA.resolveCpuPointPick(scene, center, nodeLevelPick, 1.5);
    // Establish a public Cesium per-point-picking oracle for the overlapping
    // synthetic pair. This is only two PointPrimitives and is never in the
    // production or benchmark rendering path.
    pointOracle = new Cesium.PointPrimitiveCollection();
    scene.primitives.add(pointOracle);
    pointOracle.add({
      position: farther,
      pixelSize: 8,
      color: Cesium.Color.WHITE,
      id: { nodeKey: sharedKey, pointIndex: 0, ownerId: ownerA },
    });
    pointOracle.add({
      position: nearer,
      pixelSize: 8,
      color: Cesium.Color.WHITE,
      id: { nodeKey: sharedKey, pointIndex: 1, ownerId: ownerA },
    });
    layerA.setShow(false);
    await renderNextFrame(scene);
    const oraclePicked = scene.pick(center, 3, 3) as {
      id?: { nodeKey?: unknown; pointIndex?: unknown };
    } | undefined;
    const oraclePointIndex = oraclePicked?.id?.pointIndex;
    pointOracle.show = false;
    layerA.setShow(true);
    await renderNextFrame(scene);
    scene.primitives.remove(pointOracle);
    pointOracle = undefined;
    const nearWorld = positionAlongRay(ray, 75);
    const farWorld = positionAlongRay(ray, 100);
    const cpuWorldPosition = normalHit.worldPosition
      ? new Cesium.Cartesian3(...normalHit.worldPosition)
      : undefined;
    const cpuNearPointErrorMeters = cpuWorldPosition
      ? Cesium.Cartesian3.distance(cpuWorldPosition, nearWorld)
      : undefined;
    const cpuFarPointErrorMeters = cpuWorldPosition
      ? Cesium.Cartesian3.distance(cpuWorldPosition, farWorld)
      : undefined;

    // Distinct CPU depths may quantize to one GPU depth value. Put the farther
    // vertex first so guessing the mathematical nearest point could return an
    // identity different from Cesium's rasterized winner.
    layerA.setShow(false);
    depthTieRenderer.attachTo(viewer);
    const depthTieNodeKey = 'cpu-pick-depth-quantization-tie';
    addSyntheticNode(depthTieRenderer, depthTieNodeKey, createPreparedPoints([
      positionAlongRay(ray, 75.00001),
      positionAlongRay(ray, 75),
    ]), { ownerId: ownerA, pointSize: 8 });
    await renderNextFrame(scene);
    const depthTieNodePick = scene.pick(center, 1, 1) as { id?: unknown } | undefined;
    const depthTieResolution = depthTieRenderer.resolveCpuPointPick(
      scene,
      center,
      depthTieNodePick,
      0.5,
    );
    const depthQuantizationProbe = {
      cesiumVersion: cesiumRuntimeVersion,
      logarithmicDepthBuffer: scene.logarithmicDepthBuffer,
      centerPickHitNode: (depthTieNodePick?.id as { nodeKey?: unknown } | undefined)?.nodeKey
        === depthTieNodeKey,
      pointSeparationMeters: 0.00001,
      resolution: {
        picked: depthTieResolution.picked,
        reason: depthTieResolution.reason,
        pointIndex: depthTieResolution.pointIndex,
      },
    };
    depthTieRenderer.destroy();
    layerA.setShow(true);
    await renderNextFrame(scene);

    // Make node-relative Float32 staging move the source point by one metre,
    // several screen pixels at this distance. GPU rendering still uses the
    // original ECEF doubles, so CPU picking must project that shared source
    // buffer rather than the node-relative staging coordinates.
    layerA.setShow(false);
    stagingPrecisionRenderer.attachTo(viewer);
    const screenAxisWeights = [
      viewer.camera.right.x ** 2 + viewer.camera.up.x ** 2,
      viewer.camera.right.y ** 2 + viewer.camera.up.y ** 2,
      viewer.camera.right.z ** 2 + viewer.camera.up.z ** 2,
    ];
    const shiftedAxis = screenAxisWeights.indexOf(Math.max(...screenAxisWeights));
    const distantCoordinates = [nearer.x, nearer.y, nearer.z];
    distantCoordinates[shiftedAxis] += 33_554_434;
    const distantPoint = new Cesium.Cartesian3(...distantCoordinates);
    const stagingNodeKey = 'cpu-pick-original-ecef-footprint';
    const stagingPoints = createPreparedPoints([nearer, distantPoint]);
    const staged = packRelativeEcef(stagingPoints.worldCoordinates);
    addSyntheticNode(stagingPrecisionRenderer, stagingNodeKey, stagingPoints, {
      ownerId: ownerA,
      pointSize: 2,
    });
    await renderNextFrame(scene);
    const stagedPoint = new Cesium.Cartesian3(
      staged.origin[0] + staged.positions[0],
      staged.origin[1] + staged.positions[1],
      staged.origin[2] + staged.positions[2],
    );
    const sourceScreen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, nearer);
    const stagedScreen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, stagedPoint);
    const stagingPixelError = sourceScreen && stagedScreen
      ? Cesium.Cartesian2.distance(sourceScreen, stagedScreen)
      : undefined;
    const stagingPick = scene.pick(center, 1, 1) as { id?: unknown } | undefined;
    const stagingResolution = stagingPrecisionRenderer.resolveCpuPointPick(
      scene,
      center,
      stagingPick,
      0.5,
    );
    const stagingPrecisionProbe = {
      cesiumVersion: cesiumRuntimeVersion,
      centerPickHitNode: (stagingPick?.id as { nodeKey?: unknown } | undefined)?.nodeKey
        === stagingNodeKey,
      stagingPositionErrorMeters: staged.maxAbsoluteError,
      projectedStagingErrorPx: stagingPixelError,
      resolution: {
        picked: stagingResolution.picked,
        pointIndex: stagingResolution.pointIndex,
        worldPosition: stagingResolution.worldPosition,
      },
    };
    stagingPrecisionRenderer.destroy();
    layerA.setShow(true);
    await renderNextFrame(scene);

    const toleranceCases = [
      { offsetPx: 0, label: 'center' },
      { offsetPx: 0.5, label: 'inside-point-footprint' },
      { offsetPx: 3.5, label: 'near-edge-point-footprint' },
      { offsetPx: 6, label: 'outside-point-footprint' },
    ].map(({ offsetPx, label }) => {
      const probePosition = new Cesium.Cartesian2(center.x + offsetPx, center.y);
      return {
        label,
        offsetPx,
        ...layerA.probeCpuPointPick(scene, probePosition, 1.5),
      };
    });

    // Reproduce the review finding: default scene.pick sees this 2 CSS-pixel
    // point in an outer 3x3 sample, but the center-only resolver cannot map it.
    // The production batched picker explicitly requests one pixel instead.
    layerA.setShow(false);
    edgeRenderer.attachTo(viewer);
    const edgeNodeKey = 'cpu-pick-default-window-edge';
    addSyntheticNode(edgeRenderer, edgeNodeKey, createPreparedPoints([nearer]), {
      ownerId: ownerA,
      pointSize: 2,
    });
    await renderNextFrame(scene);
    const edgePosition = new Cesium.Cartesian2(center.x + 1.25, center.y);
    const defaultWindowPick = scene.pick(edgePosition) as { id?: unknown } | undefined;
    const defaultWindowResolved = edgeRenderer.resolvePointPick(
      scene,
      edgePosition,
      defaultWindowPick,
    );
    const batchedSinglePixelPick = scene.pick(center, 1, 1) as { id?: unknown } | undefined;
    const singlePixelResolved = edgeRenderer.resolvePointPick(
      scene,
      center,
      batchedSinglePixelPick,
    );
    const defaultPickWindowEdge = {
      defaultWindowPickedNode: (defaultWindowPick?.id as { nodeKey?: unknown } | undefined)?.nodeKey === edgeNodeKey,
      defaultWindowResolvedPointIndex: defaultWindowResolved?.pointIndex,
      batchedSinglePixelPickedNode: (batchedSinglePixelPick?.id as { nodeKey?: unknown } | undefined)?.nodeKey === edgeNodeKey,
      batchedSinglePixelResolvedNodeKey: singlePixelResolved?.nodeKey,
      batchedSinglePixelResolvedPointIndex: singlePixelResolved?.pointIndex,
    };
    edgeRenderer.destroy();
    layerA.setShow(true);
    await renderNextFrame(scene);

    layerA.updateNodeStyle(sharedKey, sharedPoints, {
      pointSize: 8,
      colorMode: 'fixed',
      pointFilter: (pointIndex) => pointIndex !== 1,
      pointId: (pointIndex) => ({ nodeKey: sharedKey, pointIndex, ownerId: ownerA }),
    });
    await renderNextFrame(scene);
    const filteredHit = layerA.probeCpuPointPick(scene, center, 1.5);
    const filteredPoint = layerA.getProbePoint(scene, sharedKey, 1);
    const filteredProbe = {
      hit: filteredHit,
      hiddenPointVisible: filteredPoint?.visible,
      selectedFilteredIndex: filteredHit.pointIndex === 1,
    };

    layerA.setShow(false);
    await renderNextFrame(scene);
    const hiddenLayerMiss = layerA.probeCpuPointPick(scene, center, 1.5);
    layerA.setShow(true);
    await renderNextFrame(scene);

    layerB.attachTo(viewer);
    addSyntheticNode(layerB, sharedKey, createPreparedPoints([layerBPoint]), {
      ownerId: ownerB,
      pointSize: 8,
    });
    await renderNextFrame(scene);
    const multiLayerHit = layerB.probeCpuPointPick(scene, center, 1.5);
    const wrongLayerHit = layerA.probeCpuPointPick(scene, center, 1.5);
    layerB.removeNode(sharedKey);
    await renderNextFrame(scene);
    const afterLayerRemoval = layerA.probeCpuPointPick(scene, center, 1.5);

    layerA.removeNode(sharedKey);
    await renderNextFrame(scene);
    const afterNodeRemoval = layerA.probeCpuPointPick(scene, center, 1.5);
    result = {
      pointSizePx: 8,
      scenePickBoxPx: 3,
      normalHit,
      publicPointPickOracle: {
        nodeKey: typeof oraclePicked?.id?.nodeKey === 'string' ? oraclePicked.id.nodeKey : undefined,
        pointIndex: oraclePointIndex,
        matchesCpuIdentity: oraclePointIndex === normalHit.pointIndex,
      },
      cpuIdentityCheck: {
        expectedPointIndex: 1,
        nearPointErrorMeters: cpuNearPointErrorMeters,
        farPointErrorMeters: cpuFarPointErrorMeters,
      },
      depthQuantizationProbe,
      stagingPrecisionProbe,
      toleranceCases,
      defaultPickWindowEdge,
      filteredProbe,
      hiddenLayerMiss,
      multipleNodesFrontmostHit: normalHit,
      multipleLayers: {
        expectedOwnerId: ownerB,
        hit: multiLayerHit,
        rejectedByOtherLayer: wrongLayerHit,
        hitOwnedByLayerB: multiLayerHit.ownerId === ownerB,
        otherLayerDidNotResolve: wrongLayerHit.reason === 'not-research-node',
      },
      afterLayerRemoval,
      afterNodeRemoval,
      removedNodeCannotBeSelected: afterNodeRemoval.nodeKey !== sharedKey,
    };
  } finally {
    if (pointOracle) scene.primitives.remove(pointOracle);
    stagingPrecisionRenderer.destroy();
    depthTieRenderer.destroy();
    edgeRenderer.destroy();
    layerB.destroy();
    layerA.destroy();
    primaryRenderer.setShow(true);
    scene.requestRender();
  }

  return result;
}

/**
 * Stress a single dense node at the configured point budget. The source data
 * uses one repeated ECEF location so every point covers the same pick pixels;
 * this measures the true worst-case candidate count without allocating a
 * Cartesian3 object per source point.
 */
export async function runCpuBatchedPickingStress(
  viewer: Cesium.Viewer,
  primaryRenderer: ResearchRenderer,
  pointCount = 250_000,
  repetitions = 35,
): Promise<Record<string, unknown>> {
  const scene = viewer.scene;
  const center = new Cesium.Cartesian2(
    scene.canvas.clientWidth / 2,
    scene.canvas.clientHeight / 2,
  );
  const ray = viewer.camera.getPickRay(center);
  if (!ray) throw new Error('Could not create a Cesium pick ray for the picking stress test');

  const target = positionAlongRay(ray, 75);
  const cartographic = Cesium.Cartographic.fromCartesian(target);
  const coordinates = new Float64Array(pointCount * 3);
  const worldCoordinates = new Float64Array(pointCount * 3);
  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 3;
    coordinates[offset] = Cesium.Math.toDegrees(cartographic.longitude);
    coordinates[offset + 1] = Cesium.Math.toDegrees(cartographic.latitude);
    coordinates[offset + 2] = cartographic.height;
    worldCoordinates[offset] = target.x;
    worldCoordinates[offset + 1] = target.y;
    worldCoordinates[offset + 2] = target.z;
  }
  const points: PreparedSyntheticPoints = {
    pointCount,
    coordinates,
    worldCoordinates,
    worldCoordinateSystem: 'wgs84-ecef-meters',
  };
  const stressRenderer = new BatchedGeometryPointRenderer();
  const ownerId = 'cpu-pick-full-budget';
  const nodeKey = 'cpu-pick-full-budget-node';
  primaryRenderer.setShow(false);

  try {
    stressRenderer.attachTo(viewer);
    addSyntheticNode(stressRenderer, nodeKey, points, { ownerId, pointSize: 8 });
    await renderNextFrame(scene);

    // Discard the shader compilation and initial framebuffer setup sample.
    stressRenderer.probeCpuPointPick(scene, center);
    const samples: Array<{
      picked: boolean;
      pointIndex?: number;
      candidateCount: number;
      scannedPointCount: number;
      scenePickDurationMs: number;
      cpuResolveDurationMs: number;
      totalDurationMs: number;
      reason?: string;
    }> = [];
    for (let index = 0; index < repetitions; index += 1) {
      const sample = stressRenderer.probeCpuPointPick(scene, center);
      samples.push({
        picked: sample.picked,
        ...(sample.pointIndex === undefined ? {} : { pointIndex: sample.pointIndex }),
        candidateCount: sample.candidateCount,
        scannedPointCount: sample.scannedPointCount,
        scenePickDurationMs: sample.scenePickDurationMs,
        cpuResolveDurationMs: sample.cpuResolveDurationMs,
        totalDurationMs: sample.totalDurationMs,
        ...(sample.reason === undefined ? {} : { reason: sample.reason }),
      });
    }

    const oracleRenderer = new PointPrimitiveRenderer();
    let oraclePick: { nodeKey?: unknown; pointIndex?: unknown } | undefined;
    let oraclePreparationDurationMs = 0;
    const oraclePickDurations: number[] = [];
    try {
      // Benchmark the default renderer at the same full node budget and use
      // its direct point id as the same-depth identity oracle.
      stressRenderer.destroy();
      oracleRenderer.attachTo(viewer);
      const oraclePreparationStartedAt = performance.now();
      oracleRenderer.addOrUpdateNode(nodeKey, points, {
        pointSize: 8,
        colorMode: 'fixed',
        pointId: (pointIndex) => ({ nodeKey, pointIndex, ownerId }),
      });
      oraclePreparationDurationMs = performance.now() - oraclePreparationStartedAt;
      stressRenderer.setShow(false);
      await renderNextFrame(scene);
      for (let index = 0; index < repetitions; index += 1) {
        const pickStartedAt = performance.now();
        const picked = scene.pick(center) as { id?: { nodeKey?: unknown; pointIndex?: unknown } } | undefined;
        oraclePickDurations.push(performance.now() - pickStartedAt);
        if (typeof picked?.id?.nodeKey === 'string') {
          oraclePick = { nodeKey: picked.id.nodeKey, pointIndex: picked.id.pointIndex };
        }
      }
    } finally {
      oracleRenderer.destroy();
    }

    const sorted = (selector: (sample: (typeof samples)[number]) => number): number[] =>
      samples.map(selector).sort((left, right) => left - right);
    const percentile = (values: number[], fraction: number): number =>
      values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
    const cpuMs = sorted((sample) => sample.cpuResolveDurationMs);
    const totalMs = sorted((sample) => sample.totalDurationMs);
    const scenePickMs = sorted((sample) => sample.scenePickDurationMs);
    const oracleSorted = [...oraclePickDurations].sort((left, right) => left - right);
    const cpuIndices = [...new Set(samples.flatMap((sample) =>
      sample.pointIndex === undefined ? [] : [sample.pointIndex]))];
    return {
      cesiumVersion: cesiumRuntimeVersion,
      devicePixelRatio: window.devicePixelRatio,
      canvas: {
        cssWidth: scene.canvas.clientWidth,
        cssHeight: scene.canvas.clientHeight,
        drawingBufferWidth: scene.drawingBufferWidth,
        drawingBufferHeight: scene.drawingBufferHeight,
      },
      pointCount,
      repetitions,
      targetWorldPosition: [target.x, target.y, target.z],
      sameDepthCpuPointIndices: cpuIndices,
      sameDepthCpuResolution: {
        picked: samples[0]?.picked ?? false,
        reason: samples[0]?.reason,
      },
      sameDepthPointPrimitiveOracle: oraclePick,
      sameDepthOracleMatchesCpu: cpuIndices.length === 1
        && cpuIndices[0] === oraclePick?.pointIndex,
      latencyMs: {
        scenePickP50: percentile(scenePickMs, 0.5),
        scenePickP95: percentile(scenePickMs, 0.95),
        scenePickP99: percentile(scenePickMs, 0.99),
        cpuResolveP50: percentile(cpuMs, 0.5),
        cpuResolveP95: percentile(cpuMs, 0.95),
        cpuResolveP99: percentile(cpuMs, 0.99),
        combinedP50: percentile(totalMs, 0.5),
        combinedP95: percentile(totalMs, 0.95),
        combinedP99: percentile(totalMs, 0.99),
        pointPrimitiveScenePickP50: percentile(oracleSorted, 0.5),
        pointPrimitiveScenePickP95: percentile(oracleSorted, 0.95),
        pointPrimitiveScenePickP99: percentile(oracleSorted, 0.99),
      },
      pointPrimitivePreparationDurationMs: oraclePreparationDurationMs,
      worstCaseCandidateCount: Math.max(...samples.map((sample) => sample.candidateCount)),
      scannedPointCount: samples[0]?.scannedPointCount ?? 0,
      sourceTypedArrayBytes: coordinates.byteLength + worldCoordinates.byteLength,
      rendererTypedArrayPayloadBytes: pointCount * (3 * Float32Array.BYTES_PER_ELEMENT
        + 3 * Float32Array.BYTES_PER_ELEMENT + Float32Array.BYTES_PER_ELEMENT * 2),
      temporaryResolverTypedArrayBytes: 6 * 9 * Float64Array.BYTES_PER_ELEMENT
        + 9 * Int32Array.BYTES_PER_ELEMENT + 9 * Uint8Array.BYTES_PER_ELEMENT,
      note: 'Typed-array payload sizes are calculated from the buffers. JavaScript object overhead and GPU allocation are not measured.',
    };
  } finally {
    stressRenderer.destroy();
    primaryRenderer.setShow(true);
    scene.requestRender();
  }
}

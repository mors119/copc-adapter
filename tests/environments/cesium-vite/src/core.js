import {
  createCopcContext,
  createCopcPointFieldSelection,
  HierarchyLoader,
} from "@frillab/copc-adapter/core";

window.__COPC_CORE_NODE_SOURCE__ = async () => {
  const source = await createCopcContext(
    "/samples/autzen.copc.laz",
    "copc-js",
    { rangeValidation: "strict" },
  );
  try {
    const hierarchy = new HierarchyLoader(source, source.getMetadata().cube);
    const root = await hierarchy.loadRoot();
    const node = root.nodes.find((entry) => entry.pointCount > 0);
    if (!node) throw new Error("COPC root hierarchy contains no point node");

    const result = await source.loadPreparedNodeData(
      node,
      createCopcPointFieldSelection(["position", "intensity"]),
    );
    const coordinates = result.pointData.world.coordinates;
    let boundsEnclosePoints = true;
    for (let index = 0; index < coordinates.length; index += 3) {
      if (
        coordinates[index] < result.ecefBounds.minX ||
        coordinates[index] > result.ecefBounds.maxX ||
        coordinates[index + 1] < result.ecefBounds.minY ||
        coordinates[index + 1] > result.ecefBounds.maxY ||
        coordinates[index + 2] < result.ecefBounds.minZ ||
        coordinates[index + 2] > result.ecefBounds.maxZ
      ) {
        boundsEnclosePoints = false;
        break;
      }
    }
    return {
      pointCount: result.pointData.pointCount,
      coordinateSystem: result.pointData.world.coordinateSystem,
      isFloat64: coordinates instanceof Float64Array,
      availableFields: [...result.availableFields].sort(),
      boundsEnclosePoints,
    };
  } finally {
    source.close();
  }
};

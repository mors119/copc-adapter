import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { loadRootHierarchy } from './copc/hierarchy/loadRootHierarchy';
import { loadPointDataView } from './copc/points/loadPointData';

const COPC_URL = '/samples/autzen.copc.laz';

async function main() {
  const nodes = await loadRootHierarchy(COPC_URL);

  const sortedNodes = [...nodes]
    .filter((node) => node.pointCount > 0)
    .sort((a, b) => a.pointCount - b.pointCount);

  console.table(sortedNodes.slice(0, 20));

  const selectedNode = sortedNodes[0];

  console.log('Selected node:', selectedNode);

  await loadPointDataView(COPC_URL, selectedNode);
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});

import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { CopcCesiumLayer } from './index';
import { createCesiumViewer } from './cesium/viewer/createViewer';

const COPC_URL = '/samples/autzen.copc.laz';

async function main(): Promise<void> {
  const viewer = createCesiumViewer('cesium-container');
  const layer = new CopcCesiumLayer({
    url: COPC_URL,
    debug: true,
  });
  await layer.load();
  layer.attachTo(viewer);

  console.log('COPC Metadata:', layer.getMetadata());
  console.log('COPC Layer Snapshot:', layer.getSnapshot());
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});

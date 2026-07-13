import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { CopcViewer } from './viewer/CopcViewer';

const COPC_URL = '/samples/autzen.copc.laz';

async function main(): Promise<void> {
  const viewer = new CopcViewer({
    container: 'cesium-container',
    url: COPC_URL,
  });

  await viewer.init();
  await viewer.load();
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});

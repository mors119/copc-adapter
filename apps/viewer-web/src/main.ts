import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { createCopcViewer } from './index';

const COPC_URL = '/samples/autzen.copc.laz';

async function main(): Promise<void> {
  const viewer = await createCopcViewer({
    container: 'cesium-container',
    url: COPC_URL,
  });

  console.log('COPC Metadata:', viewer.getMetadata());
  console.log('COPC Viewer Snapshot:', viewer.getSnapshot());
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});

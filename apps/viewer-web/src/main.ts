import * as Cesium from 'cesium';
import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { createCesiumViewer } from './cesium/createViewer';
import { loadCopcMetadata } from './copc/loadCopcMetadata';

const COPC_URL = '/samples/autzen.copc.laz';

const viewer = createCesiumViewer('cesium-container');
import * as CopcPackage from 'copc';

async function main() {
  const response = await fetch('/samples/autzen.copc.laz');

  console.log(response.status);
  console.log(response.ok);

  const buffer = await response.arrayBuffer();

  console.log(buffer.byteLength);

  console.log(CopcPackage.Getter.http);
  const metadata = await loadCopcMetadata(COPC_URL);

  console.log('Normalized COPC metadata:', metadata);

  const centerLon = (metadata.bounds.minX + metadata.bounds.maxX) / 2;
  const centerLat = (metadata.bounds.minY + metadata.bounds.maxY) / 2;
  const centerHeight = metadata.bounds.maxZ + 1000;

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      centerLon,
      centerLat,
      centerHeight,
    ),
  });
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});

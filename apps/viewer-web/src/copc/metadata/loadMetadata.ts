import { Copc, Getter } from 'copc';
import type { CopcMetadata } from '../types/copc';

export async function loadCopcMetadata(url: string): Promise<CopcMetadata> {
  const getter = Getter.http(url);

  const copc = await Copc.create(getter);

  console.log('Raw COPC object:', copc);
  console.log('COPC header:', copc.header);
  console.log('COPC info:', copc.info);

  const header = copc.header;
  const info = copc.info;

  return {
    pointCount: header.pointCount,
    bounds: {
      minX: header.min[0],
      minY: header.min[1],
      minZ: header.min[2],
      maxX: header.max[0],
      maxY: header.max[1],
      maxZ: header.max[2],
    },
    spacing: info?.spacing,
    scale: {
      x: header.scale[0],
      y: header.scale[1],
      z: header.scale[2],
    },
    offset: {
      x: header.offset[0],
      y: header.offset[1],
      z: header.offset[2],
    },
  };
}

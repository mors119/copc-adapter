import type { Copc } from 'copc';
import type { CopcMetadata } from '../types/copc';

export function toCopcMetadata(copc: Copc): CopcMetadata {
  const { header, info } = copc;

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
    spacing: info.spacing,
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
    cube: {
      minX: info.cube[0],
      minY: info.cube[1],
      minZ: info.cube[2],
      maxX: info.cube[3],
      maxY: info.cube[4],
      maxZ: info.cube[5],
    },
    wkt: copc.wkt,
  };
}

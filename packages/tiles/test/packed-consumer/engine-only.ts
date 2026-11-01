import {
  TileNodeReader,
  createExplicitTileset,
  createImplicitOctreeTileset,
  encodePointCloudGlb,
  type TileNodeSource,
  type TilePointView,
} from '@frillab/copc-tiles';
import { createCopcTileResourceProvider, createTileResourceServer, type TileResourceProvider } from '@frillab/copc-tiles/resources';
import { createExplicitTileset as createExplicitTilesetFromSubpath } from '@frillab/copc-tiles/tileset';
import { createImplicitOctreeTileset as createImplicitOctreeTilesetFromSubpath } from '@frillab/copc-tiles/tileset/implicit';

const publicEngineExports = [
  TileNodeReader,
  createExplicitTileset,
  createImplicitOctreeTileset,
  encodePointCloudGlb,
  createCopcTileResourceProvider,
  createTileResourceServer,
  createExplicitTilesetFromSubpath,
  createImplicitOctreeTilesetFromSubpath,
];
const sourceNeutralTypes: readonly [TileNodeSource | undefined, TilePointView | undefined, TileResourceProvider | undefined] = [
  undefined,
  undefined,
  undefined,
];

void [publicEngineExports, sourceNeutralTypes];

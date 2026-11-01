import assert from 'node:assert/strict';
import * as tiles from '@frillab/copc-tiles';
import * as resources from '@frillab/copc-tiles/resources';
import * as explicitTileset from '@frillab/copc-tiles/tileset';
import * as implicitTileset from '@frillab/copc-tiles/tileset/implicit';

assert.equal(typeof tiles.TileNodeReader, 'function');
assert.equal(typeof tiles.encodePointCloudGlb, 'function');
assert.equal(typeof tiles.createTileResourceServer, 'function');
assert.equal(typeof resources.createCopcTileResourceProvider, 'function');
assert.equal(typeof explicitTileset.createExplicitTileset, 'function');
assert.equal(typeof implicitTileset.createImplicitOctreeTileset, 'function');
console.log('Adapter-free Tiles Engine ESM imports passed for the engine and all renderer-free public subpaths.');

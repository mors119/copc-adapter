import assert from 'node:assert/strict';
import * as core from '@frillab/copc-adapter/core';
import * as tiles from '@frillab/copc-tiles';
import * as resources from '@frillab/copc-tiles/resources';
import { CopcCoreNodeSource } from '@frillab/copc-tiles/adapter/copc-core';

assert.equal(typeof core.createCopcContext, 'function');
assert.equal(typeof core.CopcContext.prototype.getConservativeNodeEcefBounds, 'function');
assert.equal(typeof tiles.encodePointCloudGlb, 'function');
assert.equal(typeof resources.createCopcTileResourceProvider, 'function');
assert.equal(typeof CopcCoreNodeSource, 'function');
console.log('Renderer-free packed Core consumer passed without Cesium or Three installed.');

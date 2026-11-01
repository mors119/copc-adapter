import type {
  CopcHierarchyBounds,
  CopcHierarchyNode,
  CopcMetadata,
  CopcConservativeBoundsResult,
  CopcConservativeNodeSource,
  CopcNodeSource,
  CopcPointFieldSelection,
  CopcPreparedNodeData,
  CoordinateTransformPlan,
} from '@frillab/copc-adapter/core';
import type { TilePointFieldSelection, PreparedPointDataAInput } from '../src/input/tilePointView.js';
import type { TileConservativeBoundsResult, TileConservativeNodeSource, TileNodeSource } from '../src/source/tileNodeSource.js';
import type { CopcCoreNodeSource, CopcCoreNodeSourceOptions } from '../src/adapter/copcCoreAdapter.js';

type Assert<T extends true> = T;
type CorePreparedDataIsACompatible = Assert<CopcPreparedNodeData['pointData'] extends PreparedPointDataAInput ? true : false>;
type CoreNodeAcceptsPublicHierarchyNode = Assert<Parameters<CopcNodeSource['loadPreparedNodeData']>[0] extends CopcHierarchyNode ? true : false>;
type CoreSelectionAcceptsTileFields = Assert<ReturnType<typeof toCoreFields> extends CopcPointFieldSelection ? true : false>;
type CoreConnectorImplementsTileSource = Assert<CopcCoreNodeSource extends TileConservativeNodeSource ? true : false>;
type CoreMetadataContractIsPublic = Assert<ReturnType<CopcNodeSource['getMetadata']> extends CopcMetadata ? true : false>;
type CoreBoundsContractIsSourceSpace = Assert<ReturnType<CopcNodeSource['getNodeCellBounds']> extends CopcHierarchyBounds ? true : false>;
type CoreTransformPlanIsPublic = Assert<CopcNodeSource['transformPlan'] extends CoordinateTransformPlan ? true : false>;
type CoreConservativeSourceIsPublic = Assert<CopcConservativeNodeSource extends CopcNodeSource ? true : false>;
type CoreConservativeResultIsSourceNeutral = Assert<CopcConservativeBoundsResult extends TileConservativeBoundsResult ? true : false>;
type CoreConservativeBoundsTakesOnlyNodeKey = Assert<Parameters<CopcConservativeNodeSource['getConservativeNodeEcefBounds']> extends [string] ? true : false>;

function toCoreFields(_selection: TilePointFieldSelection): ReadonlySet<'position' | 'rgb' | 'intensity' | 'classification'> {
  return new Set(['position']);
}

declare const source: CopcConservativeNodeSource;
declare const sourceOptions: CopcCoreNodeSourceOptions;
const sourceMethod: CopcNodeSource['loadPreparedNodeData'] = source.loadPreparedNodeData.bind(source);
const connectorOptions: CopcCoreNodeSourceOptions = { source, sourceIdentity: 'opaque-source' };
declare const connector: CopcCoreNodeSource;
const connectorSource: TileNodeSource = connector;
const conservativeSource: TileConservativeNodeSource = connector;
const boundsResult: TileConservativeBoundsResult = connector.getConservativeNodeEcefBounds('0-0-0-0');
void [sourceMethod, connectorOptions, sourceOptions, connectorSource, conservativeSource, boundsResult];

export type CopcCoreApiCompatibility =
  | CorePreparedDataIsACompatible
  | CoreNodeAcceptsPublicHierarchyNode
  | CoreSelectionAcceptsTileFields
  | CoreConnectorImplementsTileSource
  | CoreMetadataContractIsPublic
  | CoreBoundsContractIsSourceSpace
  | CoreTransformPlanIsPublic
  | CoreConservativeSourceIsPublic
  | CoreConservativeResultIsSourceNeutral
  | CoreConservativeBoundsTakesOnlyNodeKey;

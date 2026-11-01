import type {
  CopcConservativeBoundsResult,
  CopcConservativeNodeSource,
  CopcMetadata,
} from '@frillab/copc-adapter/core';
import type { ExplicitTilesetOptions, TilesetNodeInput } from '@frillab/copc-tiles/tileset';
import type { ImplicitOctreeNodeInput, ImplicitOctreeOptions } from '@frillab/copc-tiles/tileset/implicit';
import type * as AdapterRootTypes from '@frillab/copc-adapter';
import type * as CesiumTypes from '@frillab/copc-adapter/cesium';
import type * as ThreeTypes from '@frillab/copc-adapter/three';
import type { CopcCoreNodeSource } from '@frillab/copc-tiles/adapter/copc-core';
import type { TileConservativeBoundsResult, TileConservativeNodeSource } from '@frillab/copc-tiles';
import type { CopcTileResourceProviderOptions } from '@frillab/copc-tiles/resources';

type Assert<T extends true> = T;
type PublicBoundsArePreserved = Assert<CopcConservativeBoundsResult extends TileConservativeBoundsResult ? true : false>;
type ConnectorUsesThePublicCapability = Assert<CopcCoreNodeSource extends TileConservativeNodeSource ? true : false>;
type RendererTypesAreResolved = Assert<keyof typeof CesiumTypes extends string ? true : false>;
type ThreeTypesAreResolved = Assert<keyof typeof ThreeTypes extends string ? true : false>;
type RootTypesAreResolved = Assert<keyof typeof AdapterRootTypes extends string ? true : false>;
type ExplicitTypesAreResolved = Assert<keyof ExplicitTilesetOptions extends string ? true : false>;
type ExplicitNodeTypesAreResolved = Assert<keyof TilesetNodeInput extends string ? true : false>;
type ImplicitTypesAreResolved = Assert<keyof ImplicitOctreeOptions extends string ? true : false>;
type ImplicitNodeTypesAreResolved = Assert<keyof ImplicitOctreeNodeInput extends string ? true : false>;

declare const source: CopcConservativeNodeSource;
declare const providerOptions: CopcTileResourceProviderOptions;
const fullScanAuthorization: CopcTileResourceProviderOptions = { scanCompleteHierarchy: true };
const metadata: CopcMetadata = source.getMetadata();
const conservative: TileConservativeBoundsResult = source.getConservativeNodeEcefBounds('0-0-0-0');
void [metadata, conservative, providerOptions, fullScanAuthorization];

export type PackedConsumerCompatibility =
  | PublicBoundsArePreserved
  | ConnectorUsesThePublicCapability
  | RendererTypesAreResolved
  | ThreeTypesAreResolved
  | RootTypesAreResolved
  | ExplicitTypesAreResolved
  | ExplicitNodeTypesAreResolved
  | ImplicitTypesAreResolved
  | ImplicitNodeTypesAreResolved;

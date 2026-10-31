const verticalTransformIdentities = new WeakMap<object, symbol>();

export type ApprovedTerrainAlignmentProvenance<Source> = Readonly<{
  source: Source;
  terrainUrl: string;
  verticalTransformIdentity: symbol | undefined;
  finalHeightOffsetMeters: number;
  residualMeters: number;
}>;

export type TerrainAlignmentProvenanceContext<Source> = Readonly<{
  source: Source | undefined;
  terrainUrl: string;
  verticalTransformIdentity: symbol | undefined;
  heightOffsetMeters: number;
}>;

/** Identify a grid resource without retaining its large backing buffer. */
export function getVerticalTransformIdentity(
  verticalTransform: unknown,
): symbol | undefined {
  if (typeof verticalTransform !== "object" || verticalTransform === null) {
    return undefined;
  }

  let identity = verticalTransformIdentities.get(verticalTransform);
  if (identity === undefined) {
    identity = Symbol("vertical-transform");
    verticalTransformIdentities.set(verticalTransform, identity);
  }
  return identity;
}

/** Return a residual only while its source, Terrain provider, grid, and approved offset remain active. */
export function getCurrentTerrainAlignmentResidual<Source>(
  provenance: ApprovedTerrainAlignmentProvenance<Source> | undefined,
  context: TerrainAlignmentProvenanceContext<Source>,
  sameSource: (left: Source, right: Source) => boolean,
): number | undefined {
  if (
    !provenance ||
    context.source === undefined ||
    !sameSource(provenance.source, context.source) ||
    provenance.terrainUrl !== context.terrainUrl ||
    provenance.verticalTransformIdentity !== context.verticalTransformIdentity ||
    provenance.finalHeightOffsetMeters !== context.heightOffsetMeters
  ) return undefined;
  return provenance.residualMeters;
}

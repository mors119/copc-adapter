export type ApprovedTerrainAlignmentProvenance<Source> = Readonly<{
  source: Source;
  terrainUrl: string;
  finalHeightOffsetMeters: number;
  residualMeters: number;
}>;

export type TerrainAlignmentProvenanceContext<Source> = Readonly<{
  source: Source | undefined;
  terrainUrl: string;
  heightOffsetMeters: number;
}>;

/** Return a residual only while its source, Terrain provider, and approved offset remain active. */
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
    provenance.finalHeightOffsetMeters !== context.heightOffsetMeters
  ) return undefined;
  return provenance.residualMeters;
}

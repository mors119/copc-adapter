import type { SchemaHostValidators } from "../schema/types.ts";
import type { PointVerticalReferenceContext } from "../inspection/pointFormatting.ts";

/** Metadata exposed by the released adapter's immutable verified grid. */
export type VerifiedVerticalGrid = {
  readonly gridId: string;
  readonly sha256: string;
  readonly sourceVerticalCrs: string;
  readonly targetVerticalCrs: string;
  readonly horizontalCrs: string;
  readonly referenceEllipsoid: string;
  readonly valueUnit: string;
  readonly valueConvention: string;
  readonly interpolation: string;
  readonly noDataValue: number | null;
  readonly width: number;
  readonly height: number;
  readonly longitudeOrigin: number;
  readonly latitudeOrigin: number;
  readonly longitudeStep: number;
  readonly latitudeStep: number;
  readonly encodedByteLength: number;
  readonly decodedByteLength: number;
  readonly globalLongitudeCoverage: string;
  readonly sourceCoordinateEpoch?: number;
  readonly gridReferenceEpoch?: number;
  sampleUndulation(longitude: number, latitude: number): number;
};

export type VerticalGridResourceDetails = {
  readonly gridId: string;
  readonly sha256: string;
  readonly sourceVerticalCrs: string;
  readonly targetVerticalCrs: string;
  readonly horizontalFrame: string;
  readonly verticalFrame: string;
  readonly valueUnit: string;
  readonly valueConvention: string;
  readonly noData: string;
  readonly interpolation: string;
  readonly extent: string;
  readonly dimensions: string;
  readonly memory: string;
  readonly epoch: string;
  readonly source: string;
  readonly licenseProvenance: string;
};

export type NgaEgm2008Loader = (
  source: Blob,
  options: { readonly maxGridBytes: number },
) => Promise<unknown>;

export const NGA_EGM2008_FILE_BYTES = 149_368_328;
export const NGA_EGM2008_MAX_GRID_BYTES = 160 * 1024 * 1024;
export const NGA_EGM2008_GRID_ID =
  "NGA EGM2008 2.5-minute WGS 84 Tide-Free small-endian grid";
export const NGA_EGM2008_SHA256 =
  "ab6f8b94076f78707d1cdae7b066b93a786a0c64b52449e20cf1a1a2f4e74daf";
export const NGA_EGM2008_SOURCE_URL =
  "https://earth-info.nga.mil/index.php?action=geoid&dir=wgs84";

const ARC_MINUTE_STEP = 2.5 / 60;

/** True only for the one fixed operation supported by the host Workbenches. */
export function isNgaEgm2008Grid(value: unknown): value is VerifiedVerticalGrid {
  if (typeof value !== "object" || value === null) return false;
  const grid = value as Partial<VerifiedVerticalGrid>;
  return grid.gridId === NGA_EGM2008_GRID_ID &&
    grid.sha256 === NGA_EGM2008_SHA256 &&
    grid.sourceVerticalCrs === "EPSG:3855" &&
    grid.targetVerticalCrs === "EPSG:4979" &&
    grid.horizontalCrs === "EPSG:4326" &&
    grid.referenceEllipsoid === "WGS84" &&
    grid.valueUnit === "metre" &&
    grid.valueConvention === "ellipsoidal-minus-orthometric" &&
    grid.interpolation === "bilinear" &&
    grid.noDataValue === null &&
    grid.width === 8640 &&
    grid.height === 4321 &&
    grid.longitudeOrigin === 0 &&
    grid.latitudeOrigin === -90 &&
    grid.longitudeStep === ARC_MINUTE_STEP &&
    grid.latitudeStep === ARC_MINUTE_STEP &&
    grid.globalLongitudeCoverage === "periodic" &&
    grid.encodedByteLength === NGA_EGM2008_FILE_BYTES &&
    grid.decodedByteLength === 8640 * 4321 * 4 &&
    grid.sourceCoordinateEpoch === undefined &&
    grid.gridReferenceEpoch === undefined &&
    typeof grid.sampleUndulation === "function";
}

/** Build a host-local validator around the public fixed-profile loader. */
export function createNgaEgm2008ResourceRegistry(loadGrid: NgaEgm2008Loader): {
  readonly hostValidators: SchemaHostValidators;
  readonly isLoadedGrid: (value: unknown) => value is VerifiedVerticalGrid;
  readonly loadFile: (file: Blob) => Promise<VerifiedVerticalGrid>;
} {
  const loadedGrids = new WeakSet<object>();
  const isLoadedGrid = (value: unknown): value is VerifiedVerticalGrid =>
    typeof value === "object" && value !== null &&
    loadedGrids.has(value) && isNgaEgm2008Grid(value);

  return {
    hostValidators: { isLoadedVerticalGrid: isLoadedGrid },
    isLoadedGrid,
    async loadFile(file) {
      if (file.size !== NGA_EGM2008_FILE_BYTES) {
        throw new TypeError(
          `Select the extracted NGA EGM2008 2.5-minute file (${NGA_EGM2008_FILE_BYTES.toLocaleString()} bytes). The selected file is ${file.size.toLocaleString()} bytes.`,
        );
      }
      const loaded = await loadGrid(file, {
        maxGridBytes: NGA_EGM2008_MAX_GRID_BYTES,
      });
      if (!isNgaEgm2008Grid(loaded)) {
        throw new TypeError(
          "The public loader returned a grid outside the host's registered NGA EGM2008 operation.",
        );
      }
      loadedGrids.add(loaded);
      return loaded;
    },
  };
}

/** Present truthful operation, coverage, memory, and source-rights metadata. */
export function getVerticalGridResourceDetails(
  value: unknown,
): VerticalGridResourceDetails | undefined {
  if (!isNgaEgm2008Grid(value)) return undefined;
  const grid = value;
  const maximumLatitude = grid.latitudeOrigin + (grid.height - 1) * grid.latitudeStep;
  return {
    gridId: grid.gridId,
    sha256: grid.sha256,
    sourceVerticalCrs: grid.sourceVerticalCrs,
    targetVerticalCrs: grid.targetVerticalCrs,
    horizontalFrame: "WGS 84 longitude/latitude (EPSG:4326)",
    verticalFrame: "EGM2008 Tide-Free to WGS 84 ellipsoid; no epoch propagation",
    valueUnit: grid.valueUnit,
    valueConvention: "ellipsoidal height minus EGM2008 height (h − H)",
    noData: "None in the registered NGA profile",
    interpolation: grid.interpolation,
    extent: `Global · longitude −180° to 180° (periodic); latitude −90° to ${maximumLatitude}°`,
    dimensions: `${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} samples · 2.5 arc-minute spacing`,
    memory: `${(grid.decodedByteLength / (1024 * 1024)).toFixed(2)} MiB decoded; ${(grid.encodedByteLength / (1024 * 1024)).toFixed(2)} MiB encoded; about ${((grid.decodedByteLength + grid.encodedByteLength) / (1024 * 1024)).toFixed(2)} MiB combined for this file before runtime overhead; file limit ${(NGA_EGM2008_MAX_GRID_BYTES / (1024 * 1024)).toFixed(0)} MiB`,
    epoch: "No epoch is carried by this operation; no frame or epoch propagation is performed",
    source: `NGA Office of Geomatics EGM2008 interpolation data · ${NGA_EGM2008_SOURCE_URL}`,
    licenseProvenance: "The NGA product page identifies the source but does not state redistribution terms. Select only a local copy you are authorized to use; the Workbench does not download, retain, or bundle the grid.",
  };
}

/** Human-readable fixed-profile summary used by Health and point inspection. */
export function describeVerticalGrid(value: unknown): string {
  const details = getVerticalGridResourceDetails(value);
  if (!details) return "No validated vertical grid applied";
  return `${details.gridId} · ${details.sourceVerticalCrs} → ${details.targetVerticalCrs} · ${details.interpolation} · SHA-256 ${details.sha256}`;
}

/** Combine source CRS diagnostics with the host's applied transform state. */
export function createPointVerticalReferenceContext(
  metadata: unknown,
  grid: unknown,
  heightOffsetMeters: number,
  terrainResidualMeters?: number,
): PointVerticalReferenceContext {
  const root = typeof metadata === "object" && metadata !== null
    ? metadata as { readonly crsDiagnostic?: unknown }
    : undefined;
  const diagnostic = root?.crsDiagnostic;
  const vertical = typeof diagnostic === "object" && diagnostic !== null
    ? (diagnostic as { readonly vertical?: unknown }).vertical
    : undefined;
  const values = typeof vertical === "object" && vertical !== null
    ? vertical as {
        readonly identity?: {
          readonly authority?: string;
          readonly code?: string;
          readonly name?: string;
        };
        readonly units?: { readonly name?: string; readonly kind?: string };
        readonly heightKind?: { readonly value?: string; readonly certainty?: string };
      }
    : undefined;
  const identity = values?.identity;
  const sourceVerticalCrs = identity
    ? [
        identity.authority && identity.code
          ? `${identity.authority}:${identity.code}`
          : undefined,
        identity.name,
      ].filter(Boolean).join(" · ") || undefined
    : undefined;
  const units = values?.units;
  const sourceVerticalUnits = units
    ? `${units.name ?? "Unknown"} (${units.kind ?? "unknown"})`
    : undefined;
  const heightKind = values?.heightKind;
  const sourceHeightKind = heightKind
    ? `${heightKind.value ?? "unknown"} (${heightKind.certainty ?? "unknown"})`
    : undefined;
  const details = getVerticalGridResourceDetails(grid);
  return {
    ...(sourceVerticalCrs ? { sourceVerticalCrs } : {}),
    ...(sourceVerticalUnits ? { sourceVerticalUnits } : {}),
    ...(sourceHeightKind ? { sourceHeightKind } : {}),
    ...(details ? { grid: details } : {}),
    heightOffsetMeters,
    ...(Number.isFinite(terrainResidualMeters) ? { terrainResidualMeters } : {}),
  };
}

import type { VerticalGridResourceDetails } from "../workbench/verticalGridResource.ts";

export type PointInspectionData = {
  readonly nodeKey: string;
  readonly level: number;
  readonly pointIndex: number;
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly source?: { readonly x: number; readonly y: number; readonly z: number };
  readonly world?: {
    readonly coordinateSystem: "wgs84-ecef-meters";
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly intensity?: number;
  readonly classification?: number;
  readonly classificationLabel?: string;
  readonly rgb?: {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
  };
  readonly dimensions?: Readonly<Record<string, number | bigint>>;
  readonly backend: string;
};

/** Source CRS and applied vertical-operation context supplied by the host. */
export type PointVerticalReferenceContext = {
  readonly sourceVerticalCrs?: string;
  readonly sourceVerticalUnits?: string;
  readonly sourceHeightKind?: string;
  readonly grid?: VerticalGridResourceDetails;
  readonly heightOffsetMeters: number;
  /** A separately approved visual Terrain residual, never a datum operation. */
  readonly terrainResidualMeters?: number;
};

export type PointInspectionRow = {
  readonly label: string;
  readonly value: string;
};

function formatCoordinate(value: number | bigint): string | undefined {
  if (typeof value === "bigint") return value.toString();
  return Number.isFinite(value) ? String(value) : undefined;
}

function formatTriple(
  x: number,
  y: number,
  z: number,
): string | undefined {
  const values = [x, y, z].map(formatCoordinate);
  return values.every((value): value is string => value !== undefined)
    ? values.join(" / ")
    : undefined;
}

function pushIfAvailable(
  rows: PointInspectionRow[],
  label: string,
  value: string | undefined,
): void {
  if (value !== undefined) rows.push({ label, value });
}

/** Format only values present in the point inspection without inventing precision. */
export function getPointInspectionRows(
  point: PointInspectionData,
  verticalReference?: PointVerticalReferenceContext,
): {
  readonly summary: readonly PointInspectionRow[];
  readonly details: readonly PointInspectionRow[];
} {
  const summary: PointInspectionRow[] = [];
  const details: PointInspectionRow[] = [];
  const longitude = formatCoordinate(point.longitude);
  const latitude = formatCoordinate(point.latitude);

  if (longitude !== undefined && latitude !== undefined) {
    summary.push({
      label: "Geographic position (WGS84)",
      value: `${longitude}°, ${latitude}°`,
    });
    details.push({
      label: "Longitude / latitude (WGS84 degrees)",
      value: `${longitude} / ${latitude}`,
    });
  }

  pushIfAvailable(
    summary,
    "WGS84 ellipsoidal height (m)",
    formatCoordinate(point.height),
  );

  if (point.classification !== undefined) {
    const classification = formatCoordinate(point.classification);
    pushIfAvailable(
      summary,
      "Classification",
      classification === undefined
        ? undefined
        : point.classificationLabel
          ? `${classification} · ${point.classificationLabel}`
          : classification,
    );
    pushIfAvailable(
      details,
      "Classification code",
      classification,
    );
    pushIfAvailable(
      details,
      "Classification label",
      point.classificationLabel,
    );
  } else {
    pushIfAvailable(details, "Classification label", point.classificationLabel);
  }

  if (point.intensity !== undefined && Number.isFinite(point.intensity)) {
    pushIfAvailable(summary, "Intensity", formatCoordinate(point.intensity));
    pushIfAvailable(details, "Intensity", formatCoordinate(point.intensity));
  }

  if (point.rgb) {
    const rgb = formatTriple(point.rgb.red, point.rgb.green, point.rgb.blue);
    pushIfAvailable(summary, "RGB", rgb);
    pushIfAvailable(details, "RGB (source channels)", rgb);
  }

  if (point.source) {
    pushIfAvailable(
      details,
      "Source coordinates (X / Y / Z)",
      formatTriple(point.source.x, point.source.y, point.source.z),
    );
  }

  if (verticalReference) {
    pushIfAvailable(details, "Source vertical CRS", verticalReference.sourceVerticalCrs);
    pushIfAvailable(details, "Source vertical units", verticalReference.sourceVerticalUnits);
    pushIfAvailable(details, "Source height kind", verticalReference.sourceHeightKind);
    pushIfAvailable(
      details,
      "Vertical datum transform",
      verticalReference.grid
        ? `${verticalReference.grid.gridId} · ${verticalReference.grid.sourceVerticalCrs} → ${verticalReference.grid.targetVerticalCrs} · ${verticalReference.grid.interpolation} · ${verticalReference.grid.valueConvention}`
        : "None · source height is not converted to another vertical datum",
    );
    if (verticalReference.grid) {
      pushIfAvailable(details, "Grid coverage", verticalReference.grid.extent);
      pushIfAvailable(details, "Grid SHA-256", verticalReference.grid.sha256);
      pushIfAvailable(details, "Grid source", verticalReference.grid.source);
    }
    if (Number.isFinite(verticalReference.heightOffsetMeters)) {
      details.push({
        label: "Manual heightOffsetMeters",
        value: `${verticalReference.heightOffsetMeters} m · ${verticalReference.grid ? "applied separately after the vertical grid" : "independent manual adjustment"}`,
      });
    }
    if (Number.isFinite(verticalReference.terrainResidualMeters)) {
      details.push({
        label: "Terrain residual (visual only)",
        value: `${verticalReference.terrainResidualMeters} m · not a geoid or vertical-datum conversion`,
      });
    }
  }

  if (point.world?.coordinateSystem === "wgs84-ecef-meters") {
    pushIfAvailable(
      details,
      "ECEF coordinates (metres)",
      formatTriple(point.world.x, point.world.y, point.world.z),
    );
  }

  details.push(
    { label: "Node key", value: point.nodeKey },
    { label: "Point index", value: String(point.pointIndex) },
    { label: "Level", value: String(point.level) },
    { label: "Backend", value: point.backend },
  );

  for (const [name, value] of Object.entries(point.dimensions ?? {})) {
    pushIfAvailable(details, `Extra dimension · ${name}`, formatCoordinate(value));
  }

  return { summary, details };
}

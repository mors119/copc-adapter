import type {
  SchemaDimensionColorStop,
  SchemaDimensionFilter,
  SchemaDimensionStyle,
  SchemaNumericDimensionMetadata,
} from "../schema/types.ts";

type ExtraDimensionDescriptor = {
  readonly name: string;
  readonly type?: "signed" | "unsigned" | "float";
  readonly length: number;
  readonly scale?: number;
  readonly offset?: number;
  readonly noData?: number;
};

type CopcMetadataView = {
  readonly extraDimensions?: readonly ExtraDimensionDescriptor[];
};

const DEFAULT_PALETTE: readonly SchemaDimensionColorStop[] = [
  { position: 0, color: { red: 0.05, green: 0.2, blue: 0.65, alpha: 0.9 } },
  { position: 1 / 3, color: { red: 0, green: 0.75, blue: 1, alpha: 0.9 } },
  { position: 2 / 3, color: { red: 1, green: 0.85, blue: 0.1, alpha: 0.9 } },
  { position: 1, color: { red: 0.85, green: 0.1, blue: 0.05, alpha: 0.9 } },
];

const FALLBACK_RANGE = { min: 0, max: 1 } as const;

function integerRange(dimension: ExtraDimensionDescriptor): { min: number; max: number } | undefined {
  if (dimension.type !== "signed" && dimension.type !== "unsigned") return undefined;
  if (![1, 2, 4].includes(dimension.length)) return undefined;
  const bits = dimension.length * 8;
  const rawMin = dimension.type === "signed" ? -(2 ** (bits - 1)) : 0;
  const rawMax = dimension.type === "signed" ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const scale = dimension.scale ?? 1;
  const offset = dimension.offset ?? 0;
  const min = rawMin * scale + offset;
  const max = rawMax * scale + offset;
  return Number.isFinite(min) && Number.isFinite(max)
    ? { min: Math.min(min, max), max: Math.max(min, max) }
    : undefined;
}

function floatStarterRange(dimension: ExtraDimensionDescriptor): { min: number; max: number } | undefined {
  if (dimension.type !== "float" || ![4, 8].includes(dimension.length)) return undefined;
  const scale = dimension.scale ?? 1;
  const offset = dimension.offset ?? 0;
  const first = offset;
  const second = scale + offset;
  if (!Number.isFinite(first) || !Number.isFinite(second)) return undefined;
  if (first !== second) return { min: Math.min(first, second), max: Math.max(first, second) };
  return { min: first - 0.5, max: first + 0.5 };
}

function styleableDescriptor(dimension: ExtraDimensionDescriptor): boolean {
  return dimension.type === "signed" || dimension.type === "unsigned"
    ? [1, 2, 4].includes(dimension.length)
    : dimension.type === "float" && [4, 8].includes(dimension.length);
}

/**
 * Describe numeric fields from loaded COPC metadata without reading point
 * records. `extraDimensions` are selectable only with copc-js; the 0.7.1
 * Rust backend supports standard Intensity but not named Extra Bytes fields.
 */
export function getWorkbenchNumericDimensions(
  metadata: CopcMetadataView | undefined,
  backend: "copc-js" | "rust",
  decodedExtraDimensions: readonly string[] = [],
  intensityDecoded = true,
): readonly SchemaNumericDimensionMetadata[] | undefined {
  if (!metadata) return undefined;
  const result: SchemaNumericDimensionMetadata[] = [{
    name: "Intensity",
    kind: "intensity",
    type: "unsigned",
    length: 2,
    defaultRange: { min: 0, max: 65_535 },
    units: "raw LAS intensity (unitless)",
    styleable: true,
    decoded: intensityDecoded,
  }];
  for (const dimension of metadata.extraDimensions ?? []) {
    if (dimension.name === "Intensity") continue;
    const typeSupported = styleableDescriptor(dimension);
    const rustUnsupported = backend === "rust";
    const bigintUnsupported =
      (dimension.type === "signed" || dimension.type === "unsigned") &&
      dimension.length === 8;
    const styleable = typeSupported && !rustUnsupported;
    const unsupportedReason = rustUnsupported
      ? "Named Extra Bytes are not supported by Rust/WASM."
      : bigintUnsupported
        ? "64-bit integer fields are preserved as BigInt and cannot be used as numeric colors."
        : !typeSupported
          ? "The descriptor is not a supported scalar integer or floating-point field."
          : undefined;
    const defaultRange = integerRange(dimension) ?? floatStarterRange(dimension) ?? FALLBACK_RANGE;
    result.push({
      name: dimension.name,
      kind: "extra",
      ...(dimension.type === undefined ? {} : { type: dimension.type }),
      length: dimension.length,
      ...(dimension.scale === undefined ? {} : { scale: dimension.scale }),
      ...(dimension.offset === undefined ? {} : { offset: dimension.offset }),
      ...(dimension.noData === undefined ? {} : { noData: dimension.noData }),
      defaultRange,
      defaultRangeNote: dimension.type === "float"
        ? "A raw 0–1 starter range is transformed by the declared scale and offset; point samples have not been scanned."
        : "Range uses the field's representable limits after the declared scale and offset; it is not an observed sample range.",
      units: dimension.scale === undefined && dimension.offset === undefined
        ? "source values (unit not declared)"
        : "scaled source values (unit not declared)",
      styleable,
      ...(unsupportedReason ? { unsupportedReason } : {}),
      decoded: styleable && (
        decodedExtraDimensions.includes(dimension.name) || decodedExtraDimensions.includes("*")
      ),
    });
  }
  return result;
}

/** Create a dimension ramp preset from the exact selected metadata descriptor. */
export function createDefaultDimensionStyle(
  metadata: readonly SchemaNumericDimensionMetadata[] | undefined,
  name: string,
): SchemaDimensionStyle {
  const dimension = metadata?.find((candidate) => candidate.name === name && candidate.styleable);
  if (!dimension) {
    throw new RangeError("Choose a numeric field that is present and supported by the active backend.");
  }
  return {
    name: dimension.name,
    range: { ...dimension.defaultRange },
    palette: DEFAULT_PALETTE.map((stop) => ({
      position: stop.position,
      color: { ...stop.color },
    })),
    ...(dimension.noData === undefined ? {} : { missingValue: dimension.noData }),
  };
}

/** Return only named Extra Bytes needed by the selected style and Cesium filter. */
export function requestedDimensionNames(
  dimension: SchemaDimensionStyle | undefined,
  filter: SchemaDimensionFilter | undefined | null,
): readonly string[] {
  return [...new Set([dimension?.name, filter?.name]
    .filter((name): name is string => name !== undefined && name !== "Intensity"))];
}

/** Copy schema state while synchronizing the exact Extra Bytes decode requests. */
export function withRequestedExtraDimensions(
  schemaOptionValues: Readonly<Record<string, unknown>>,
  configuredExtraDimensions: readonly string[] | "*",
  dimension: SchemaDimensionStyle | undefined,
  filter: SchemaDimensionFilter | undefined | null,
): Record<string, unknown> {
  const next = { ...schemaOptionValues };
  const requested = configuredExtraDimensions === "*"
    ? ["*"]
    : [...new Set([
        ...configuredExtraDimensions,
        ...requestedDimensionNames(dimension, filter),
      ])];
  if (requested.length > 0) {
    next["attributes.extraDimensions"] = configuredExtraDimensions === "*"
      ? "*"
      : requested;
  } else {
    delete next["attributes.extraDimensions"];
  }
  return next;
}

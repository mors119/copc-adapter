import {
  extractExplicitVerticalUnitScale,
  extractHorizontalCrsWkt,
  getVerticalCrsIdentity,
  type VerticalCrsIdentity,
} from "../crs/parseCopcWkt";

/** Stable validation errors emitted by the caller-supplied vertical grid path. */
export type VerticalTransformErrorCode =
  | "missing-vertical-crs"
  | "unsupported-crs-pair"
  | "missing-grid"
  | "invalid-grid-metadata"
  | "grid-integrity"
  | "grid-format"
  | "outside-grid-coverage"
  | "grid-nodata"
  | "unsupported-direction"
  | "missing-epoch"
  | "incompatible-reference-frame"
  | "unsupported-interpolation"
  | "resource-limit"
  | "integrity-unavailable";

/** Error that identifies a fail-closed grid-loading or height-sampling failure. */
export class VerticalTransformError extends Error {
  readonly code: VerticalTransformErrorCode;
  readonly gridId?: string;

  constructor(
    code: VerticalTransformErrorCode,
    message: string,
    gridId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VerticalTransformError";
    this.code = code;
    this.gridId = gridId;
  }
}

/** Units supported for GTX grid values. Values are converted to metres on sample. */
export type VerticalGridValueUnit =
  | "metre"
  | "international-foot"
  | "us-survey-foot";

/** Direction used by the reusable height equation helper. */
export type VerticalHeightDirection =
  | "orthometric-to-ellipsoidal"
  | "ellipsoidal-to-orthometric";

/** Source accepted by the offline GTX loader. URLs are intentionally unsupported. */
export type VerticalGridBytes =
  | Blob
  | ArrayBuffer
  | ArrayBufferView<ArrayBuffer>;

/**
 * Metadata GTX does not store and that must be supplied from the grid's
 * authoritative documentation. This assertion is not a model registry.
 */
export type GtxGeoidGridOptions = {
  /** Caller-chosen description; it does not select or infer a model. */
  gridId: string;
  /** Exact vertical CRS authority (for example `EPSG:3855`) or WKT vertical CRS name. */
  sourceVerticalCrs: string;
  /** The adapter's only supported rendering target: WGS 84 ellipsoidal height. */
  targetVerticalCrs: "EPSG:4979";
  /** GTX coordinates are interpreted as WGS 84 longitude/latitude in degrees. */
  horizontalCrs: "EPSG:4326";
  /** Ellipsoid used by the documented undulation values. */
  referenceEllipsoid: "WGS84";
  /** Expected SHA-256 digest of the complete GTX file, in hexadecimal. */
  sha256: string;
  /** Unit of the stored vertical shift values. */
  valueUnit: VerticalGridValueUnit;
  /** GTX stores offsets, so the caller must identify the sign convention. */
  valueConvention: "ellipsoidal-minus-orthometric";
  /** Bilinear is the only implemented interpolation rule. Defaults to `bilinear`. */
  interpolation?: "bilinear";
  /** Publisher's raw-value sentinel, or `null` only when its documentation confirms none. */
  noDataValue: number | null;
  /** Maximum encoded and decoded grid size in bytes. Defaults to 256 MiB, hard limit 512 MiB. */
  maxGridBytes?: number;
  /** Set when the source/model operation requires a matched coordinate epoch. */
  requiresMatchedEpoch?: boolean;
  /** Source observation epoch; required together with `gridReferenceEpoch` when either is set. */
  sourceCoordinateEpoch?: number;
  /** Grid/reference epoch; no epoch propagation is performed. */
  gridReferenceEpoch?: number;
};

const GTX_HEADER_BYTES = 40;
const DEFAULT_MAX_GRID_BYTES = 256 * 1024 * 1024;
const HARD_MAX_GRID_BYTES = 512 * 1024 * 1024;
const METRES_PER_UNIT: Readonly<Record<VerticalGridValueUnit, number>> = {
  metre: 1,
  "international-foot": 0.3048,
  "us-survey-foot": 1200 / 3937,
};
const WGS84_ELLIPSOIDAL_CRS = "EPSG:4979";

function fail(
  code: VerticalTransformErrorCode,
  message: string,
  gridId?: string,
): never {
  throw new VerticalTransformError(code, message, gridId);
}

function normalizeEpsg(value: string): string | undefined {
  const match = value.trim().match(/^EPSG\s*:\s*(\d+)$/i);
  return match ? `EPSG:${match[1]}` : undefined;
}

function validateOptions(options: GtxGeoidGridOptions): void {
  if (!options || typeof options !== "object") {
    fail("invalid-grid-metadata", "GTX grid metadata is required");
  }
  if (!options.gridId?.trim()) {
    fail("invalid-grid-metadata", "gridId must be a non-empty description");
  }
  if (!options.sourceVerticalCrs?.trim()) {
    fail("missing-vertical-crs", "sourceVerticalCrs must be provided explicitly");
  }
  if (normalizeEpsg(options.targetVerticalCrs) !== WGS84_ELLIPSOIDAL_CRS) {
    fail(
      "unsupported-crs-pair",
      `Only target vertical CRS ${WGS84_ELLIPSOIDAL_CRS} is supported by the WGS 84 ECEF renderer path`,
      options.gridId,
    );
  }
  if (normalizeEpsg(options.horizontalCrs) !== "EPSG:4326") {
    fail(
      "incompatible-reference-frame",
      "GTX sampling currently supports only WGS 84 longitude/latitude (EPSG:4326)",
      options.gridId,
    );
  }
  if (options.referenceEllipsoid !== "WGS84") {
    fail(
      "incompatible-reference-frame",
      "GTX geoid values must be documented relative to the WGS84 ellipsoid",
      options.gridId,
    );
  }
  if (options.interpolation !== undefined && options.interpolation !== "bilinear") {
    fail(
      "unsupported-interpolation",
      `Unsupported grid interpolation: ${String(options.interpolation)}; use bilinear`,
      options.gridId,
    );
  }
  if (options.valueConvention !== "ellipsoidal-minus-orthometric") {
    fail(
      "unsupported-crs-pair",
      "The grid must explicitly document values as ellipsoidal height minus orthometric height (h - H)",
      options.gridId,
    );
  }
  if (!Object.hasOwn(METRES_PER_UNIT, options.valueUnit)) {
    fail("invalid-grid-metadata", "valueUnit must be a supported vertical unit", options.gridId);
  }
  if (!/^[\da-f]{64}$/i.test(options.sha256)) {
    fail("invalid-grid-metadata", "sha256 must contain exactly 64 hexadecimal characters", options.gridId);
  }
  if (!Object.hasOwn(options, "noDataValue")) {
    fail("invalid-grid-metadata", "Declare noDataValue from grid documentation, or null when no sentinel is used", options.gridId);
  }
  if (options.noDataValue !== null && !Number.isFinite(options.noDataValue)) {
    fail("invalid-grid-metadata", "noDataValue must be finite or explicitly null", options.gridId);
  }
  const sourceEpoch = options.sourceCoordinateEpoch;
  const gridEpoch = options.gridReferenceEpoch;
  if (
    (sourceEpoch !== undefined && !Number.isFinite(sourceEpoch)) ||
    (gridEpoch !== undefined && !Number.isFinite(gridEpoch))
  ) {
    fail("invalid-grid-metadata", "coordinate epochs must be finite decimal years", options.gridId);
  }
  if (options.requiresMatchedEpoch && (sourceEpoch === undefined || gridEpoch === undefined)) {
    fail(
      "missing-epoch",
      "This grid operation requires sourceCoordinateEpoch and gridReferenceEpoch",
      options.gridId,
    );
  }
  if ((sourceEpoch === undefined) !== (gridEpoch === undefined)) {
    fail(
      "missing-epoch",
      "Provide both sourceCoordinateEpoch and gridReferenceEpoch, or neither",
      options.gridId,
    );
  }
  if (sourceEpoch !== undefined && sourceEpoch !== gridEpoch) {
    fail(
      "incompatible-reference-frame",
      "Epoch propagation is not implemented; sourceCoordinateEpoch must equal gridReferenceEpoch",
      options.gridId,
    );
  }
  const maxGridBytes = options.maxGridBytes ?? DEFAULT_MAX_GRID_BYTES;
  if (
    !Number.isSafeInteger(maxGridBytes) ||
    maxGridBytes < GTX_HEADER_BYTES + 2 * 2 * 4 ||
    maxGridBytes > HARD_MAX_GRID_BYTES
  ) {
    fail(
      "resource-limit",
      `maxGridBytes must be an integer between ${GTX_HEADER_BYTES + 16} and ${HARD_MAX_GRID_BYTES}`,
      options.gridId,
    );
  }
}

async function readGridBytes(
  source: VerticalGridBytes,
  maxBytes: number,
  gridId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    if (source.size > maxBytes) {
      fail("resource-limit", `GTX file exceeds the ${maxBytes}-byte encoded grid limit`, gridId);
    }
    return new Uint8Array(await source.arrayBuffer());
  }
  if (source instanceof ArrayBuffer) {
    if (source.byteLength > maxBytes) {
      fail("resource-limit", `GTX buffer exceeds the ${maxBytes}-byte encoded grid limit`, gridId);
    }
    // Snapshot caller-owned mutable memory before the asynchronous digest and
    // decode phases, so the bytes checked are the bytes that are decoded.
    return new Uint8Array(source).slice();
  }
  if (ArrayBuffer.isView(source)) {
    if (source.byteLength > maxBytes) {
      fail("resource-limit", `GTX view exceeds the ${maxBytes}-byte encoded grid limit`, gridId);
    }
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  fail("missing-grid", "Provide a local Blob/File, ArrayBuffer, or typed-array view; network URLs are not supported", gridId);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>, gridId: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    fail(
      "integrity-unavailable",
      "SHA-256 verification requires Web Crypto; use HTTPS, localhost, or a runtime with crypto.subtle",
      gridId,
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function near(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

/**
 * Immutable, decoded GTX geoid/vertical-shift grid. The grid values and file
 * bytes are private; one instance can be shared by all source and worker paths.
 */
export class GtxGeoidGrid {
  readonly gridId: string;
  readonly sha256: string;
  readonly sourceVerticalCrs: string;
  readonly targetVerticalCrs: "EPSG:4979";
  readonly valueUnit: VerticalGridValueUnit;
  readonly interpolation = "bilinear" as const;
  readonly width: number;
  readonly height: number;
  readonly longitudeOrigin: number;
  readonly latitudeOrigin: number;
  readonly longitudeStep: number;
  readonly latitudeStep: number;
  readonly encodedByteLength: number;
  readonly decodedByteLength: number;
  readonly minimumUndulationMeters: number;
  readonly maximumUndulationMeters: number;
  readonly #values: Float32Array | Float64Array;
  readonly #noDataValue?: number;
  readonly #metresPerGridUnit: number;
  readonly #globalLongitudeCoverage: "none" | "duplicated-seam" | "periodic";
  readonly #hasMatchedEpoch: boolean;

  private constructor(input: {
    options: GtxGeoidGridOptions;
    sha256: string;
    width: number;
    height: number;
    longitudeOrigin: number;
    latitudeOrigin: number;
    longitudeStep: number;
    latitudeStep: number;
    values: Float32Array | Float64Array;
    encodedByteLength: number;
    minimumUndulationMeters: number;
    maximumUndulationMeters: number;
    globalLongitudeCoverage: "none" | "duplicated-seam" | "periodic";
  }) {
    this.gridId = input.options.gridId.trim();
    this.sha256 = input.sha256;
    this.sourceVerticalCrs = input.options.sourceVerticalCrs.trim();
    this.targetVerticalCrs = WGS84_ELLIPSOIDAL_CRS;
    this.valueUnit = input.options.valueUnit;
    this.width = input.width;
    this.height = input.height;
    this.longitudeOrigin = input.longitudeOrigin;
    this.latitudeOrigin = input.latitudeOrigin;
    this.longitudeStep = input.longitudeStep;
    this.latitudeStep = input.latitudeStep;
    this.#values = input.values;
    this.#noDataValue = input.options.noDataValue === null
      ? undefined
      : input.values instanceof Float32Array
        ? Math.fround(input.options.noDataValue)
        : input.options.noDataValue;
    this.#metresPerGridUnit = METRES_PER_UNIT[input.options.valueUnit];
    this.#hasMatchedEpoch =
      input.options.sourceCoordinateEpoch !== undefined &&
      input.options.gridReferenceEpoch !== undefined;
    this.encodedByteLength = input.encodedByteLength;
    this.decodedByteLength = input.values.byteLength;
    this.minimumUndulationMeters = input.minimumUndulationMeters;
    this.maximumUndulationMeters = input.maximumUndulationMeters;
    this.#globalLongitudeCoverage = input.globalLongitudeCoverage;
    Object.freeze(this);
  }

  /**
   * Validate metadata and bytes, verify the requested digest, and decode one
   * GTX grid. No network access or persistence occurs.
   *
   * GTX itself carries WGS 84 latitude/longitude axes and float offsets but
   * does not carry the vertical CRS pair, sign convention, license, or epoch.
   * Those values must be supplied from the grid's own documentation.
   */
  static async load(
    source: VerticalGridBytes,
    options: GtxGeoidGridOptions,
  ): Promise<GtxGeoidGrid> {
    // Preserve the exact metadata that passed validation across the async
    // digest/read boundary; otherwise callers could mutate CRS, unit, or
    // NoData declarations while loading is in flight.
    options = { ...options };
    validateOptions(options);
    const gridId = options.gridId.trim();
    const maxGridBytes = options.maxGridBytes ?? DEFAULT_MAX_GRID_BYTES;
    const bytes = await readGridBytes(source, maxGridBytes, gridId);
    if (bytes.byteLength < GTX_HEADER_BYTES) {
      fail("grid-format", "GTX file is shorter than its 40-byte header", gridId);
    }
    const actualDigest = await sha256(bytes, gridId);
    if (actualDigest.toLowerCase() !== options.sha256.toLowerCase()) {
      fail(
        "grid-integrity",
        `SHA-256 mismatch for grid ${gridId}: expected ${options.sha256.toLowerCase()}, received ${actualDigest}`,
        gridId,
      );
    }

    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const latitudeOrigin = header.getFloat64(0, false);
    const longitudeOrigin = header.getFloat64(8, false);
    const latitudeStep = header.getFloat64(16, false);
    const longitudeStep = header.getFloat64(24, false);
    const height = header.getInt32(32, false);
    const width = header.getInt32(36, false);
    if (
      ![latitudeOrigin, longitudeOrigin, latitudeStep, longitudeStep].every(Number.isFinite) ||
      latitudeStep <= 0 ||
      longitudeStep <= 0 ||
      latitudeOrigin < -90 ||
      longitudeOrigin < -360 ||
      longitudeOrigin > 360 ||
      width < 2 ||
      height < 2
    ) {
      fail("invalid-grid-metadata", "GTX header has invalid origin, spacing, or dimensions", gridId);
    }
    const count = width * height;
    if (!Number.isSafeInteger(count) || count <= 0) {
      fail("resource-limit", "GTX dimensions exceed safe indexing limits", gridId);
    }
    const valueBytes = bytes.byteLength - GTX_HEADER_BYTES;
    const bytesPerValue = valueBytes === count * 4 ? 4 : valueBytes === count * 8 ? 8 : 0;
    if (bytesPerValue === 0) {
      fail(
        "grid-integrity",
        `GTX data length does not match ${width} × ${height} float32 or float64 samples`,
        gridId,
      );
    }
    if (valueBytes > maxGridBytes) {
      fail("resource-limit", `Decoded GTX data exceeds the ${maxGridBytes}-byte grid limit`, gridId);
    }
    const maximumLatitude = latitudeOrigin + (height - 1) * latitudeStep;
    const longitudeSpan = (width - 1) * longitudeStep;
    const tolerance = Math.max(1e-9, longitudeStep * 1e-7);
    if (
      maximumLatitude > 90 + 1e-9 ||
      longitudeSpan > 360 + tolerance
    ) {
      fail("invalid-grid-metadata", "GTX grid extent exceeds geographic latitude or longitude limits", gridId);
    }
    const duplicatedSeam = near(longitudeSpan, 360, tolerance);
    const periodic = !duplicatedSeam && near(width * longitudeStep, 360, tolerance);
    const globalLongitudeCoverage = duplicatedSeam
      ? "duplicated-seam"
      : periodic
        ? "periodic"
        : "none";
    const values = bytesPerValue === 4 ? new Float32Array(count) : new Float64Array(count);
    const noDataValue = options.noDataValue === null
      ? undefined
      : bytesPerValue === 4
        ? Math.fround(options.noDataValue)
        : options.noDataValue;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      const value = bytesPerValue === 4
        ? header.getFloat32(GTX_HEADER_BYTES + index * 4, false)
        : header.getFloat64(GTX_HEADER_BYTES + index * 8, false);
      values[index] = value;
      if (!Number.isFinite(value)) {
        fail("grid-format", `GTX sample ${index} is non-finite; use a documented finite NoData sentinel`, gridId);
      }
      if (noDataValue !== undefined && value === noDataValue) {
        continue;
      }
      const metres = value * METRES_PER_UNIT[options.valueUnit];
      if (!Number.isFinite(metres)) {
        fail("grid-format", `GTX sample ${index} is outside the supported numeric range`, gridId);
      }
      minimum = Math.min(minimum, metres);
      maximum = Math.max(maximum, metres);
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
      fail("grid-format", "GTX grid contains no finite, non-NoData samples", gridId);
    }

    return new GtxGeoidGrid({
      options,
      sha256: actualDigest,
      width,
      height,
      longitudeOrigin,
      latitudeOrigin,
      longitudeStep,
      latitudeStep,
      values,
      encodedByteLength: bytes.byteLength,
      minimumUndulationMeters: minimum,
      maximumUndulationMeters: maximum,
      globalLongitudeCoverage,
    });
  }

  /** Sample `N = h - H` in metres using bilinear interpolation. */
  sampleUndulation(longitude: number, latitude: number): number {
    const { gridId, height } = this;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      fail("outside-grid-coverage", "Grid lookup longitude and latitude must be finite", gridId);
    }
    if (latitude < -90 || latitude > 90) {
      fail("outside-grid-coverage", `Latitude ${latitude} is outside [-90, 90]`, gridId);
    }
    const y = (latitude - this.latitudeOrigin) / this.latitudeStep;
    const row = this.resolveBoundedAxis(y, height, "latitude");
    const x = this.resolveLongitudeColumn(longitude);
    const column = x.lower;
    const row0 = row.lower;
    const row1 = row.upper;
    const column0 = column;
    const column1 = x.upper;
    const { fraction: xFraction } = x;
    const { fraction: yFraction } = row;
    const weightedCells = [
      { row: row0, column: column0, weight: (1 - xFraction) * (1 - yFraction) },
      { row: row0, column: column1, weight: xFraction * (1 - yFraction) },
      { row: row1, column: column0, weight: (1 - xFraction) * yFraction },
      { row: row1, column: column1, weight: xFraction * yFraction },
    ];
    let result = 0;
    for (const cell of weightedCells) {
      // At exact cell boundaries, an adjacent zero-weight NoData sample does
      // not contribute to the interpolation and must not invalidate a valid
      // grid node.
      if (cell.weight !== 0) {
        result += this.valueAt(cell.row, cell.column) * cell.weight;
      }
    }
    if (!Number.isFinite(result)) {
      fail("grid-format", "Bilinear interpolation produced a non-finite geoid undulation", gridId);
    }
    return result;
  }

  /** Apply h = H + N or its explicitly requested inverse, in metres. */
  transformHeight(
    heightMeters: number,
    longitude: number,
    latitude: number,
    direction: VerticalHeightDirection,
  ): number {
    if (!Number.isFinite(heightMeters)) {
      fail("grid-format", "Height supplied to the vertical transform must be finite", this.gridId);
    }
    if (direction !== "orthometric-to-ellipsoidal" && direction !== "ellipsoidal-to-orthometric") {
      fail("unsupported-direction", `Unsupported vertical transform direction: ${String(direction)}`, this.gridId);
    }
    const undulation = this.sampleUndulation(longitude, latitude);
    const output = direction === "orthometric-to-ellipsoidal"
      ? heightMeters + undulation
      : heightMeters - undulation;
    if (!Number.isFinite(output)) {
      fail("grid-format", "Vertical transform produced a non-finite height", this.gridId);
    }
    return output;
  }

  /** Check that source COPC WKT explicitly names the configured vertical CRS. */
  assertCompatibleSourceWkt(wkt: string | undefined): void {
    if (!wkt) {
      fail("missing-vertical-crs", "A requested geoid transform requires COPC WKT with an explicit vertical CRS", this.gridId);
    }
    let identity: VerticalCrsIdentity | undefined;
    try {
      identity = getVerticalCrsIdentity(wkt);
    } catch {
      fail("invalid-grid-metadata", "COPC WKT has a malformed vertical CRS definition", this.gridId);
    }
    if (!identity) {
      fail("missing-vertical-crs", "COPC WKT does not declare a supported VERT_CS or VERTCRS", this.gridId);
    }
    let verticalUnitScale: number | undefined;
    try {
      verticalUnitScale = extractExplicitVerticalUnitScale(wkt);
    } catch {
      fail("invalid-grid-metadata", "COPC vertical CRS has an invalid unit declaration", this.gridId);
    }
    if (verticalUnitScale === undefined) {
      fail(
        "unsupported-crs-pair",
        "The requested vertical conversion requires a WKT1 VERT_CS with an explicit vertical unit; no unit is assumed",
        this.gridId,
      );
    }
    const configuredEpsg = normalizeEpsg(this.sourceVerticalCrs);
    const matches = configuredEpsg
      ? identity.authority?.toUpperCase() === "EPSG" && identity.code === configuredEpsg.slice(5)
      : identity.name === this.sourceVerticalCrs;
    if (!matches) {
      fail(
        "unsupported-crs-pair",
        `COPC vertical CRS ${identity.authority ? `${identity.authority}:${identity.code}` : identity.name} does not match configured sourceVerticalCrs ${this.sourceVerticalCrs}`,
        this.gridId,
      );
    }
    let horizontalWkt: string;
    try {
      horizontalWkt = extractHorizontalCrsWkt(wkt);
    } catch {
      fail("incompatible-reference-frame", "COPC WKT must declare a supported horizontal CRS for grid sampling", this.gridId);
    }
    const horizontalDatum = horizontalWkt.match(/DATUM\s*\[\s*"([^"]+)"/i)?.[1];
    const horizontalEllipsoid = horizontalWkt.match(
      /SPHEROID\s*\[\s*"[^"]+"\s*,\s*([+-]?[\d.]+(?:e[+-]?\d+)?)\s*,\s*([+-]?[\d.]+(?:e[+-]?\d+)?)/i,
    );
    const semiMajorAxis = horizontalEllipsoid ? Number(horizontalEllipsoid[1]) : NaN;
    const inverseFlattening = horizontalEllipsoid ? Number(horizontalEllipsoid[2]) : NaN;
    if (
      !horizontalDatum ||
      !/^(?:WGS_1984|WGS 84|World Geodetic System 1984)$/i.test(horizontalDatum) ||
      !near(semiMajorAxis, 6378137, 1e-6) ||
      !near(inverseFlattening, 298.257223563, 1e-9)
    ) {
      fail(
        "incompatible-reference-frame",
        "The grid path currently requires a source horizontal CRS explicitly based on the WGS 84 datum and ellipsoid; other frames need a verified transformation first",
        this.gridId,
      );
    }
    if ((identity.dynamic || /(?:^|,)\s*DYNAMIC\s*\[|FRAMEEPOCH\s*\[/i.test(wkt)) && !this.#hasMatchedEpoch) {
      fail(
        "missing-epoch",
        "Dynamic source CRS metadata requires matching sourceCoordinateEpoch and gridReferenceEpoch",
        this.gridId,
      );
    }
  }

  /**
   * Validate the source CRS and return its explicit conversion factor to
   * metres. Grid-backed transforms must use this factor for forward and
   * inverse height operations rather than the legacy metre fallback.
   */
  getSourceVerticalUnitScale(wkt: string | undefined): number {
    this.assertCompatibleSourceWkt(wkt);
    const scale = wkt ? extractExplicitVerticalUnitScale(wkt) : undefined;
    if (scale === undefined) {
      fail(
        "unsupported-crs-pair",
        "The requested vertical conversion requires an explicit WKT1 vertical unit",
        this.gridId,
      );
    }
    return scale;
  }

  private resolveBoundedAxis(
    coordinate: number,
    size: number,
    axis: "latitude" | "longitude",
  ): { lower: number; upper: number; fraction: number } {
    const tolerance = Math.max(1e-9, size * 1e-10);
    let bounded = coordinate;
    if (bounded < 0 && bounded >= -tolerance) bounded = 0;
    if (bounded > size - 1 && bounded <= size - 1 + tolerance) bounded = size - 1;
    if (bounded < 0 || bounded > size - 1) {
      fail("outside-grid-coverage", `${axis} is outside GTX coverage`, this.gridId);
    }
    const lower = Math.min(Math.floor(bounded), size - 2);
    return {
      lower,
      upper: lower + 1,
      fraction: bounded - lower,
    };
  }

  private resolveLongitudeColumn(longitude: number): {
    lower: number;
    upper: number;
    fraction: number;
  } {
    const { width, longitudeOrigin, longitudeStep } = this;
    const globalLongitudeCoverage = this.#globalLongitudeCoverage;
    if (globalLongitudeCoverage !== "none") {
      const uniqueColumnCount = globalLongitudeCoverage === "duplicated-seam" ? width - 1 : width;
      const wrapped = ((longitude - longitudeOrigin) % 360 + 360) % 360;
      const position = wrapped / longitudeStep;
      const lower = Math.min(Math.floor(position), uniqueColumnCount - 1);
      const fraction = position - lower;
      return {
        lower,
        upper: (lower + 1) % uniqueColumnCount,
        fraction,
      };
    }

    const maximum = longitudeOrigin + (width - 1) * longitudeStep;
    let candidate: number | undefined;
    for (let turn = -2; turn <= 2; turn += 1) {
      const value = longitude + turn * 360;
      if (value >= longitudeOrigin - 1e-9 && value <= maximum + 1e-9) {
        candidate = value;
        break;
      }
    }
    if (candidate === undefined) {
      fail("outside-grid-coverage", `Longitude ${longitude} is outside GTX coverage`, this.gridId);
    }
    const position = (candidate - longitudeOrigin) / longitudeStep;
    const bounded = this.resolveBoundedAxis(position, width, "longitude");
    return bounded;
  }

  private valueAt(row: number, column: number): number {
    const index = row * this.width + column;
    const value = this.#values[index];
    if (
      !Number.isFinite(value) ||
      (this.#noDataValue !== undefined && value === this.#noDataValue)
    ) {
      fail("grid-nodata", `GTX cell (${column}, ${row}) is NoData or non-finite`, this.gridId);
    }
    const metres = value * this.#metresPerGridUnit;
    if (!Number.isFinite(metres)) {
      fail("grid-format", `GTX cell (${column}, ${row}) is outside the supported numeric range`, this.gridId);
    }
    return metres;
  }
}

/** Load an offline GTX file, verify its digest and decode its geoid values. */
export async function loadGtxGeoidGrid(
  source: VerticalGridBytes,
  options: GtxGeoidGridOptions,
): Promise<GtxGeoidGrid> {
  return GtxGeoidGrid.load(source, options);
}

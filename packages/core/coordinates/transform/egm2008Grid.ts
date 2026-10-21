import {
  createVerifiedGeoidGrid,
  GtxGeoidGrid,
  VerticalTransformError,
  type GtxGeoidGridOptions,
  type VerifiedGeoidGridData,
  type VerticalGridBytes,
} from "./verticalGrid";

/** Resource and integrity settings for the pinned NGA EGM2008 grid. */
export type NgaEgm2008GridOptions = {
  /** Maximum encoded and decoded grid size in bytes. Defaults to 256 MiB. */
  maxGridBytes?: number;
};

const DEFAULT_MAX_GRID_BYTES = 256 * 1024 * 1024;
const HARD_MAX_GRID_BYTES = 512 * 1024 * 1024;
const NGA_EGM2008_ROWS = 4321;
const NGA_EGM2008_COLUMNS = 8640;
const NGA_EGM2008_ROW_SAMPLES_BYTES = NGA_EGM2008_COLUMNS * 4;
const NGA_EGM2008_RECORD_BYTES = NGA_EGM2008_ROW_SAMPLES_BYTES + 8;
const NGA_EGM2008_FILE_BYTES = NGA_EGM2008_ROWS * NGA_EGM2008_RECORD_BYTES;
const NGA_EGM2008_ROWS_PER_CHUNK = 16;
// Calculated from the raw member in NGA's official interpolation ZIP acquired
// on 2026-10-22. NGA does not publish a separate checksum for this file.
const NGA_EGM2008_EXPECTED_SHA256 =
  "ab6f8b94076f78707d1cdae7b066b93a786a0c64b52449e20cf1a1a2f4e74daf";
const NGA_EGM2008_GRID_ID =
  "NGA EGM2008 2.5-minute WGS 84 Tide-Free small-endian grid";
const MINIMUM_GRID_LIMIT = 40 + 2 * 2 * 4;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/** @internal Process source rows in bounded chunks and yield between chunks. */
export async function processNgaEgm2008Rows(
  rowCount: number,
  processRow: (row: number) => void,
  yieldTask: () => Promise<void> = yieldToEventLoop,
): Promise<void> {
  for (let row = 0; row < rowCount; row += 1) {
    processRow(row);
    if ((row + 1) % NGA_EGM2008_ROWS_PER_CHUNK === 0 && row + 1 < rowCount) {
      await yieldTask();
    }
  }
}

function fail(
  code: ConstructorParameters<typeof VerticalTransformError>[0],
  message: string,
): never {
  throw new VerticalTransformError(code, message, NGA_EGM2008_GRID_ID);
}

function validateLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < MINIMUM_GRID_LIMIT ||
    limit > HARD_MAX_GRID_BYTES
  ) {
    fail(
      "resource-limit",
      `maxGridBytes must be an integer between ${MINIMUM_GRID_LIMIT} and ${HARD_MAX_GRID_BYTES}`,
    );
  }
}

async function readNgaGridBytes(
  source: VerticalGridBytes,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    if (source.size > maxBytes) {
      fail("resource-limit", `Grid file exceeds the ${maxBytes}-byte encoded limit`);
    }
    return new Uint8Array(await source.arrayBuffer());
  }
  if (source instanceof ArrayBuffer) {
    if (source.byteLength > maxBytes) {
      fail("resource-limit", `Grid buffer exceeds the ${maxBytes}-byte encoded limit`);
    }
    return new Uint8Array(source).slice();
  }
  if (ArrayBuffer.isView(source)) {
    if (source.byteLength > maxBytes) {
      fail("resource-limit", `Grid view exceeds the ${maxBytes}-byte encoded limit`);
    }
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  fail(
    "missing-grid",
    "Provide the extracted NGA grid as a local Blob/File, ArrayBuffer, or typed-array view",
  );
}

async function digestNgaGrid(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    fail(
      "integrity-unavailable",
      "SHA-256 verification requires Web Crypto; use HTTPS, localhost, or a runtime with crypto.subtle",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function createNgaGridOptions(maxGridBytes: number): GtxGeoidGridOptions {
  return {
    gridId: NGA_EGM2008_GRID_ID,
    sourceVerticalCrs: "EPSG:3855",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: NGA_EGM2008_EXPECTED_SHA256,
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    interpolation: "bilinear",
    noDataValue: null,
    maxGridBytes,
  };
}

/**
 * Load NGA's official EGM2008 2.5-minute small-endian grid member from local
 * bytes and prepare it for the explicit EPSG:3855 → EPSG:4979 conversion.
 *
 * The source must be the extracted raw
 * `Und_min2.5x2.5_egm2008_isw=82_WGS84_TideFree_SE` member from NGA's
 * interpolation ZIP. The loader verifies the pinned file digest, exact size,
 * record markers, and finite samples. It does not fetch or persist grid data.
 *
 * NGA stores rows north-to-south as little-endian float32 values, with a
 * little-endian Fortran record-length marker before and after each row. The
 * sampler stores rows south-to-north, so decoding reverses row order once.
 * The supported profile fixes WGS 84 longitude/latitude sampling, metres,
 * `h - H` undulation, no NoData sentinel, and bilinear interpolation.
 *
 * @param source Extracted raw grid file as a local File/Blob, ArrayBuffer, or view.
 * @param options Optional memory cap for the encoded and decoded grid.
 * @returns A shared geoid grid using the pinned EGM2008 profile.
 * @throws {VerticalTransformError} When the file digest, layout, or resource
 * limits are invalid.
 */
export async function loadNgaEgm2008Grid(
  source: VerticalGridBytes,
  options: NgaEgm2008GridOptions = {},
): Promise<GtxGeoidGrid> {
  if (!options || typeof options !== "object") {
    fail("invalid-grid-metadata", "EGM2008 loader options must be an object");
  }
  const maxGridBytes = options.maxGridBytes ?? DEFAULT_MAX_GRID_BYTES;
  validateLimit(maxGridBytes);
  const bytes = await readNgaGridBytes(source, maxGridBytes);
  if (bytes.byteLength !== NGA_EGM2008_FILE_BYTES) {
    fail(
      "grid-format",
      `Expected the ${NGA_EGM2008_ROWS} × ${NGA_EGM2008_COLUMNS} NGA EGM2008 sequential grid (${NGA_EGM2008_FILE_BYTES} bytes); received ${bytes.byteLength} bytes`,
    );
  }

  const actualDigest = await digestNgaGrid(bytes);
  if (actualDigest !== NGA_EGM2008_EXPECTED_SHA256) {
    fail(
      "grid-integrity",
      `SHA-256 mismatch for ${NGA_EGM2008_GRID_ID}: expected ${NGA_EGM2008_EXPECTED_SHA256}, received ${actualDigest}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(NGA_EGM2008_ROWS * NGA_EGM2008_COLUMNS);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  await processNgaEgm2008Rows(NGA_EGM2008_ROWS, (sourceRow) => {
    const recordOffset = sourceRow * NGA_EGM2008_RECORD_BYTES;
    const leadingMarker = view.getUint32(recordOffset, true);
    const trailingMarker = view.getUint32(
      recordOffset + NGA_EGM2008_RECORD_BYTES - 4,
      true,
    );
    if (
      leadingMarker !== NGA_EGM2008_ROW_SAMPLES_BYTES ||
      trailingMarker !== NGA_EGM2008_ROW_SAMPLES_BYTES
    ) {
      fail(
        "grid-format",
        `Invalid little-endian Fortran record markers in EGM2008 row ${sourceRow}`,
      );
    }

    const targetRow = NGA_EGM2008_ROWS - 1 - sourceRow;
    const rowValuesOffset = recordOffset + 4;
    const targetRowOffset = targetRow * NGA_EGM2008_COLUMNS;
    for (let column = 0; column < NGA_EGM2008_COLUMNS; column += 1) {
      const value = view.getFloat32(rowValuesOffset + column * 4, true);
      if (!Number.isFinite(value)) {
        fail(
          "grid-format",
          `Non-finite EGM2008 undulation at row ${sourceRow}, column ${column}`,
        );
      }
      values[targetRowOffset + column] = value;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  });

  const gridData: VerifiedGeoidGridData = {
    options: createNgaGridOptions(maxGridBytes),
    sha256: actualDigest,
    width: NGA_EGM2008_COLUMNS,
    height: NGA_EGM2008_ROWS,
    longitudeOrigin: 0,
    latitudeOrigin: -90,
    longitudeStep: 2.5 / 60,
    latitudeStep: 2.5 / 60,
    values,
    encodedByteLength: bytes.byteLength,
    minimumUndulationMeters: minimum,
    maximumUndulationMeters: maximum,
    globalLongitudeCoverage: "periodic",
  };
  return createVerifiedGeoidGrid(gridData);
}

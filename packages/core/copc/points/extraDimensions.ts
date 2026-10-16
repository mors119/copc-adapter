import type { CopcExtraDimensionReader } from '../types/copc';

/** Names of extra schema dimensions to read per point, or `'*'` for every non-standard one. */
export type CopcExtraDimensionSelection = readonly string[] | '*';

/** The point-view surface needed to read extra dimensions. */
export type ExtraDimensionSourceView = {
  dimensions: Record<string, unknown>;
  getter(name: string): (index: number) => number;
};

/** Decoded LAS point records plus the layout needed to read 64-bit extra bytes exactly. */
export type ExtraDimensionRawPoints = {
  data: Uint8Array;
  header: { pointDataRecordFormat: number; pointDataRecordLength: number };
  extraBytes: readonly {
    name: string;
    type?: string;
    length: number;
    scale?: number;
    offset?: number;
  }[];
};

/** Dimensions defined by the LAS point data record formats rather than by extra bytes. */
const STANDARD_DIMENSIONS: ReadonlySet<string> = new Set([
  'X',
  'Y',
  'Z',
  'Intensity',
  'ReturnNumber',
  'NumberOfReturns',
  'ScanDirectionFlag',
  'EdgeOfFlightLine',
  'Classification',
  'Synthetic',
  'KeyPoint',
  'Withheld',
  'Overlap',
  'ScanAngle',
  'ScanAngleRank',
  'UserData',
  'PointSourceId',
  'GpsTime',
  'Red',
  'Green',
  'Blue',
  'Infrared',
  'ScannerChannel',
]);

/** Point record sizes excluding extra bytes, by LAS point data record format. */
const BASE_POINT_RECORD_LENGTH: Readonly<Record<number, number>> = {
  0: 20,
  1: 28,
  2: 26,
  3: 34,
  6: 30,
  7: 36,
  8: 38,
};

function resolveRequestedNames(
  view: ExtraDimensionSourceView,
  selection: CopcExtraDimensionSelection,
): string[] {
  const available = Object.keys(view.dimensions);
  const names = selection === '*'
    ? available.filter((name) => !STANDARD_DIMENSIONS.has(name))
    : selection.filter((name) => available.includes(name));

  return [...new Set(names)];
}

/**
 * copc.js narrows 64-bit integers to a double and throws once a value exceeds
 * `Number.MAX_SAFE_INTEGER`, which identifier-style dimensions routinely do.
 * Read those straight from the decoded record so they stay exact.
 */
function createExactInt64Reader(
  raw: ExtraDimensionRawPoints,
  name: string,
): CopcExtraDimensionReader | undefined {
  const base = BASE_POINT_RECORD_LENGTH[raw.header.pointDataRecordFormat];
  if (base === undefined) {
    return undefined;
  }

  let fieldOffset = base;
  for (const extra of raw.extraBytes) {
    if (extra.name === name) {
      const isInteger = extra.type === 'signed' || extra.type === 'unsigned';
      const isUnscaled = (extra.scale === undefined || extra.scale === 1)
        && (extra.offset === undefined || extra.offset === 0);
      if (extra.length !== 8 || !isInteger || !isUnscaled) {
        return undefined;
      }

      const recordLength = raw.header.pointDataRecordLength;
      const view = new DataView(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
      const unsigned = extra.type === 'unsigned';
      return {
        valueType: unsigned ? 'uint64' : 'int64',
        read: (index) => {
          const position = index * recordLength + fieldOffset;
          return unsigned
            ? view.getBigUint64(position, true)
            : view.getBigInt64(position, true);
        },
      };
    }
    fieldOffset += extra.length;
  }

  return undefined;
}

/** Create readers for the requested extra dimensions that exist in the decoded view. */
export function createExtraDimensionReaders(
  view: ExtraDimensionSourceView,
  selection: CopcExtraDimensionSelection,
  raw?: ExtraDimensionRawPoints,
): Map<string, CopcExtraDimensionReader> {
  const readers = new Map<string, CopcExtraDimensionReader>();

  for (const name of resolveRequestedNames(view, selection)) {
    const exact = raw ? createExactInt64Reader(raw, name) : undefined;
    if (exact) {
      readers.set(name, exact);
      continue;
    }

    const getter = view.getter(name);
    readers.set(name, { valueType: 'float64', read: (index) => getter(index) });
  }

  return readers;
}

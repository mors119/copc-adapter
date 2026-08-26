import { loadCopcWasm } from '../wasm/copcWasm';
import type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcHierarchySubtree,
} from './hierarchy/types';
import type { CopcMetadata } from './types/copc';
import type { RandomAccessByteSource } from './range/types';

const INITIAL_LAS_HEADER_LENGTH = 375;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_HIERARCHY_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

type RustHeaderValue = {
  version_major: number;
  version_minor: number;
  point_data_record_format: number;
  point_data_record_length: number;
  point_count: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bounds: [number, number, number, number, number, number];
  cube: [number, number, number, number, number, number];
  spacing: number;
  root_hierarchy_page_offset: number;
  root_hierarchy_page_length: number;
  wkt?: string;
};

type RustHierarchyValue = {
  entry_count: number;
  nodes: Array<{
    level: number;
    x: number;
    y: number;
    z: number;
    point_data_offset: number;
    point_data_length: number;
    point_count: number;
  }>;
  pages: Array<{
    level: number;
    x: number;
    y: number;
    z: number;
    page_offset: number;
    page_length: number;
  }>;
};

type RustParserResponse<T> = {
  ok: boolean;
  value?: T;
  error?: {
    code: string;
    message: string;
  };
};

export type RustCopcParseErrorCode =
  | 'invalid-input'
  | 'truncated'
  | 'invalid-header'
  | 'unsupported-value'
  | 'invalid-value'
  | 'missing-copc-info'
  | 'malformed-copc-info'
  | 'malformed-wkt'
  | 'invalid-hierarchy'
  | 'overflow'
  | string;

/** Structured validation failure returned by the Rust COPC parser. */
export class RustCopcParseError extends Error {
  readonly code: RustCopcParseErrorCode;

  constructor(code: RustCopcParseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RustCopcParseError';
    this.code = code;
  }
}

export type RustCopcHeader = RustHeaderValue;

function requireSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_INTEGER) {
    throw new RustCopcParseError(
      'unsupported-value',
      `${name} is not a non-negative JavaScript-safe integer`,
    );
  }
  return value;
}

function requirePositiveSafeInteger(value: number, name: string): number {
  const checked = requireSafeInteger(value, name);
  if (checked === 0) {
    throw new RustCopcParseError('invalid-value', `${name} must be positive`);
  }
  return checked;
}

function requireHierarchyPageLength(value: number): number {
  const checked = requirePositiveSafeInteger(value, 'hierarchy page length');
  if (checked > MAX_HIERARCHY_PAGE_BYTES) {
    throw new RustCopcParseError(
      'unsupported-value',
      `hierarchy page exceeds the ${MAX_HIERARCHY_PAGE_BYTES}-byte safety limit`,
    );
  }
  return checked;
}

function readCString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  if (end === bytes.length) {
    throw new RustCopcParseError('invalid-input', 'Rust parser returned an unterminated response');
  }
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}

async function parseWithRust<T>(
  bytes: Uint8Array,
  parse: (wasm: Awaited<ReturnType<typeof loadCopcWasm>>, pointer: number, length: number) => number,
): Promise<T> {
  const wasm = await loadCopcWasm();
  const inputPointer = wasm.alloc_bytes(bytes.byteLength);
  new Uint8Array(wasm.memory.buffer, inputPointer, bytes.byteLength).set(bytes);

  try {
    const responsePointer = parse(wasm, inputPointer, bytes.byteLength);
    try {
      const response = JSON.parse(readCString(wasm.memory, responsePointer)) as RustParserResponse<T>;
      if (!response.ok || response.value === undefined) {
        throw new RustCopcParseError(
          response.error?.code ?? 'invalid-input',
          response.error?.message ?? 'Rust parser returned an invalid error response',
        );
      }
      return response.value;
    } finally {
      wasm.free_parser_json(responsePointer);
    }
  } finally {
    wasm.dealloc_bytes(inputPointer, bytes.byteLength);
  }
}

function headerLayout(initialBytes: Uint8Array): { headerSize: number; pointDataOffset: number } {
  if (initialBytes.byteLength < INITIAL_LAS_HEADER_LENGTH) {
    throw new RustCopcParseError(
      'truncated',
      `LAS header requires ${INITIAL_LAS_HEADER_LENGTH} bytes, received ${initialBytes.byteLength}`,
    );
  }
  const view = new DataView(initialBytes.buffer, initialBytes.byteOffset, initialBytes.byteLength);
  const headerSize = view.getUint16(94, true);
  const pointDataOffset = view.getUint32(96, true);
  if (headerSize < INITIAL_LAS_HEADER_LENGTH) {
    throw new RustCopcParseError('invalid-header', `LAS header size ${headerSize} is too small`);
  }
  if (pointDataOffset < headerSize) {
    throw new RustCopcParseError('invalid-header', 'point data offset precedes the LAS header');
  }
  if (pointDataOffset > MAX_METADATA_BYTES) {
    throw new RustCopcParseError(
      'unsupported-value',
      `LAS metadata area exceeds the ${MAX_METADATA_BYTES}-byte safety limit`,
    );
  }
  return { headerSize, pointDataOffset };
}

function key(level: number, x: number, y: number, z: number): string {
  return `${level}-${x}-${y}-${z}`;
}

function toHierarchySubtree(value: RustHierarchyValue): CopcHierarchySubtree {
  return {
    nodes: value.nodes.map((node): CopcHierarchyNode => ({
      key: key(node.level, node.x, node.y, node.z),
      level: node.level,
      x: node.x,
      y: node.y,
      z: node.z,
      pointCount: requireSafeInteger(node.point_count, 'hierarchy point count'),
      pointDataOffset: requireSafeInteger(node.point_data_offset, 'point data offset'),
      pointDataLength: requireSafeInteger(node.point_data_length, 'point data length'),
    })),
    pages: value.pages.map((page): CopcHierarchyPage => ({
      key: key(page.level, page.x, page.y, page.z),
      pageOffset: requireSafeInteger(page.page_offset, 'hierarchy page offset'),
      pageLength: requireHierarchyPageLength(page.page_length),
    })),
  };
}

/**
 * Header/root reader backed by the project-owned random-access source.
 * TypeScript owns I/O; Rust only validates and interprets COPC bytes.
 */
export class RustCopcReader {
  readonly source: string;
  readonly header: RustCopcHeader;
  private readonly byteSource: RandomAccessByteSource;

  private constructor(byteSource: RandomAccessByteSource, header: RustCopcHeader) {
    this.byteSource = byteSource;
    this.source = byteSource.source;
    this.header = header;
  }

  static async open(byteSource: RandomAccessByteSource): Promise<RustCopcReader> {
    const initialBytes = await byteSource.readRange(0, INITIAL_LAS_HEADER_LENGTH);
    const { pointDataOffset } = headerLayout(initialBytes);
    const metadataBytes = pointDataOffset <= initialBytes.byteLength
      ? initialBytes.slice(0, pointDataOffset)
      : await byteSource.readRange(0, pointDataOffset);
    const header = await parseWithRust<RustCopcHeader>(
      metadataBytes,
      (wasm, pointer, length) => wasm.parse_copc_header_json(pointer, length),
    );
    return new RustCopcReader(byteSource, header);
  }

  getMetadata(): CopcMetadata {
    const { bounds, cube, scale, offset } = this.header;
    return {
      pointCount: requireSafeInteger(this.header.point_count, 'point count'),
      bounds: {
        minX: bounds[0], minY: bounds[1], minZ: bounds[2],
        maxX: bounds[3], maxY: bounds[4], maxZ: bounds[5],
      },
      spacing: this.header.spacing,
      scale: { x: scale[0], y: scale[1], z: scale[2] },
      offset: { x: offset[0], y: offset[1], z: offset[2] },
      cube: {
        minX: cube[0], minY: cube[1], minZ: cube[2],
        maxX: cube[3], maxY: cube[4], maxZ: cube[5],
      },
      wkt: this.header.wkt,
    };
  }

  getRootHierarchyPage(): CopcHierarchyPage {
    return {
      key: '0-0-0-0',
      pageOffset: requireSafeInteger(
        this.header.root_hierarchy_page_offset,
        'root hierarchy page offset',
      ),
      pageLength: requireHierarchyPageLength(
        this.header.root_hierarchy_page_length,
      ),
    };
  }

  async loadHierarchyPage(page: CopcHierarchyPage): Promise<CopcHierarchySubtree> {
    const pageOffset = requireSafeInteger(page.pageOffset, 'hierarchy page offset');
    const pageLength = requireHierarchyPageLength(page.pageLength);
    const end = pageOffset + pageLength;
    if (!Number.isSafeInteger(end)) {
      throw new RustCopcParseError('overflow', 'hierarchy page range exceeds JavaScript-safe integers');
    }
    const bytes = await this.byteSource.readRange(pageOffset, pageLength);
    return toHierarchySubtree(await parseWithRust(
      bytes,
      (wasm, pointer, length) => wasm.parse_root_hierarchy_json(pointer, length),
    ));
  }

  async loadRootHierarchy(): Promise<CopcHierarchySubtree> {
    return this.loadHierarchyPage(this.getRootHierarchyPage());
  }
}

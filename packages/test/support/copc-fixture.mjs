const HEADER_SIZE = 375;
const COPC_INFO_SIZE = 160;
const ROOT_PAGE_OFFSET = 1024;
const CHILD_PAGE_OFFSET = 2048;

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function putU16(bytes, offset, value) {
  dataView(bytes).setUint16(offset, value, true);
}

function putU32(bytes, offset, value) {
  dataView(bytes).setUint32(offset, value, true);
}

function putI32(bytes, offset, value) {
  dataView(bytes).setInt32(offset, value, true);
}

function putU64(bytes, offset, value) {
  dataView(bytes).setBigUint64(offset, BigInt(value), true);
}

function putF64(bytes, offset, value) {
  dataView(bytes).setFloat64(offset, value, true);
}

function putVlr(bytes, offset, userId, recordId, payload) {
  const encodedUserId = new TextEncoder().encode(userId);
  bytes.set(encodedUserId.subarray(0, 16), offset + 2);
  putU16(bytes, offset + 18, recordId);
  putU16(bytes, offset + 20, payload.length);
  bytes.set(payload, offset + 54);
  return offset + 54 + payload.length;
}

function putHierarchyEntry(bytes, offset, { level, x, y, z, byteOffset, byteLength, pointCount }) {
  putI32(bytes, offset, level);
  putI32(bytes, offset + 4, x);
  putI32(bytes, offset + 8, y);
  putI32(bytes, offset + 12, z);
  putU64(bytes, offset + 16, byteOffset);
  putI32(bytes, offset + 24, byteLength);
  putI32(bytes, offset + 28, pointCount);
}

/**
 * Small, generated LAS 1.4/COPC bytes used for parser, hierarchy, range, and
 * error tests. It intentionally has no LASzip VLR or valid point chunks.
 * Point decoding is covered against the downloaded Autzen integration sample.
 */
export function createDeterministicCopcFixture({ rootPageLength = 96 } = {}) {
  const copcPayload = new Uint8Array(COPC_INFO_SIZE);
  putF64(copcPayload, 0, 50);
  putF64(copcPayload, 8, 60);
  putF64(copcPayload, 16, 70);
  putF64(copcPayload, 24, 10);
  putF64(copcPayload, 32, 2.5);
  putU64(copcPayload, 40, ROOT_PAGE_OFFSET);
  putU64(copcPayload, 48, rootPageLength);

  const wkt = new TextEncoder().encode('PROJCS["Fixture CRS"]\0');
  const pointDataOffset = HEADER_SIZE + 54 + COPC_INFO_SIZE + 54 + wkt.length;
  const bytes = new Uint8Array(CHILD_PAGE_OFFSET + 64);
  bytes.set(new TextEncoder().encode('LASF'), 0);
  bytes[24] = 1;
  bytes[25] = 4;
  putU16(bytes, 94, HEADER_SIZE);
  putU32(bytes, 96, pointDataOffset);
  putU32(bytes, 100, 2);
  bytes[104] = 0x86;
  putU16(bytes, 105, 30);
  putU64(bytes, 247, 42);
  putF64(bytes, 131, 0.01);
  putF64(bytes, 139, 0.02);
  putF64(bytes, 147, 0.03);
  putF64(bytes, 155, 10);
  putF64(bytes, 163, 20);
  putF64(bytes, 171, 30);
  putF64(bytes, 179, 100);
  putF64(bytes, 187, 1);
  putF64(bytes, 195, 200);
  putF64(bytes, 203, 2);
  putF64(bytes, 211, 300);
  putF64(bytes, 219, 3);

  let nextVlr = putVlr(bytes, HEADER_SIZE, 'copc', 1, copcPayload);
  putVlr(bytes, nextVlr, 'LASF_Projection', 2112, wkt);

  putHierarchyEntry(bytes, ROOT_PAGE_OFFSET, {
    level: 0, x: 0, y: 0, z: 0, byteOffset: 1200, byteLength: 10, pointCount: 100,
  });
  putHierarchyEntry(bytes, ROOT_PAGE_OFFSET + 32, {
    level: 1, x: 0, y: 0, z: 0, byteOffset: 1300, byteLength: 20, pointCount: 60,
  });
  putHierarchyEntry(bytes, ROOT_PAGE_OFFSET + 64, {
    level: 1, x: 1, y: 0, z: 0, byteOffset: CHILD_PAGE_OFFSET, byteLength: 64, pointCount: -1,
  });

  putHierarchyEntry(bytes, CHILD_PAGE_OFFSET, {
    level: 1, x: 1, y: 0, z: 0, byteOffset: 1400, byteLength: 5, pointCount: 40,
  });
  putHierarchyEntry(bytes, CHILD_PAGE_OFFSET + 32, {
    level: 2, x: 3, y: 0, z: 0, byteOffset: 1500, byteLength: 6, pointCount: 20,
  });

  return {
    bytes,
    rootPage: { key: '0-0-0-0', pageOffset: ROOT_PAGE_OFFSET, pageLength: rootPageLength },
    childPage: { key: '1-1-0-0', pageOffset: CHILD_PAGE_OFFSET, pageLength: 64 },
    pointDataOffset,
  };
}

export function mutateU32(bytes, offset, value) {
  putU32(bytes, offset, value);
}

export function mutateU16(bytes, offset, value) {
  putU16(bytes, offset, value);
}

export function mutateU64(bytes, offset, value) {
  putU64(bytes, offset, value);
}

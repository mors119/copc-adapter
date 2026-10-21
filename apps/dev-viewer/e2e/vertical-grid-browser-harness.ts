import {
  loadGtxGeoidGrid,
  VerticalTransformError,
} from "@frillab/copc-adapter";

declare global {
  interface Window {
    __VERTICAL_GRID_BROWSER_SMOKE__?: () => Promise<{
      centerUndulationMeters: number;
      correctedHeightMeters: number;
      noDataCode: string;
    }>;
  }
}

window.__VERTICAL_GRID_BROWSER_SMOKE__ = async () => {
  const buffer = new ArrayBuffer(40 + 4 * 4);
  const header = new DataView(buffer);
  header.setFloat64(0, 0, false);
  header.setFloat64(8, 0, false);
  header.setFloat64(16, 1, false);
  header.setFloat64(24, 1, false);
  header.setInt32(32, 2, false);
  header.setInt32(36, 2, false);
  [10, 20, 30, 40].forEach((value, index) =>
    header.setFloat32(40 + index * 4, value, false),
  );
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const grid = await loadGtxGeoidGrid(blob, {
    gridId: "browser-synthetic-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256,
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
  });
  let noDataCode = "none";
  try {
    const badBytes = new ArrayBuffer(40 + 4 * 4);
    const bad = new DataView(badBytes);
    bad.setFloat64(0, 0, false);
    bad.setFloat64(8, 0, false);
    bad.setFloat64(16, 1, false);
    bad.setFloat64(24, 1, false);
    bad.setInt32(32, 2, false);
    bad.setInt32(36, 2, false);
    [10, -9999, 30, 40].forEach((value, index) =>
      bad.setFloat32(40 + index * 4, value, false),
    );
    const badBlob = new Blob([badBytes]);
    const badDigest = await crypto.subtle.digest(
      "SHA-256",
      await badBlob.arrayBuffer(),
    );
    const badGrid = await loadGtxGeoidGrid(badBlob, {
      gridId: "browser-synthetic-nodata-grid",
      sourceVerticalCrs: "Local orthometric height",
      targetVerticalCrs: "EPSG:4979",
      horizontalCrs: "EPSG:4326",
      referenceEllipsoid: "WGS84",
      sha256: [...new Uint8Array(badDigest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      valueUnit: "metre",
      valueConvention: "ellipsoidal-minus-orthometric",
      noDataValue: -9999,
    });
    badGrid.sampleUndulation(1, 0);
  } catch (error) {
    if (!(error instanceof VerticalTransformError)) throw error;
    noDataCode = error.code;
  }
  return {
    centerUndulationMeters: grid.sampleUndulation(0.5, 0.5),
    correctedHeightMeters: grid.transformHeight(
      100,
      0.5,
      0.5,
      "orthometric-to-ellipsoidal",
    ),
    noDataCode,
  };
};

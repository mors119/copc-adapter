import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractHorizontalCrsWkt,
  extractHorizontalUnitScale,
  extractHorizontalWkt,
  extractVerticalUnitScale,
} from "../../../../core/coordinates/crs/parseCopcWkt.ts";
import { transformPointBufferToPreparedPointData } from "../../../../core/coordinates/transform/createPointTransformer.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  testDirectory,
  "../../../../../crates/crs-audit/src/fixtures.json",
);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8")).fixtures;

test("CRS audit fixtures match the current horizontal WKT boundaries", () => {
  for (const fixture of fixtures.filter((entry) => entry.horizontal_wkt)) {
    assert.equal(
      extractHorizontalCrsWkt(fixture.wkt),
      fixture.horizontal_wkt,
      fixture.id,
    );
    if (/^(?:PROJCS|PROJCRS)\s*\[/i.test(fixture.horizontal_wkt)) {
      assert.equal(
        extractHorizontalWkt(fixture.wkt),
        fixture.horizontal_wkt,
        fixture.id,
      );
    }
    assert.equal(
      extractVerticalUnitScale(fixture.wkt),
      fixture.vertical_unit_scale,
      fixture.id,
    );
  }
});

test("EPSG:5186 WKT1 fixture is supported by the TypeScript adapter", () => {
  const fixture = fixtures.find(
    (entry) => entry.id === "epsg-5186-korean-central-belt-2010",
  );
  assert.ok(fixture);
  assert.equal(extractHorizontalWkt(fixture.wkt), fixture.wkt);
  assert.equal(
    extractVerticalUnitScale(fixture.wkt),
    fixture.vertical_unit_scale,
  );
});

test("projected extraction supports WKT1/WKT2 and rejects geographic fixtures", () => {
  const geographic = fixtures.find((entry) => entry.id === "wgs84-geographic-wkt1");
  const projectedWkt2 = fixtures.find((entry) => entry.id === "utm11-wkt2-projcrs");
  assert.ok(geographic);
  assert.ok(projectedWkt2);
  assert.equal(extractHorizontalWkt(projectedWkt2.wkt), projectedWkt2.wkt);
  assert.throws(() => extractHorizontalWkt(geographic.wkt), geographic.id);
});

test("prepares a valid WKT2 EPSG:4979 source in its latitude/longitude axis order", () => {
  const wkt =
    'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]],ID["EPSG",6326]],CS[ellipsoidal,3],AXIS["geodetic latitude (Lat)",north,ORDER[1],ANGLEUNIT["degree",0.0174532925199433]],AXIS["geodetic longitude (Lon)",east,ORDER[2],ANGLEUNIT["degree",0.0174532925199433]],AXIS["ellipsoidal height (h)",up,ORDER[3],LENGTHUNIT["metre",1]],ID["EPSG",4979]]';
  const metadata = {
    pointCount: 1,
    bounds: {
      minX: 44.5,
      minY: -122.5,
      minZ: 100,
      maxX: 44.5,
      maxY: -122.5,
      maxZ: 100,
    },
    cube: {
      minX: 44.5,
      minY: -122.5,
      minZ: 100,
      maxX: 44.5,
      maxY: -122.5,
      maxZ: 100,
    },
    wkt,
  };
  const points = {
    pointCount: 1,
    coordinates: new Float64Array([44.5, -122.5, 100]),
  };

  assert.equal(extractHorizontalCrsWkt(wkt), wkt);
  assert.ok(extractHorizontalUnitScale(wkt) > 100_000);

  const prepared = transformPointBufferToPreparedPointData(metadata, points);
  assert.deepEqual([...prepared.sourceCoordinates], [44.5, -122.5, 100]);
  assert.ok(Math.abs(prepared.coordinates[0] - -122.5) < 1e-9);
  assert.ok(Math.abs(prepared.coordinates[1] - 44.5) < 1e-9);
  assert.equal(prepared.coordinates[2], 100);
  assert.ok([...prepared.worldCoordinates].every(Number.isFinite));

  const withOffset = transformPointBufferToPreparedPointData(metadata, points, 7);
  assert.deepEqual([...withOffset.sourceCoordinates], [44.5, -122.5, 100]);
  assert.equal(withOffset.coordinates[2], 107);
});

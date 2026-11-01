import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCopcCrsMetadata } from "../../../../core/coordinates/crs/copcCrsMetadata.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const auditPath = path.resolve(testDirectory, "../../../../../../crates/crs-audit/src/fixtures.json");
const auditFixtures = JSON.parse(fs.readFileSync(auditPath, "utf8")).fixtures;

const WKT2_COMPOUND = 'COMPOUNDCRS["WGS 84 / UTM zone 11N + NAVD88 height",PROJCRS["WGS 84 / UTM zone 11N",BASEGEODCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]]],CONVERSION["UTM zone 11N",METHOD["Transverse Mercator"]],CS[Cartesian,2],AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",32611]],VERTCRS["NAVD88 height",VDATUM["North American Vertical Datum 1988",ID["EPSG",5103]],CS[vertical,1],AXIS["gravity-related height (H)",up,LENGTHUNIT["US survey foot",0.304800609601219]],ID["EPSG",6360]]]';
const UNKNOWN_LOCAL_VERTICAL = 'COMPD_CS["Local test CRS",PROJCS["Local grid",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["central_meridian",0],UNIT["foot",0.3048]],VERT_CS["Local height",VERT_DATUM["Local datum",2000],UNIT["metre",1]]]';
const CONTRADICTORY_IDENTIFIERS = 'PROJCS["Conflicting identifiers",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","1000"],AUTHORITY["EPSG","2000"]]';
const WGS84_3D = 'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]],ID["EPSG",6326]],CS[ellipsoidal,3],AXIS["geodetic latitude (Lat)",north,ORDER[1],ANGLEUNIT["degree",0.0174532925199433]],AXIS["geodetic longitude (Lon)",east,ORDER[2],ANGLEUNIT["degree",0.0174532925199433]],AXIS["ellipsoidal height (h)",up,ORDER[3],LENGTHUNIT["metre",1]],ID["EPSG",4979]]';
const CONTRADICTORY_UNIT = 'PROJCS["Conflicting unit",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["US survey foot",0.3048]]';
const PARTIAL_AXIS_UNIT = 'PROJCRS["Partial axis unit",BASEGEOGCRS["WGS 84",DATUM["WGS 84",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0],ANGLEUNIT["degree",0.0174532925199433]],CONVERSION["test",METHOD["Transverse Mercator"]],CS[Cartesian,2],AXIS["Easting",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["Northing",north,ORDER[2],LENGTHUNIT["bad",0]]]';
const CONFLICTING_VERTICAL_UNIT = 'VERTCRS["Gravity-related height",VDATUM["Test datum"],CS[vertical,1],AXIS["gravity-related height",up,LENGTHUNIT["metre",1]],LENGTHUNIT["foot",0.3048]]';
const INCONSISTENT_AXIS_UNITS = 'PROJCRS["Inconsistent axis units",BASEGEOGCRS["WGS 84",DATUM["WGS 84",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0],ANGLEUNIT["degree",0.0174532925199433]],CONVERSION["test",METHOD["Transverse Mercator"]],CS[Cartesian,2],AXIS["Easting",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["Northing",north,ORDER[2],LENGTHUNIT["foot",1]]]';

test("reports source CRS identities, explicit axes, and distinct foot definitions", () => {
  const autzen = auditFixtures.find((fixture) => fixture.id === "autzen-wkt1-compound-lcc");
  assert.ok(autzen);
  const diagnostic = resolveCopcCrsMetadata(autzen.wkt);

  assert.equal(diagnostic.wkt.format, "WKT1");
  assert.equal(diagnostic.wkt.metadataSupport, "supported");
  assert.deepEqual(diagnostic.horizontal.identity, {
    name: "NAD83 / Oregon GIC Lambert (ft)",
    authority: "EPSG",
    code: "2992",
    certainty: "explicit",
  });
  assert.equal(diagnostic.horizontal.axisOrder.order, "east-north");
  assert.equal(diagnostic.horizontal.units.standard, "international-foot");
  assert.equal(diagnostic.vertical.identity?.code, "6360");
  assert.equal(diagnostic.vertical.units.standard, "us-survey-foot");
  assert.equal(diagnostic.vertical.heightKind.value, "gravity-related/orthometric");
  assert.equal(diagnostic.vertical.heightKind.certainty, "explicit");
  assert.ok(diagnostic.evidence.some((item) => item.value === "EPSG:2992"));
  assert.deepEqual(autzen.las_header.bounds, {
    min: [635577.79, 848882.15, 406.14],
    max: [639003.73, 853537.66, 615.26],
  });
  assert.deepEqual(autzen.las_header.scale, [0.01, 0.01, 0.01]);
  assert.equal(autzen.las_header.offset[2], 510.7);
  assert.equal(autzen.las_header.vertical_unit, "US survey foot");
  assert.equal(autzen.las_header.vertical_unit_to_metres, 0.304800609601219);
  assert.equal(/FRAMEEPOCH|DYNAMIC\s*\[/i.test(autzen.wkt), false);
});

test("records WKT2 compound metadata while keeping transform support backend-dependent", () => {
  const diagnostic = resolveCopcCrsMetadata(WKT2_COMPOUND);

  assert.equal(diagnostic.wkt.format, "WKT2");
  assert.equal(diagnostic.wkt.metadataSupport, "supported");
  assert.equal(diagnostic.wkt.transformSupport, "backend-dependent");
  assert.equal(diagnostic.horizontal.identity?.code, "32611");
  assert.equal(diagnostic.horizontal.units.standard, "metre");
  assert.equal(diagnostic.horizontal.axisOrder.order, "east-north");
  assert.equal(diagnostic.vertical.identity?.code, "6360");
  assert.equal(diagnostic.vertical.units.standard, "us-survey-foot");
  assert.equal(diagnostic.vertical.heightKind.value, "gravity-related/orthometric");
});

test("does not guess a local vertical reference from units or horizontal coordinates", () => {
  const diagnostic = resolveCopcCrsMetadata(UNKNOWN_LOCAL_VERTICAL);

  assert.equal(diagnostic.vertical.units.standard, "metre");
  assert.equal(diagnostic.vertical.heightKind.value, "local/unknown");
  assert.equal(diagnostic.vertical.heightKind.certainty, "unknown");
  assert.ok(diagnostic.reasons.some((reason) => reason.code === "unknown-vertical-reference"));
});

test("reports missing, malformed, and contradictory source CRS metadata with stable reasons", () => {
  const missing = resolveCopcCrsMetadata(undefined);
  assert.equal(missing.wkt.metadataSupport, "missing");
  assert.equal(missing.vertical.heightKind.value, "local/unknown");
  assert.ok(missing.reasons.some((reason) => reason.code === "missing-wkt"));

  const malformed = resolveCopcCrsMetadata('PROJCS["broken"');
  assert.equal(malformed.wkt.metadataSupport, "malformed");
  assert.ok(malformed.reasons.some((reason) => reason.code === "malformed-wkt"));

  const contradictory = resolveCopcCrsMetadata(CONTRADICTORY_IDENTIFIERS);
  assert.equal(contradictory.horizontal.identity?.name, "Conflicting identifiers");
  assert.equal(contradictory.horizontal.identity?.code, undefined);
  assert.ok(contradictory.reasons.some((reason) => reason.code === "conflicting-identifiers"));

  const contradictoryUnit = resolveCopcCrsMetadata(CONTRADICTORY_UNIT);
  assert.equal(contradictoryUnit.horizontal.units.standard, "other");
  assert.ok(contradictoryUnit.reasons.some((reason) => reason.code === "inconsistent-unit-declaration"));
});

test("leaves horizontal units unknown when any declared axis unit is unresolvable", () => {
  const diagnostic = resolveCopcCrsMetadata(PARTIAL_AXIS_UNIT);

  assert.equal(diagnostic.horizontal.units.kind, "unknown");
  assert.equal(diagnostic.horizontal.units.name, undefined);
  assert.ok(diagnostic.reasons.some((reason) => reason.code === "unsupported-horizontal-unit"));
});

test("rejects a vertical axis unit that conflicts with the CRS-level unit", () => {
  const diagnostic = resolveCopcCrsMetadata(CONFLICTING_VERTICAL_UNIT);

  assert.equal(diagnostic.vertical.units.kind, "unknown");
  assert.ok(diagnostic.reasons.some((reason) => reason.code === "conflicting-axis-units"));
});

test("detects axis name and factor inconsistencies regardless of axis order", () => {
  const reversedAxes = INCONSISTENT_AXIS_UNITS.replace(
    'AXIS["Easting",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["Northing",north,ORDER[2],LENGTHUNIT["foot",1]]',
    'AXIS["Northing",north,ORDER[1],LENGTHUNIT["foot",1]],AXIS["Easting",east,ORDER[2],LENGTHUNIT["metre",1]]',
  );

  for (const wkt of [INCONSISTENT_AXIS_UNITS, reversedAxes]) {
    const diagnostic = resolveCopcCrsMetadata(wkt);

    assert.equal(diagnostic.horizontal.units.kind, "unknown");
    assert.ok(diagnostic.reasons.some((reason) => reason.code === "inconsistent-unit-declaration"));
  }
});

test("unknown WKT2 vertical systems remain unknown even with an explicit unit", () => {
  const fixture = auditFixtures.find((entry) => entry.id === "utm11-wkt2-projcrs");
  assert.ok(fixture);
  const diagnostic = resolveCopcCrsMetadata(fixture.wkt);

  assert.equal(diagnostic.wkt.format, "WKT2");
  assert.equal(diagnostic.vertical.heightKind.value, "local/unknown");
  assert.equal(diagnostic.vertical.heightKind.certainty, "unknown");
});

test("recognizes the Korean EPSG:5186 source identity without inventing a height datum", () => {
  const fixture = auditFixtures.find((entry) => entry.id === "epsg-5186-korean-central-belt-2010");
  assert.ok(fixture);
  const diagnostic = resolveCopcCrsMetadata(fixture.wkt);

  assert.equal(diagnostic.horizontal.identity?.code, "5186");
  assert.equal(diagnostic.horizontal.units.standard, "metre");
  assert.equal(diagnostic.vertical.heightKind.value, "local/unknown");
});

test("marks only an explicit three-dimensional EPSG:4979 source as ellipsoidal", () => {
  const explicit3d = resolveCopcCrsMetadata(WGS84_3D);
  const geographic2dFixture = auditFixtures.find((entry) => entry.id === "wgs84-geographic-wkt1");
  assert.ok(geographic2dFixture);
  const geographic2d = resolveCopcCrsMetadata(geographic2dFixture.wkt);

  assert.equal(explicit3d.vertical.heightKind.value, "ellipsoidal");
  assert.equal(explicit3d.vertical.heightKind.certainty, "explicit");
  assert.equal(explicit3d.vertical.units.standard, "metre");
  assert.equal(explicit3d.horizontal.units.standard, "degree");
  assert.ok(!explicit3d.reasons.some((reason) => reason.code === "unsupported-horizontal-unit"));
  assert.equal(geographic2d.vertical.heightKind.value, "local/unknown");
});

test("validates the explicit EPSG:4979 ellipsoidal height unit", () => {
  const missing = resolveCopcCrsMetadata(
    WGS84_3D.replace('ORDER[3],LENGTHUNIT["metre",1]', 'ORDER[3]'),
  );
  assert.equal(missing.vertical.units.kind, "unknown");
  assert.ok(missing.reasons.some((reason) => reason.code === "missing-vertical-unit"));

  const unsupported = resolveCopcCrsMetadata(
    WGS84_3D.replace('LENGTHUNIT["metre",1]],ID["EPSG",4979]', 'LENGTHUNIT["metre",0]],ID["EPSG",4979]'),
  );
  assert.equal(unsupported.vertical.units.kind, "unknown");
  assert.ok(unsupported.reasons.some((reason) => reason.code === "unsupported-vertical-unit"));

  const inconsistent = resolveCopcCrsMetadata(
    WGS84_3D.replace('LENGTHUNIT["metre",1]],ID["EPSG",4979]', 'LENGTHUNIT["metre",0.3048]],ID["EPSG",4979]'),
  );
  assert.equal(inconsistent.vertical.units.standard, "other");
  assert.ok(inconsistent.reasons.some((reason) => reason.code === "inconsistent-unit-declaration"));
});

test("records WKT2 format even when a recognized root syntax is unsupported", () => {
  const diagnostic = resolveCopcCrsMetadata('BOUNDCRS["Bound CRS"]');
  assert.equal(diagnostic.wkt.format, "WKT2");
  assert.equal(diagnostic.wkt.metadataSupport, "unsupported");
  assert.ok(diagnostic.reasons.some((reason) => reason.code === "unsupported-wkt-syntax"));
});

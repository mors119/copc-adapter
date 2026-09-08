import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractHorizontalWkt,
  extractVerticalUnitScale,
} from '../src/coordinates/crs/parseCopcWkt.ts';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDirectory, '../../../crates/crs-audit/src/fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).fixtures;

test('CRS audit projected fixtures match the current horizontal WKT boundary', () => {
  for (const fixture of fixtures.filter((entry) => entry.horizontal_wkt)) {
    assert.equal(extractHorizontalWkt(fixture.wkt), fixture.horizontal_wkt, fixture.id);
    assert.equal(extractVerticalUnitScale(fixture.wkt), fixture.vertical_unit_scale, fixture.id);
  }
});

test('CRS audit geographic and WKT2 fixtures expose the current adapter boundary gap', () => {
  for (const fixture of fixtures.filter((entry) => !entry.horizontal_wkt)) {
    assert.throws(() => extractHorizontalWkt(fixture.wkt), fixture.id);
  }
});

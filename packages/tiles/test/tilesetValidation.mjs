import assert from 'node:assert/strict';
import { validateTileset } from '@frillab/copc-tiles-validate';

function describeReport(report) {
  return JSON.stringify({
    valid: report.valid,
    passed: report.passed,
    conformance: report.conformance,
    issues: report.issues,
    coverage: report.coverage,
    stats: report.stats,
  }, null, 2);
}

export async function validateTilesetReport(tilesetPath) {
  return validateTileset(tilesetPath, { checkContent: true });
}

export async function assertValidTileset(tilesetPath) {
  const report = await validateTilesetReport(tilesetPath);
  const details = describeReport(report);
  assert.equal(report.valid, true, details);
  assert.equal(report.passed, true, details);
  assert.equal(report.conformance, 'partial', details);
  if (report.stats.glbs > 0) {
    assert.ok(
      report.coverage.partial.some((entry) => entry.kind === 'gltf-semantics'),
      `GLB semantic validation must remain identified as partial coverage.\n${details}`,
    );
  }
  return report;
}

export function assertTilesetIssue(report, { code, severity = 'ERROR' }) {
  const details = describeReport(report);
  assert.equal(report.valid, false, details);
  assert.equal(report.passed, false, details);
  const issue = report.issues.find((entry) => entry.code === code && entry.severity === severity);
  assert.ok(issue, `Expected ${severity} issue ${code}.\n${details}`);
  return issue;
}

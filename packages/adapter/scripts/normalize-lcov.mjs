import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootEntrypoints = new Set(['index.ts', 'core.ts', 'cesium.ts', 'three.ts']);
const sourceDirectories = ['core/', 'cesium/', 'three/'];

/**
 * Preserve only Adapter source records and rewrite paths relative to the Git root.
 * Node's LCOV reporter emits paths relative to packages/adapter.
 */
export function normalizeAdapterLcov(report, packageDirectory) {
  const normalized = [];
  for (const candidate of report.split(/end_of_record\s*(?:\r?\n|$)/)) {
    const record = candidate.trim();
    const source = record.match(/^SF:(.+)$/m)?.[1]?.trim();
    if (!source) continue;

    const sourcePath = source.startsWith('file://') ? fileURLToPath(source) : source;
    const path = relative(packageDirectory, resolve(packageDirectory, sourcePath))
      .split(sep).join('/');
    if (path === '..' || path.startsWith('../') || isAbsolute(path)) continue;
    if (!rootEntrypoints.has(path) && !sourceDirectories.some((dir) => path.startsWith(dir))) continue;
    if (!/\.(?:[cm]?js|tsx?)$/.test(path) || /\.(?:test|spec)\.[cm]?[jt]s$/.test(path)) continue;

    normalized.push(record.replace(/^SF:.*$/m, `SF:packages/adapter/${path}`) + '\nend_of_record');
  }
  if (!normalized.length) {
    throw new Error('LCOV did not contain any Adapter source records.');
  }
  return normalized.join('\n') + '\n';
}

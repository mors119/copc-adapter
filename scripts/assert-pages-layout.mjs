import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagesDirectory = path.resolve(process.argv[2] ?? path.join(repositoryDirectory, '.ci-artifacts/pages-dist'));
const docsBase = '/copc-adapter/';
const playgroundBase = '/copc-adapter/playground/';

async function requireFile(filename, label) {
  try {
    await access(filename);
  } catch {
    throw new Error(`Combined Pages artifact is missing ${label}.`);
  }
}

await requireFile(path.join(pagesDirectory, 'index.html'), '/index.html (English documentation)');
await requireFile(path.join(pagesDirectory, 'ko/index.html'), '/ko/ (Korean documentation)');
await requireFile(path.join(pagesDirectory, 'playground/index.html'), '/playground/index.html');

async function collectHtml(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectHtml(filename);
    return entry.name.endsWith('.html') ? [filename] : [];
  }));
  return nested.flat();
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(filename) : [filename];
  }));
  return nested.flat();
}

function routeForHtml(filename) {
  const relative = path.relative(pagesDirectory, filename).split(path.sep).join('/');
  if (relative === 'index.html') return docsBase;
  if (relative.endsWith('/index.html')) return `${docsBase}${relative.slice(0, -'index.html'.length)}`;
  return `${docsBase}${relative.replace(/\.html$/u, '')}`;
}

function fileCandidates(pathname) {
  if (!pathname.startsWith(docsBase)) return [];
  const relative = decodeURIComponent(pathname.slice(docsBase.length));
  if (!relative) return [path.join(pagesDirectory, 'index.html')];

  const candidates = relative.endsWith('/')
    ? [path.join(pagesDirectory, relative, 'index.html')]
    : [
        path.join(pagesDirectory, relative),
        path.join(pagesDirectory, `${relative}.html`),
        path.join(pagesDirectory, relative, 'index.html'),
      ];
  return candidates.filter((filename) => {
    const rel = path.relative(pagesDirectory, filename);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

const htmlFiles = await collectHtml(pagesDirectory);
const packagedData = (await collectFiles(pagesDirectory)).find((filename) => filename.endsWith('.copc.laz'));
if (packagedData) throw new Error(`The Pages artifact must not include COPC data: ${packagedData}`);
const documentationFiles = htmlFiles.filter((filename) =>
  !path.relative(pagesDirectory, filename).split(path.sep).includes('playground'));

for (const filename of documentationFiles) {
  const html = await readFile(filename, 'utf8');
  const route = routeForHtml(filename);
  const links = [...html.matchAll(/\b(?:href|src)="([^"]+)"/gu)].map((match) => match[1]);
  for (const link of links) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(link)) {
      if (!link.startsWith(docsBase) || link.startsWith(playgroundBase)) continue;
    }
    if (link.startsWith(playgroundBase)) continue;

    let targetUrl;
    try {
      targetUrl = new URL(link, `https://pages.invalid${route}`);
    } catch {
      continue;
    }
    if (targetUrl.origin !== 'https://pages.invalid') continue;
    if (!targetUrl.pathname.startsWith(docsBase)) {
      throw new Error(`Documentation link escapes the VitePress base path: ${link} (from ${route})`);
    }

    const candidates = fileCandidates(targetUrl.pathname);
    let found = false;
    for (const candidate of candidates) {
      try {
        found = (await stat(candidate)).isFile();
        if (found) break;
      } catch {
        // Try another VitePress clean-URL output shape.
      }
    }
    if (!found) {
      throw new Error(`Documentation link has no output in the assembled site: ${link} (from ${route})`);
    }
  }
}

const playgroundHtml = await readFile(path.join(pagesDirectory, 'playground/index.html'), 'utf8');
for (const match of playgroundHtml.matchAll(/\b(?:href|src)="([^"]+)"/gu)) {
  const url = match[1];
  if (url.startsWith('/') && !url.startsWith(playgroundBase)) {
    throw new Error(`Playground HTML asset escapes its nested base path: ${url}`);
  }
}

console.log('Combined Pages layout and VitePress links verified.');

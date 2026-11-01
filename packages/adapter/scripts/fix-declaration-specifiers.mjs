import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv[2] === "--check";
const requestedDirectory = checkOnly ? process.argv[3] : undefined;
if (checkOnly && !requestedDirectory) {
  throw new Error("Usage: fix-declaration-specifiers.mjs --check <dist-directory>");
}
const declarationDirectory = requestedDirectory
  ? path.resolve(requestedDirectory)
  : path.resolve(scriptDirectory, "../dist");

async function findDeclarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findDeclarationFiles(entryPath)));
    } else if (/\.d\.(?:ts|mts|cts)$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function tokenizeDeclaration(source) {
  const tokens = [];
  let index = 0;
  let line = 0;

  while (index < source.length) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (/\s/u.test(character)) {
      if (character === "\n") line += 1;
      index += 1;
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      index += 2;
      while (index < source.length) {
        if (source[index] === "\n") line += 1;
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const start = index;
      index += 1;
      let value = "";

      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (source[index] === "\n") line += 1;
        value += source[index];
        index += 1;
      }

      if (source[index] === quote) index += 1;
      tokens.push({
        kind: "string",
        line,
        start,
        end: index,
        value,
        valueStart: start + 1,
        valueEnd: index - 1,
      });
      continue;
    }

    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\w$]/u.test(source[index])) {
        index += 1;
      }
      tokens.push({
        kind: "identifier",
        line,
        start,
        end: index,
        value: source.slice(start, index),
      });
      continue;
    }

    tokens.push({
      kind: "punctuation",
      line,
      start: index,
      end: index + 1,
      value: character,
    });
    index += 1;
  }

  return tokens;
}

function collectModuleSpecifiers(source) {
  const tokens = tokenizeDeclaration(source);
  const firstTokenByLine = new Map();
  const specifiers = new Map();

  for (const [index, token] of tokens.entries()) {
    if (!firstTokenByLine.has(token.line)) {
      firstTokenByLine.set(token.line, index);
    }

    if (
      token.kind === "identifier" &&
      token.value === "import" &&
      tokens[index + 1]?.value === "(" &&
      tokens[index + 2]?.kind === "string"
    ) {
      specifiers.set(tokens[index + 2].start, tokens[index + 2]);
      continue;
    }

    if (
      token.kind !== "identifier" ||
      (token.value !== "import" && token.value !== "export") ||
      firstTokenByLine.get(token.line) !== index
    ) {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < tokens.length; nextIndex += 1) {
      const nextToken = tokens[nextIndex];
      if (nextToken.line !== token.line) break;
      if (
        nextToken.kind === "identifier" &&
        nextToken.value === "from" &&
        tokens[nextIndex + 1]?.kind === "string" &&
        tokens[nextIndex + 1].line === token.line
      ) {
        const moduleSpecifier = tokens[nextIndex + 1];
        specifiers.set(moduleSpecifier.start, moduleSpecifier);
        break;
      }
    }
  }

  return [...specifiers.values()];
}

function declarationTarget(specifier, declarationFile, declarationFiles) {
  const target = path.resolve(path.dirname(declarationFile), specifier);
  for (const [declarationSuffix, runtimeSuffix] of [
    [".d.ts", ".js"],
    [".d.mts", ".mjs"],
    [".d.cts", ".cjs"],
  ]) {
    if (declarationFiles.has(`${target}${declarationSuffix}`)) {
      return `${specifier}${runtimeSuffix}`;
    }
  }

  for (const [declarationSuffix, runtimeSuffix] of [
    ["index.d.ts", "index.js"],
    ["index.d.mts", "index.mjs"],
    ["index.d.cts", "index.cjs"],
  ]) {
    if (declarationFiles.has(path.resolve(target, declarationSuffix))) {
      return `${specifier}/${runtimeSuffix}`;
    }
  }

  return undefined;
}

function assertNodeEsmSpecifier(specifier, declarationFile, declarationFiles) {
  const runtimeExtension = specifier.match(/\.(js|mjs|cjs)$/u)?.[1];
  const declarationExtension = specifier.match(/\.d\.(ts|mts|cts)$/u)?.[1];
  if (runtimeExtension) {
    const target = specifier.slice(0, -runtimeExtension.length - 1);
    const declarationSuffix =
      runtimeExtension === "js"
        ? ".d.ts"
        : runtimeExtension === "mjs"
          ? ".d.mts"
          : ".d.cts";
    const declarationTargetPath = path.resolve(
      path.dirname(declarationFile),
      target + declarationSuffix,
    );
    if (!declarationFiles.has(declarationTargetPath)) {
      throw new Error(
        `Node ESM declaration specifier ${JSON.stringify(specifier)} in ${path.relative(declarationDirectory, declarationFile)} has no matching declaration file`,
      );
    }
    return;
  }

  if (declarationExtension) {
    const target = path.resolve(path.dirname(declarationFile), specifier);
    if (!declarationFiles.has(target)) {
      throw new Error(
        `Declaration specifier ${JSON.stringify(specifier)} in ${path.relative(declarationDirectory, declarationFile)} does not exist`,
      );
    }
    return;
  }

  if (/\.(?:json|node)$/iu.test(specifier)) return;

  throw new Error(
    `Relative declaration specifier ${JSON.stringify(specifier)} in ${path.relative(declarationDirectory, declarationFile)} has no Node ESM extension`,
  );
}

const declarationFiles = await findDeclarationFiles(declarationDirectory);
const declarationFileSet = new Set(declarationFiles.map((file) => path.resolve(file)));
let rewrittenSpecifierCount = 0;

for (const declarationFile of declarationFiles) {
  const source = await readFile(declarationFile, "utf8");
  const edits = [];

  for (const moduleSpecifier of collectModuleSpecifiers(source)) {
    if (!moduleSpecifier.value.startsWith("./") && !moduleSpecifier.value.startsWith("../")) {
      continue;
    }

    if (checkOnly) {
      assertNodeEsmSpecifier(
        moduleSpecifier.value,
        declarationFile,
        declarationFileSet,
      );
      continue;
    }

    if (/\.(?:[cm]?js|d\.[cm]?ts|json|node)$/iu.test(moduleSpecifier.value)) {
      assertNodeEsmSpecifier(
        moduleSpecifier.value,
        declarationFile,
        declarationFileSet,
      );
      continue;
    }

    const targetSpecifier = declarationTarget(
      moduleSpecifier.value,
      declarationFile,
      declarationFileSet,
    );
    if (!targetSpecifier) {
      throw new Error(
        `Cannot map relative declaration specifier ${JSON.stringify(moduleSpecifier.value)} in ${path.relative(declarationDirectory, declarationFile)}`,
      );
    }

    edits.push({
      start: moduleSpecifier.valueStart,
      end: moduleSpecifier.valueEnd,
      replacement: targetSpecifier,
    });
  }

  if (edits.length === 0) continue;

  let updatedSource = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    updatedSource =
      updatedSource.slice(0, edit.start) +
      edit.replacement +
      updatedSource.slice(edit.end);
  }

  await writeFile(declarationFile, updatedSource);
  rewrittenSpecifierCount += edits.length;
}

if (checkOnly) {
  console.log(`Checked ${declarationFiles.length} packed declaration files for Node ESM resolution.`);
} else {
  for (const declarationFile of declarationFiles) {
    const source = await readFile(declarationFile, "utf8");
    for (const moduleSpecifier of collectModuleSpecifiers(source)) {
      if (moduleSpecifier.value.startsWith("./") || moduleSpecifier.value.startsWith("../")) {
        assertNodeEsmSpecifier(
          moduleSpecifier.value,
          declarationFile,
          declarationFileSet,
        );
      }
    }
  }

  console.log(
    `Updated ${rewrittenSpecifierCount} relative declaration specifier${rewrittenSpecifierCount === 1 ? "" : "s"} for Node ESM resolution.`,
  );
}

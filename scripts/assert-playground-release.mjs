import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  assertRegistryReleaseMatchesLock,
  assertReleasedAdapter,
} from "../apps/playground/scripts/package-provenance.mjs";

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const playgroundDirectory = path.join(repositoryDirectory, "apps/playground");

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function readRegistryRelease(version) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "view",
        `@frillab/copc-adapter@${version}`,
        "dist.tarball",
        "dist.integrity",
        "--json",
      ],
      { cwd: repositoryDirectory, stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `npm registry does not have a verifiable @frillab/copc-adapter@${version} release.`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(new Error(`Could not parse npm registry metadata: ${error}`));
      }
    });
  });
}

const [appManifest, appLock, installedManifest, installedLock] =
  await Promise.all([
    readJson(path.join(playgroundDirectory, "package.json")),
    readJson(path.join(playgroundDirectory, "package-lock.json")),
    readJson(
      path.join(
        playgroundDirectory,
        "node_modules/@frillab/copc-adapter/package.json",
      ),
    ),
    readJson(
      path.join(playgroundDirectory, "node_modules/.package-lock.json"),
    ),
  ]);

const release = assertReleasedAdapter({
  appManifest,
  appLock,
  installedManifest,
  installedLock,
});
const registryRelease = await readRegistryRelease(release.version);
assertRegistryReleaseMatchesLock(registryRelease, release);
console.log(
  `Verified Playground dependency: @frillab/copc-adapter@${release.version} from ${release.source} (${release.integrity.slice(0, 19)}…).`,
);

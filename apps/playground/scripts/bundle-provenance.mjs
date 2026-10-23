import path from "node:path";

const ADAPTER_PACKAGE_PATH = "/@frillab/copc-adapter/";
const CANDIDATE_DIRECTORY_PREFIXES = [
  "copc-adapter-pack-",
  "copc-adapter-packed-consumer-",
  "copc-adapter-three-pack-",
  "copc-adapter-three-consumer-",
];

function normalizeModulePath(value) {
  return String(value)
    .replaceAll("\\", "/")
    .split(/[?#]/u, 1)[0]
    .replace(/\/+$/u, "");
}

function normalizeRoot(value) {
  return normalizeModulePath(path.resolve(value));
}

function isWithin(modulePath, root) {
  return modulePath === root || modulePath.startsWith(`${root}/`);
}

export function findUnexpectedAdapterModules(
  moduleIds,
  { adapterPackageRoot, repositoryPackageRoot, candidateArtifactsRoot },
) {
  const installedPackageRoot = normalizeRoot(adapterPackageRoot);
  const localPackageRoot = normalizeRoot(repositoryPackageRoot);
  const candidateRoot = candidateArtifactsRoot
    ? normalizeRoot(candidateArtifactsRoot)
    : undefined;

  return [...moduleIds]
    .map(normalizeModulePath)
    .filter((modulePath) => {
      if (isWithin(modulePath, localPackageRoot)) return true;
      if (candidateRoot && isWithin(modulePath, candidateRoot)) return true;

      const pathSegments = modulePath.split("/");
      if (
        pathSegments.some((segment) =>
          CANDIDATE_DIRECTORY_PREFIXES.some((prefix) =>
            segment.startsWith(prefix),
          ),
        )
      ) {
        return true;
      }

      if (
        !isWithin(modulePath, installedPackageRoot) &&
        modulePath.includes(ADAPTER_PACKAGE_PATH)
      ) {
        return true;
      }

      return (
        !isWithin(modulePath, installedPackageRoot) &&
        /\/package\/dist\/(?:index|cesium|three)\.js$/u.test(modulePath)
      );
    });
}

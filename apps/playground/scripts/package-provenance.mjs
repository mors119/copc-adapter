export const ADAPTER_PACKAGE_NAME = "@frillab/copc-adapter";

const ADAPTER_LOCK_KEY = "node_modules/@frillab/copc-adapter";
const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;

export function registryTarballUrl(version) {
  return `https://registry.npmjs.org/@frillab/copc-adapter/-/copc-adapter-${version}.tgz`;
}

export function classifyAdapterSource(entry, installedVersion) {
  if (!entry) return "Unknown package origin";

  if (
    entry.version === installedVersion &&
    entry.resolved === registryTarballUrl(installedVersion)
  ) {
    return "npm release";
  }

  if (entry.resolved?.startsWith("file:") && /\.tgz(?:$|[?#])/u.test(entry.resolved)) {
    return "Packed candidate";
  }

  if (
    entry.link === true ||
    entry.resolved?.startsWith("file:") ||
    entry.resolved?.startsWith("workspace:")
  ) {
    return "Workspace/local";
  }

  return "Unknown package origin";
}

export function assertReleasedAdapter({
  appManifest,
  appLock,
  installedManifest,
  installedLock,
}) {
  const requestedVersion = appManifest.devDependencies?.[ADAPTER_PACKAGE_NAME];
  if (!requestedVersion || !STABLE_VERSION.test(requestedVersion)) {
    throw new Error(
      `Playground must pin ${ADAPTER_PACKAGE_NAME} to an exact stable npm version.`,
    );
  }

  const lockRoot = appLock.packages?.[""];
  if (lockRoot?.devDependencies?.[ADAPTER_PACKAGE_NAME] !== requestedVersion) {
    throw new Error(
      `Playground package-lock.json does not match its exact ${ADAPTER_PACKAGE_NAME} pin.`,
    );
  }

  const lockedEntry = appLock.packages?.[ADAPTER_LOCK_KEY];
  if (
    lockedEntry?.version !== requestedVersion ||
    lockedEntry.resolved !== registryTarballUrl(requestedVersion) ||
    typeof lockedEntry.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/=]+$/u.test(lockedEntry.integrity)
  ) {
    throw new Error(
      `Playground lockfile must resolve ${ADAPTER_PACKAGE_NAME}@${requestedVersion} from its exact npm registry tarball with SHA-512 integrity.`,
    );
  }

  if (
    installedManifest.name !== ADAPTER_PACKAGE_NAME ||
    installedManifest.version !== requestedVersion
  ) {
    throw new Error(
      `Installed Playground adapter must be ${ADAPTER_PACKAGE_NAME}@${requestedVersion}; run npm ci --prefix apps/playground.`,
    );
  }

  const installedEntry = installedLock.packages?.[ADAPTER_LOCK_KEY];
  if (
    classifyAdapterSource(installedEntry, installedManifest.version) !==
      "npm release" ||
    installedEntry.integrity !== lockedEntry.integrity
  ) {
    throw new Error(
      `Installed Playground adapter does not match the locked npm release tarball for ${ADAPTER_PACKAGE_NAME}@${requestedVersion}; run npm ci --prefix apps/playground.`,
    );
  }

  return {
    version: requestedVersion,
    resolved: lockedEntry.resolved,
    integrity: lockedEntry.integrity,
    source: "npm release",
  };
}

export function assertRegistryReleaseMatchesLock(registryRelease, release) {
  if (
    !registryRelease ||
    registryRelease["dist.tarball"] !== release.resolved ||
    registryRelease["dist.integrity"] !== release.integrity
  ) {
    throw new Error(
      `The npm registry does not have a release matching the Playground lockfile for ${ADAPTER_PACKAGE_NAME}@${release.version}.`,
    );
  }
}

export function assertKnownAdapterInstall(installedManifest, installedEntry) {
  const source = classifyAdapterSource(
    installedEntry,
    installedManifest.version,
  );
  if (
    installedManifest.name !== ADAPTER_PACKAGE_NAME ||
    !installedManifest.version ||
    source === "Unknown package origin"
  ) {
    throw new Error(
      "Playground adapter package identity or installation origin is unknown.",
    );
  }

  return source;
}

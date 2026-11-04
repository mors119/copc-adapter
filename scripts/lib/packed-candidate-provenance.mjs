import path from "node:path";

export function assertPackedCandidateInstall({
  candidatePath,
  candidateManifest,
  installedManifest,
  installedLock,
}) {
  const packageName = "@frillab/copc-adapter";
  if (
    candidateManifest.name !== packageName ||
    !candidateManifest.version ||
    installedManifest.name !== packageName ||
    installedManifest.version !== candidateManifest.version
  ) {
    throw new Error(
      "Installed packed candidate identity does not match the candidate tarball manifest.",
    );
  }

  for (const dependencyField of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (candidateManifest[dependencyField]?.["@frillab/copc-tiles-validate"] !== undefined) {
      throw new Error(
        `Adapter packed candidate must not declare the test-only validator in ${dependencyField}.`,
      );
    }
  }

  const validatorInstall = Object.keys(installedLock.packages ?? {}).find((key) =>
    key.endsWith("node_modules/@frillab/copc-tiles-validate"),
  );
  if (validatorInstall !== undefined) {
    throw new Error(
      `Clean Adapter consumer unexpectedly installed @frillab/copc-tiles-validate at ${validatorInstall}.`,
    );
  }

  const entry = installedLock.packages?.["node_modules/@frillab/copc-adapter"];
  const resolvedTarball = entry?.resolved?.replace(/[?#].*$/u, "");
  if (
    entry?.version !== candidateManifest.version ||
    !resolvedTarball?.startsWith("file:") ||
    path.basename(resolvedTarball.slice("file:".length)) !==
      path.basename(candidatePath)
  ) {
    throw new Error(
      "Packed consumer did not install the adapter from the supplied candidate tarball.",
    );
  }

  return `Packed candidate ${packageName}@${candidateManifest.version} (${path.basename(candidatePath)})`;
}

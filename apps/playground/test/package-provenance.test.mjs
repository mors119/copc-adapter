import assert from "node:assert/strict";
import test from "node:test";
import { findUnexpectedAdapterModules } from "../scripts/bundle-provenance.mjs";
import {
  ADAPTER_PACKAGE_NAME,
  assertRegistryReleaseMatchesLock,
  assertReleasedAdapter,
  classifyAdapterSource,
  registryTarballUrl,
} from "../scripts/package-provenance.mjs";

function releaseFixture() {
  const version = "0.7.1";
  const integrity = "sha512-aGVsbG8=";
  const entry = {
    version,
    resolved: registryTarballUrl(version),
    integrity,
  };
  return {
    appManifest: {
      devDependencies: { [ADAPTER_PACKAGE_NAME]: version },
    },
    appLock: {
      packages: {
        "": { devDependencies: { [ADAPTER_PACKAGE_NAME]: version } },
        "node_modules/@frillab/copc-adapter": { ...entry },
      },
    },
    installedManifest: { name: ADAPTER_PACKAGE_NAME, version },
    installedLock: {
      packages: {
        "node_modules/@frillab/copc-adapter": { ...entry },
      },
    },
  };
}

test("accepts an exact npm release matching both lockfiles and installed metadata", () => {
  const verified = assertReleasedAdapter(releaseFixture());
  assert.equal(verified.version, "0.7.1");
  assert.equal(verified.source, "npm release");
});

test("rejects a missing exact stable npm version pin", () => {
  const fixture = releaseFixture();
  fixture.appManifest.devDependencies[ADAPTER_PACKAGE_NAME] = "^0.7.1";
  assert.throws(() => assertReleasedAdapter(fixture), /exact stable npm version/u);
});

test("rejects a pinned version that is missing from npm registry metadata", () => {
  const release = assertReleasedAdapter(releaseFixture());
  assert.throws(
    () => assertRegistryReleaseMatchesLock(undefined, release),
    /does not have a release matching/u,
  );
});

test("rejects a mismatched package lock", () => {
  const fixture = releaseFixture();
  fixture.appLock.packages[""].devDependencies[ADAPTER_PACKAGE_NAME] = "0.5.3";
  assert.throws(() => assertReleasedAdapter(fixture), /does not match/u);
});

test("rejects a candidate tarball as the public Pages dependency", () => {
  const fixture = releaseFixture();
  fixture.appLock.packages["node_modules/@frillab/copc-adapter"].resolved =
    "file:../../.ci-artifacts/copc-adapter-0.7.1.tgz";
  assert.throws(() => assertReleasedAdapter(fixture), /exact npm registry tarball/u);
});

test("labels workspace and candidate installs by their actual lockfile origin", () => {
  assert.equal(
    classifyAdapterSource(
      { version: "0.7.1", resolved: "file:../../.ci-artifacts/copc-adapter-0.7.1.tgz" },
      "0.7.1",
    ),
    "Packed candidate",
  );
  assert.equal(
    classifyAdapterSource(
      { version: "0.7.1", resolved: "file:../../packages", link: true },
      "0.7.1",
    ),
    "Workspace/local",
  );
});

test("rejects mixed local and packed-candidate adapter modules but allows shared UI", () => {
  const appDirectory = "/repo/apps/playground";
  const installedPackage = `${appDirectory}/node_modules/@frillab/copc-adapter`;
  const localAdapterSource = "/repo/packages/core/streaming/CopcStreamingCore.ts";
  const packedCandidate =
    "/tmp/copc-adapter-packed-consumer-123/node_modules/@frillab/copc-adapter/dist/cesium.js";
  const extractedCandidate =
    "/tmp/copc-adapter-pack-123/package/dist/three.js";
  const unexpected = findUnexpectedAdapterModules(
    [
      `${installedPackage}/dist/cesium.js`,
      `${installedPackage}/dist/three.js`,
      "/repo/apps/shared/src/ViewerControls.tsx",
      localAdapterSource,
      packedCandidate,
      extractedCandidate,
    ],
    {
      adapterPackageRoot: installedPackage,
      repositoryPackageRoot: "/repo/packages",
      candidateArtifactsRoot: "/repo/.ci-artifacts",
    },
  );

  assert.deepEqual(unexpected, [
    localAdapterSource,
    packedCandidate,
    extractedCandidate,
  ]);
});

test("rejects adapter code loaded from candidate artifacts", () => {
  const candidateModule = "/repo/.ci-artifacts/candidate/dist/core/streaming.js";
  assert.deepEqual(
    findUnexpectedAdapterModules([candidateModule], {
      adapterPackageRoot:
        "/repo/apps/playground/node_modules/@frillab/copc-adapter",
      repositoryPackageRoot: "/repo/packages",
      candidateArtifactsRoot: "/repo/.ci-artifacts",
    }),
    [candidateModule],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTER_PACKAGE_NAME,
  assertRegistryReleaseMatchesLock,
  assertReleasedAdapter,
  classifyAdapterSource,
  registryTarballUrl,
} from "../scripts/package-provenance.mjs";

function releaseFixture() {
  const version = "0.6.0";
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
  assert.equal(verified.version, "0.6.0");
  assert.equal(verified.source, "npm release");
});

test("rejects a missing exact stable npm version pin", () => {
  const fixture = releaseFixture();
  fixture.appManifest.devDependencies[ADAPTER_PACKAGE_NAME] = "^0.6.0";
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
    "file:../../.ci-artifacts/copc-adapter-0.6.0.tgz";
  assert.throws(() => assertReleasedAdapter(fixture), /exact npm registry tarball/u);
});

test("labels workspace and candidate installs by their actual lockfile origin", () => {
  assert.equal(
    classifyAdapterSource(
      { version: "0.6.0", resolved: "file:../../.ci-artifacts/copc-adapter-0.6.0.tgz" },
      "0.6.0",
    ),
    "Packed candidate",
  );
  assert.equal(
    classifyAdapterSource(
      { version: "0.6.0", resolved: "file:../../packages", link: true },
      "0.6.0",
    ),
    "Workspace/local",
  );
});

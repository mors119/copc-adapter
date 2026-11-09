import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const root = json("package.json");
const lock = json("package-lock.json");
const adapter = json("packages/adapter/package.json");
const viewer = json("apps/dev-viewer/package.json");
const viewerLock = json("apps/dev-viewer/package-lock.json");

assert.deepEqual(root.workspaces, ["packages/adapter"], "Only Adapter must remain a root workspace");
assert.deepEqual(lock.packages[""].workspaces, root.workspaces, "Root lockfile workspaces must match the manifest");
assert.equal(lock.packages["packages/adapter"]?.name, adapter.name, "Adapter lockfile package name");
assert.equal(lock.packages["packages/adapter"]?.version, adapter.version, "Adapter lockfile package version");
assert.deepEqual(viewerLock.packages[""].devDependencies, viewer.devDependencies, "Dev Viewer lockfile must match its manifest");
assert.equal(viewer.devDependencies["@frillab/copc-adapter"], "file:../../packages/adapter");
assert.equal(root.private, true, "The repository root must remain private");
for (const [label, manifest] of [["root", root], ["viewer", viewer]]) {
  for (const list of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[list] ?? {})) {
      assert.notEqual(name, "@frillab/copc-tiles", label + " cannot depend on Tiles");
      assert.notEqual(name, "3d-tiles-renderer", label + " cannot depend on Tiles renderer");
    }
  }
}
for (const [label, packages] of [["root lockfile", lock.packages], ["viewer lockfile", viewerLock.packages]]) {
  for (const path of Object.keys(packages)) {
    assert.equal(/(^|\\/)packages\\/tiles($|\\/)|node_modules\\/@frillab\\/copc-tiles(?:-validate)?($|\\/)|node_modules\\/3d-tiles-renderer($|\\/)/.test(path), false, label + " retains a Tiles package path: " + path);
  }
}
console.log("Standalone COPC Adapter workspace and lockfiles verified.");

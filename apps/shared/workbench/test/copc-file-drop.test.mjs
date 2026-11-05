import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalCopcFileCandidate } from "../copcFileDrop.ts";

test("local COPC candidate validation accepts supported names including .copc.laz", () => {
  for (const name of ["city.copc.laz", "CITY.COPC.LAZ", "city.copc", "city.laz"]) {
    assert.equal(
      validateLocalCopcFileCandidate({ name, size: 1, type: "" }),
      undefined,
    );
  }
});

test("local COPC candidate validation rejects empty, LAS, and unsupported files", () => {
  assert.match(
    validateLocalCopcFileCandidate({ name: "empty.copc.laz", size: 0, type: "" }) ?? "",
    /empty/,
  );
  assert.match(
    validateLocalCopcFileCandidate({ name: "ordinary.las", size: 12, type: "" }) ?? "",
    /Ordinary LAS files are not supported/,
  );
  assert.match(
    validateLocalCopcFileCandidate({ name: "notes.txt", size: 12, type: "text/plain" }) ?? "",
    /Unsupported file type/,
  );
});

test("generic binary files reach package validation instead of trusting the extension", () => {
  assert.equal(
    validateLocalCopcFileCandidate({
      name: "unknown.bin",
      size: 12,
      type: "application/octet-stream",
    }),
    undefined,
  );
});

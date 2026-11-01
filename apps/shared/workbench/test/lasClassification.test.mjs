import assert from "node:assert/strict";
import test from "node:test";
import {
  appendClassificationCode,
  LAS_1_4_CLASSIFICATION_CATALOG,
} from "../lasClassification.ts";

test("LAS 1.4 standard catalog names only the standard 0–18 classes", () => {
  assert.equal(LAS_1_4_CLASSIFICATION_CATALOG.length, 19);
  assert.equal(LAS_1_4_CLASSIFICATION_CATALOG[2].label, "Ground");
  assert.equal(LAS_1_4_CLASSIFICATION_CATALOG[6].label, "Building");
  assert.equal(LAS_1_4_CLASSIFICATION_CATALOG[18].label, "High noise");
});

test("catalog selection preserves numeric entry and avoids duplicate codes", () => {
  assert.equal(appendClassificationCode("2, 6", 6), "2, 6");
  assert.equal(appendClassificationCode("2 64", 6), "2, 64, 6");
  assert.equal(appendClassificationCode("", 2), "2");
});

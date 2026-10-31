import assert from "node:assert/strict";
import test from "node:test";
import { canStartVerticalGridLoad } from "../VerticalGridControl.ts";

test("vertical-grid control rejects new files while verification is active", () => {
  assert.equal(canStartVerticalGridLoad(false, true, false), true);
  assert.equal(canStartVerticalGridLoad(true, true, false), false);
  assert.equal(canStartVerticalGridLoad(false, false, false), false);
  assert.equal(canStartVerticalGridLoad(false, true, true), false);
});

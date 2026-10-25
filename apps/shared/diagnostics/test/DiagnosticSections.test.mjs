import assert from "node:assert/strict";
import test from "node:test";

import { validateDiagnosticSections } from "../DiagnosticSections.ts";

test("accepts diagnostics with unique section and field identities", () => {
  assert.doesNotThrow(() =>
    validateDiagnosticSections([
      {
        id: "runtime",
        title: "Runtime status",
        fields: [
          { key: "health.lifecycle", label: "Lifecycle" },
          { key: "health.renderedPoints", label: "Rendered points" },
        ],
      },
      {
        id: "hierarchy",
        title: "Hierarchy",
        fields: [{ key: "data.pageRequests", label: "Page requests" }],
      },
    ]),
  );
});

test("rejects repeated section ids and repeated field ownership", () => {
  assert.throws(
    () =>
      validateDiagnosticSections([
        { id: "runtime", title: "Runtime", fields: [] },
        { id: "runtime", title: "Duplicate runtime", fields: [] },
      ]),
    /section id must be unique/u,
  );
  assert.throws(
    () =>
      validateDiagnosticSections([
        {
          id: "runtime",
          title: "Runtime",
          fields: [{ key: "lifecycle", label: "Lifecycle" }],
        },
        {
          id: "health",
          title: "Health",
          fields: [{ key: "lifecycle", label: "Layer status" }],
        },
      ]),
    /field key must be unique/u,
  );
});

test("rejects incomplete section and field labels", () => {
  assert.throws(
    () =>
      validateDiagnosticSections([
        { id: "empty-title", title: " ", fields: [] },
      ]),
    /needs a title/u,
  );
  assert.throws(
    () =>
      validateDiagnosticSections([
        {
          id: "empty-field-label",
          title: "Runtime",
          fields: [{ key: "lifecycle", label: " " }],
        },
      ]),
    /needs a label/u,
  );
});

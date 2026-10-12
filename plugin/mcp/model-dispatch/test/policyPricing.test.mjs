import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicy } from "../dist/policy.js";

const POLICIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");
const SHIPPED = readdirSync(POLICIES_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""));

function leaves(modelName) {
  return SHIPPED.flatMap((name) =>
    loadPolicy({ policyName: name })
      .models.filter((m) => m.model_name === modelName)
      .map((m) => ({ where: `${name}/${m.id}`, pricing: m.pricing })),
  );
}

// Introductory rate through 2026-12-31. Google lists 1.50 / 0.15 / 7.50 from
// 2027-01-01; re-pin here and in the policies then.
const FLASH_3_7_AND_3_8 = { input: 0.75, input_cached: 0.075, output: 3.75 };

for (const model of ["gemini-3.7-flash", "gemini-3.8-flash"]) {
  test(`every ${model} leaf carries the published rate`, () => {
    const found = leaves(model);
    assert.ok(found.length > 0, `no shipped policy names ${model}`);
    for (const { where, pricing } of found) {
      assert.deepEqual(pricing, FLASH_3_7_AND_3_8, where);
    }
  });
}

test("gemini-3.5-flash leaves keep the 3.5 rate, not the 3.7 one", () => {
  for (const { where, pricing } of leaves("gemini-3.5-flash")) {
    assert.deepEqual(pricing, { input: 1.5, input_cached: 0.15, output: 9.0 }, where);
  }
});

test("gpt-plus-flash-38 differs from gpt-plus-flash only in the Gemini model", () => {
  const base = loadPolicy({ policyName: "gpt-plus-flash" });
  const v38 = loadPolicy({ policyName: "gpt-plus-flash-38" });
  assert.deepEqual(v38.rules, base.rules);
  assert.deepEqual(v38.select, base.select && {
    ...base.select,
    "gemini-flash": {
      ...base.select["gemini-flash"],
      reason: base.select["gemini-flash"].reason.replace("Gemini 3.7", "Gemini 3.8"),
    },
  });
  assert.equal(v38.hard_cost_cap_usd, base.hard_cost_cap_usd);
  assert.deepEqual(
    v38.models.map((m) => ({ ...m, model_name: m.model_name.replace("3.8", "3.7"), display_name: undefined })),
    base.models.map((m) => ({ ...m, display_name: undefined })),
  );
});

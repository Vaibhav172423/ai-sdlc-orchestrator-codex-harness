import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PLUGIN_POLICY_DIR, isReplayFixture, loadPolicy, loadPolicyFromPath, resolvePolicy, shippedPresetNames } from "../dist/policy.js";

const SHIPPED = join(PLUGIN_POLICY_DIR, "gpt-plus-flash.yaml");

function withOverride(yaml, fn) {
  const root = mkdtempSync(join(tmpdir(), "mmo-driver-pin-"));
  writeFileSync(join(root, "routing-policy.yaml"), yaml);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a driver block is validated when present", () => {
  const bad = [
    ["driver: 7", /'driver' must be an object/],
    ["driver: { reasoning: { effort: high } }", /model_name/],
    ["driver: { model_name: gpt-5.6-terra }", /reasoning\.effort/],
    ["driver: { model_name: gpt-5.6-terra, reasoning: { effort: high }, pricing: { input: 1 } }", /pricing\.input_cached/],
  ];
  for (const [block, re] of bad) {
    const yaml = readFileSync(SHIPPED, "utf-8").replace(/^driver:\n(?:  .*\n)+/m, `${block}\n`);
    withOverride(yaml, (root) => {
      assert.throws(() => resolvePolicy({ projectRoot: root }), re, block);
    });
  }
});

function shippedPolicies() {
  return readdirSync(PLUGIN_POLICY_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort()
    .map((name) => ({ file: `${name}.yaml`, name, policy: loadPolicyFromPath(join(PLUGIN_POLICY_DIR, `${name}.yaml`)) }));
}

test("every runnable shipped policy carries the same driver block; replay fixtures carry none", () => {
  const reference = loadPolicy({ policyName: "gpt-plus-flash" }).driver;
  assert.deepEqual(
    { model_name: reference.model_name, effort: reference.reasoning.effort },
    { model_name: "gpt-5.6-terra", effort: "high" },
  );
  const all = shippedPolicies();
  const runnable = all.filter((p) => !isReplayFixture(p.policy));
  const fixtures = all.filter((p) => isReplayFixture(p.policy));
  assert.ok(runnable.length > 1 && fixtures.length > 0, "the policy directory holds both kinds");
  assert.deepEqual(runnable.map((p) => p.name), shippedPresetNames(), "the presets a run is offered are the runnable files");
  for (const { file, name, policy } of runnable) {
    assert.equal(policy.name, name, `${file}: name matches the file name, so --policy=${name} finds it`);
    assert.deepEqual(policy.driver, reference, file);
    const gpt = policy.models.find((m) => m.id === "gpt");
    if (gpt) assert.deepEqual(policy.driver.pricing, gpt.pricing, `${file}: driver rates equal the gpt entry's`);
  }
  for (const { file, policy } of fixtures) {
    assert.equal(policy.driver, undefined, file);
  }
});

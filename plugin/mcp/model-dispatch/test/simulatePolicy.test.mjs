import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { simulatePolicyCost } from "../dist/routing.js";
import { loadPolicy } from "../dist/policy.js";
import { connectBridge } from "../dist/driverClient.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml");

// Telemetry stores fresh and cached input as disjoint counts, so cached > fresh is normal.
const JUDGMENT_EVENT = {
  phase: "requirements_analysis",
  task_type: "analysis",
  module: "all",
  retry_count: 0,
  input_tokens: 2_000,
  input_tokens_cached: 8_000,
  output_tokens: 1_000,
};

test("simulatePolicyCost prices fresh and cached input as disjoint, like live dispatch", () => {
  const out = simulatePolicyCost([JUDGMENT_EVENT], loadPolicy({ policyName: "gpt-plus-flash" }));
  // 2,000 × $2.00 + 8,000 × $0.20 + 1,000 × $12.00, per 1M.
  assert.equal(out.total_cost_usd, 0.0176);
  assert.deepEqual(out.per_model, { gpt: 0.0176 });
});

test("simulate_policy prices against a repo-local routing-policy.yaml when project_root is given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-sim-"));
  const bridge = await connectBridge();
  try {
    writeFileSync(
      join(dir, "routing-policy.yaml"),
      readFileSync(SHIPPED, "utf-8").replaceAll(
        "pricing: { input: 2.00, input_cached: 0.20, output: 12.00 }",
        "pricing: { input: 20.00, input_cached: 2.00, output: 120.00 }",
      ),
    );
    const shipped = await bridge.callTool("simulate_policy", { events: [JUDGMENT_EVENT], policy_name: "gpt-plus-flash" });
    const local = await bridge.callTool("simulate_policy", {
      events: [JUDGMENT_EVENT],
      policy_name: "gpt-plus-flash",
      project_root: dir,
    });
    assert.equal(shipped.total_cost_usd, 0.0176);
    assert.equal(local.total_cost_usd, 0.176);
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * What runs once a driver process stops, whatever the outcome. Each later
 * run-end step (manifest, report, contract close, provenance) is added here.
 */
import { join } from "node:path";

import { modeledDriverCostRows } from "./telemetry/event-reader.mjs";
import { buildDriverManifest, writeFileAtomic } from "./run-record.mjs";
import { readRunRecords } from "./run-folder.mjs";

/**
 * Rewrites driver-cost-modeled.jsonl and driver-manifest.json from
 * driver-events.jsonl, so both are exact and carry the incomplete turns the
 * live append cannot know about yet.
 */
export function regenerateDriverFiles({ runDir, runId, records = readRunRecords(runDir), driver }) {
  const { pricing, model, policyName, policyVersion = 1, pin, sandbox, approvalPolicy, auth } = driver;
  const rows = modeledDriverCostRows(records, { runId, model, pricing, policyName, policyVersion });
  writeFileAtomic(
    join(runDir, "driver-cost-modeled.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
  const manifest = buildDriverManifest(records, {
    runId,
    policyName,
    pin,
    sandbox,
    approvalPolicy,
    pricing,
    driverAuth: auth,
  });
  writeFileAtomic(join(runDir, "driver-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { rows, manifest };
}

/**
 * ctx: {route, projectRoot, runDir, runId, mode, outcome, deliberate, reason,
 * policyName, codeDir, records, driver}. `route` is 'headless' (run.mjs, the
 * default) or 'interactive' (end-run.mjs). `driver` carries what pricing the
 * conductor needs: {pricing, model, policyName, policyVersion, pin, sandbox,
 * approvalPolicy, auth}; an interactive run has no driver-events.jsonl, so it
 * has neither `driver` nor driver files to regenerate.
 */
export async function finalizeRun(ctx) {
  const out = { driverManifest: null };
  if (ctx.route !== "interactive") {
    const records = ctx.records ?? readRunRecords(ctx.runDir);
    const { manifest } = regenerateDriverFiles({
      runDir: ctx.runDir,
      runId: ctx.runId,
      records,
      driver: { policyName: ctx.policyName, ...ctx.driver },
    });
    out.driverManifest = manifest;
  }
  return out;
}

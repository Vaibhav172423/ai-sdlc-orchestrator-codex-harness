/**
 * What runs once a driver process stops, whatever the outcome. Each later
 * run-end step (manifest, report, contract close, provenance) is added here.
 */
import { join } from "node:path";

import { modeledDriverCostRows } from "./telemetry/event-reader.mjs";
import { buildDriverManifest, gate4Acceptance, gateDecision, writeFileAtomic } from "./run-record.mjs";
import { readRunRecords } from "./run-folder.mjs";
import { ACCEPTED_STATUSES, codeWrittenSummary, writeManifest } from "../scripts/write-manifest.mjs";

/**
 * Rewrites driver-cost-modeled.jsonl and driver-manifest.json from
 * driver-events.jsonl, so both are exact and carry the incomplete turns the
 * live append cannot know about yet.
 */
export function regenerateDriverFiles({ runDir, runId, records = readRunRecords(runDir), driver }) {
  const { pricing, model, policyName, policyVersion = 1, policyRecord, pin, sandbox, approvalPolicy, auth } = driver;
  const rows = modeledDriverCostRows(records, { runId, model, pricing, policyName, policyVersion });
  writeFileAtomic(
    join(runDir, "driver-cost-modeled.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
  const manifest = buildDriverManifest(records, {
    runId,
    policyName,
    policyRecord,
    pin,
    sandbox,
    approvalPolicy,
    pricing,
    driverAuth: auth,
  });
  writeFileAtomic(join(runDir, "driver-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { rows, manifest };
}

const STATUS_FOR_OUTCOME = { max_turns: "incomplete", codex_failed: "failed" };

/**
 * manifest.json's status for a run that ended with `outcome`. A completed run
 * keeps the status the conductor's Gate 4 re-run gave it, which says whether
 * a person or the gate mode accepted it; the Gate 4 line's wording is only
 * the fallback.
 */
export function manifestStatus(outcome, runDir) {
  if (outcome === "completed") {
    const { ok, status } = codeWrittenSummary(runDir);
    if (ok && ACCEPTED_STATUSES.includes(status)) return status;
    return /^auto-approved$/i.test(gateDecision(gate4Acceptance(runDir))) ? "auto-approved" : "accepted";
  }
  return STATUS_FOR_OUTCOME[outcome] ?? outcome;
}

/**
 * ctx: {route, projectRoot, runDir, runId, mode, outcome, deliberate, reason,
 * policyName, codeDir, records, driver}. `route` is 'headless' (run.mjs, the
 * default) or 'interactive' (end-run.mjs). `driver` carries what pricing the
 * conductor needs: {pricing, model, policyName, policyVersion, policyRecord,
 * pin, sandbox, approvalPolicy, auth}; an interactive run has no driver-events.jsonl, so it
 * has neither `driver` nor driver files to regenerate. Returns
 * {driverManifest, manifest, notes}; a manifest.json that cannot be written
 * is a note, never a failed run end.
 */
export async function finalizeRun(ctx) {
  let driverManifest = null;
  if (ctx.route !== "interactive") {
    const records = ctx.records ?? readRunRecords(ctx.runDir);
    ({ manifest: driverManifest } = regenerateDriverFiles({
      runDir: ctx.runDir,
      runId: ctx.runId,
      records,
      driver: { policyName: ctx.policyName, ...ctx.driver },
    }));
  }
  const notes = [];
  let manifest = null;
  try {
    // The completed run's SUMMARY.md is rendered again, now with the conductor's final figure.
    const r = writeManifest({
      runDir: ctx.runDir,
      runId: ctx.runId,
      policy: ctx.policyName,
      projectRoot: ctx.projectRoot,
      codeDir: ctx.codeDir,
      status: manifestStatus(ctx.outcome, ctx.runDir),
      summary: ctx.outcome === "completed",
    });
    manifest = r.manifest;
    notes.push(...r.notes.map((n) => `manifest.json: ${n}`));
  } catch (err) {
    notes.push(`manifest.json was not written: ${err?.message ?? err}`);
  }
  return { driverManifest, manifest, notes };
}

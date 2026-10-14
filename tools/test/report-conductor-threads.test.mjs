/**
 * The report against driver-usage.json files whose interactive conductor
 * shares a thread with another run.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../../plugin/scripts/report.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = join(REPO_ROOT, "plugin", "mcp", "model-dispatch");
const { measureDriverUsage } = await import(join(SERVER, "dist", "sessionUsage.js"));
const { loadPolicyFromPath } = await import(join(SERVER, "dist", "policy.js"));
const { SyntheticRollout, inside, marker, u, writeJsonl } = await import(join(SERVER, "test", "fixtures", "syntheticRollout.mjs"));
const POLICY = loadPolicyFromPath(join(REPO_ROOT, "plugin", "config", "policies", "gpt-plus-flash.yaml"));
const CONDUCTOR = "01a2000e-0000-7000-8000-0000000000c1";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function project(...ids) {
  const root = mkdtempSync(join(tmpdir(), "report-excluded-"));
  dirs.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const runs = ids.map((id) => {
    const dir = join(root, "p", ".sdlc", "runs", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { home, runs };
}

function collect(run, home) {
  const m = measureDriverUsage({ runDir: run, policy: POLICY, codexHome: home });
  assert.equal(m.ok, true, m.message);
  writeFileSync(join(run, "driver-usage.json"), JSON.stringify(m.report, null, 2) + "\n");
  return m.report;
}

function report(dir, args = []) {
  const out = [];
  const status = main([dir, ...args], { out: (s) => out.push(s), err: () => {} }, "report.mjs");
  assert.equal(status, 0);
  return out.join("\n");
}

test("a window that skips another run's turns says how many it left out", () => {
  const { home, runs: [a, b] } = project("run-a", "run-b");
  const r = new SyntheticRollout({ threadId: CONDUCTOR, originator: "codex-tui" });
  const a1 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
  const b1 = r.turn({ text: "$mmo-codex:docs", responses: [{ usage: u(50_000) }] });
  const a2 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(2000) }] });
  r.write(home);
  writeJsonl(join(a, "driver-session.jsonl"), [marker(CONDUCTOR, inside(a1), "start_run"), marker(CONDUCTOR, inside(a2), "start_run")]);
  writeJsonl(join(b, "driver-session.jsonl"), [marker(CONDUCTOR, inside(b1), "start_run")]);
  assert.equal(collect(a, home).tokens.input_tokens, 3000);
  const out = report(a);
  assert.match(out, /Window\s+\S+ → \S+ \(1 turn inside it is another run's or no run's, and not counted\)/);
  assert.match(out, /Modeled cost\s+\$0\.0060/);
});

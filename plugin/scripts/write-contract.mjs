#!/usr/bin/env node
/**
 * write-contract — freezes, ends and checks a brownfield run's write contract in code. The model never writes
 * `.sdlc/local/write-contract.json` itself; the hook refuses that while a run is live.
 *
 * Usage:
 *   node write-contract.mjs --freeze --run-id=<id> --allowlist='<JSON array>' [--off-limits='<JSON array>']
 *                           [--strict-write=off] [--project-root=<dir>]
 *   node write-contract.mjs --close --run-id=<id> [--project-root=<dir>]
 *   node write-contract.mjs --abandon --run-id=<id> [--reason=<text>] [--project-root=<dir>]
 *   node write-contract.mjs --assert-guard-live [--run-id=<id>] [--project-root=<dir>]
 *
 * Flags take `--name=value` or `--name value`. The project root is the root of its git project, the only place the
 * hook reads a contract. Exit 0 = done, 2 = refused, usage or a failed file write; the message says which, and a guard
 * check that finds the write guard did not run in this session says so.
 */
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OFF_LIMITS_DEFAULT } from "./lib/off-limits.mjs";
import { isRunId, runDirFor } from "./lib/run-id.mjs";
import {
  CONTRACT_MAX_BYTES, CONTRACT_REL_PATH, DECISIONS_REL_PATH, FROZEN_FILE, LOCK_FILE, contractTampered, fingerprint,
  gitRoot, jsonBytes, liveLock, liveLocks, lockPresent, readContract, readContractBytes, readLock, readRegular,
  readRegularTail, writeWhole,
} from "./lib/contract-lock.mjs";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;

/** End outcomes a resumed run may not reopen: the run finished, or the person ended it. */
const FINAL_OUTCOMES = new Set(["completed", "aborted"]);
/** Gate-4 answers that end a run as completed, compared without case. `accept` is the reply the Gate 4 prompt asks for. */
const GATE4_ACCEPTED = new Set(["approved", "accepted", "accept", "auto-approved"]);
const ABORTED = new Set(["aborted", "abort"]);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
/** The command the person runs to end a run, ready to paste. */
export const abandonCommand = (runId, root) => `node ${shq(SCRIPT_PATH)} --abandon --run-id=${runId} --project-root=${shq(root)}`;

const PERSON_DECIDES = "A wider scope is the person's decision, for a new run with its own Gate 0: stop and tell the person which path is needed and why.";

export class ContractRefusal extends Error {
  constructor(message) {
    super(message);
    this.code = "WRITE_CONTRACT_REFUSED";
  }
}
const refuse = (msg) => { throw new ContractRefusal(msg); };

const nowIso = (now) => (now instanceof Date ? now : new Date()).toISOString();
const lockPath = (root, runId) => join(runDirFor(root, runId), LOCK_FILE);
const frozenPath = (root, runId) => join(runDirFor(root, runId), FROZEN_FILE);

function requireRunId(runId) {
  if (!isRunId(runId)) refuse(`--run-id must be the run's id (letters, digits, '.', '_' or '-', not starting with a dot), got ${JSON.stringify(runId ?? null)}`);
}

/** The project root, refused unless it is the root of its git project. */
function gitProjectRoot(projectRoot) {
  const root = resolve(String(projectRoot ?? process.cwd()));
  if (existsSync(join(root, ".git"))) return root;
  const top = gitRoot(root);
  refuse(
    (top ? `${root} is not the root of a git project: it is inside the git project at ${top}` : `${root} is not in a git project`) +
    `. A brownfield run's contract lives at its git project's root, the only place the write hook reads it. Nothing is written. ` +
    `Stop and tell the person: a brownfield run starts from the project's root folder${top ? ` (${top})` : ", in a git project"}.`,
  );
}

function globList(value, flag) {
  const v = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!Array.isArray(v) || !v.every((g) => typeof g === "string" && g.length > 0)) {
    refuse(`${flag} must be a JSON array of path globs, such as '["src/**","docs/**"]'`);
  }
  return v;
}

function projectOffLimits(root) {
  const bytes = readRegular(join(root, ".sdlc", "project.json"), 1024 * 1024);
  try {
    const list = JSON.parse(bytes?.toString("utf8") ?? "null")?.off_limits_default;
    if (Array.isArray(list) && list.every((p) => typeof p === "string" && p.length > 0)) return list;
  } catch { /* fall back to the shipped default */ }
  return OFF_LIMITS_DEFAULT;
}

/** Writes the contract, its frozen copy and the lock (the lock last: it is what makes the freeze real). */
export function freezeContract({ projectRoot, runId, allowlist, offLimits = [], strict = true, now } = {}) {
  requireRunId(runId);
  const root = gitProjectRoot(projectRoot);
  const allow = globList(allowlist, "--allowlist");
  const extra = globList(offLimits, "--off-limits");
  if (lockPresent(root, runId)) {
    refuse(`run ${runId} has already frozen its contract: a run freezes once, at its Gate 0, and its scope does not change after that. ${PERSON_DECIDES}`);
  }
  const live = liveLock(root);
  if (live) {
    refuse(`run ${live.run_id} is live and holds this project's write contract. Ending that run is the person's decision ` +
      `(${abandonCommand(live.run_id, root)}). Nothing is written.`);
  }
  const current = readContract(root);
  if (current?.active === true && !readLock(root, current.run_id)?.ended_at) {
    const id = isRunId(current.run_id) ? current.run_id : null;
    refuse(`an active write contract${id ? ` for run ${id}` : ""} that no lock records holds this project. Ending it is the person's decision` +
      (id ? ` (${abandonCommand(id, root)})` : "") + ". Nothing is written.");
  }

  const frozenAt = nowIso(now);
  const contract = {
    schema_version: 1,
    active: true,
    mode: "brownfield",
    run_id: runId,
    strict: strict !== false,
    allowlist: allow,
    off_limits: [...new Set([...projectOffLimits(root), ...extra])],
    frozen_at: frozenAt,
  };
  const bytes = jsonBytes(contract);
  const sha256 = fingerprint(bytes);
  const contractPath = join(root, CONTRACT_REL_PATH);
  const before = readRegular(contractPath, CONTRACT_MAX_BYTES);

  writeWhole(contractPath, bytes);
  try {
    writeWhole(frozenPath(root, runId), bytes);
    writeWhole(lockPath(root, runId), jsonBytes({
      schema_version: 1, run_id: runId, sha256, frozen_at: frozenAt, ended_at: null, end_outcome: null, end_reason: null, reopened_at: [],
    }));
  } catch (err) {
    if (before) writeWhole(contractPath, before);
    else rmSync(contractPath, { force: true });
    rmSync(frozenPath(root, runId), { force: true });
    refuse(`the run's lock could not be written (${err?.message ?? err}): nothing is frozen`);
  }
  return { root, contract, sha256 };
}

/**
 * Ends a run: the lock's end record first, then the contract switched off, so the switch-off is never a change to a
 * live frozen contract. Keeps the frozen copy. A run with no lock and no contract naming it has nothing to end.
 */
export function endRun({ projectRoot, runId, outcome, reason = null, now } = {}) {
  requireRunId(runId);
  if (typeof outcome !== "string" || !outcome) refuse("endRun needs an outcome");
  const root = resolve(String(projectRoot ?? process.cwd()));
  const lock = readLock(root, runId);
  const before = readContractBytes(root);
  const contract = readContract(root);
  const result = { run_id: runId, found: !!lock || contract?.run_id === runId, ended: false, already_ended: false, switched_off: false };
  if (!result.found) return result;

  const wasLive = !!lock && !lock.ended_at;
  if (wasLive) {
    writeWhole(lockPath(root, runId), jsonBytes({ ...lock, ended_at: nowIso(now), end_outcome: outcome, end_reason: reason }));
    result.ended = true;
  } else if (lock) {
    result.already_ended = true;
  }

  if (contract?.active === true) {
    const sha = before ? fingerprint(before) : null;
    const heldByAnother = liveLocks(root).some((l) => l.run_id !== runId && l.sha256 === sha);
    const untrusted = wasLive && sha !== lock.sha256 && !heldByAnother;
    if (contract.run_id === runId || untrusted) {
      writeWhole(join(root, CONTRACT_REL_PATH), jsonBytes({ ...contract, active: false }));
      result.switched_off = true;
    }
  }
  return result;
}

/** For `--resume`: puts a stopped run's frozen contract back and makes its lock live again. */
export function reopenRun({ projectRoot, runId, now } = {}) {
  requireRunId(runId);
  const root = resolve(String(projectRoot ?? process.cwd()));
  const lock = readLock(root, runId);
  if (!lock) return { run_id: runId, reopened: false, live: false };
  if (!lock.ended_at) {
    const bad = contractTampered(root);
    if (bad) refuse(`run ${runId} cannot resume: ${bad}`);
    return { run_id: runId, reopened: false, live: true };
  }
  if (FINAL_OUTCOMES.has(lock.end_outcome)) {
    refuse(`run ${runId} ended ${lock.end_outcome}, so it does not resume. A further change is a new run with its own Gate 0.`);
  }
  const other = liveLocks(root).find((l) => l.run_id !== runId);
  if (other) refuse(`run ${other.run_id} is live and holds this project's write contract, so run ${runId} cannot resume.`);
  const current = readContract(root);
  if (current && current.run_id !== runId) {
    refuse(`the project's write contract now belongs to run ${String(current.run_id)}, so run ${runId} cannot resume.`);
  }
  const frozen = readRegular(frozenPath(root, runId), CONTRACT_MAX_BYTES);
  if (!frozen || fingerprint(frozen) !== lock.sha256) {
    refuse(`run ${runId}'s frozen contract copy no longer matches its lock, so the run cannot resume. Stop and tell the person what changed it.`);
  }
  const contractPath = join(root, CONTRACT_REL_PATH);
  const before = readContractBytes(root);
  writeWhole(contractPath, frozen);
  try {
    writeWhole(lockPath(root, runId), jsonBytes({
      ...lock, ended_at: null, end_outcome: null, end_reason: null,
      reopened_at: [...(Array.isArray(lock.reopened_at) ? lock.reopened_at : []), nowIso(now)],
    }));
  } catch (err) {
    if (before) writeWhole(contractPath, before);
    refuse(`run ${runId}'s lock could not be reopened (${err?.message ?? err})`);
  }
  return { run_id: runId, reopened: true, live: true };
}

/**
 * completed / aborted from the run's gates.jsonl, or null while neither is recorded. Conductors have written the
 * answer as `decision` and as `status`, so both are read.
 */
function gateOutcome(root, runId) {
  const text = readRegular(join(runDirFor(root, runId), "gates.jsonl"), 4 * 1024 * 1024)?.toString("utf8") ?? "";
  let outcome = null;
  for (const line of text.split("\n")) {
    let g;
    try { g = JSON.parse(line); } catch { continue; }
    if (!g || typeof g !== "object") continue;
    const answer = String(g.decision ?? g.status ?? "").trim().toLowerCase();
    if (ABORTED.has(answer)) return "aborted";
    if (Number(g.gate) === 4 && GATE4_ACCEPTED.has(answer)) outcome = "completed";
  }
  return outcome;
}

/** Close-out: ends the run once Gate 4 is accepted (or the run aborted) in its gates.jsonl, then switches the contract off. */
export function closeContract({ projectRoot, runId, now } = {}) {
  requireRunId(runId);
  const root = gitProjectRoot(projectRoot);
  const contract = readContract(root);
  const lock = readLock(root, runId);
  if (!lock && contract?.run_id !== runId) refuse(`run ${runId} holds no write contract in ${root}`);
  if (contract && contract.run_id !== runId) {
    refuse(`the write contract belongs to run ${String(contract.run_id)}, not ${runId}. Stop and tell the person.`);
  }
  let outcome = lock?.end_outcome ?? "completed";
  if (lock && !lock.ended_at) {
    outcome = gateOutcome(root, runId);
    if (!outcome) {
      refuse(`run ${runId} is live: its gates.jsonl (.sdlc/runs/${runId}/gates.jsonl) records no accepted Gate 4 and no abort. ` +
        `The contract is closed at close-out, after the person accepts Gate 4, never during the run. To end the run ` +
        `without an accepted Gate 4, the person runs: ${abandonCommand(runId, root)}`);
    }
  }
  return { ...endRun({ projectRoot: root, runId, outcome, now }), outcome };
}

/** The person ends a run that will not end by itself (a killed session, a discarded resume, an abort). */
export function abandonRun({ projectRoot, runId, reason, now } = {}) {
  requireRunId(runId);
  const root = gitProjectRoot(projectRoot);
  const why = typeof reason === "string" && reason.trim() ? reason.trim() : "abandoned by the person";
  const result = endRun({ projectRoot: root, runId, outcome: "aborted", reason: why, now });
  if (!result.found) refuse(`run ${runId} holds no write contract in ${root}: it has no lock and the contract does not name it`);
  return { ...result, reason: why };
}

export const GUARD_NOT_LIVE =
  "The write guard did not run in this session, so nothing would stop a write outside the confirmed scope. " +
  "Start Codex and choose 'Trust all and continue' when it asks about hooks, or open /hooks and trust " +
  "mmo-codex's PreToolUse hook, then start the run again.";

/**
 * Proves the write hook ran in this session after the freeze: a decision row for the live run, stamped at or after
 * frozen_at. The hook records a row for every call while a contract binds, this script's own Bash call included.
 * Without one the run is ended (outcome `refused`) and the contract switched off.
 */
export function assertGuardLive({ projectRoot, runId, now } = {}) {
  const root = gitProjectRoot(projectRoot);
  const contract = readContract(root);
  if (contract?.active !== true || !isRunId(contract.run_id)) refuse(`no active write contract in ${root}: freeze one at Gate 0 first`);
  if (runId !== undefined && runId !== null) {
    requireRunId(runId);
    if (contract.run_id !== runId) refuse(`the write contract belongs to run ${contract.run_id}, not ${runId}`);
  }
  const lock = readLock(root, contract.run_id);
  if (!lock || lock.ended_at) refuse(`run ${contract.run_id} has no live lock: its contract was not frozen by write-contract.mjs, or the run has ended`);
  const tampered = contractTampered(root);
  if (tampered) refuse(tampered);

  const text = readRegularTail(join(root, DECISIONS_REL_PATH), 1024 * 1024)?.toString("utf8") ?? "";
  const row = text.split("\n").reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((r) => r && r.run_id === contract.run_id && typeof r.ts === "string" && r.ts >= contract.frozen_at);
  if (row) return { live: true, run_id: contract.run_id, wired_by: row.wired_by ?? null };
  endRun({ projectRoot: root, runId: contract.run_id, outcome: "refused", reason: "the write guard did not run in this session", now });
  return { live: false, run_id: contract.run_id };
}

const MODES = ["--freeze", "--close", "--abandon", "--assert-guard-live"];
const VALUE_FLAGS = ["--run-id", "--allowlist", "--off-limits", "--reason", "--project-root", "--strict-write"];

export function parseArgs(argv) {
  const out = { mode: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (MODES.includes(arg)) {
      if (out.mode) refuse(`give one of ${MODES.join(", ")}, not both ${out.mode} and ${arg}`);
      out.mode = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.includes(name)) refuse(`unknown argument ${arg}`);
    let value;
    if (eq !== -1) value = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
    else refuse(`${name} needs a value`);
    const key = name.slice(2);
    if (key in out) refuse(`${name} given twice`);
    out[key] = value;
  }
  if (!out.mode) refuse(`usage: one of ${MODES.join(", ")} (see the header of write-contract.mjs)`);
  if (out["strict-write"] !== undefined && out["strict-write"] !== "off") refuse("--strict-write takes only the value off");
  return out;
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const a = parseArgs(argv);
    const projectRoot = a["project-root"] ?? process.cwd();
    const runId = a["run-id"];
    if (a.mode === "--freeze") {
      const { root, contract } = freezeContract({
        projectRoot, runId, allowlist: a.allowlist ?? refuse("--freeze needs --allowlist"),
        offLimits: a["off-limits"] ?? [], strict: a["strict-write"] !== "off",
      });
      stdout.write(`write-contract: frozen for run ${runId} (${contract.allowlist.length} allowlist, ${contract.off_limits.length} off-limits pattern(s)${contract.strict ? "" : ", strict off"})\n`);
      stdout.write(`write-contract: check the guard next, in a tool call of its own: node ${shq(SCRIPT_PATH)} --assert-guard-live --run-id=${runId} --project-root=${shq(root)}\n`);
      return EXIT_OK;
    }
    if (a.mode === "--close") {
      const r = closeContract({ projectRoot, runId });
      stdout.write(`write-contract: run ${runId} ${r.ended ? `ended ${r.outcome}` : "had already ended"}; ${r.switched_off ? "its contract is switched off" : "its contract was already off"}\n`);
      return EXIT_OK;
    }
    if (a.mode === "--abandon") {
      const r = abandonRun({ projectRoot, runId, reason: a.reason });
      stdout.write(`write-contract: run ${runId} ${r.ended ? `ended (aborted: ${r.reason})` : "had already ended"}${r.switched_off ? "; its contract is switched off" : ""}\n`);
      return EXIT_OK;
    }
    const r = assertGuardLive({ projectRoot, runId });
    if (r.live) {
      stdout.write(`write-contract: the write guard is live for run ${r.run_id}${r.wired_by ? ` (wired by ${r.wired_by})` : ""}\n`);
      return EXIT_OK;
    }
    stderr.write(`write-contract: ${GUARD_NOT_LIVE} Run ${r.run_id} is ended and its contract switched off.\n`);
    return EXIT_REFUSED;
  } catch (err) {
    const what = err?.code === "WRITE_CONTRACT_REFUSED" ? err.message : `failed: ${err?.message ?? String(err)}`;
    stderr.write(`write-contract: ${what}\n`);
    return EXIT_REFUSED;
  }
}

const isDirectRun = (() => {
  try { return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isDirectRun) process.exitCode = main();

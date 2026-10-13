/**
 * The driver's own record of a run: driver-events.jsonl (format v1), the
 * evidence a finished invocation leaves, the outcome it maps to, and the
 * driver-manifest.json rebuilt from the record.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";

import { codexEvents } from "./telemetry/event-reader.mjs";
import { findCodexWarnings, findPinRejection } from "./telemetry/fairnessPin.mjs";
import { driverTurns, summarizeDriverTurns } from "../mcp/model-dispatch/dist/driverUsage.js";

export const RECORD_VERSION = 1;
export const STDOUT_LINE_MAX = 4096;
export const STDERR_TAIL_MAX = 2000;
/** Where a conductor under --gates=prompt puts a question for the person that is not a gate. */
export const QUESTION_FILE = "question.json";

/** outcome → whether a person or a rule meant it, and the driver's exit code (interrupted: 128 + signal). */
export const OUTCOMES = {
  completed: { deliberate: null, exit: 0 },
  aborted: { deliberate: true, exit: 4 },
  halted: { deliberate: true, exit: 4 },
  refused: { deliberate: true, exit: 4 },
  stopped: { deliberate: true, exit: 4 },
  cost_cap: { deliberate: true, exit: 4 },
  pin_rejected: { deliberate: true, exit: 1 },
  max_turns: { deliberate: false, exit: 3 },
  codex_failed: { deliberate: false, exit: 1 },
  interrupted: { deliberate: false, exit: null },
};

export function outcomeExitCode(outcome, signal = null) {
  if (outcome === "interrupted") return 128 + (osConstants.signals[signal] ?? 0);
  const entry = OUTCOMES[outcome];
  if (!entry) throw new Error(`run-record: unknown outcome '${outcome}'`);
  return entry.exit;
}

export function isDeliberate(outcome) {
  return OUTCOMES[outcome]?.deliberate === true;
}

export function appendRecord(runDir, record) {
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, "driver-events.jsonl"), JSON.stringify({ v: RECORD_VERSION, ...record }) + "\n");
}

export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

/** The run_end that closes the latest driver process, or null while it runs (or after it was killed). */
export function lastRunEnd(records) {
  let end = null;
  for (const r of records) {
    if (r.kind === "invocation_start") end = null;
    else if (r.kind === "run_end") end = r;
  }
  return end;
}

/**
 * How the previous driver process ended: its run_end, an `outcome: 'killed'`
 * stand-in when it started an invocation and never wrote one, or null for a
 * new or legacy record.
 */
export function previousRunEnd(records) {
  let last = null;
  for (const r of records) {
    if (r.legacy) continue;
    if (r.kind === "invocation_start" || r.kind === "run_end") last = r;
  }
  if (!last) return null;
  if (last.kind === "run_end") return last;
  return { kind: "run_end", outcome: "killed", deliberate: false, reason: "the driver stopped without writing run_end" };
}

/** `ps -o etime=` prints `[[dd-]hh:]mm:ss`. */
export function parseEtime(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

function processStartMs(pid) {
  if (process.platform === "win32") return null;
  const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const secs = r.status === 0 ? parseEtime(r.stdout) : null;
  return secs === null ? null : Date.now() - secs * 1000;
}

/**
 * Whether the driver process a record names still runs. A pid is reused once
 * its process is gone, so a process that started after the record was
 * written is someone else.
 */
export function driverAlive(pid, recordedAt) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code !== "EPERM") return false;
  }
  const started = processStartMs(pid);
  const at = Date.parse(recordedAt ?? "");
  // etime has whole-second resolution.
  return !(started !== null && Number.isFinite(at) && started > at + 2000);
}

/** The driver process still working on this run (mid-turn, or waiting at a gate), or null. */
export function liveDriver(records, alive = driverAlive) {
  let last = null;
  for (const r of records) {
    if (r.legacy) continue;
    if (r.kind === "invocation_start" || r.kind === "run_end") last = r;
  }
  if (last?.kind !== "invocation_start" || last.driver_pid === undefined || last.driver_pid === null) return null;
  return alive(last.driver_pid, last.at) ? { pid: last.driver_pid, invocation: last.invocation, at: last.at } : null;
}

/** The newest run_end anywhere in the record, whether or not a later process started after it. */
export function latestRunEnd(records) {
  let end = null;
  for (const r of records) if (r.kind === "run_end") end = r;
  return end;
}

export function invocationCount(records) {
  return records.filter((r) => r.kind === "invocation_start").length;
}

function readLines(path) {
  try {
    return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

function parseJsonLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v);
    } catch {
      continue;
    }
  }
  return out;
}

export function countLines(path) {
  return readLines(path).length;
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Filesystem mtimes and Date.now() are not taken at the same instant; this keeps a write made right at the start fresh. */
const FRESH_SLACK_MS = 5;

function writtenSince(path, sinceMs) {
  const m = mtimeMs(path);
  return m !== null && m + FRESH_SLACK_MS >= sinceMs;
}

/** Files a conductor writes to say why it stopped. */
const STOP_FILES = ["preflight.json", "stop.json", QUESTION_FILE];

function stamp(path) {
  const m = mtimeMs(path);
  if (m === null) return null;
  try {
    return `${m}:${readFileSync(path, "utf-8")}`;
  } catch {
    return `${m}:`;
  }
}

/**
 * What the stop check compares against: each stop file's mtime and content,
 * and the guard log's length, taken just before an invocation starts. Two
 * invocations can start within a millisecond or two of each other (a gate
 * answer), which an mtime-against-start-time check cannot tell apart.
 */
export function snapshotStopEvidence(runDir, projectRoot) {
  const files = {};
  for (const name of STOP_FILES) files[name] = stamp(join(runDir, name));
  return { files, guardLines: countLines(join(projectRoot, ".sdlc", "local", "guard-decisions.jsonl")) };
}

function gateNumber(line) {
  const g = line?.gate;
  if (typeof g === "number") return g;
  const m = /(\d+)/.exec(String(g ?? ""));
  return m ? Number(m[1]) : null;
}

const GATE4_ACCEPTED = /^(approved|accept|accepted|auto-approved)$/i;

/** Gate decisions recorded in gates.jsonl, leniently parsed. */
export function readGateLines(runDir) {
  return parseJsonLines(readLines(join(runDir, "gates.jsonl")));
}

/** Conductors have written both `decision` and `status`; read either. */
export function gateDecision(line) {
  return String(line?.decision ?? line?.status ?? "").trim();
}

export { gateNumber };

/**
 * Completion needs both the final report (a SUMMARY.md written since the run
 * began) and the final acceptance gate recorded as accepted.
 */
export function completionEvidence(runDir, runStartedAtMs) {
  const summary = join(runDir, "SUMMARY.md");
  const fresh = existsSync(summary) && (runStartedAtMs == null || writtenSince(summary, runStartedAtMs - 2000));
  const accepted = readGateLines(runDir).some(
    (l) => gateNumber(l) === 4 && GATE4_ACCEPTED.test(gateDecision(l)),
  );
  return { summary: fresh, gate4: accepted, complete: fresh && accepted };
}

/**
 * Why an invocation's turn ended, from evidence written during that
 * invocation only. Returns {outcome, reason, gate?, question?} or null when
 * nothing in the folder says the run stopped (a context-ceiling stop, so
 * resume). `gate_pending` and `question_pending` wait for the person.
 */
export function stopCheck({
  runDir,
  projectRoot,
  runId,
  gateMode,
  startedAtMs,
  gatesLinesBefore = 0,
  runStartedAtMs = null,
  events = [],
  before = null,
}) {
  const fresh = (name) => {
    const path = join(runDir, name);
    if (!before) return writtenSince(path, startedAtMs);
    const now = stamp(path);
    return now !== null && now !== before.files[name];
  };
  const newGates = parseJsonLines(readLines(join(runDir, "gates.jsonl")).slice(gatesLinesBefore));
  const last = newGates[newGates.length - 1];
  if (gateMode === "prompt" && last && gateDecision(last).toLowerCase() === "pending") {
    const gate = gateNumber(last);
    return { outcome: "gate_pending", gate, reason: `gate ${gate ?? "?"} is waiting for an answer` };
  }
  const aborted = newGates.find((l) => /^abort/i.test(gateDecision(l)));
  if (aborted) {
    const note = aborted.note ? `: ${aborted.note}` : "";
    return { outcome: "aborted", reason: `gate ${gateNumber(aborted) ?? "?"} aborted${note}` };
  }

  const preflightPath = join(runDir, "preflight.json");
  if (fresh("preflight.json")) {
    const pre = readJson(preflightPath);
    if (pre && pre.ok === false) return { outcome: "halted", reason: pre.halt_reason ?? "preflight reported ok:false" };
  }

  const guardLog = readLines(join(projectRoot, ".sdlc", "local", "guard-decisions.jsonl"));
  const guard = parseJsonLines(before ? guardLog.slice(before.guardLines) : guardLog);
  const deny = guard.find(
    (d) =>
      d.decision === "deny" &&
      (before || Date.parse(d.ts) + FRESH_SLACK_MS >= startedAtMs) &&
      (d.run_id === undefined || d.run_id === null || d.run_id === runId),
  );
  if (deny) return { outcome: "refused", reason: `${deny.path ?? "a write"}: ${deny.reason ?? "refused by the write contract"}` };

  const stopPath = join(runDir, "stop.json");
  if (fresh("stop.json")) {
    const stop = readJson(stopPath);
    return { outcome: "stopped", reason: stop?.reason ?? "the conductor wrote stop.json" };
  }

  if (fresh(QUESTION_FILE)) {
    const q = readJson(join(runDir, QUESTION_FILE));
    const question = typeof q?.question === "string" && q.question.trim() ? q.question.trim() : null;
    if (gateMode === "prompt") {
      return { outcome: "question_pending", question, reason: "the conductor is waiting for an answer to its question" };
    }
    return {
      outcome: "stopped",
      reason: `the conductor asked a question nobody can answer under --gates=${gateMode}${question ? `: ${question}` : ""}`,
    };
  }

  const rejection = findPinRejection(events);
  if (rejection) return { outcome: "pin_rejected", reason: `the codex CLI rejected the pinned model or effort — ${rejection}` };

  if (completionEvidence(runDir, runStartedAtMs).complete) {
    return { outcome: "completed", reason: "SUMMARY.md written and Gate 4 accepted" };
  }
  return null;
}

function uniqueInOrder(values) {
  return [...new Set(values.filter((v) => v !== undefined && v !== null))];
}

/** driver-manifest.json, rebuilt whole from the record. */
export function buildDriverManifest(records, { runId, policyName, pin, sandbox, approvalPolicy, pricing, driverAuth }) {
  const starts = records.filter((r) => r.kind === "invocation_start");
  const ends = records.filter((r) => r.kind === "invocation_end");
  const events = codexEvents(records);
  const turns = driverTurns(records);
  const summary = summarizeDriverTurns(turns, pricing);
  const end = lastRunEnd(records);
  const lastEnd = ends[ends.length - 1] ?? null;
  return {
    run_id: runId,
    policy: policyName,
    gates: uniqueInOrder(starts.map((s) => s.gates)).join(", ") || null,
    pin: { ...pin, sandbox, approval_policy: approvalPolicy },
    started_at: starts[0]?.at ?? null,
    ended_at: end?.at ?? lastEnd?.at ?? null,
    codex_exit_status: lastEnd?.exit_status ?? null,
    driver_turns: summary.turns,
    driver_turns_incomplete: summary.turns_incomplete,
    driver_cost_complete: summary.turns_incomplete === 0,
    driver_cost_flags: summary.flags,
    codex_invocations: starts.length,
    completed: end?.outcome === "completed",
    cost_cap_stop: end?.outcome === "cost_cap" ? end.reason : null,
    driver_cost_usd_modeled: summary.cost_usd,
    pin_rejection: findPinRejection(events),
    events_captured: events.length,
    thread_ids: summary.thread_ids,
    outcome: end?.outcome ?? null,
    outcome_reason: end?.reason ?? null,
    exit_code: end?.exit_code ?? null,
    codex_warnings: findCodexWarnings(events),
    driver_auth: driverAuth ?? "unknown",
  };
}

/** `codex login status` wording → how the conductor authenticates. The text itself is never kept. */
export function classifyDriverAuth(text) {
  const s = String(text ?? "");
  if (/logged in using chatgpt/i.test(s)) return "chatgpt";
  if (/logged in using an api key/i.test(s)) return "api_key";
  return "unknown";
}

/**
 * Reader for the `codex exec --json` stream and the driver-events.jsonl
 * record run.mjs writes from it.
 *
 * Codex stamps no time on its events, so a v1 record carries the driver's own
 * `received_at`. Every executed shell command arrives wrapped as
 * `/bin/bash -lc '…'` or `/bin/zsh -lc '…'`, unwrapped here.
 *
 * The conductor never dispatches through `execute_with_model` (D1), so its
 * cost reaches telemetry only as the `provenance: "modeled"` rows built here.
 */

import {
  driverTurns,
  parseDriverRecords,
  priceUsage,
  toDriverRecords,
} from "../../mcp/model-dispatch/dist/driverUsage.js";

const SHELL_WRAP_RE = /^\/bin\/(?:ba|z)sh\s+-lc\s+(['"])([\s\S]*)\1$/;

/** Strips a `/bin/bash -lc '…'` or `/bin/zsh -lc '…'` wrapper; a bare command is returned unchanged. */
export function unwrapShellCommand(command) {
  if (typeof command !== "string") return command;
  const m = SHELL_WRAP_RE.exec(command);
  return m ? m[2] : command;
}

function withUnwrappedCommand(event) {
  if (event.item?.type === "command_execution" && typeof event.item.command === "string") {
    return { ...event, item: { ...event.item, unwrapped_command: unwrapShellCommand(event.item.command) } };
  }
  return event;
}

/**
 * Parses bare `codex exec --json` text into events stamped with `ts` from
 * `now`. Malformed lines are skipped.
 */
export function parseEventStream(jsonlText, now = () => new Date().toISOString()) {
  const events = [];
  for (const line of String(jsonlText ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    events.push(withUnwrappedCommand({ ts: now(), ...raw }));
  }
  return events;
}

/**
 * Records from driver-events.jsonl text, v1 or legacy (bare codex events).
 * Legacy events carry no arrival time; with `now`, each one is stamped with it.
 */
export function readDriverRecord(text, now) {
  if (!now) return parseDriverRecords(text);
  return toDriverRecords(parseEventStream(text, now));
}

/**
 * The codex events inside a record, each stamped with `ts` = received_at,
 * its invocation and its thread id.
 */
export function codexEvents(records) {
  const out = [];
  for (const rec of records) {
    if (rec.kind !== "codex" || !rec.event) continue;
    out.push(
      withUnwrappedCommand({
        ts: rec.received_at ?? null,
        invocation: rec.invocation,
        thread_id: rec.thread_id ?? null,
        ...rec.event,
      }),
    );
  }
  return out;
}

/**
 * Every `turn.completed` usage block, in stream order. On codex 0.160.1 the
 * value is the thread's running total, not the turn's own usage.
 */
export function extractTurnUsage(events) {
  const usages = [];
  let turnIndex = 0;
  for (const ev of events) {
    if (ev.type === "turn.started") turnIndex++;
    if (ev.type === "turn.completed" && ev.usage) {
      usages.push({ turn_index: turnIndex, usage: ev.usage });
    }
  }
  return usages;
}

const RULE_REASON =
  "driver loop cost — never dispatched through execute_with_model (D1); modeled from the codex exec " +
  "--json thread totals (each turn priced as the difference from the previous total), not a routed call";

/** One driver-cost-modeled.jsonl row for a DriverTurn (see driverUsage.ts). */
export function driverCostRow(turn, { runId, model, pricing, policyName, policyVersion = 1 }) {
  const complete = turn.status === "complete" && turn.delta;
  const priced = complete ? priceUsage(turn.delta, pricing) : null;
  return {
    ts: turn.ended_at ?? turn.started_at ?? null,
    pass: runId,
    phase: "driver_loop",
    task_type: "conductor",
    task_id: `driver-i${turn.invocation}-t${turn.turn}`,
    module: "driver",
    model,
    provenance: "modeled",
    routed_by: "manual",
    routing: { policy_name: policyName, policy_version: policyVersion, rule_index: -1, rule_reason: RULE_REASON },
    input_tokens: priced ? priced.tokens.input : null,
    input_tokens_cached: priced ? priced.tokens.input_cached : null,
    output_tokens: priced ? priced.tokens.output : null,
    output_tokens_reasoning: priced ? priced.reasoning : null,
    cost_usd: priced ? priced.cost_usd : null,
    latency_ms: null,
    success: Boolean(complete),
    retry_count: 0,
    invocation: turn.invocation,
    thread_id: turn.thread_id,
    status: complete ? "complete" : "incomplete",
    incomplete_reason: complete ? null : turn.incomplete_reason,
    usage_source: "exec-stream",
    ...(turn.flags?.length ? { driver_flags: turn.flags } : {}),
  };
}

function requirePolicyName(opts) {
  if (typeof opts?.policyName !== "string" || !opts.policyName) {
    throw new Error("event-reader: policyName is required; a driver row names the policy the run used.");
  }
}

/** Modeled rows, complete and incomplete, for every driver turn in a run's records. */
export function modeledDriverCostRows(records, opts) {
  requirePolicyName(opts);
  return driverTurns(records, { baselines: opts.baselines }).map((t) => driverCostRow(t, opts));
}

/**
 * The same rows for an already-parsed bare stream (parseEventStream output),
 * which carries no invocation markers: each thread.started opens one.
 * Takes `pass` as the run id for compatibility with older callers.
 */
export function modeledDriverCostEvents(events, opts) {
  requirePolicyName(opts);
  const records = toDriverRecords(events);
  return modeledDriverCostRows(records, { ...opts, runId: opts.runId ?? opts.pass });
}

#!/usr/bin/env node
/**
 * plan-packets — Phase 4's planner packet, and the plan that comes back. The planner is a dispatched worker that sees
 * only its packet, so the plan's shape is held by the shipped schema in plugin/config/schemas/ and every child is
 * checked here before packets.json exists.
 *
 * Usage:
 *   node plan-packets.mjs --build --run-dir=<dir> --instruction=<file> [--inputs=<file>] [--previous=<result.json>]
 *   node plan-packets.mjs --accept=<result.json> --run-dir=<dir>
 *
 * --build writes <run-dir>/tp-plan-<n>.json and prints it with the --out path its dispatch writes. --inputs is a JSON
 * array of {path, reason, content?}; a missing or empty content is read from disk. --previous names the refused
 * plan's result: its problems and the refused plan go into the new packet, and it counts as an attempt.
 * --accept reads a dispatch result (dispatch.mjs --out) and writes <run-dir>/packets.json.
 *
 * Exit codes: 0 done; 1 the plan was refused (numbered problems on stderr, nothing written) or the planner has had
 * its attempts; 2 usage, or a run record, instruction or inputs file this script cannot use.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFlags, readRunJson, UsageError } from "../codex/interactive-run.mjs";
import { FROZEN_FILE, readRegular } from "./lib/contract-lock.mjs";
import { CREATABLE_WHEN_ABSENT, firstMatch, hardcodedHit } from "./lib/off-limits.mjs";
import { isRunId } from "./lib/run-id.mjs";
import { guardedHit, insidePath, judgedPaths, realPath } from "./lib/write-guard.mjs";
import { projectOffLimits } from "./write-contract.mjs";
import { scan } from "./dispatch-sanitize.mjs";
import { isMain } from "./lib/is-main.mjs";
import { exitAfterFlush } from "./lib/exit.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PLAN_ATTEMPTS = 3;
export const PLAN_SCHEMA_FILES = Object.freeze({
  greenfield: "plan-packets.greenfield.json",
  brownfield: "plan-packets.brownfield.json",
});
export const MAX_INPUT_BYTES = 128 * 1024;
export const PLAN_FLAGS = Object.freeze({ value: ["run-dir", "instruction", "inputs", "previous", "accept"], boolean: ["build"] });

const MAX_PACKET_INPUT_BYTES = 384 * 1024;
const MAX_PACKETS = 200;
// Reasoning tokens count against the ceiling; the OpenAI adapter doubles it on truncation.
const PLAN_OUTPUT_TOKENS = 8000;
const PLAN_FIELDS = [
  "phase", "task_type", "subtype", "module", "instruction", "inputs", "output_schema_json", "acceptance", "budget",
  "artifact_path",
];
/** Run metadata: the script sets these from the run record, whatever a planner wrote there. */
const RUN_FIELDS = new Set(["id", "pass_id", "intent", "retry_count"]);
const FIELD_HINTS = {
  task_id: "the script numbers the packets itself",
  title: "put it in instruction",
  path: "the path a packet writes is artifact_path",
  type: "the work type is task_type",
  outputSchema: "give the child's schema as output_schema_json, a JSON string",
  depends_on: "list the packets in dependency order instead",
};
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const SCHEMA_KEYWORDS = ["type", "anyOf", "oneOf", "allOf", "enum", "const", "$ref", "not"];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (v) => JSON.stringify(v);
const firstLine = (v) => String(v ?? "").split("\n")[0];

export function loadPlanSchema(mode, pluginRoot = PLUGIN_ROOT) {
  return JSON.parse(readFileSync(join(pluginRoot, "config", "schemas", PLAN_SCHEMA_FILES[mode]), "utf-8"));
}

const childProperties = (schema) => schema.properties.packets.items.properties;

// ── the run ─────────────────────────────────────────────────────────────────

/** run-folder.mjs reads driver-events.jsonl through the built bridge, which only a headless run's folder needs. */
async function headlessSettings(runDir) {
  let folder;
  try {
    folder = await import("../codex/run-folder.mjs");
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new UsageError(`the dispatch bridge is not built (${err.message}); run verify-setup.mjs --fix first.`);
  }
  return folder.runSettings(folder.readRunRecords(runDir));
}

function readJsonFile(path, maxBytes = 1024 * 1024) {
  const bytes = readRegular(path, maxBytes);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

export function briefTaskType(text, allowed) {
  const lines = String(text ?? "").split("\n");
  const at = lines.findIndex((l) => /^##\s+Task type\b/i.test(l));
  if (at === -1) return null;
  for (const line of lines.slice(at + 1)) {
    if (/^#/.test(line)) return null;
    const word = line.replace(/[`*\-\s]+/g, " ").trim().split(" ")[0];
    if (word) return allowed.includes(word) ? word : null;
  }
  return null;
}

/** run.json on the interactive route, driver-events.jsonl on the headless one. */
export async function readRunFacts(runDirArg, { pluginRoot = PLUGIN_ROOT } = {}) {
  const runDir = resolve(String(runDirArg));
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) throw new UsageError(`--run-dir=${runDirArg} is not a folder.`);

  let rec = null;
  const session = readRunJson(runDir);
  if (session) {
    rec = session;
  } else {
    const s = await headlessSettings(runDir);
    if (s) rec = { ...s, mode: s.run_mode === "greenfield" ? "greenfield" : "brownfield", project_root: s.cwd };
  }
  if (!rec) {
    throw new UsageError(`${runDir} holds no run record (run.json or driver-events.jsonl): Phase 4 runs inside a run start-run.mjs or run.mjs started.`);
  }
  const runId = rec.run_id;
  if (!isRunId(runId)) throw new UsageError(`the run record in ${runDir} names no run id.`);
  const mode = rec.mode === "greenfield" ? "greenfield" : "brownfield";
  const canonicalRoot = basename(dirname(runDir)) === "runs" && basename(dirname(dirname(runDir))) === ".sdlc"
    ? dirname(dirname(dirname(runDir)))
    : null;
  const projectRoot = typeof rec.project_root === "string" ? resolve(rec.project_root) : canonicalRoot;
  if (!projectRoot) throw new UsageError(`the run record in ${runDir} names no project root.`);
  const codeDir = typeof rec.code_dir === "string" ? resolve(rec.code_dir) : mode === "greenfield" ? join(projectRoot, "src") : projectRoot;
  const codeRel = insidePath(projectRoot, codeDir);
  if (codeRel === null) throw new UsageError(`the run's code directory ${codeDir} is outside its project root ${projectRoot}.`);
  const runRel = insidePath(projectRoot, runDir);
  const schema = loadPlanSchema(mode, pluginRoot);

  const facts = {
    runDir, runId, mode, projectRoot, codeDir,
    stacksDir: join(pluginRoot, "skills", "pipeline", "stacks"),
    codeRel,
    runRel,
    notesPrefix: runRel ? `${runRel}/notes/` : null,
    schema,
    phases: childProperties(schema).phase.enum,
    taskTypes: childProperties(schema).task_type.enum ?? null,
    intent: null,
    contract: null,
    offLimits: [],
    briefTaskType: null,
  };

  if (mode === "brownfield") {
    const intent = rec.intent ?? readJsonFile(join(runDir, "provenance.json"))?.intent ?? null;
    if (typeof intent !== "string" || !intent) {
      throw new UsageError(`run ${runId} records no intent (run record or provenance.json): a brownfield plan carries one on every packet.`);
    }
    const contract = readJsonFile(join(runDir, FROZEN_FILE), 128 * 1024);
    if (!isObject(contract) || !Array.isArray(contract.allowlist) || !Array.isArray(contract.off_limits)) {
      throw new UsageError(`no frozen write contract at ${join(runDir, FROZEN_FILE)}: a brownfield plan comes after Gate 0 froze it.`);
    }
    if (contract.run_id !== runId) throw new UsageError(`${join(runDir, FROZEN_FILE)} is run ${contract.run_id}'s contract, not run ${runId}'s.`);
    facts.intent = intent;
    facts.contract = contract;
    facts.offLimits = contract.off_limits.filter((p) => typeof p === "string");
    const briefPaths = [join(runDir, "intent_brief.md"), ...(typeof rec.brief_path === "string" ? [rec.brief_path] : [])];
    for (const p of briefPaths) {
      const bytes = readRegular(p, 256 * 1024);
      if (!bytes) continue;
      facts.briefTaskType = briefTaskType(bytes.toString("utf8"), facts.taskTypes);
      break;
    }
  } else {
    facts.offLimits = projectOffLimits(projectRoot);
  }
  return facts;
}

// ── paths ───────────────────────────────────────────────────────────────────

/** A path as written, made project-relative, or the reason it cannot be one. A leading `./` is dropped. */
export function relPath(raw) {
  if (typeof raw !== "string") return { problem: `is ${quote(raw)}, not a path` };
  if (raw.trim() === "") return { problem: "is empty" };
  if (raw.includes("\0") || raw.includes("\\")) return { problem: `${quote(raw)} holds a backslash; write the path with / between folders` };
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return { problem: `${quote(raw)} is absolute; write it relative to the project root` };
  const rel = raw.replace(/^(?:\.\/)+/, "");
  const names = rel.split("/");
  if (names.includes("..")) return { problem: `${quote(raw)} climbs out of its folder with ".."` };
  if (names.some((n) => n === "" || n === ".")) {
    return { problem: `${quote(raw)} is not a normalised path; write ${quote(posix.normalize(rel).replace(/\/+$/, ""))}` };
  }
  return { rel };
}

function offLimitsHit(facts, rel) {
  const hard = hardcodedHit(rel);
  if (hard) return hard;
  return firstMatch(rel, facts.offLimits, { ci: true });
}

/**
 * Where a slice is read from: a project-relative path, or (`absoluteOk`) an absolute one inside the project, the run
 * folder or the plugin's stack guides. Checked as written and with links resolved, as the write guard checks a write.
 */
function locateRead(facts, raw, { absoluteOk = false } = {}) {
  let abs;
  let label;
  if (absoluteOk && typeof raw === "string" && isAbsolute(raw)) {
    const inProject = insidePath(facts.projectRoot, raw);
    if (inProject === null && insidePath(facts.runDir, raw) === null && insidePath(facts.stacksDir, raw) === null) {
      return { problem: `${quote(raw)} is outside the project, the run folder and the plugin's stack guides` };
    }
    abs = raw;
    label = inProject ?? raw;
  } else {
    const r = relPath(raw);
    if (r.problem) return r;
    abs = join(facts.projectRoot, r.rel);
    label = r.rel;
  }
  const root = [facts.projectRoot, facts.runDir, facts.stacksDir].find((d) => insidePath(d, abs) !== null);
  const { paths, leaves } = judgedPaths(root, abs);
  if (leaves) return { problem: `${quote(label)} leads outside ${root === facts.projectRoot ? "the project" : "its folder"} through a link` };
  for (const p of paths) {
    const hit = root === facts.projectRoot ? offLimitsHit(facts, p) : hardcodedHit(p);
    if (hit) return { problem: `${quote(label)} is off-limits (pattern ${quote(hit)}), so it does not go to a model` };
  }
  return { abs, label };
}

function secretProblem(label, content) {
  const found = scan(content, { maxFindings: 1 })[0];
  return found ? `${quote(label)} holds what looks like a secret (${found.name}, line ${found.line}), so it does not go to a model; give a slice without it` : null;
}

function readText(abs, label) {
  const real = realPath(abs);
  let st;
  try {
    st = lstatSync(real);
  } catch {
    return { problem: `${quote(label)} has no file on disk to read` };
  }
  if (!st.isFile()) return { problem: `${quote(label)} is not a file` };
  if (st.size > MAX_INPUT_BYTES) {
    return { problem: `${quote(label)} is ${Math.ceil(st.size / 1024)} KB, over the ${MAX_INPUT_BYTES / 1024} KB a slice read from disk may hold; give the part the worker needs as content` };
  }
  const bytes = readRegular(real, MAX_INPUT_BYTES);
  if (!bytes) return { problem: `${quote(label)} could not be read` };
  if (bytes.includes(0)) return { problem: `${quote(label)} is not a text file` };
  return { content: bytes.toString("utf8") };
}

/**
 * The reason `rel` is not a path this run's plan may write, `{warning}` for a miss a non-strict contract allows, or {}.
 * Brownfield follows the write guard's order: the run's guarded records, the always-off-limits list, the run folder,
 * the contract's off-limits, then its allowlist.
 */
export function targetProblem(facts, rel) {
  const inNotes = facts.notesPrefix && rel.startsWith(facts.notesPrefix) && rel.length > facts.notesPrefix.length;
  const inRunFolder = facts.runRel && (rel === facts.runRel || rel.startsWith(`${facts.runRel}/`));
  const notes = facts.notesPrefix
    ? `a note that is not shipped code goes under ${facts.notesPrefix}`
    : "this run's folder is outside the project, so a plan writes no notes";
  if (facts.mode === "brownfield") {
    const c = facts.contract;
    const g = guardedHit(rel, facts.runId);
    if (g) return { problem: `${quote(rel)} is ${g}, a record the plugin keeps for the run` };
    const hard = hardcodedHit(rel);
    if (hard) return { problem: `${quote(rel)} matches always-off-limits pattern ${quote(hard)}` };
    if (inNotes) return {};
    if (inRunFolder) return { problem: `${quote(rel)} is in the run folder beside the run's own records; ${notes}` };
    const off = firstMatch(rel, c.off_limits, { ci: true });
    if (off) return { problem: `${quote(rel)} matches off-limits pattern ${quote(off)}` };
    if (firstMatch(rel, c.allowlist)) return {};
    const why = `${quote(rel)} is not in the run's frozen allowlist (${c.allowlist.map(quote).join(", ")}); ${notes}`;
    return c.strict === false ? { warning: `${why}. Allowed because the contract is not strict.` } : { problem: why };
  }
  const hard = hardcodedHit(rel);
  if (hard && !CREATABLE_WHEN_ABSENT.includes(rel.slice(rel.lastIndexOf("/") + 1).toLowerCase())) {
    return { problem: `${quote(rel)} matches always-off-limits pattern ${quote(hard)}` };
  }
  if (inNotes) return {};
  if (inRunFolder || rel === ".sdlc" || rel.startsWith(".sdlc/")) return { problem: `${quote(rel)} is among the run records; ${notes}` };
  if (facts.codeRel === "" || rel.startsWith(`${facts.codeRel}/`)) return {};
  return { problem: `${quote(rel)} is outside the code directory ${facts.codeRel}/; ${notes}` };
}

function checkTarget(facts, raw) {
  const r = relPath(raw);
  if (r.problem) return r;
  const { paths, leaves } = judgedPaths(facts.projectRoot, join(facts.projectRoot, r.rel));
  if (leaves) return { problem: `${quote(r.rel)} leads outside the project through a link` };
  const warnings = [];
  for (const p of paths) {
    const v = targetProblem(facts, p);
    if (v.problem) return { problem: p === r.rel ? v.problem : `${quote(r.rel)} resolves to ${quote(p)} through a link: ${v.problem}` };
    if (v.warning) warnings.push(v.warning);
  }
  return { rel: r.rel, warnings };
}

// ── the child's own schema ──────────────────────────────────────────────────

export function childSchemaProblem(node, at = "", depth = 0) {
  const where = at ? `${at} ` : "";
  if (depth > 32) return `${where}nests too deep`;
  if (!isObject(node)) return `${where}is not a JSON Schema object`;
  // GeminiFlashAdapter's marker for a markdown reply.
  if ("__free_text__" in node) return node.__free_text__ === true && Object.keys(node).length === 1 ? null : `${where}mixes __free_text__ with a schema`;
  if (!SCHEMA_KEYWORDS.some((k) => k in node)) {
    return `${where}names no type (it holds ${Object.keys(node).slice(0, 4).map(quote).join(", ") || "nothing"}); give each value a {"type": ...} schema`;
  }
  if ("type" in node) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.length === 0 || !types.every((t) => JSON_TYPES.has(t))) return `${where}type ${quote(node.type)} is not a JSON Schema type`;
  }
  if ("properties" in node) {
    if (!isObject(node.properties)) return `${where}properties is not an object`;
    for (const [k, v] of Object.entries(node.properties)) {
      const p = childSchemaProblem(v, `${at}properties.${k}`.replace(/^\./, ""), depth + 1);
      if (p) return p;
    }
  }
  if ("required" in node && !(Array.isArray(node.required) && node.required.every((r) => typeof r === "string"))) {
    return `${where}required is not a list of property names`;
  }
  if ("items" in node && typeof node.items !== "boolean") {
    const list = Array.isArray(node.items) ? node.items : [node.items];
    for (const [i, v] of list.entries()) {
      const p = childSchemaProblem(v, `${at}items${Array.isArray(node.items) ? `[${i}]` : ""}`, depth + 1);
      if (p) return p;
    }
  }
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (!(k in node)) continue;
    if (!Array.isArray(node[k]) || node[k].length === 0) return `${where}${k} is not a non-empty list`;
    for (const [i, v] of node[k].entries()) {
      const p = childSchemaProblem(v, `${at}${k}[${i}]`, depth + 1);
      if (p) return p;
    }
  }
  return null;
}

// ── a plan ──────────────────────────────────────────────────────────────────

export function readDispatchResult(path) {
  const abs = resolve(String(path));
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf-8"));
  } catch (err) {
    throw new UsageError(`cannot read the dispatch result ${abs}: ${err?.code === "ENOENT" ? "no such file" : err.message}.`);
  }
  if (!isObject(parsed) || !isObject(parsed.result)) throw new UsageError(`${abs} is not a dispatch result (the --out file of dispatch.mjs).`);
  return { path: abs, result: parsed };
}

function planValue(result) {
  const r = result.result;
  if (r.success !== true) {
    if (String(r.terminal_reason ?? "").startsWith("output_cap")) {
      return { problem: "The reply was cut off at its output ceiling before the plan was complete. Plan fewer packets, or shorter instructions." };
    }
    return { problem: `The plan dispatch did not succeed (terminal_reason ${r.terminal_reason ?? "unknown"}): ${firstLine(r.error ?? "no error recorded")}.` };
  }
  let value = r.result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { problem: "The reply is not JSON." };
    }
  }
  if (isObject(value) && value._truncated === true) return { problem: "The reply was cut off at its output ceiling. Plan fewer packets, or shorter instructions." };
  if (isObject(value) && Object.keys(value).length === 1 && typeof value.raw === "string") return { problem: "The reply is not JSON." };
  return { value };
}

export function judgePlan(facts, result) {
  const events = Array.isArray(result.events) ? result.events.filter(isObject) : [];
  const event = events[0] ?? null;
  if (event?.phase && event.phase !== "plan_task_packets") throw new UsageError(`that result is a ${event.phase} dispatch, not a plan.`);
  if (event?.pass && event.pass !== facts.runId) throw new UsageError(`that result is from run ${event.pass}, not run ${facts.runId}.`);
  const attempt = Number.isInteger(event?.retry_count) && event.retry_count >= 0 ? event.retry_count + 1 : 1;

  const problems = [];
  const warnings = [];
  const out = { attempt, problems, warnings, packets: null, value: undefined };
  const got = planValue(result);
  if (got.problem) {
    problems.push(got.problem);
    return out;
  }
  const plan = got.value;
  out.value = plan;
  if (Array.isArray(plan)) {
    problems.push('The plan is a bare list. Return an object, {"packets": [...]}.');
    return out;
  }
  if (!isObject(plan)) {
    problems.push(`The plan is ${plan === null ? "null" : `a ${typeof plan}`}. Return an object, {"packets": [...]}.`);
    return out;
  }
  for (const k of Object.keys(plan)) if (k !== "packets") problems.push(`The plan has a field ${quote(k)}; its only field is "packets".`);
  if (!Array.isArray(plan.packets) || plan.packets.length === 0) {
    problems.push('"packets" must be a non-empty list of packets.');
    return out;
  }
  if (plan.packets.length > MAX_PACKETS) {
    problems.push(`The plan has ${plan.packets.length} packets, more than ${MAX_PACKETS}. Plan file-sized units, one packet per file.`);
    return out;
  }

  const children = plan.packets.map((raw, i) => judgeFields(facts, raw, `packets[${i}]`, problems, warnings));

  // Targets first: an input may name a file an earlier packet writes.
  const writers = new Map();
  children.forEach((c, i) => {
    if (!c?.artifact_path) return;
    const key = c.artifact_path.toLowerCase();
    if (writers.has(key)) {
      problems.push(`packets[${writers.get(key)}] and packets[${i}] both write ${quote(c.artifact_path)}. Plan one packet per file.`);
    } else writers.set(key, i);
  });
  children.forEach((c, i) => {
    if (c) c.inputs = judgeInputs(facts, c.rawInputs, `packets[${i}]`, i, writers, problems);
  });
  if (problems.length > 0) return out;

  const seq = {};
  out.packets = children.map((c) => {
    seq[c.phase] = (seq[c.phase] ?? 0) + 1;
    return {
      id: `tp_${c.phase}_${String(seq[c.phase]).padStart(3, "0")}`,
      phase: c.phase,
      task_type: c.task_type,
      ...(c.subtype ? { subtype: c.subtype } : {}),
      module: c.module,
      instruction: c.instruction,
      inputs: c.inputs,
      outputSchema: c.outputSchema,
      acceptance: c.acceptance,
      budget: c.budget,
      retry_count: 0,
      pass_id: facts.runId,
      ...(facts.mode === "brownfield" ? { intent: facts.intent } : {}),
      ...(c.artifact_path ? { artifact_path: c.artifact_path } : {}),
    };
  });
  return out;
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

function judgeFields(facts, raw, at, problems, warnings) {
  const fail = (msg) => problems.push(`${at}${msg}`);
  if (!isObject(raw)) {
    fail(` is ${Array.isArray(raw) ? "a list" : `a ${raw === null ? "null" : typeof raw}`}, not a packet object.`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (PLAN_FIELDS.includes(k) || RUN_FIELDS.has(k)) continue;
    fail(` has a field ${quote(k)} the plan does not take: ${FIELD_HINTS[k] ?? `a packet's fields are ${PLAN_FIELDS.join(", ")}`}.`);
  }
  const brown = facts.mode === "brownfield";
  for (const k of PLAN_FIELDS) {
    if (k in raw) continue;
    if (k === "subtype" || (k === "artifact_path" && !brown)) continue;
    fail(` has no ${k}.`);
  }

  const c = { rawInputs: raw.inputs };
  if ("phase" in raw) {
    if (facts.phases.includes(raw.phase)) c.phase = raw.phase;
    else fail(`.phase ${quote(raw.phase)} is not a phase a planned packet takes. Use one of: ${facts.phases.join(", ")}.`);
  }
  if ("task_type" in raw) {
    const t = raw.task_type;
    if (facts.taskTypes ? !facts.taskTypes.includes(t) : !(typeof t === "string" && /^[a-z][a-z0-9_]*$/.test(t))) {
      fail(facts.taskTypes
        ? `.task_type ${quote(t)} is not a brownfield task type. Use one of: ${facts.taskTypes.join(", ")}.`
        : `.task_type ${quote(t)} is not a snake_case work type, such as controller_handler or test_unit.`);
    } else if (facts.briefTaskType && t !== facts.briefTaskType) {
      fail(`.task_type ${quote(t)} differs from the intent brief's task type; every packet in this run is ${quote(facts.briefTaskType)}.`);
    } else c.task_type = t;
  }
  if (raw.subtype !== undefined && raw.subtype !== null && typeof raw.subtype !== "string") fail(".subtype must be a string or null.");
  else c.subtype = nonEmpty(raw.subtype) ? raw.subtype.trim() : null;
  if ("module" in raw) {
    if (nonEmpty(raw.module) && raw.module.length <= 64 && !raw.module.includes("\n")) c.module = raw.module.trim();
    else fail(".module must be a short name, such as auth or cross.");
  }
  if ("instruction" in raw) {
    if (nonEmpty(raw.instruction)) c.instruction = raw.instruction.trim();
    else fail(".instruction is empty.");
  }
  if ("inputs" in raw && !Array.isArray(raw.inputs)) {
    fail(`.inputs is ${typeof raw.inputs === "string" ? "a string" : isObject(raw.inputs) ? "an object" : quote(raw.inputs)}; give a list of {"path", "content", "reason"} slices, [] when the worker reads none.`);
  }
  if ("output_schema_json" in raw) {
    const s = raw.output_schema_json;
    let parsed;
    let ok = typeof s === "string";
    if (!ok) fail(".output_schema_json must be a string holding the child's JSON Schema, JSON-encoded.");
    else {
      try {
        parsed = JSON.parse(s);
      } catch {
        ok = false;
        fail(`.output_schema_json does not parse as JSON: ${quote(s.slice(0, 80))}. Encode a JSON Schema object, such as {"type":"object","properties":{"content":{"type":"string"}},"required":["content"]}.`);
      }
    }
    if (ok) {
      const p = childSchemaProblem(parsed);
      if (p) fail(`.output_schema_json ${p}.`);
      else c.outputSchema = parsed;
    }
  }
  if ("acceptance" in raw) {
    const a = raw.acceptance;
    if (Array.isArray(a) && a.length > 0 && a.every(nonEmpty)) c.acceptance = a.map((x) => x.trim());
    else fail(".acceptance must be a non-empty list of testable bullets, each a non-empty string.");
  }
  if ("budget" in raw) {
    const b = raw.budget;
    const whole = (n) => Number.isInteger(n) && n > 0;
    if (isObject(b) && whole(b.maxInputTokens) && whole(b.maxOutputTokens) && Object.keys(b).length === 2) {
      c.budget = { maxInputTokens: b.maxInputTokens, maxOutputTokens: b.maxOutputTokens };
    } else fail(`.budget must be {"maxInputTokens": <whole number>, "maxOutputTokens": <whole number>}, got ${quote(b)}.`);
  }
  if (raw.artifact_path === null && brown) fail(".artifact_path is null; every brownfield packet names the one path it writes.");
  else if (raw.artifact_path !== undefined && raw.artifact_path !== null) {
    const t = checkTarget(facts, raw.artifact_path);
    if (t.problem) fail(`.artifact_path ${t.problem}.`);
    else {
      c.artifact_path = t.rel;
      warnings.push(...t.warnings.map((w) => `${at}.artifact_path ${w}`));
    }
  }
  return c;
}

function judgeInputs(facts, inputs, at, index, writers, problems) {
  if (!Array.isArray(inputs)) return null;
  const out = [];
  let bytes = 0;
  inputs.forEach((s, j) => {
    const where = `${at}.inputs[${j}]`;
    if (typeof s === "string") {
      problems.push(`${where} is a string (${quote(s.slice(0, 60))}); give {"path", "content", "reason"}, with content "" to have the file read from disk.`);
      return;
    }
    if (!isObject(s) || typeof s.path !== "string" || typeof s.content !== "string" || typeof s.reason !== "string") {
      problems.push(`${where} must be {"path": string, "content": string, "reason": string}.`);
      return;
    }
    for (const k of Object.keys(s)) if (!["path", "content", "reason"].includes(k)) problems.push(`${where} has a field ${quote(k)}; a slice holds path, content and reason.`);
    if (!nonEmpty(s.reason)) problems.push(`${where}.reason is empty; say why the worker needs it.`);
    const r = relPath(s.path);
    if (r.problem) {
      problems.push(`${where}.path ${r.problem}.`);
      return;
    }
    const hit = offLimitsHit(facts, r.rel);
    if (hit) {
      problems.push(`${where}.path ${quote(r.rel)} is off-limits (pattern ${quote(hit)}), so it does not go to a model.`);
      return;
    }
    const writer = writers.get(r.rel.toLowerCase());
    let content = s.content;
    if (content.trim() === "") {
      if (writer !== undefined && writer < index) {
        content = "";
      } else {
        const where2 = locateRead(facts, r.rel);
        const read = where2.problem ? where2 : readText(where2.abs, r.rel);
        if (read.problem) {
          problems.push(writer !== undefined && writer > index
            ? `${where} reads ${quote(r.rel)}, which packets[${writer}] writes later. List the packets in dependency order.`
            : `${where}.path ${read.problem}.`);
          return;
        }
        content = read.content;
      }
    }
    const secret = secretProblem(r.rel, content);
    if (secret) {
      problems.push(`${where}.content ${secret}.`);
      return;
    }
    bytes += Buffer.byteLength(content);
    out.push({ path: r.rel, content, reason: s.reason.trim() });
  });
  if (bytes > MAX_PACKET_INPUT_BYTES) {
    problems.push(`${at}.inputs hold ${Math.ceil(bytes / 1024)} KB, over the ${MAX_PACKET_INPUT_BYTES / 1024} KB one packet may carry. Slice them.`);
  }
  return out;
}

// ── the planner packet ──────────────────────────────────────────────────────

/** The rules the planner is told, from the run record. The checks above hold it to each of them. */
export function planRules(facts) {
  const lines = [
    "## Plan rules",
    "These hold for every packet. A plan that breaks one is refused and planned again.",
    "",
    "- List the packets in dependency order: each runs only after every packet before it.",
    "- One packet per file: no two packets share an artifact_path.",
    "- Paths are relative to the project root, with / between folders, and never climb out with `..`.",
    `- Leave an input's content empty to have the file read from disk (at most ${MAX_INPUT_BYTES / 1024} KB). A file an earlier packet writes is read once that packet has run.`,
    "- output_schema_json is the JSON Schema the worker's reply must match, encoded as a JSON string.",
    "- budget.maxOutputTokens: 3000 for a source, test or doc file; 5000 for a large one. maxInputTokens: about the inputs' size in tokens plus 2000.",
    `- Run id ${facts.runId}. ${facts.runRel ? `The run's records (requirements.md, design.md) are under ${facts.runRel}/.` : ""}`.trimEnd(),
    facts.notesPrefix
      ? `- A note that is not shipped code (a reproduction, a diagnosis) is written under ${facts.notesPrefix}.`
      : "- This run's folder is outside the project, so the plan writes no notes.",
  ];
  if (facts.mode === "brownfield") {
    lines.push(
      `- Every packet's artifact_path matches the run's frozen allowlist: ${facts.contract.allowlist.map((g) => `\`${g}\``).join(", ")}, or is a note.`,
      `- Never name these, as a target or an input: ${facts.offLimits.map((g) => `\`${g}\``).join(", ")}.`,
    );
    if (facts.briefTaskType) lines.push(`- Every packet's task_type is \`${facts.briefTaskType}\`, the one the intent brief names.`);
  } else {
    lines.push(
      `- Generated code goes under \`${facts.codeRel || "."}/\`; artifact_path is null only for a packet that writes no file.`,
      "- Never name secrets or tool config (`.env`, `.git/`, `.codex/`, `.agents/`) as an input or a target; `.env.example` and `.env.test` may be targets.",
    );
  }
  return lines.join("\n");
}

function nextPlanSeq(runDir) {
  let max = 0;
  for (const name of readdirSync(runDir)) {
    const m = /^tp-plan-(\d+)(?:-result)?\.json$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(3, "0");
}

/** A problem here is the conductor's command, not the planner's, so it exits 2 and is not an attempt. */
function conductorInputs(facts, path) {
  if (!path) return [];
  let list;
  try {
    list = JSON.parse(readFileSync(resolve(path), "utf-8"));
  } catch (err) {
    throw new UsageError(`cannot read --inputs=${path}: ${err?.code === "ENOENT" ? "no such file" : err.message}.`);
  }
  if (!Array.isArray(list)) throw new UsageError(`--inputs=${path} must hold a JSON list of {"path", "reason"} slices.`);
  const problems = [];
  const out = [];
  list.forEach((s, i) => {
    const where = `inputs[${i}]`;
    if (!isObject(s) || typeof s.path !== "string" || !nonEmpty(s.reason) || (s.content !== undefined && typeof s.content !== "string")) {
      problems.push(`${where} must be {"path": string, "reason": string}, with an optional "content" string.`);
      return;
    }
    const at = locateRead(facts, s.path, { absoluteOk: true });
    if (at.problem) {
      problems.push(`${where}.path ${at.problem}.`);
      return;
    }
    let content = s.content ?? "";
    if (content.trim() === "") {
      const read = readText(at.abs, at.label);
      if (read.problem) {
        problems.push(`${where}.path ${read.problem}.`);
        return;
      }
      content = read.content;
    }
    const secret = secretProblem(at.label, content);
    if (secret) {
      problems.push(`${where}.content ${secret}.`);
      return;
    }
    out.push({ path: at.label, content, reason: s.reason.trim() });
  });
  const bytes = out.reduce((n, s) => n + Buffer.byteLength(s.content), 0);
  if (bytes > MAX_PACKET_INPUT_BYTES) {
    problems.push(`the slices hold ${Math.ceil(bytes / 1024)} KB, over the ${MAX_PACKET_INPUT_BYTES / 1024} KB one packet may carry; slice the largest.`);
  }
  if (problems.length) throw new UsageError(`--inputs=${path} was not used; nothing was written:\n${numbered(problems)}`);
  return out;
}

const MAX_LISTED = 30;
const numbered = (items) => {
  const shown = items.slice(0, MAX_LISTED).map((p, i) => `${i + 1}. ${p}`);
  if (items.length > MAX_LISTED) shown.push(`${MAX_LISTED + 1}. And ${items.length - MAX_LISTED} more problems of the kinds above.`);
  return shown.join("\n");
};

export function buildPlanPacket(facts, { instruction, inputs = [], previous = null, seq = "001" }) {
  let attempt = 1;
  const parts = [instruction.trim(), "", planRules(facts)];
  const slices = [...inputs];
  if (previous) {
    const judged = judgePlan(facts, previous.result);
    if (judged.problems.length === 0) {
      throw new UsageError(`${previous.path} holds a plan that passes: run --accept on it instead of planning again.`);
    }
    if (judged.attempt >= PLAN_ATTEMPTS) return { limit: true, attempt: judged.attempt };
    attempt = judged.attempt + 1;
    parts.push(
      "",
      "## Your previous plan was refused",
      "Return a corrected plan. Fix every problem below; keep what was not named.",
      numbered(judged.problems),
    );
    const refused = judged.value === undefined ? null : JSON.stringify(judged.value, null, 2);
    if (refused && Buffer.byteLength(refused) <= MAX_INPUT_BYTES) {
      slices.push({
        path: insidePath(facts.projectRoot, previous.path) ?? previous.path,
        content: refused,
        reason: "The plan you returned last time, refused for the problems listed in the instruction.",
      });
    }
  }
  const text = parts.join("\n");
  const size = text.length + JSON.stringify(slices).length + JSON.stringify(facts.schema).length;
  const packet = {
    id: `tp_plan_${seq}`,
    phase: "plan_task_packets",
    task_type: "plan",
    module: "cross",
    instruction: text,
    inputs: slices,
    outputSchema: facts.schema,
    acceptance: [
      "Returns one object whose packets list holds the whole plan, in dependency order.",
      "Every packet keeps to the plan rules in the instruction.",
      "Each output_schema_json parses to a JSON Schema object.",
    ],
    budget: { maxInputTokens: Math.ceil(size / 4 / 1000) * 1000 + 2000, maxOutputTokens: PLAN_OUTPUT_TOKENS },
    retry_count: attempt - 1,
    pass_id: facts.runId,
    ...(facts.mode === "brownfield" ? { intent: facts.intent, ...(facts.runRel ? { artifact_path: `${facts.runRel}/packets.json` } : {}) } : {}),
  };
  return { packet, attempt };
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

function stopRecord(resultPath) {
  return JSON.stringify({
    reason: `Phase 4: the planner returned no plan that passes plan-packets.mjs in ${PLAN_ATTEMPTS} attempts.`,
    needs:
      `Read the problems plan-packets.mjs --accept prints for ${resultPath}, then narrow or correct the plan ` +
      "instruction (the design sections and the files each packet changes) and resume the run from Phase 4.",
  });
}

function limitMessage(facts, resultPath) {
  return (
    `plan-packets: the planner has had its ${PLAN_ATTEMPTS} attempts and no plan passed. Do not dispatch another plan.\n` +
    `Stop the run. On the run.mjs route write ${join(facts.runDir, "stop.json")}:\n${stopRecord(resultPath)}\n` +
    "In a session, tell the user why and record the end with --outcome=stopped.\n"
  );
}

// ── the command ─────────────────────────────────────────────────────────────

export async function main(argv = [], deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const args = parseFlags(argv, { ...PLAN_FLAGS, script: "plan-packets.mjs" });
    const build = args.build === true;
    if (build === (args.accept !== undefined)) throw new UsageError("give one of --build or --accept=<result.json>.");
    if (args["run-dir"] === undefined) throw new UsageError("--run-dir=<the run folder> is required.");
    if (build && args.instruction === undefined) throw new UsageError("--build needs --instruction=<file>.");
    if (!build) {
      for (const f of ["instruction", "inputs", "previous"]) if (args[f] !== undefined) throw new UsageError(`--${f} goes with --build, not --accept.`);
    }
    const facts = await readRunFacts(args["run-dir"], deps);

    if (build) {
      let instruction;
      try {
        instruction = readFileSync(resolve(args.instruction), "utf-8");
      } catch (err) {
        throw new UsageError(`cannot read --instruction=${args.instruction}: ${err?.code === "ENOENT" ? "no such file" : err.message}.`);
      }
      if (instruction.trim() === "") throw new UsageError(`--instruction=${args.instruction} is empty: say what to plan.`);
      const inputs = conductorInputs(facts, args.inputs);
      const previous = args.previous !== undefined ? readDispatchResult(args.previous) : null;
      const seq = nextPlanSeq(facts.runDir);
      const built = buildPlanPacket(facts, { instruction, inputs, previous, seq });
      if (built.limit) {
        stderr.write(limitMessage(facts, previous.path));
        return 1;
      }
      const packetPath = join(facts.runDir, `tp-plan-${seq}.json`);
      writeAtomic(packetPath, JSON.stringify(built.packet, null, 2) + "\n");
      stdout.write(`packet: ${packetPath}\nresult: ${join(facts.runDir, `tp-plan-${seq}-result.json`)}\nattempt: ${built.attempt} of ${PLAN_ATTEMPTS}\n`);
      return 0;
    }

    const { path, result } = readDispatchResult(args.accept);
    const judged = judgePlan(facts, result);
    for (const w of judged.warnings) stderr.write(`warning: ${w}\n`);
    if (judged.problems.length > 0) {
      stderr.write(
        `plan-packets: the plan in ${path} was refused (attempt ${judged.attempt} of ${PLAN_ATTEMPTS}). Nothing was written.\n` +
          `${numbered(judged.problems)}\n`,
      );
      stderr.write(
        judged.attempt >= PLAN_ATTEMPTS
          ? limitMessage(facts, path)
          : `Next: run the --build command again with --previous='${path}' added; it hands these problems to the planner.\n`,
      );
      return 1;
    }
    const target = join(facts.runDir, "packets.json");
    writeAtomic(target, JSON.stringify(judged.packets, null, 2) + "\n");
    const byPhase = {};
    for (const p of judged.packets) byPhase[p.phase] = (byPhase[p.phase] ?? 0) + 1;
    const counts = Object.entries(byPhase).map(([k, n]) => `${k} ${n}`).join(", ");
    stdout.write(`packets: ${target} (${judged.packets.length} packets: ${counts})\n`);
    return 0;
  } catch (err) {
    stderr.write(`plan-packets: ${err?.message ?? err}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  exitAfterFlush(await main(process.argv.slice(2)));
}

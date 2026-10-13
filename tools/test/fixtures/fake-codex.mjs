/**
 * A stand-in for `codex` in the driver tests. Each `codex exec` call plays
 * the next step of the scenario named by FAKE_CODEX_SCENARIO and logs its
 * argv to FAKE_CODEX_LOG. `codex login status` prints FAKE_CODEX_AUTH.
 *
 * Step keys: fixture (a codex-0.160.1 capture to replay), events (raw lines
 * after thread.started), usage, message, failTurn, noThread, thread, stderr,
 * gates, summary, preflight, stop, question, guardDeny, telemetry, sleepMs (after
 * turn.started, or after turn.completed with sleepAfterTurn), ignoreTerm,
 * exit.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const env = process.env;

if (argv[0] === "login" && argv[1] === "status") {
  process.stdout.write(`${env.FAKE_CODEX_AUTH ?? "Logged in using ChatGPT"}\n`);
  process.exit(0);
}

const scenario = JSON.parse(readFileSync(env.FAKE_CODEX_SCENARIO, "utf-8"));
const statePath = `${env.FAKE_CODEX_SCENARIO}.state`;
const n = (existsSync(statePath) ? Number(readFileSync(statePath, "utf-8")) : 0) + 1;
writeFileSync(statePath, String(n));
const step = scenario.steps?.[n - 1] ?? scenario.default ?? {};
const log = (entry) => appendFileSync(env.FAKE_CODEX_LOG, JSON.stringify({ n, pid: process.pid, ...entry }) + "\n");
log({ argv, cwd: process.cwd() });

process.on("SIGTERM", () => {
  log({ signal: "SIGTERM" });
  if (!step.ignoreTerm) process.exit(143);
});
process.on("SIGHUP", () => {
  log({ signal: "SIGHUP" });
  process.exit(129);
});

const out = (ev) => process.stdout.write((typeof ev === "string" ? ev : JSON.stringify(ev)) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runDir = scenario.runDir;
const append = (path, line) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + "\n");
};

function writeFiles() {
  for (const g of step.gates ?? []) append(join(runDir, "gates.jsonl"), g);
  for (const t of step.telemetry ?? []) append(join(runDir, "telemetry.jsonl"), t);
  if (step.preflight) writeFileSync(join(runDir, "preflight.json"), JSON.stringify(step.preflight));
  if (step.stop) writeFileSync(join(runDir, "stop.json"), JSON.stringify(step.stop));
  if (step.question) writeFileSync(join(runDir, "question.json"), JSON.stringify({ question: step.question }));
  if (step.summary) writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
  if (step.guardDeny) {
    append(join(scenario.projectRoot, ".sdlc", "local", "guard-decisions.jsonl"), {
      ts: new Date().toISOString(),
      decision: "deny",
      ...step.guardDeny,
    });
  }
}

const thread = step.thread ?? scenario.thread ?? "01a1340d-41da-7e31-84cd-b0907e9bc31f";

if (step.fixture) {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "codex-0.160.1");
  writeFiles();
  for (const line of readFileSync(join(fixtures, `${step.fixture}.jsonl`), "utf-8").split("\n")) {
    if (line.trim()) out(line);
  }
} else {
  if (!step.noThread) out({ type: "thread.started", thread_id: thread });
  for (const ev of step.events ?? []) out(ev);
  out({ type: "turn.started" });
  if (step.sleepMs && !step.sleepAfterTurn) await sleep(step.sleepMs);
  if (step.stderr) process.stderr.write(step.stderr);
  writeFiles();
  if (step.failTurn) {
    out({ type: "turn.failed", error: { message: step.failTurn } });
  } else {
    out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: step.message ?? "ok" } });
    out({ type: "turn.completed", usage: step.usage ?? { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10 } });
  }
  if (step.sleepMs && step.sleepAfterTurn) await sleep(step.sleepMs);
}
if (step.fixture && step.stderr) process.stderr.write(step.stderr);
process.exitCode = step.exit ?? 0;

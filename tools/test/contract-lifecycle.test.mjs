/**
 * A brownfield run's write contract across the run's life, on both routes: the run end switches it off with the
 * run's outcome, a resume puts it back, a finished or aborted run is not reopened, and a project another run holds
 * is refused before spending. Offline: run.mjs drives fixtures/fake-codex.mjs, the session route runs in-process.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main as runMain } from "../../plugin/codex/run.mjs";
import { main as startMain } from "../../plugin/codex/start-run.mjs";
import { main as endMain } from "../../plugin/codex/end-run.mjs";
import { endWriteContract, finalizeRun } from "../../plugin/codex/run-finalize.mjs";
import { abandonRun, freezeContract } from "../../plugin/scripts/write-contract.mjs";
import { sessionHome } from "./fixtures/session-home.mjs";
import "./lib/stand-ins.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-codex.mjs");
const THREAD = "01a10f3e-4db6-7a70-8d73-a94d86244d4d";
const SESSION_HOME = sessionHome([THREAD]);
after(() => rmSync(SESSION_HOME, { recursive: true, force: true }));

const fakeSpawn = (bin, args, opts) => spawn(process.execPath, [FAKE, ...args], opts);
const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const readLines = (p) => (existsSync(p) ? readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);

/** A project folder that is the root of its git project, as the freeze requires. The path has a space in it. */
function repo() {
  const base = mkdtempSync(join(tmpdir(), "contract-life-"));
  const root = join(base, "my repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "brief.md"), "# Brief\n");
  const work = join(base, "work");
  mkdirSync(work);
  const runDir = (id) => join(root, ".sdlc", "runs", id);
  return {
    root,
    runDir,
    contract: () => readJson(join(root, ".sdlc", "local", "write-contract.json")),
    lock: (id) => readJson(join(runDir(id), "write-contract.lock.json")),
    calls: () => readLines(join(work, "fake.log")).filter((l) => l.argv),
    scenario(id, steps) {
      const path = join(work, "scenario.json");
      writeFileSync(path, JSON.stringify({ runDir: runDir(id), projectRoot: root, steps }));
      try { unlinkSync(`${path}.state`); } catch { /* first scenario */ }
    },
    async run(argv) {
      let out = "";
      let err = "";
      const code = await runMain(["--project-root", root, ...argv], {
        cwd: root,
        env: { ...process.env, CODEX_HOME: SESSION_HOME, FAKE_CODEX_SCENARIO: join(work, "scenario.json"), FAKE_CODEX_LOG: join(work, "fake.log") },
        spawnFn: fakeSpawn,
        stdin: { isTTY: false },
        signals: new EventEmitter(),
        isGitRepo: () => true,
        stdout: { write: (s) => ((out += s), true) },
        stderr: { write: (s) => ((err += s), true) },
      });
      return { code, out, err };
    },
    done: () => rmSync(base, { recursive: true, force: true }),
  };
}

const BROWNFIELD = ["--mode=brownfield", "--gates=auto-approve"];

test("headless: the run end switches a frozen contract off with the run's outcome, and --resume puts it back", async () => {
  const p = repo();
  try {
    p.scenario("b1", [{ freeze: { allowlist: ["src/**"] }, gates: [{ gate: 0, decision: "auto-approved" }] }]);
    let r = await p.run(["--run-id=b1", ...BROWNFIELD, "--max-turns=1"]);
    assert.equal(r.code, 3, r.err);
    assert.equal(p.lock("b1").end_outcome, "max_turns");
    assert.ok(p.lock("b1").ended_at);
    assert.equal(p.contract().active, false, "an ended run binds nothing, so the person's own edits go through");
    assert.match(r.out, /^ {2}write contract: ended \(max_turns\), switched off$/m);

    p.scenario("b1", [{
      gates: [{ gate: 4, decision: "auto-approved" }], close: true, summary: true,
    }]);
    r = await p.run(["--resume=b1"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /run b1: its write contract binds again, as frozen at Gate 0\./);
    const lock = p.lock("b1");
    assert.equal(lock.reopened_at.length, 1);
    assert.equal(lock.end_outcome, "completed", "close-out ended it; the run end left it as it was");
    assert.equal(p.contract().active, false);
    assert.doesNotMatch(r.out, /write contract: ended/, "the run end has nothing more to end");
  } finally { p.done(); }
});

test("headless: a run that ended aborted does not resume its contract, and nothing is spent", async () => {
  const p = repo();
  try {
    p.scenario("b2", [{ freeze: { allowlist: ["docs/**"] }, gates: [{ gate: 1, decision: "aborted" }] }]);
    let r = await p.run(["--run-id=b2", ...BROWNFIELD]);
    assert.equal(r.code, 4, r.err);
    assert.equal(p.lock("b2").end_outcome, "aborted");
    const spawned = p.calls().length;

    r = await p.run(["--resume=b2"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /run b2 ended aborted, so it does not resume/);
    assert.equal(p.calls().length, spawned, "refused before any codex call");
    assert.equal(p.contract().active, false);
  } finally { p.done(); }
});

test("headless: a fresh brownfield run in a project another run holds is refused before spending", async () => {
  const p = repo();
  try {
    freezeContract({ projectRoot: p.root, runId: "held", allowlist: ["src/**"] });
    p.scenario("b3", [{}]);
    let r = await p.run(["--run-id=b3", ...BROWNFIELD]);
    assert.equal(r.code, 2);
    assert.match(r.err, /run held is live and holds this project's write contract/);
    assert.match(r.err, /--abandon --run-id=held --project-root='[^']*my repo'/, "the command to end it is ready to paste");
    assert.equal(p.calls().length, 0);
    assert.equal(existsSync(p.runDir("b3")), false);

    r = await p.run(["--run-id=b3", ...BROWNFIELD, "--dry-run"]);
    assert.equal(r.code, 2, "a dry run says the same");

    abandonRun({ projectRoot: p.root, runId: "held", reason: "test" });
    r = await p.run(["--run-id=b3", ...BROWNFIELD, "--dry-run"]);
    assert.equal(r.code, 0, r.err);
  } finally { p.done(); }
});

test("headless: a greenfield run neither checks nor ends a contract", async () => {
  const p = repo();
  try {
    freezeContract({ projectRoot: p.root, runId: "held", allowlist: ["src/**"] });
    p.scenario("g1", [{ gates: [{ gate: 1, decision: "auto-approved" }, { gate: 4, decision: "auto-approved" }], summary: true }]);
    const r = await p.run(["--run-id=g1", "--mode=greenfield", "--gates=auto-approve"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(p.lock("held").ended_at, null);
    assert.equal(p.contract().run_id, "held");
  } finally { p.done(); }
});

// ── the session route ──────────────────────────────────────────────────

function sink() {
  let text = "";
  return { write: (s) => { text += s; return true; }, get text() { return text; } };
}

async function session(main, root, argv) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, {
    cwd: root,
    env: { CODEX_HOME: SESSION_HOME, CODEX_THREAD_ID: THREAD },
    isGitRepo: () => true,
    gitToplevel: () => root,
    stdout,
    stderr,
  });
  return { code, out: stdout.text, err: stderr.text };
}

test("session: end-run switches the contract off, start-run --resume puts it back, and an aborted run stays ended", async () => {
  const p = repo();
  try {
    let r = await session(startMain, p.root, ["--mode=brownfield", "--run-id=s1", "--intent=bugfix"]);
    assert.equal(r.code, 0, r.err);
    freezeContract({ projectRoot: p.root, runId: "s1", allowlist: ["src/**"] });

    r = await session(endMain, p.root, [`--run-dir=${p.runDir("s1")}`, "--outcome=stopped", "--reason=the session is closing"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(p.lock("s1").end_outcome, "stopped");
    assert.equal(p.contract().active, false);
    assert.match(r.out, /^ {2}write contract: ended \(stopped\), switched off$/m);

    r = await session(startMain, p.root, ["--resume=s1"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^write_contract: reopened$/m);
    assert.equal(p.contract().active, true);
    assert.equal(p.lock("s1").ended_at, null);

    abandonRun({ projectRoot: p.root, runId: "s1", reason: "aborted at gate 2" });
    r = await session(endMain, p.root, [`--run-dir=${p.runDir("s1")}`, "--outcome=aborted", "--reason=aborted at gate 2"]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /write contract: ended/, "--abandon already ended it");
    const before = readFileSync(join(p.runDir("s1"), "run.json"), "utf-8");
    r = await session(startMain, p.root, ["--resume=s1"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /run s1 ended aborted, so it does not resume/);
    assert.equal(readFileSync(join(p.runDir("s1"), "run.json"), "utf-8"), before, "nothing is written");
  } finally { p.done(); }
});

// ── the run-end step itself ────────────────────────────────────────────

test("the run-end step leaves a greenfield project alone, names the undo for a run with recorded files, and turns a failure into a note", async () => {
  const p = repo();
  try {
    freezeContract({ projectRoot: p.root, runId: "r1", allowlist: ["src/**"] });
    const green = endWriteContract({ projectRoot: p.root, runDir: p.runDir("r1"), runId: "r1", mode: "greenfield", outcome: "aborted" });
    assert.deepEqual(green, { contract: null, notes: [], lines: [] });
    assert.equal(p.lock("r1").ended_at, null);

    const prov = join(p.runDir("r1"), "provenance.json");
    const ended = endWriteContract({ projectRoot: p.root, runDir: p.runDir("r1"), runId: "r1", mode: "brownfield", outcome: "halted", reason: "preflight" });
    assert.equal(ended.contract.ended, true);
    assert.equal(p.lock("r1").end_reason, "preflight");
    writeFileSync(prov, JSON.stringify({ ...readJson(prov), files_touched: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }));
    const again = endWriteContract({ projectRoot: p.root, runDir: p.runDir("r1"), runId: "r1", mode: null, outcome: "completed" });
    assert.equal(again.contract.already_ended, true);
    assert.deepEqual(again.lines, ["Undo:        $mmo-codex:revert r1 (2 file(s) in provenance.json)"]);

    const bad = endWriteContract({ projectRoot: p.root, runDir: p.root, runId: "../x", mode: "brownfield", outcome: "aborted" });
    assert.equal(bad.contract, null);
    assert.match(bad.notes[0], /^write contract: not ended \(--run-id must be the run's id/);

    const out = await finalizeRun({ route: "interactive", projectRoot: p.root, runDir: p.runDir("r1"), runId: "r1", mode: "brownfield", outcome: "completed", policyName: "gpt-plus-flash" });
    assert.deepEqual(out.contractLines, ["Undo:        $mmo-codex:revert r1 (2 file(s) in provenance.json)"]);
    assert.equal(out.contract.found, true);
  } finally { p.done(); }
});

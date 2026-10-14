// Interactive conductor cost when several runs share one codex thread: every
// response the session file records is booked by at most one run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { driverSpendForCap, measureDriverUsage } from "../dist/sessionUsage.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { SyntheticRollout, inside, marker, u, writeJsonl } from "./fixtures/syntheticRollout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = loadPolicyFromPath(join(HERE, "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml"));
const T1 = "01a2000b-0000-7000-8000-0000000000a1";
const T2 = "01a2000b-0000-7000-8000-0000000000a2";
const cost = (x) => ((x.input_tokens - x.cached_input_tokens) * 2 + x.cached_input_tokens * 0.2 + x.output_tokens * 12) / 1e6;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function sandbox(...runIds) {
  const root = mkdtempSync(join(tmpdir(), "mmo-attrib-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const runs = runIds.map((id) => {
    const dir = join(root, "project", ".sdlc", "runs", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { root, home, runs, done: () => rmSync(root, { recursive: true, force: true }) };
}

const measure = (s, run) => {
  const m = measureDriverUsage({ runDir: run, policy: POLICY, codexHome: s.home });
  assert.equal(m.ok, true, m.message);
  return m.report;
};
const inputOf = (rep) => rep.turns.map((t) => t.tokens.input_tokens);

test("a run resumed on a thread that hosted another run in between books only its own turns, and so does its cap", () => {
  const s = sandbox("run-a", "run-b");
  try {
    const [A, B] = s.runs;
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a1 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
    const a2 = r.turn({ text: "approve", responses: [{ usage: u(2000) }] });
    const b1 = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(50_000) }] });
    const b2 = r.turn({ text: "approve", responses: [{ usage: u(60_000) }] });
    r.turn({ text: "what changed?", responses: [{ usage: u(70_000) }] });
    const a3 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(3000) }] });
    const a4 = r.turn({ text: "approve", responses: [{ usage: u(4000) }] });
    r.write(s.home);
    writeJsonl(join(A, "driver-session.jsonl"), [
      marker(T1, inside(a1), "start_run"),
      marker(T1, inside(a2)),
      marker(T1, inside(a3), "start_run"),
      marker(T1, inside(a4)),
    ]);
    writeJsonl(join(B, "driver-session.jsonl"), [marker(T1, inside(b1), "start_run"), marker(T1, inside(b2))]);

    const a = measure(s, A);
    assert.deepEqual(inputOf(a), [1000, 2000, 3000, 4000]);
    assert.equal(a.window.start_anchor, "command_turn");
    assert.equal(a.window.exact, true);
    assert.equal(a.window.left_out_turns, 3, "B's two turns and the chat turn after it");
    assert.equal(a.cost_usd_modeled, r6(cost(u(10_000))));
    assert.equal(driverSpendForCap(A, POLICY, { codexHome: s.home }).usd, a.cost_usd_modeled, "the cap books the same turns");

    const b = measure(s, B);
    assert.deepEqual(inputOf(b), [50_000, 60_000]);
    assert.equal(b.window.left_out_turns, undefined);
  } finally {
    s.done();
  }
});

test("the discard step's collection claims no turn of the session that discarded the run", () => {
  const s = sandbox("run-old", "run-new");
  try {
    const [OLD, NEW] = s.runs;
    const old = new SyntheticRollout({ threadId: T2, originator: "codex-tui", start: "2026-10-12T09:00:00.000Z" });
    const o1 = old.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(7000) }] });
    old.write(s.home, { dir: "sessions/2026/10/12" });
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const n0 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
    const n1 = r.turn({ text: "discard", responses: [{ usage: u(30_000) }] });
    const n2 = r.turn({ text: "approve", responses: [{ usage: u(5000) }] });
    r.write(s.home);
    writeFileSync(join(OLD, "run.json"), JSON.stringify({ route: "interactive", starts: [{ codex_thread_id: T2 }] }));
    writeJsonl(join(OLD, "driver-session.jsonl"), [
      marker(T2, inside(o1), "start_run"),
      marker(T1, inside(n1), "collect_driver_usage"),
    ]);
    writeJsonl(join(NEW, "driver-session.jsonl"), [marker(T1, inside(n0), "start_run"), marker(T1, inside(n2))]);

    const discarded = measure(s, OLD);
    assert.deepEqual(discarded.thread_ids, [T2]);
    assert.deepEqual(inputOf(discarded), [7000]);
    assert.deepEqual(discarded.excluded_threads.map((e) => e.thread_id), [T1]);
    assert.equal(discarded.cost_complete, true);
    assert.deepEqual(inputOf(measure(s, NEW)), [1000, 30_000, 5000]);

    rmSync(join(OLD, "run.json"));
    writeJsonl(join(OLD, "driver-session.jsonl"), [marker(T1, inside(n1), "collect_driver_usage")]);
    const legacy = measureDriverUsage({ runDir: OLD, policy: POLICY, codexHome: s.home });
    assert.equal(legacy.ok, false, "with no run.json and only that collection, nothing is this run's");
    assert.equal(legacy.code, "no_threads");
  } finally {
    s.done();
  }
});

test("a turn that ends one run and resumes another is split at the first run's last marker, the same before and after", () => {
  const s = sandbox("run-a", "run-n");
  try {
    const [A, N] = s.runs;
    const build = (responses) => {
      const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
      const x = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
      const y = r.turn({ text: "resume", responses, end: null });
      r.write(s.home);
      return { x, y };
    };
    const ending = { usage: u(20_000, 10_000, 100) };
    // end-run's collection runs after the turn's first response, start-run --resume after its second.
    const early = build([ending]);
    writeJsonl(join(N, "driver-session.jsonl"), [marker(T1, inside(early.x), "start_run"), marker(T1, inside(early.y, 35), "collect_driver_usage")]);
    const atEnd = measure(s, N);
    assert.deepEqual(inputOf(atEnd), [1000, 20_000]);
    assert.equal(atEnd.window.provisional, true);

    const { y } = build([ending, { usage: u(30_000, 25_000, 200) }, { usage: u(40_000, 35_000, 300) }]);
    assert.equal(y.started_at, early.y.started_at);
    writeJsonl(join(A, "driver-session.jsonl"), [marker(T1, inside(y, 55), "start_run")]);
    const n = measure(s, N);
    const a = measure(s, A);
    assert.deepEqual(inputOf(n), [1000, 20_000], "the figure end-run wrote still holds");
    assert.equal(n.window.provisional, false, "the next run's marker closes this run's share of the turn");
    assert.equal(n.window.end, inside(y, 35));
    assert.deepEqual(inputOf(a), [70_000]);
    assert.deepEqual(a.turns.map((t) => t.turn_id), [y.id]);
    assert.deepEqual([a.window.start, a.window.start_anchor, a.window.provisional], [inside(y, 35), "start_run_turn", true]);
    assert.equal(a.window.lower_bound, false, "the resume's own start marker anchors it: no turn of this run comes before it");
    assert.doesNotMatch(a.cost_source, /LOWER BOUND/);
    assert.equal(n.tokens.input_tokens + a.tokens.input_tokens, y.cumulative.input_tokens, "every response of both turns, once");
    assert.equal(
      r6(n.cost_usd_modeled + a.cost_usd_modeled),
      r6(cost(u(1000)) + cost(u(20_000, 10_000, 100)) + cost(u(70_000, 60_000, 500))),
    );
  } finally {
    s.done();
  }
});

test("a run started in plain words opens at start-run's turn, and only a dispatch-first window is a lower bound", () => {
  const s = sandbox("run-a", "run-b");
  try {
    const [A, B] = s.runs;
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    r.turn({ text: "what does this repo do?", responses: [{ usage: u(9000) }] });
    const a1 = r.turn({ text: "run the brownfield pipeline here", responses: [{ usage: u(1000) }] });
    const a2 = r.turn({ text: "approve", responses: [{ usage: u(2000) }] });
    const b1 = r.turn({ text: "now the docs job", responses: [{ usage: u(3000) }] });
    r.write(s.home);
    writeJsonl(join(A, "driver-session.jsonl"), [marker(T1, inside(a1), "start_run"), marker(T1, inside(a2))]);
    writeJsonl(join(B, "driver-session.jsonl"), [marker(T1, inside(b1))]);
    const a = measure(s, A);
    assert.deepEqual(inputOf(a), [1000, 2000]);
    assert.deepEqual([a.window.start_anchor, a.window.lower_bound, a.window.exact], ["start_run_turn", false, true]);
    const b = measure(s, B);
    assert.deepEqual([b.window.start_anchor, b.window.lower_bound], ["first_dispatch_turn", true]);
  } finally {
    s.done();
  }
});

test("runs interleaved on one thread never book the same response twice", () => {
  const s = sandbox("run-a", "run-b", "run-c");
  try {
    const [A, B, C] = s.runs;
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const three = [{ usage: u(100) }, { usage: u(200) }, { usage: u(400) }];
    const t = [
      r.turn({ text: "$mmo-codex:greenfield", responses: three }),
      r.turn({ text: "go", responses: three }),
      r.turn({ text: "$mmo-codex:docs", responses: three }),
      r.turn({ text: "go", responses: three }),
      r.turn({ text: "go", responses: three, end: null }),
    ];
    r.write(s.home);
    writeJsonl(join(A, "driver-session.jsonl"), [marker(T1, inside(t[0])), marker(T1, inside(t[1], 35)), marker(T1, inside(t[3], 75))]);
    writeJsonl(join(B, "driver-session.jsonl"), [marker(T1, inside(t[1], 55)), marker(T1, inside(t[2], 45))]);
    writeJsonl(join(C, "driver-session.jsonl"), [marker(T1, inside(t[2], 65)), marker(T1, inside(t[4]))]);
    const reps = [A, B, C].map((run) => measure(s, run));
    const booked = new Map();
    for (const rep of reps) {
      for (const turn of rep.turns) booked.set(turn.turn_id, (booked.get(turn.turn_id) ?? 0) + turn.tokens.input_tokens);
    }
    for (const turn of t) assert.ok((booked.get(turn.id) ?? 0) <= 700, `${turn.id} booked ${booked.get(turn.id)} of 700`);
    assert.equal(reps.reduce((n, rep) => n + rep.tokens.input_tokens, 0), 3500, "every response of the five turns, once");
  } finally {
    s.done();
  }
});

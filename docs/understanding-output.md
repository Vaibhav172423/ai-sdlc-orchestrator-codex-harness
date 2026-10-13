# Understanding the output

> **For:** reading the cost report and the raw files a run leaves behind. **Also see:** [methodology.md](methodology.md) · [running.md](running.md) · [architecture.md](architecture.md)

Each run's files land in its own folder, `.sdlc/runs/<run-id>/`. Project-level state stays in `.sdlc/`. Nothing is uploaded off the machine.

Render the report for one run:

```bash
node tools/report.mjs .sdlc/runs/<run-id>              # terminal
node tools/report.mjs .sdlc/runs/<run-id> --markdown   # pasteable
```

## The report, section by section

### Header

Run id, policy, the model and effort pin, sandbox and approval policy, start time, duration.

The pin matters more than it looks. Cost figures are only comparable between runs that used the same model at the same reasoning effort, so the report states which, and a run whose pin was rejected mid-flight says so under the table rather than presenting the numbers as if nothing happened.

### Dispatched work — vendor-metered

One row per phase, in pipeline order: calls, tokens in and out, cost. These are packets that went through `execute_with_model` and came back with vendor-reported token counts.

The `Prov` column is the provenance of that phase's events:

| Tag | Meaning |
|---|---|
| `V` | vendor-metered — the vendor reported these tokens |
| `E` | estimated — counted locally, not vendor-confirmed |
| `M` | modeled — derived from token counts, not reported money: a dispatched event at the dated price list's rates, a `driver_loop` row at the card in the policy's `driver:` block, which a test holds to the list |
| `–` | no model call — the phase was skipped for this intent, or the conductor completed it in-session. The zeros are facts, not estimates; any tokens it did consume were the conductor's and are counted in the driver loop. |
| `~` | mixed within the phase |
| `?` | unlabelled — provenance genuinely unknown, which is not the same as `–` |

### Driver loop — modeled, not measured

The conductor's own token consumption, one row per `codex exec` turn.

codex reports each turn's usage as the thread's running total, and `codex exec resume` carries that total into the next invocation, so each turn is priced as the difference from the previous total. A turn that failed or was cut off mid-way is recorded as incomplete: its cost is unknown, not $0. Tokens of a failed turn show up in the next completed turn's running total.

This is a separate section, not a line in the table above, and the two totals are never added together. Codex reports token counts but no money at all, so this figure is derived rather than measured — and a driver running on a ChatGPT seat may have cost nothing in money. A combined number would be neither metered nor modeled. [methodology.md](methodology.md) is the long form.

### Packets that hit the output cap

Only appears when a packet's output was truncated at the model's ceiling and the doubling loop retried it. Worth reading — a packet that hit the cap may have produced less than the phase needed.

### Delegated to an agent worker

Only appears on runs that used the agent door. Names every delegated packet, its tool calls, and what changed on disk while it ran.

### Footer

The provenance key, a per-provenance count of dispatched events, and a note if the fairness pin was rejected during the run.

## The raw files

In each run's folder, `.sdlc/runs/<run-id>/`:

| File | Contents |
|---|---|
| `telemetry.jsonl` | One JSON line per model call. The source of everything in the report. |
| `manifest.json` | Rollup of the telemetry — totals, per-phase, per-module, per-task-type — plus the run's artifacts. |
| `SUMMARY.md` | Written by the final phase. A run counts as completed only once this exists and Gate 4 is accepted. |
| `gates.jsonl` | One line per gate decision, including `auto-approved` and `pending` ones, so an unattended run leaves the same audit trail as an attended one. When you abort a relayed gate (or give no answer) and the conductor does not record it, `run.mjs` adds the `aborted` line with `"recorded_by": "run.mjs"`. |
| `state.json` | The gate that is waiting for an answer, written before the gate is printed. |
| `provenance.json` | Brownfield: every file the run touched, with its pre-run hash. The input `$mmo-codex:revert` reads. |
| `orchestrator.log` | `run.start` and `run.end` (from `run.mjs`, or from `start-run.mjs` and `end-run.mjs` in a session), the conductor's `phase.start`, `phase.end`, `phase.skip`, `gate.open` and `gate.resolved` lines, and the bridge's log of each dispatch. |
| `run.json` | Session runs: the route (`interactive`), mode, intent, the policy (`policy_source`, `policy_path`, `policy_sha256`) and its driver `pin`, every start of the run with the session's model and effort (`session_model`), and how it ended (`outcome`, `reason`). `start-run.mjs` writes it, `end-run.mjs` closes it. |
| `skills/` | The playbooks rendered with this run's paths (`pipeline.md`, `brownfield-guide.md`, `discovery.md`, `roles/*.md`). The conductor reads these copies, never the plugin's own `SKILL.md` files. |
| `driver-events.jsonl` | `run.mjs` runs: one JSON line per record. `invocation_start` and `invocation_end` bracket each `codex exec`, `codex` lines carry each raw event with its arrival time, and `run_end` names the outcome and exit code. Written as events arrive. |
| `driver-stderr.log` | `run.mjs` runs: what codex wrote to stderr, with a header line per invocation. |
| `driver-cost-modeled.jsonl` | `run.mjs` runs: one modeled row per conductor turn, `status` `complete` or `incomplete`. |
| `driver-manifest.json` | `run.mjs` runs: the pins, how the run ended (`outcome`, `exit_code`), incomplete turns, codex warnings, the thread ids, and the modeled driver cost. |
| `delegation/` | Agent-path runs only. Per delegated packet: the task brief, the worker's usage sidecar, and a receipt. |

In `.sdlc/`, shared by every run in the project:

| File | Contents |
|---|---|
| `local/guard-decisions.jsonl` | One line per hooked call while a brownfield contract binds, allow or deny, with the reason. Outside a run, only refusals, and only where `.sdlc/` already exists. |
| `local/write-contract.json` | The brownfield write contract frozen at Gate 0. |

### `telemetry.jsonl`

One event per line. The fields that matter when reading by hand:

| Field | What it holds |
|---|---|
| `phase` | Pipeline phase — `requirements_analysis`, `codegen`, and so on. `driver_loop` marks a conductor turn rather than a dispatched packet. |
| `model` / `model_id` | Which model ran, and through which door. On Gemini events this is what distinguishes the model door from the agent door. |
| `provenance` | `vendor`, `estimated`, `modeled`, or `none`. Decides which report total the event lands in. `none` marks a phase that made no model call at all. |
| `input_tokens` / `input_tokens_cached` / `output_tokens` | Token counts. Input is **exclusive** of cached input — see below. |
| `output_tokens_reasoning` | Reasoning tokens, where the vendor reports them separately. |
| `cost_usd` | A dispatched event: derived from the dated price list (`plugin/mcp/model-dispatch/src/prices.ts`) on the dispatch's UTC day, or from the policy's `pricing:` block under `pricing_override: true`. A `driver_loop` row: derived from the `pricing:` card in the policy's `driver:` block, which a test holds equal to the list's card for today, with no date or tier. |
| `price_basis` / `price_tier` / `price_verified` | Dispatched events only. `list` or `custom`; `standard`, `long_context`, or `unverified` (a tiered model whose card no vendor-reported per-request count proves: usage summed over several requests, or an estimated prompt); the date the list entry was last checked. |
| `prompt_tokens` | One request's whole prompt, cached tokens included, on an adapter that reports usage per request (`openai`). Above 272,000 on `gpt-5.6-terra`, every token of that request bills the long-context card. Absent where usage sums several requests (`codex-cli`). |
| `routing` | The policy name and version, which rule index matched, and why. Makes a routing decision auditable after the fact. |
| `retry_count` | Which attempt this was. A packet at `retry_count: 2` is the one escalation fires on. |

**The cached-token convention.** Codex reports `input_tokens` inclusive of `cached_input_tokens`; this harness stores them exclusive, so `input_tokens + input_tokens_cached` is the true total. An adapter that gets this wrong double-counts cached input and inflates cost. The convention is enforced in `plugin/codex/telemetry/event-reader.mjs`, and [methodology.md](methodology.md) explains why it was chosen.

### `provenance.json`

Written per run in `.sdlc/runs/<run-id>/`. For each touched file: path, whether it was tracked and committed before the run, and its pre-run hash. `$mmo-codex:revert` restores tracked files with git and untracked ones from a per-run backup, and refuses when a later run has touched the same file — printing a three-way diff instead of guessing.

### `guard-decisions.jsonl`

The only record of a refused write. A denied call leaves no trace in the Codex event stream, so a write that silently did not happen is explained here and nowhere else. While a brownfield contract binds, every hooked call gets a line; with no binding contract, only a refusal does, and only in a project that already has `.sdlc/`.

| Field | What it holds |
|---|---|
| `ts` | When the hook decided. |
| `decision` | `allow` or `deny`. |
| `reason` | The refusal text the model saw, or what was cleared. |
| `path` | The path judged, relative to the project root. |
| `run_id` | The run whose contract decided. |
| `matched_rule` | The pattern or record a refusal hit. |
| `tool_name` | `apply_patch` or `Bash`. |
| `wired_by` | `run` (headless `run.mjs`) or `plugin` (the installed plugin's hook). Two rows per call with both values mean both wirings fired. |

## A phase with no row is a lost event

Every phase leaves a row, including ones that made no model call. A phase the intent skipped, or
one the conductor completed in-session rather than dispatching, is recorded as a zero-cost event
with `provenance: "none"` and a reason explaining which.

That is deliberate, and it was not always true. A refactor run whose extraction turned out to be
already complete wrote both a senior review and a security review without dispatching either, and
left a three-event file that read as truncated — there was no way to tell a skipped phase from a
lost one. Now absence always means loss.

The zeros on such a row do not mean the phase was free. Where it consumed tokens they were the
conductor's own, and they are counted in the driver loop instead — which the run's `--reason`
string says on the row itself.

## What is not here

No transcript of the conductor session is stored in the run folder beyond codex's event stream in `driver-events.jsonl` on `run.mjs` runs — codex keeps its own session history under `~/.codex/`. If a run needs explaining after the fact, `telemetry.jsonl` plus `gates.jsonl` plus `guard-decisions.jsonl` is the audit trail this harness guarantees.

# Understanding the output

> **For:** reading the cost report and the raw files a run leaves behind. **Also see:** [methodology.md](methodology.md) · [running.md](running.md) · [architecture.md](architecture.md)

Each run's files land in its own folder, `.sdlc/runs/<run-id>/`. Project-level state stays in `.sdlc/`. Nothing is uploaded off the machine.

Render the report for one run:

```bash
node tools/report.mjs .sdlc/runs/<run-id>              # terminal
node tools/report.mjs .sdlc/runs/<run-id> --markdown   # pasteable
```

## The report, section by section

| You pass | The report shows |
|---|---|
| a run folder (`.sdlc/runs/<run-id>`) | that run |
| a project's `.sdlc` folder, or the project root | the run under `.sdlc/runs/` that started last, with a `Selected` line saying so |
| a `.sdlc` folder from before `runs/` existed, which still holds its own `telemetry.jsonl`, or its project root | those files when they are newer than every run under `runs/`, otherwise the latest run; the `Selected` line says which, and that the older files are not shown |
| `--markdown` | the same report as tables you can paste |
| `--json` | the same figures as one JSON object |

### Header

Run id, policy, the model and effort pin, sandbox and approval policy, start time, duration, and the run's outcome and exit code when `run.mjs` recorded them.

The run id and policy come from `driver-manifest.json` first, then `manifest.json` (either spelling: `run_id` or `pass`, `policy` or `policy_name`), then the first `telemetry.jsonl` event. No cost figure comes from either manifest.

The pin matters more than it looks. Cost figures are only comparable between runs that used the same model at the same reasoning effort, so the report states which, and a run whose pin was rejected mid-flight says so under the table rather than presenting the numbers as if nothing happened.

### Dispatched work

One row per SDLC phase, in pipeline order from `discovery` and `change_plan` through `security_review`: calls, tokens in and out, cost. These are packets that went through `execute_with_model`. `SDLC total` adds them up. `Runner overhead` adds up the other phases (`debug`, `refactor`, `final_report`, and anything unrecognised), each listed under it. `Dispatched total` is the two together.

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

The conductor's own token consumption. The report books `driver-usage.json` when the run folder has one, and `driver-cost-modeled.jsonl` otherwise; the `Source` line says which reading that is.

codex reports each turn's usage as the thread's running total, and `codex exec resume` carries that total into the next invocation, so each turn is priced as the difference from the previous total. A turn that failed or was cut off mid-way is recorded as incomplete: its cost is unknown, not $0. Tokens of a failed turn show up in the next completed turn's running total.

| Line | Meaning |
|---|---|
| `Cost source` | The collector's own description of the reading, from `driver-usage.json`, including its `LOWER BOUND`, `INCOMPLETE`, `PROVISIONAL` or `upper bound` qualifiers |
| `Verification` | `verified` when the exec stream and the session file agree, `UNVERIFIED` otherwise (always so on the interactive route, which has no exec stream), followed by the qualifiers above |
| `Turns` | Driver turns with a priced usage record |
| `Incomplete turns` | Turns that started and never reported usage in the exec stream: a failed turn, or one cut off by a signal. When the session file priced them the note says so and the total is unaffected; otherwise the run total becomes a floor. |
| `Tokens (in / out)` | Fresh input and output, every turn the reading counted, unpriced ones included |
| `Cached input` | Cached input, kept out of the input figure |
| `Unpriced` | Turns on a model with no price, left out of the figure. The run total becomes a floor. |
| `Flags` | Per-turn flags from `driver-cost-modeled.jsonl` or `driver-manifest.json`: `baseline_unknown`, `cumulative_reset`, `zero_usage`, `no_thread_id` |
| `Cross-check` | Whether the `codex exec --json` figure and the session-file figure agree, when both exist |
| `Modeled cost` | Token counts at the pinned rates |

Codex reports token counts but no money at all, so this figure is derived rather than measured, and a driver running on a ChatGPT seat may have cost nothing in money. A run folder with neither file shows `Not measured`.

### Run total

| Line | What it adds up |
|---|---|
| `Dispatched total` | Every `telemetry.jsonl` event |
| `Driver loop — modeled` | The driver figure above |
| `Run total = dispatched + driver` | The two together, with a qualifier when the figure is not exact (table below) |
| `Vendor-metered total` | Events labelled `vendor` or `estimated`, with the estimated share on its own line. An event with `adapter_provenance: modeled` is left out. |
| `Modeled (seat) total` | Dispatched events labelled `modeled` or carrying `adapter_provenance: modeled`, plus the driver loop. Named `Modeled total` when the driver signed in with an API key, since OpenAI then bills those tokens. |
| `Unlabelled provenance` | Events with no provenance label, shown only when there are any |

| Qualifier | Meaning |
|---|---|
| `at least` | Cost is missing: an incomplete or unpriced driver turn, an unread conductor thread, a window that opens late, a turn still running, a last turn that reported zero usage, or a dispatched call with partial usage |
| `at most` | The figure can include cost from outside this run: a resumed thread priced at its whole running total (`baseline_unknown`, or the collector's `upper bound`), or a driver window that covers the whole conductor thread |
| `about` | Reasons of both kinds apply, or a thread's running total dropped (`cumulative_reset`), so the figure can be off either way |

The notes under the run total name each reason. When the cross-check ran and failed, a further note says the driver figure is `UNVERIFIED`.

The vendor-metered, modeled and unlabelled lines add up to the run total. When the driver loop was not measured, the run total reads `not measured`, and the report says the dispatched figure alone is not the run's cost. [methodology.md](methodology.md) explains why modeled figures stay out of the vendor-metered total.

### Packets that hit the output cap

Only appears when a packet's output was truncated at the model's ceiling and the doubling loop retried it. Worth reading — a packet that hit the cap may have produced less than the phase needed.

### Delegated to an agent worker

Only appears on runs that used the agent door. Names every delegated packet, its tool calls, and what changed on disk while it ran.

### Footer

The provenance key, a per-provenance count of dispatched events, and a note for each of these when it applies: the fairness pin was rejected during the run, the run stopped at the cost cap, codex printed warnings, or the policy names in `driver-manifest.json`, `manifest.json` and `telemetry.jsonl` disagree.

## The raw files

In each run's folder, `.sdlc/runs/<run-id>/`:

| File | Contents |
|---|---|
| `telemetry.jsonl` | One JSON line per model call. The source of everything in the report. |
| `manifest.json` | Written by `plugin/scripts/write-manifest.mjs`, never by the model: the telemetry rollup, the cost split by provenance, the conductor's modeled cost, the gates and the file counts. See below. |
| `SUMMARY.md` | Rendered from `manifest.json` by the same script. A run counts as completed once Gate 4 is accepted and the script has run again after it. |
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
| `delegation/` | Agent-path runs only. Per delegated packet: the task brief, the worker's usage sidecar, and a receipt. The sidecar is written for failed sessions too, with `status` (`ok`, `timeout` or `error`) and `usage_source`, and its `sdk_version` decides how its input is priced. |

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
| `attempt_number` / `retry_reason` | One event per request a dispatch made, numbered from 1. `output_cap`: the previous attempt hit its output ceiling and this one doubled it. `transient`: the previous OpenAI request got no answer or a 408, 409, 429 or 5xx, and this one sent it again. |
| `usage_complete` | `false` when the tokens are a lower bound because the call's real usage never arrived: a killed agent session, a failed or timed-out `codex-cli` turn, a Gemini or OpenAI call that got no answer or hit its deadline, or an attempt the client stopped waiting for (its `error` starts `abandoned`). Absent otherwise. |
| `error_status` / `error_code` | A failed call: the HTTP status the vendor answered with, or the connection's code (`ECONNRESET`, `ENOTFOUND`, …). [methodology.md](methodology.md#failed-and-abandoned-calls) says which of these bill $0. |
| `adapter_provenance` | `modeled` on every event from a seat adapter (`codex-cli`), whatever the event's own `provenance`. An `estimated` event that carries it is a seat floor, not metered spend. Absent for metered adapters. |
| `codex_thread_id` | `codex-cli` dispatches only: the nested `codex exec` thread. Its rollout under `CODEX_HOME/sessions` ends in this id. |

**The cached-token convention.** Codex reports `input_tokens` inclusive of `cached_input_tokens`; this harness stores them exclusive, so `input_tokens + input_tokens_cached` is the true total. An adapter that gets this wrong double-counts cached input and inflates cost. The convention is enforced in `plugin/codex/telemetry/event-reader.mjs`, and [methodology.md](methodology.md) explains why it was chosen.

### `manifest.json`

Phase 9 runs `write-manifest.mjs`, Gate 4's acceptance runs it again with `--status=accepted`, and every run end runs it once more: `run.mjs` on a headless run, `end-run.mjs` on a run started in a session. Its main keys:

| Key | What it holds |
|---|---|
| `run_id`, `pass` | The run id, in both spellings readers use. |
| `policy`, `policy_name` | The policy name, in both spellings. |
| `status` | `provisional` until Gate 4, then `accepted` or `auto-approved`. A run that ends any other way gets its outcome: `incomplete` (`--max-turns`), `aborted`, `halted`, `refused`, `stopped`, `cost_cap`, `failed`, `pin_rejected`, `interrupted`. |
| `route` | `headless` for a `run.mjs` run, `interactive` otherwise. |
| `total_cost_usd`, `totals.dispatched_cost_usd` | Dispatched work, summed from `telemetry.jsonl`. |
| `totals.by_provenance` | The same total split into `vendor`, `estimated`, `modeled`, `none` and `unlabelled`. |
| `totals.driver_cost_usd_modeled` | The conductor's modeled cost; `null` when nothing measured it. It comes from `driver-usage.json` when the session-file collector wrote one (it books the session file wherever the exec stream disagrees with it), else from `driver-manifest.json`. The cost report reads them in the same order. |
| `totals.driver_cost_source`, `totals.driver_usage` | Which of the two files the figure came from and, for `driver-usage.json`, its `cost_source`, `verified`, `cost_complete` and `unpriced`. |
| `phase_breakdown`, `model_breakdown`, `module_breakdown`, `task_type_breakdown` | The bridge's `buildManifest` rollups. |
| `artifacts` | `files` and `loc` of the product. Left out, with a note, when the code directory is the repository and no `provenance.json` lists the files the run wrote. |
| `gates` | Every `gates.jsonl` line that parses. |
| `driver` | From `driver-manifest.json`: invocations, turns, incomplete turns, outcome, thread ids, pin. `null` on the interactive route. |
| `summary` | The `SUMMARY.md` this script rendered, with its sha256. A hand-written or edited `SUMMARY.md` does not match it, and does not complete the run. |
| `notes` | What the script left out, and why. |

The manifest holds no summed run total: dispatched work and the conductor's cost stay on separate lines.

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

---
name: pass
description: "Headless, flag-driven SDLC run for CI or scripted replays. The non-interactive twin of the greenfield and brownfield entry points. Explicit invocation only."
---

The flag-driven twin of `$mmo-codex:greenfield` and `$mmo-codex:brownfield`, for scripted and CI use.

There are two ways to reach it, and they are not interchangeable.

# Shape 1 — from a shell, no session at all

This is what "headless" means here. The driver spawns its own `codex exec` conductor, feeds it the
pipeline, and exits when the run finishes:

```bash
node plugin/codex/run.mjs \
  --brief=<path-to-brief.md> \
  --project-root=<path> \
  --gates=prompt|auto-approve|auto-abort \
  [--mode=greenfield|brownfield] \
  [--policy=<name>] \
  [--code-dir=<path>] \
  [--intent=<id>] \
  [--seed=<text>] \
  [--run-id=<id>] \
  [--output-dir=<path>] \
  [--max-turns=<n>] \
  [--resume=<run-id>] \
  [--dry-run]
```

| Flag | Purpose |
|---|---|
| `--brief=<path>` | The brief the run builds from. Greenfield takes a project brief; brownfield takes an intent brief. |
| `--project-root=<path>` | The repo the run works against. Defaults to the current directory. |
| `--output-dir=<path>` | Greenfield only: a different run folder, inside the project. Relative paths resolve against `--project-root`. It may not be the project root, a folder inside `.sdlc` other than the run's own, or a folder that overlaps the code directory. By default each run gets `<project-root>/.sdlc/runs/<run-id>/`. A run in a custom folder needs the same `--output-dir` again on `--resume`. |
| `--policy=<name>` | Routing policy for this run. Defaults to `gpt-plus-flash`. A per-run override; it does not rewrite the project default. |
| `--code-dir=<path>` | Where generated code goes. Defaults to `<project-root>/src` for greenfield and the repo root for brownfield. Relative paths resolve against `--project-root`; it must stay inside the project and outside `.sdlc`. |
| `--gates=<mode>` | Gate behavior. `prompt` (default) asks the person at the terminal at each gate, and relays the conductor's other questions the same way; it is refused when stdin is not a terminal. `auto-approve` accepts every gate — the one CI usually wants for a known-good replay. `auto-abort` stops at the first gate instead of answering it, so a run that drifts into needing a human never silently proceeds. |
| `--mode=<mode>` | `greenfield` or `brownfield`. Omit to let the conductor infer it from the brief and the repo. A folder that is not a git repository needs `--mode=greenfield`. |
| `--intent=<id>` | Brownfield job type: `docs`, `bugfix`, `feature-extend`, `feature-new`, `refactor`, `test`, or `deps`. Answers the "which job type?" question up front. Rejected alongside `--mode=greenfield`, which has no intents. |
| `--seed=<text>` | The job in the user's own words. Becomes the answer to the interview's first question, so only the remaining ones get asked. |
| `--max-turns=<n>` | How many `codex exec` invocations one driver process may use (default 12). One turn is not enough for a real project — the session hits its context ceiling partway through — so the driver resumes the same session until the run ends. A gate answer's invocation does not count. |
| `--run-id=<id>` | Run identifier and run folder name. Defaults to `YYYYMMDD-HHMMSS-<intent or mode>-<6 hex>`. A run id that already has a record is refused; continue it with `--resume`. |
| `--resume=<id>` | Continue a stopped run: its run id, or the codex thread id it recorded. The run keeps its policy, mode and intent; `--brief` is not needed. A completed run is not resumed. Resuming a run that stopped on purpose continues past that stop under the `--gates` you pass. The driver prints the exact command as `Continue:` when it stops. |
| `--dry-run` | Render the conductor prompt and the `codex exec` argv, print them, and exit without spawning anything or spending anything. |

`--dry-run` is the cheapest way to check a CI invocation is shaped correctly. Use it first.

**An unattended brownfield run needs `--intent`.** Under `--gates=auto-approve` there is nobody
to answer the guide's "which job type?" question, and stdin is closed. Pass the intent (and
ideally a `--seed`) so the run never reaches that question:

```bash
node plugin/codex/run.mjs --brief=intent-brief.md --project-root=. \
  --mode=brownfield --intent=bugfix --seed='login returns 500 on empty password' \
  --gates=auto-approve
```

Every run gets its own folder, and nothing from an earlier run is overwritten. The driver's exit
code says how the run ended:

| Exit | Meaning |
|---|---|
| 0 | Completed: `SUMMARY.md` written and Gate 4 accepted |
| 1 | codex failed, or rejected the pinned model or effort |
| 2 | Usage error, or refused before spending anything |
| 3 | `--max-turns` reached before the run finished; continue with `--resume` |
| 4 | Stopped on purpose: an aborted gate, a preflight halt, a refused write, `stop.json`, or the cost cap |
| 128+n | Interrupted by signal n (130 for Ctrl-C); continue with `--resume` |

# Shape 2 — invoked as a skill inside a session

When the user invokes this skill directly with flags in their message, do not shell out to
`run.mjs` — you are already the conductor it would have spawned, and spawning another would bill
the same work twice. Instead, read the flags out of the user's text, resolve them against the
defaults in the table above, and follow
[plugin/skills/pipeline/SKILL.md](../pipeline/SKILL.md) yourself with those settings.

Honor `--gates` as written: under `auto-approve` print each gate block and continue without
waiting; under `auto-abort` print the gate and stop the run; under `prompt` (or when the flag is
absent) wait for the user as normal.

For a brownfield run, take the intent from the user's text and follow
[plugin/skills/brownfield-guide/SKILL.md](../brownfield-guide/SKILL.md) from step 4
with `intent:` pre-set — Gate 0 still fires, and under `auto-approve` it is answered rather than
skipped.

# Requirements before starting

- The dispatch bridge must be built. `node '{{PLUGIN_ROOT}}/codex/verify-setup.mjs' --fix` builds
  it; `$mmo-codex:setup` wraps that with everything else.
- The credentials the resolved policy needs must be present. Preflight (pipeline phase -1) proves
  this before any billable phase runs — do not skip it, and do not start a run on a policy whose
  cheap tier cannot be reached.
- Brownfield additionally requires a git repo. `.sdlc/local/write-contract.json` is written after
  Gate 0 approval, before any packet dispatches; the write-contract hook reads it before every
  write.

# Output paths

- `output_dir`: `<project-root>/.sdlc/runs/<run-id>/` (greenfield may name another folder inside the
  project with `--output-dir`)
- `telemetry_path`: `<output_dir>/telemetry.jsonl`
- `manifest_path`: `<output_dir>/manifest.json`
- Brownfield also writes `<output_dir>/provenance.json`, the record `$mmo-codex:revert` reads

# Cost report

After the run:

```bash
node tools/report.mjs .sdlc/runs/<run-id> --markdown
```

It keeps any modeled figure apart from the metered total rather than summing them into one number.

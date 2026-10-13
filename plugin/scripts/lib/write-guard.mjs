/**
 * The write hook's decision for one Codex tool call. plugin/codex/hooks/write-contract-check.mjs reads the call from
 * stdin and replies with what decideCall returns; the rule order is in docs/architecture.md §7.
 */
import { lstatSync, mkdirSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { CREATABLE_WHEN_ABSENT, firstMatch, hardcodedHit } from "./off-limits.mjs";
import {
  CONTRACT_REL_PATH, DECISIONS_REL_PATH, FROZEN_FILE, LOCK_FILE, appendRegular, contractTampered, gitRoot, liveLock,
  readContractBytes, readLock,
} from "./contract-lock.mjs";
import { isRunId } from "./run-id.mjs";

export const WIRED_BY_RUN_FLAG = "--wired-by=run";

const SCOPE_IS_THE_PERSONS =
  "A wider scope is the person's decision, for a new run with its own Gate 0: stop and tell the person which path is needed and why.";

// ── what a call writes ──────────────────────────────────────────────────────

/** `*** Add File:` / `Update File:` / `Delete File:` / `Move to:` headers of an apply_patch call. */
export function extractApplyPatchTargets(command) {
  if (typeof command !== "string") return [];
  const targets = [];
  const headerRe = /^\*\*\*\s*(Add File|Update File|Delete File|Move to):\s*(.+)$/gm;
  let m;
  while ((m = headerRe.exec(command)) !== null) {
    const path = m[2].trim();
    if (path) targets.push(path);
  }
  return targets;
}

// Quotes at either end, not only a matching pair: a target that ends a wrapped string (`sh -c 'cp a .env'`) keeps one.
const unquote = (s) => s.replace(/^['"]+|['"]+$/g, "");
// An fd number before a redirect (`cp a b 2>/dev/null`) is not an argument.
const ARGS = String.raw`((?:-{1,2}[A-Za-z-]*\s+)*(?:(?!\d+>)[^\s;&|()<>-][^\s;&|()<>]*\s*)+)`;
const argsOf = (text) => text.trim().split(/\s+/).filter(Boolean).map(unquote).filter(Boolean);

/** Device files a redirect writes to without touching the project (`2>/dev/null`). */
const DEVICE_RE = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;

/**
 * Write targets of a shell command: redirects, `tee`, `touch`, the `cp`/`mv` destination, and the file headers of an
 * `apply_patch` run through the shell (Codex applies it itself and hands the hook a Bash call). A heuristic, not a
 * shell parser: a form it misses is allowed.
 */
export function extractBashTargets(command) {
  return bashWriteTargets(command).filter((t) => !DEVICE_RE.test(t));
}

const SHELL_PATCH_RE = /(?:^|[\s;&|(])(?:apply_patch|applypatch)(?=$|[\s;&|)<'"])/;

/** The command with a shell `apply_patch`'s patch text taken out: its lines are file content, not shell. */
function shellOnly(command) {
  if (typeof command !== "string") return command;
  return SHELL_PATCH_RE.test(command) ? command.replace(/\*\*\*\s*Begin Patch[\s\S]*?\*\*\*\s*End Patch/g, " ") : command;
}

function bashWriteTargets(raw) {
  if (typeof raw !== "string") return [];
  const targets = SHELL_PATCH_RE.test(raw) ? extractApplyPatchTargets(raw) : [];
  const command = shellOnly(raw);
  const redirectRe = /(?:^|[\s;&|(])\d*>{1,2}\s*([^\s;&|()<>]+)/g;
  let m;
  while ((m = redirectRe.exec(command)) !== null) {
    const target = unquote(m[1].trim());
    if (target && !/^&\d+$/.test(target)) targets.push(target);
  }
  const teeRe = new RegExp(String.raw`\btee\s+` + ARGS, "g");
  while ((m = teeRe.exec(command)) !== null) targets.push(...argsOf(m[1]).filter((a) => !a.startsWith("-")));
  const touchRe = new RegExp(String.raw`\btouch\s+` + ARGS, "g");
  while ((m = touchRe.exec(command)) !== null) targets.push(...argsOf(m[1]).filter((a) => !a.startsWith("-")));
  // A trailing `/` destination (copy into a folder) names no file, so it is not judged.
  const cpMvRe = new RegExp(String.raw`\b(?:cp|mv)\s+` + ARGS, "g");
  while ((m = cpMvRe.exec(command)) !== null) {
    const args = argsOf(m[1]).filter((a) => !a.startsWith("-"));
    const dest = args[args.length - 1];
    if (dest && !dest.endsWith("/")) targets.push(dest);
  }
  return targets;
}

/**
 * Redirects written with no space before the `>` (`echo hi>.env`). Code such as `a>b` reads the same way, so these are
 * judged against the always-off-limits list and the guarded set only.
 */
export function extractBashTightRedirects(raw) {
  if (typeof raw !== "string") return [];
  const command = shellOnly(raw);
  const out = [];
  const re = /[^-=<>\s;&|(]\d*>{1,2}\s*([^\s;&|()<>]+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const target = unquote(m[1].trim());
    if (target && !/^&\d+$/.test(target) && !DEVICE_RE.test(target)) out.push(target);
  }
  return out;
}

/** Paths a shell command removes or moves away: `rm`/`unlink` arguments and `mv` sources. Judged for the guarded set only. */
export function extractBashRemovals(raw) {
  if (typeof raw !== "string") return [];
  const command = shellOnly(raw);
  const out = [];
  let m;
  const rmRe = new RegExp(String.raw`\b(?:rm|unlink)\s+` + ARGS, "g");
  while ((m = rmRe.exec(command)) !== null) out.push(...argsOf(m[1]).filter((a) => !a.startsWith("-")));
  const mvRe = new RegExp(String.raw`\bmv\s+` + ARGS, "g");
  while ((m = mvRe.exec(command)) !== null) out.push(...argsOf(m[1]).filter((a) => !a.startsWith("-")).slice(0, -1));
  return out;
}

/** Every write target the call names. A structured `file_path` is accepted for tools that carry one. */
export function extractTargets(call) {
  const command = call?.tool_input?.command;
  if (call?.tool_name === "apply_patch") return extractApplyPatchTargets(command);
  if (call?.tool_name === "Bash") return extractBashTargets(command);
  const structured = call?.tool_input?.file_path ?? call?.tool_input?.path ?? call?.input?.file_path;
  return typeof structured === "string" && structured.length > 0 ? [structured] : [];
}

export function extractNarrowTargets(call) {
  if (call?.tool_name !== "Bash") return [];
  const strict = new Set(extractTargets(call));
  return extractBashTightRedirects(call?.tool_input?.command).filter((t) => !strict.has(t));
}

export function extractRemovals(call) {
  return call?.tool_name === "Bash" ? extractBashRemovals(call?.tool_input?.command) : [];
}

// ── paths through links ────────────────────────────────────────────────────

const names = (p) => p.split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean);
const MAX_LINK_HOPS = 64;
const toPosix = (p) => p.split(sep).join("/");
/** `target` against `cwd` with its `..` kept for realPath. */
export const joinRaw = (cwd, target) => (isAbsolute(target) ? target : `${cwd.replace(/[\\/]+$/, "")}${sep}${target}`);

/**
 * A path with every link in it resolved, the last name included, also where the link's target does not exist yet: a
 * write through a dangling link creates the file the link names. A `..` applies to the folder reached so far, links
 * already followed, as the kernel applies it; `resolve()` would drop `l/..` before `l` is followed.
 */
export function realPath(p) {
  const given = isAbsolute(p) ? p : joinRaw(process.cwd(), p);
  const root = parse(given).root;
  let cur = root;
  let pending = names(given.slice(root.length));
  for (let hops = 0; pending.length > 0;) {
    const name = pending.shift();
    if (name === ".") continue;
    if (name === "..") { cur = dirname(cur); continue; }
    const next = join(cur, name);
    let link = null;
    try { if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next); } catch { /* not there yet */ }
    if (link === null) { cur = next; continue; }
    if (++hops > MAX_LINK_HOPS) return resolve(given);
    if (isAbsolute(link)) cur = parse(link).root;
    pending = [...names(isAbsolute(link) ? link.slice(cur.length) : link), ...pending];
  }
  return cur;
}

const relPosix = (from, to) => toPosix(relative(from, to));
const outsideRel = (r) => r === ".." || r.startsWith("../") || isAbsolute(r);
const sameFolder = (a, b) => !!a && !!b && realPath(a) === realPath(b);

/**
 * `abs` relative to `root`, or null when outside. A second look with links resolved on both sides, because Codex gives
 * the session folder in its resolved form (/private/tmp/… on macOS) while a write path arrives as written (/tmp/…).
 */
export function insidePath(root, abs) {
  const asWritten = relPosix(root, abs);
  if (!outsideRel(asWritten)) return asWritten;
  const resolved = relPosix(realPath(root), realPath(abs));
  return outsideRel(resolved) ? null : resolved;
}

/** The paths a write is judged by inside `root`, as written and as resolved; `leaves` when the resolved one is outside. */
export function judgedPaths(root, abs) {
  const asWritten = insidePath(root, abs);
  const real = realPath(abs);
  const resolved = relPosix(realPath(root), real);
  if (outsideRel(resolved)) return { paths: asWritten ? [asWritten] : [], leaves: true, real };
  return { paths: [...new Set([asWritten ?? resolved, resolved])], leaves: false, real };
}

// ── a project's contract state ─────────────────────────────────────────────

/**
 * The contract state of the git project at `root`, or null when it has no contract and no live lock.
 * `binds`: active, and its run's lock (when it has one) not ended.
 */
export function projectState(root) {
  const live = liveLock(root);
  const bytes = readContractBytes(root);
  if (!live && !bytes) return null;
  let contract = null;
  try { contract = JSON.parse(bytes?.toString("utf8") ?? "null"); } catch { contract = null; }
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) contract = null;
  const runId = isRunId(contract?.run_id) ? contract.run_id : null;
  const lock = runId ? readLock(root, runId) : null;
  const binds = contract?.active === true && !lock?.ended_at;
  return { root, live, lock, contract, runId, binds, tampered: contractTampered(root, live) };
}

const RUN_RECORDS = [LOCK_FILE, FROZEN_FILE, "provenance.json"];
const RUN_RECORD_FOLDERS = ["skills", "backups"];

/**
 * The guarded file or folder `rel` names (compared without case), or null: the contract, and inside the run's own
 * folder the records the plugin keeps for it. With `containing`, a path that holds one of them (`rm -r .sdlc/runs/r1`).
 */
export function guardedHit(rel, runId, { containing = false } = {}) {
  const r = rel.toLowerCase().replace(/\/+$/, "");
  const guarded = [CONTRACT_REL_PATH];
  if (isRunId(runId)) {
    const base = `.sdlc/runs/${runId.toLowerCase()}`;
    guarded.push(...RUN_RECORDS.map((f) => `${base}/${f}`), ...RUN_RECORD_FOLDERS.map((f) => `${base}/${f}`));
  }
  for (const g of guarded) {
    if (r === g || r.startsWith(`${g}/`)) return g;
    if (containing && (r === "" || r === "." || g.startsWith(`${r}/`))) return g;
  }
  return null;
}

const statusOf = (st) => ({ root: st.root, run_id: st.runId ?? st.live?.run_id ?? null, binds: st.binds });

/** A word the shell writes to as it stands: no `~` or `=` expansion, variable, command substitution, glob or quoting. */
const isLiteralWord = (w) => typeof w === "string" && w.length > 0 && !/^[~=]/.test(w) && !/[$`*?[\]{}\\'"]/.test(w);

const absent = (p) => { try { lstatSync(p); return false; } catch (e) { return e?.code === "ENOENT"; } };

/**
 * Whether a missing `.env`-family fixture may be created at `target`, with nothing at it now. Only where the hook knows
 * the folder the write lands in: an `apply_patch` Add File, whose paths Codex resolves against the payload's `cwd`, or
 * a shell target written as a literal absolute path. A relative shell path may land elsewhere: the shell tool's
 * `workdir` is not in the payload, and a `cd` can hide inside a quoted `sh -c '…'`.
 */
function mayCreateWhenAbsent(call, target, cwd) {
  if (!isLiteralWord(target)) return false;
  if (call?.tool_name === "apply_patch") {
    return addFileTargets(call?.tool_input?.command).includes(target) && absent(joinRaw(cwd, target));
  }
  return call?.tool_name === "Bash" && isAbsolute(target) && absent(target);
}

function addFileTargets(command) {
  if (typeof command !== "string") return [];
  return [...command.matchAll(/^\*\*\*\s*Add File:\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
}

/** The always-off-limits pattern `path` hits, or null. With no binding contract a missing `.env`-family fixture may be created. */
function hardRefusal(path, binds, mayCreate) {
  const hit = hardcodedHit(path);
  if (!hit) return null;
  if (!binds && mayCreate && CREATABLE_WHEN_ABSENT.includes(path.slice(path.lastIndexOf("/") + 1).toLowerCase())) return null;
  return hit;
}

const hardMessage = (target, hit, runId) =>
  `${target} matches always-off-limits pattern "${hit}"${runId ? ` (run ${runId})` : ""}: secrets, Codex's own config, ` +
  `git's store and the conductor's skills are never written by a tool call, with or without a contract. ` +
  `Stop and tell the person which file and why.`;

/** One binding or non-binding project's answer for one path inside it. */
function verdict(st, rel, mayCreate, narrow) {
  const c = st.contract;
  const runId = st.runId;
  if (st.binds) {
    const g = guardedHit(rel, runId);
    if (g) {
      if (c.strict === false && !st.lock) return { warn: `${rel} is the run's own write contract. Allowed because contract.strict = false.` };
      return {
        deny: `${rel} is run ${runId ?? "?"}'s write contract or a record the plugin keeps for it (its lock, frozen copy, ` +
          `rendered skills, provenance or backups), which a live run does not change. ${SCOPE_IS_THE_PERSONS}`,
        rule: g,
      };
    }
  }
  const hard = hardRefusal(rel, st.binds, mayCreate);
  if (hard) return { deny: hardMessage(rel, hard, runId), rule: hard };
  if (!st.binds || narrow) return {};
  if (runId && rel.startsWith(`.sdlc/runs/${runId}/`)) return {};
  const off = firstMatch(rel, c.off_limits, { ci: true });
  if (off) {
    if (c.strict === false) return { warn: `${rel} matches off-limits pattern "${off}". Allowed because contract.strict = false.` };
    return { deny: `${rel} matches off-limits pattern "${off}" (run ${runId ?? "?"}). ${SCOPE_IS_THE_PERSONS}`, rule: off };
  }
  if (firstMatch(rel, c.allowlist)) return {};
  if (c.strict === false) return { warn: `${rel} is not in the confirmed allowlist. Allowed because contract.strict = false.` };
  const other = /^\.sdlc\/runs\/([^/]+)\//.exec(rel)?.[1];
  if (other && runId && other !== runId) {
    return {
      deny: `${rel} is in run ${other}'s folder, but run ${runId} still holds this project's write contract. If run ` +
        `${runId} is over, ending it is the person's decision (write-contract.mjs --abandon --run-id=${runId}). ` +
        `Stop and tell the person.`,
    };
  }
  return { deny: `${rel} is not in the confirmed allowlist for run ${runId ?? "?"}. ${SCOPE_IS_THE_PERSONS}` };
}

function decide(st, abs, target, mayCreate, narrow) {
  if (st.tampered) return { deny: st.tampered, rule: "tampered" };
  const { paths, leaves, real } = judgedPaths(st.root, abs);
  if (leaves) {
    if (st.binds && !narrow) {
      return {
        deny: `${target} leads OUTSIDE the contract's repo root (${st.root}) through a link. Cross-project writes are ` +
          `refused: a brownfield run writes only inside the repo whose contract it holds.`,
      };
    }
    const hit = hardRefusal(toPosix(real), st.binds, mayCreate);
    if (hit) return { deny: hardMessage(target, hit), rule: hit };
  }
  const warns = [];
  for (const rel of paths) {
    const v = verdict(st, rel, mayCreate, narrow);
    if (v.deny) return { ...v, rel };
    if (v.warn) warns.push(v.warn);
  }
  return { warns, rel: paths[0] };
}

// ── one call ────────────────────────────────────────────────────────────────

function statesFor(abs, sessionRoot, session) {
  const roots = [];
  for (const r of [gitRoot(dirname(abs)), gitRoot(dirname(realPath(abs)))]) {
    if (r && !roots.some((x) => sameFolder(x, r))) roots.push(r);
  }
  const states = roots.map((r) => (sameFolder(r, sessionRoot) ? session : projectState(r)));
  // A target in a nested git project inside the session's project answers to the session's contract as well.
  if (session && !roots.some((r) => sameFolder(r, sessionRoot)) && insidePath(sessionRoot, abs) !== null) states.push(session);
  return states.filter(Boolean);
}

/** `narrow`: a target the scan is unsure of, judged by the always-off-limits list, the guarded set and tampering only. */
function checkWrite(target, cwd, sessionRoot, session, mayCreate, narrow = false) {
  const abs = joinRaw(cwd, target);
  if (!narrow && session && (session.binds || session.tampered) && insidePath(sessionRoot, abs) === null) {
    if (session.tampered) return { deny: session.tampered, rule: "tampered", state: session };
    return {
      deny: `${abs} resolves OUTSIDE the calling session's contracted repo (${sessionRoot}). Cross-project writes are ` +
        `refused: a brownfield run writes only inside the repo whose contract it holds.`,
      state: session,
    };
  }
  const deciding = statesFor(abs, sessionRoot, session);
  if (deciding.length === 0) {
    for (const p of new Set([toPosix(resolve(abs)), toPosix(realPath(abs))])) {
      const hit = hardRefusal(p, false, mayCreate);
      if (hit) return { deny: hardMessage(target, hit), rule: hit, root: gitRoot(dirname(abs)) ?? sessionRoot };
    }
    return { bound: [] };
  }
  const warns = [];
  const bound = [];
  for (const st of deciding) {
    const v = decide(st, abs, target, mayCreate, narrow);
    if (v.deny) return { ...v, state: st };
    warns.push(...v.warns);
    if (st.binds && !narrow) bound.push({ ...statusOf(st), target, abs, rel: v.rel });
  }
  return { warns, bound };
}

function checkRemoval(target, cwd, sessionRoot, session) {
  const abs = joinRaw(cwd, target);
  const candidates = statesFor(abs, sessionRoot, session);
  if (session && !candidates.includes(session)) candidates.push(session);
  for (const st of candidates) {
    const runId = st.binds ? st.runId : st.live?.run_id;
    if (!st.binds && !st.live) continue;
    for (const rel of judgedPaths(st.root, abs).paths) {
      const g = guardedHit(rel, runId, { containing: true });
      if (g) {
        return {
          deny: `${target} would remove or move ${g}, which run ${runId ?? "?"} keeps while it is live. ` +
            `Ending a run is the person's decision. Stop and tell the person.`,
          rule: g,
          state: st,
        };
      }
    }
  }
  return null;
}

/**
 * The hook's answer for one tool call: `{ decision, reason, warnings, record, bound }`. `record` is where the decision
 * log row goes, or null (no binding contract, and for a refusal no `.sdlc/` folder to write into). `bound` lists each
 * allowed write a binding contract judged.
 */
export function decideCall(call, { wiredBy = "plugin" } = {}) {
  const cwd = typeof call?.cwd === "string" && call.cwd ? call.cwd : process.cwd();
  const sessionRoot = gitRoot(cwd);
  const session = sessionRoot ? projectState(sessionRoot) : null;
  const toolName = typeof call?.tool_name === "string" ? call.tool_name : null;
  const targets = extractTargets(call);
  const row = (decision, extra) => ({ decision, tool_name: toolName, wired_by: wiredBy, ...extra });

  const warnings = [];
  const bound = [];
  let refusal = null;
  for (const target of targets) {
    const v = checkWrite(target, cwd, sessionRoot, session, mayCreateWhenAbsent(call, target, cwd));
    if (v.deny) { refusal = { ...v, target }; break; }
    warnings.push(...v.warns ?? []);
    bound.push(...v.bound);
  }
  if (!refusal) {
    for (const target of extractNarrowTargets(call)) {
      const v = checkWrite(target, cwd, sessionRoot, session, mayCreateWhenAbsent(call, target, cwd), true);
      if (v.deny) { refusal = { ...v, target }; break; }
    }
  }
  if (!refusal) {
    for (const target of extractRemovals(call)) {
      const v = checkRemoval(target, cwd, sessionRoot, session);
      if (v) { refusal = { ...v, target }; break; }
    }
  }

  if (refusal) {
    const st = refusal.state;
    const root = st?.root ?? refusal.root ?? null;
    const keep = !!root && (!!st?.binds || !!st?.live || isDir(join(root, ".sdlc")));
    return {
      decision: "deny",
      reason: refusal.deny,
      warnings,
      bound: [],
      record: keep ? {
        root,
        row: row("deny", {
          reason: refusal.deny, path: refusal.rel ?? refusal.target, run_id: st ? statusOf(st).run_id : null,
          matched_rule: refusal.rule ?? null,
        }),
      } : null,
    };
  }

  const binding = session?.binds ? statusOf(session) : bound[0] ?? null;
  return {
    decision: "allow",
    reason: null,
    warnings,
    bound,
    record: binding ? {
      root: binding.root,
      row: row("allow", {
        reason: targets.length ? `${targets.length} target(s) cleared` : "no write target in this call",
        path: bound[0]?.rel ?? null,
        run_id: binding.run_id,
      }),
    } : null,
  };
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Appends a decision row under an existing `.sdlc/`. Best effort: a failure never changes the decision. */
export function recordDecision(record, now = new Date()) {
  if (!record?.root || !isDir(join(record.root, ".sdlc"))) return false;
  try {
    mkdirSync(join(record.root, ".sdlc", "local"), { recursive: true });
    return appendRegular(join(record.root, DECISIONS_REL_PATH), JSON.stringify({ ts: now.toISOString(), ...record.row }) + "\n");
  } catch {
    return false;
  }
}

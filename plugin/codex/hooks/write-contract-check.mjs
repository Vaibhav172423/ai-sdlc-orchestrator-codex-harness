#!/usr/bin/env node
/**
 * Codex PreToolUse hook for the brownfield write contract, on `apply_patch` and `Bash`. The decision is in
 * plugin/scripts/lib/write-guard.mjs. Codex blocks a call only on the JSON reply on stdout, not on an exit code, and a
 * denied call leaves no trace in `codex exec --json`, so the hook records its own decisions. Any failure here allows
 * the call; the one deliberate refusal on doubt is a contract that changed after its run froze it.
 */
import { decideCall, recordDecision, WIRED_BY_RUN_FLAG } from "../../scripts/lib/write-guard.mjs";
import { log } from "../../scripts/lib/log.mjs";

const WIRED_BY = process.argv.includes(WIRED_BY_RUN_FLAG) ? "run" : "plugin";

function readStdinJson() {
  return new Promise((resolveP) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => {
      try { resolveP(JSON.parse(buf)); } catch { resolveP(null); }
    });
    // Some environments never close stdin.
    setTimeout(() => resolveP(null), 1500).unref();
  });
}

/** Exits once the reply is flushed: stdin may never close, and a pipe write is asynchronous on macOS. */
function reply(decision, reason) {
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

async function main() {
  const call = await readStdinJson();
  if (!call || typeof call !== "object") return reply("allow");
  const out = decideCall(call, { wiredBy: WIRED_BY });
  for (const w of out.warnings) console.error(`[mmo-brownfield write-contract] WARN: ${w}`);
  const row = out.record?.row;
  if (out.decision === "deny") {
    console.error(`[mmo-brownfield write-contract] DENY: ${out.reason}`);
    log("warn", "write.deny", { run_id: row?.run_id, path: row?.path, matched_rule: row?.matched_rule, wired_by: WIRED_BY });
  } else {
    log("debug", "write.allow", { run_id: row?.run_id, path: row?.path, wired_by: WIRED_BY });
  }
  recordDecision(out.record);
  reply(out.decision, out.reason);
}

main().catch((e) => {
  if (process.env.MMO_DEBUG === "1") console.error(`[mmo-brownfield write-contract] unhandled: ${e?.message ?? e}`);
  reply("allow");
});

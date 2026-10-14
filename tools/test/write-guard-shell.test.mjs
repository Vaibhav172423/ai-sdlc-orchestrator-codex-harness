/**
 * The write guard reads a shell command as the shell splits it: quoted text and here-document bodies are data, a
 * word starting with `-` is never a command, and only a redirect operator outside quotes names a target.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { freezeContract } from "../../plugin/scripts/write-contract.mjs";
import { decideCall, extractBashRemovals, extractBashTargets, extractNarrowTargets } from "../../plugin/scripts/lib/write-guard.mjs";
import { scanShell } from "../../plugin/scripts/lib/shell-scan.mjs";

const HOOK = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "codex", "hooks", "write-contract-check.mjs");

/** A git project holding a `.env`, with a live contract for run r1 over `src/**` when `live` is set. */
function project({ live }) {
  const dir = mkdtempSync(join(tmpdir(), "guard-shell-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  if (live) freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"], offLimits: [], strict: true });
  return dir;
}

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

/** [command, under a live contract, with no contract, the target a refusal names] */
const CASES = [
  // Text inside quotes is data.
  ['git commit -m "fix(parser): treat a > b as data"', "allow", "allow"],
  ["git commit -am 'feat: x >> y, a << b'", "allow", "allow"],
  ["git commit -m \"$(cat <<'EOF'\nfix: a > b (x)\n\nbody << here, it's\nEOF\n)\"", "allow", "allow"],
  ['node -e "if (1 > 0) process.exit(0)"', "allow", "allow"],
  ["node -e 'console.log([1, 2].map((x) => x > 1))' > /dev/null", "allow", "allow"],
  ["node plugin/scripts/end-run.mjs --run-dir=.sdlc/runs/r1 --outcome=stopped --reason='cost > 3'", "allow", "allow"],
  ["printf '%s\\n' \"a > b\" | grep -c '>'", "allow", "allow"],
  ["echo $'a > b' \"c >> d\"", "allow", "allow"],
  ['rg -n "=> |-> " src', "allow", "allow"],
  ["jq '.version > \"1\"' package.json", "allow", "allow"],
  ["awk '$3 > 100 { print $1 }' src/a.ts", "allow", "allow"],
  ['python3 -c "print(1 > 0)"', "allow", "allow"],
  ["git log --format='%h > %s' -5", "allow", "allow"],
  ["/bin/zsh -lc 'git commit -m \"a > b\"'", "allow", "allow"],
  ['bash -lc "npm test -- --reporter=dot 2>&1 | tail -5"', "allow", "allow"],
  // A here-document body is data, whatever it holds.
  ["cat > src/x.ts <<'EOF'\nexport const f = (a: number) => (a > 0 ? a << 1 : 0);\nconst s = \"it's\";\ncat <<INNER > docs/x.md\nEOF", "allow", "allow"],
  ["cat > src/y.ts <<EOF\nif (a > 0) { b >>= 1; }\nrm -rf .sdlc\nEOF", "allow", "allow"],
  ["mkdir -p src/lib && cat > src/lib/a.ts <<'EOF'\nexport const gt = (a, b) => a > b;\nEOF", "allow", "allow"],
  // A word starting with `-` is never a command.
  ["java -cp build/libs/app.jar com.example.Main --mode=check", "allow", "allow"],
  ['docker run --rm -v "$PWD":/w -w /w node:20 npm test', "allow", "allow"],
  ["npx --yes prettier@3.3.3 --check src", "allow", "allow"],
  ['echo "--rm -cp" | wc -c', "allow", "allow"],
  // Comparisons and devices.
  ["[[ -f src/a.ts && 3 > 2 ]] && echo ok", "allow", "allow"],
  ["(( 3 > 2 )) && echo ok", "allow", "allow"],
  ["npm test 2>&1 | tail -20", "allow", "allow"],
  ["npm test > /dev/null 2>&1", "allow", "allow"],
  ["ls -la >/dev/null 2>&1", "allow", "allow"],
  // Real writes outside the allowlist, beside the same text.
  ["echo x > docs/a.md", "deny", "allow", "docs/a.md"],
  ['git commit -m "a > b" > docs/commit.log', "deny", "allow", "docs/commit.log"],
  ["cat > docs/x.md <<'EOF'\nbody > here\nEOF", "deny", "allow", "docs/x.md"],
  ["bash -lc 'echo x > docs/a.md'", "deny", "allow", "docs/a.md"],
  ["/bin/zsh -lc 'cp src/a.ts docs/a.ts'", "deny", "allow", "docs/a.ts"],
  ["java -cp lib/a.jar Main > docs/out.txt", "deny", "allow", "docs/out.txt"],
  ["docker run --rm img > docs/out.txt", "deny", "allow", "docs/out.txt"],
  ["npx --yes tsx script.ts | tee docs/a.md", "deny", "allow", "docs/a.md"],
  ['echo "$(echo x > docs/a.md)"', "deny", "allow", "docs/a.md"],
  ["cat <<'EOF' | bash\necho x > docs/a.md\nEOF", "deny", "allow", "docs/a.md"],
  ["git status && cp src/a.ts docs/b.ts", "deny", "allow", "docs/b.ts"],
  ["env -C . FOO=1 cp src/a.ts docs/c.ts", "deny", "allow", "docs/c.ts"],
  // Clobber and both-stream redirects.
  ["echo x >| .env", "deny", "deny", ".env"],
  ["echo x >& .env", "deny", "deny", ".env"],
  ["echo x &> .env", "deny", "deny", ".env"],
  ["echo x >! .env", "deny", "deny", ".env"],
  ["echo x >| src/a.ts", "allow", "allow"],
  // A shell removal meets the always-off-limits list, as an apply_patch Delete File does.
  ["rm -rf .git", "deny", "deny", ".git"],
  ["rm .env", "deny", "deny", ".env"],
  ["rm -f .env.test", "deny", "deny", ".env.test"],
  ["rm -f .env*", "deny", "deny", ".env*"],
  ["rm -rf .codex", "deny", "deny", ".codex"],
  ["rm -rf .agents/skills", "deny", "deny", ".agents/skills"],
  ["rm -rf src/.git", "deny", "deny", "src/.git"],
  ["unlink .mcp.json", "deny", "deny", ".mcp.json"],
  ["git rm -q .env", "deny", "deny", ".env"],
  ["mv .env src/env.bak", "deny", "deny", ".env"],
  ["rm -rf node_modules dist/* .next", "allow", "allow"],
  ["rm -f *.log src/*", "allow", "allow"],
  ["rm .gitignore && rm -rf .github/old", "allow", "allow"],
  ["git rm --cached .env", "allow", "allow"],
];

test("the guard judges real conductor commands by what the shell writes, not by text in quotes or here-documents", () => {
  const live = project({ live: true });
  const plain = project({ live: false });
  try {
    for (const [command, underContract, withoutContract, target] of CASES) {
      for (const [dir, want, label] of [[live, underContract, "live contract"], [plain, withoutContract, "no contract"]]) {
        const out = decideCall({ cwd: dir, ...bash(command) });
        assert.equal(out.decision, want, `${label}: ${JSON.stringify(command)} → ${out.reason ?? ""}`);
        if (want === "deny" && target) assert.ok(out.reason.startsWith(`${target} `), `${label}: ${command} → ${out.reason}`);
      }
    }
  } finally { cleanup(live); cleanup(plain); }
});

test("the hook replies the same way for a commit message and a here-document holding >", () => {
  const dir = project({ live: true });
  try {
    const ask = (command) => spawnSync(process.execPath, [HOOK], { cwd: dir, input: JSON.stringify({ cwd: dir, ...bash(command) }), encoding: "utf8" });
    for (const command of ['git commit -m "a > b"', "cat > src/x.ts <<'EOF'\nif (a > b) x <<= 1;\nEOF", "java -cp x.jar Main"]) {
      const r = ask(command);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "", `allowed: ${command}\n${r.stderr}`);
    }
    const r = ask("echo x >| .env");
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("scan: no quoted string, here-document body or comment names a target", () => {
  for (const command of [
    'echo "a > b"', "echo 'a > b'", "echo $'a > b'", 'echo $"a > b"', "echo a\\>b", "echo 'cp x .env; rm -rf .git'",
    "cat <<'EOF'\nx > y\nrm -rf .git\ncp a .env\nEOF", "cat <<EOF\nx > y\nEOF", "cat <<-EOF\n\tx > y\n\tEOF",
    "ls # > x", "echo 'unterminated > x",
  ]) {
    assert.deepEqual(scanShell(command), [], command);
  }
});

test("scan: a command is a word at a command position, never an option or an argument", () => {
  for (const command of ["java -cp a b", "docker run --rm img", "ls --rm -cp -mv x", "echo rm -rf x", "git log -- rm cp", "grep -e touch -e tee src"]) {
    assert.deepEqual(scanShell(command), [], command);
  }
  const targets = (command) => extractBashTargets(command);
  assert.deepEqual(targets("ls; cp a b"), ["b"]);
  assert.deepEqual(targets("ls && cp a b || cp c d"), ["b", "d"]);
  assert.deepEqual(targets("echo x | tee a"), ["a"]);
  assert.deepEqual(targets("(cp a b)"), ["b"]);
  assert.deepEqual(targets("ls\ncp a b"), ["b"]);
  assert.deepEqual(targets("FOO=1 BAR='x y' cp a b"), ["b"]);
  assert.deepEqual(targets("sudo -u root cp a b"), ["b"]);
  assert.deepEqual(targets("time nice -n 5 timeout 10 cp a b"), ["b"]);
  assert.deepEqual(targets("if true; then cp a b; fi"), ["b"]);
  assert.deepEqual(targets("f() { cp a b; }"), ["b"]);
  assert.deepEqual(targets("find . -name x -exec cp {} out/ \\;"), ["out/{}"]);
  assert.deepEqual(targets("xargs -I{} cp {} out/x < list"), ["out/x"]);
  assert.deepEqual(targets("/bin/cp a b"), ["b"]);
  assert.deepEqual(extractBashRemovals("git -C . rm -q a b && git rm --cached c && git mv d e"), ["a", "b", "d"]);
});

test("scan: what the shell runs from a string or a here-document is read as shell", () => {
  const targets = (command) => extractBashTargets(command);
  assert.deepEqual(targets("sh -c 'cp a b'"), ["b"]);
  assert.deepEqual(targets("bash -o pipefail -c 'echo x > b'"), ["b"]);
  assert.deepEqual(targets("eval 'cp a' b"), ["b"]);
  assert.deepEqual(targets("bash <<'EOF'\necho x > b\nEOF"), ["b"]);
  assert.deepEqual(targets("bash <<< 'echo x > b'"), ["b"]);
  assert.deepEqual(targets("echo 'echo x > b' | sh"), ["b"]);
  assert.deepEqual(targets("cat <<EOF\n$(echo x > b)\nEOF"), ["b"], "an unquoted here-document runs its command substitutions");
  assert.deepEqual(targets("cat <<'EOF'\n$(echo x > b)\nEOF"), [], "a quoted one does not");
  assert.deepEqual(targets('x="$(echo x > b)"'), ["b"]);
  assert.deepEqual(targets("x=`cp a b`"), ["b"]);
  assert.deepEqual(targets("tee >(gzip > b.gz) < a"), ["b.gz"]);
  assert.deepEqual(targets("bash script.sh <<'EOF'\necho x > b\nEOF"), [], "a script's stdin is its data");
  assert.deepEqual(
    targets("apply_patch <<EOF\n*** Begin Patch\n*** Add File: src/a.ts\n+const s = `${a}`; $(rm x) > y\n*** End Patch\nEOF"),
    ["src/a.ts"], "Codex applies a shell apply_patch itself, so its text is never shell",
  );
});

test("scan: only an operator outside quotes redirects, and a glued one stays a narrow target", () => {
  const narrow = (command) => extractNarrowTargets(bash(command));
  assert.deepEqual(extractBashTargets("echo x >| a >> b &> c &>> d >& e >! f <> g 2> h"), ["a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.deepEqual(extractBashTargets("exec 3>&- 2>&1 >&2 4<&0 < in <<< 'x > y'"), []);
  assert.deepEqual(narrow("echo x>|.env"), [".env"]);
  assert.deepEqual(narrow('echo "a>b">c'), ["c"]);
  assert.deepEqual(narrow("echo 'a>b'"), []);
});

test("a shell removal and an apply_patch delete of the same always-off-limits file get the same answer", () => {
  const dir = project({ live: false });
  try {
    for (const path of [".env", ".git", ".git/index.lock", ".codex/config.toml", ".agents/x.md", "pkg/.env.local", "src/a.ts"]) {
      const patch = decideCall({ cwd: dir, tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` } });
      const shell = decideCall({ cwd: dir, ...bash(`rm -f ${path}`) });
      assert.equal(shell.decision, patch.decision, path);
      if (shell.decision === "deny") assert.match(shell.reason, /always-off-limits pattern .*never written or removed by a tool call/);
    }
  } finally { cleanup(dir); }
});

test("a removal is judged by the name it removes: a link to .env goes, a path through a link into .git does not", () => {
  const dir = project({ live: true });
  try {
    symlinkSync(join(dir, ".env"), join(dir, "src", "env-link"));
    symlinkSync(join(dir, ".git"), join(dir, "src", "gitlink"));
    assert.equal(decideCall({ cwd: dir, ...bash("rm src/env-link") }).decision, "allow");
    const r = decideCall({ cwd: dir, ...bash("rm -f src/gitlink/config") });
    assert.equal(r.decision, "deny");
    assert.equal(r.record.row.run_id, "r1", "a refusal under a live contract is logged with its run");
  } finally { cleanup(dir); }
});

test("an argv-array command and an apply_patch under tool_input.input are judged like the string forms", () => {
  const live = project({ live: true });
  const plain = project({ live: false });
  const hook = (dir, call) => {
    const r = spawnSync(process.execPath, [HOOK], { cwd: dir, input: JSON.stringify({ cwd: dir, ...call }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout === "" ? "allow" : JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  };
  const argv = (...command) => ({ tool_name: "Bash", tool_input: { command } });
  const patchInput = (path) => ({ tool_name: "apply_patch", tool_input: { input: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` } });
  try {
    assert.equal(hook(live, argv("bash", "-lc", "echo x > docs/a.md")), "deny");
    assert.equal(hook(live, argv("/bin/zsh", "-lc", "git commit -m 'a > b'")), "allow");
    assert.equal(hook(live, argv("cat", "a > docs/b.md")), "allow", "an argv word is one word, not shell");
    assert.equal(hook(live, argv("apply_patch", "*** Begin Patch\n*** Add File: docs/c.md\n+x\n*** End Patch")), "deny");
    assert.equal(hook(live, { tool_name: "apply_patch", tool_input: { command: ["*** Begin Patch", "*** Add File: docs/d.md", "+x", "*** End Patch"] } }), "deny");
    assert.equal(hook(live, patchInput("docs/e.md")), "deny");
    assert.equal(hook(live, patchInput("src/e.ts")), "allow");
    assert.equal(hook(plain, argv("bash", "-lc", "echo x > .env")), "deny");
    assert.equal(hook(plain, patchInput(".mcp.json")), "deny");
  } finally { cleanup(live); cleanup(plain); }
});

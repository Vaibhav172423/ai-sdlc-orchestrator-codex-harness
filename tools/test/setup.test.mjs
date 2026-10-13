/**
 * Guards the clone-route setup wizard (tools/setup.mjs).
 *
 * The wizard is an interactive script, so what is testable without driving a
 * TTY is: that it runs to completion non-interactively without hanging, that
 * its verdict reaches the exit code, and that it never writes state into the
 * repo as a side effect of merely *checking*. Those are exactly the three
 * ways a setup wizard fails badly — hanging a CI job, reporting success while
 * blocked, or silently changing a checkout it was only asked to inspect.
 *
 * Every run gets its own codexSandbox(): a temporary HOME and CODEX_HOME with
 * the codex and npm stand-ins first on PATH. The wizard's last step runs
 * `codex mcp add`, which a real codex writes into ~/.codex/config.toml, and
 * its build step runs `npm ci`; neither may reach this computer's own.
 *
 * The decision logic it shares with verify-setup.mjs (credential state,
 * version pins) is covered in verify-setup.test.mjs against the imported
 * functions directly, not re-derived here through the wizard's output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexSandbox } from "./lib/sandbox.mjs";
import { STAND_IN_BIN, isSandboxCodexHome } from "./lib/stand-ins.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = join(REPO_ROOT, "plugin", "mcp", "model-dispatch");
const DIST_ENTRY = join(SERVER_DIR, "dist", "server.js");

/**
 * Runs the wizard with stdin closed — the shape a CI job or a piped shell
 * gives it. A wizard that waits for input here would hang the job forever,
 * so the timeout is the assertion as much as the exit code is.
 */
function runWizard(sb, env = {}, root = REPO_ROOT) {
  assertSandboxed({ ...sb.env, ...env });
  return spawnSync(process.execPath, [join(root, "tools", "setup.mjs")], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...sb.env, ...env },
  });
}

function assertSandboxed(env) {
  assert.ok(isSandboxCodexHome(env.CODEX_HOME), `CODEX_HOME ${env.CODEX_HOME} is not a test sandbox`);
  assert.equal(env.PATH.split(delimiter)[0], STAND_IN_BIN, "the codex stand-in must come first on PATH");
}

function inSandbox(fn, extraEnv = {}) {
  const sb = codexSandbox(extraEnv);
  try {
    return fn(sb);
  } finally {
    sb.cleanup();
  }
}

/**
 * Pins the policy the wizard will resolve, then restores whatever was there.
 *
 * The wizard reads this clone's own `.sdlc/project.json` to decide whether a
 * missing OPENAI_API_KEY is a blocker — a metered policy needs one, the seat
 * policy does not. That file is gitignored and machine-local, so a developer
 * who has chosen the seat policy would otherwise see these tests fail while CI
 * (which has no such file) passed. Pin it rather than inherit it.
 */
function withPolicy(name, fn) {
  const dir = join(REPO_ROOT, ".sdlc");
  const path = join(dir, "project.json");
  const had = existsSync(path) ? readFileSync(path, "utf8") : null;
  const madeDir = !existsSync(dir);
  try {
    mkdirSync(dir, { recursive: true });
    const base = had ? JSON.parse(had) : {};
    writeFileSync(path, JSON.stringify({ ...base, default_policy: name }, null, 2));
    return fn();
  } finally {
    if (had !== null) writeFileSync(path, had);
    else if (madeDir) rmSync(dir, { recursive: true, force: true });
    else rmSync(path, { force: true });
  }
}

test("the wizard runs to completion with stdin closed instead of hanging", () => {
  const r = inSandbox((sb) => runWizard(sb));
  assert.notEqual(r.signal, "SIGTERM", "wizard hung waiting for input that will never come");
  assert.ok(typeof r.status === "number", "wizard must exit with a status");
});

test("every question falls through to a documented default when non-interactive", () => {
  const r = inSandbox((sb) => runWizard(sb));
  assert.match(
    r.stdout,
    /non-interactive/,
    "a skipped question must say so, not silently pick an answer",
  );
});

test("a blocked setup reports its verdict through the exit code, not just on screen", () => {
  // Pinned to the metered policy so the block is real and not machine-dependent:
  // no key + a policy that bills one is a genuine blocker.
  const r = withPolicy("gpt-plus-flash", () => inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "" })));
  assert.match(r.stdout, /Setup incomplete/);
  assert.equal(r.status, 1, "a caller checking only the exit code must see the block");
});

test("the same install is NOT blocked once the policy is one that needs no key", () => {
  // The other half of the same rule — a wizard that blocks here is telling a
  // ChatGPT-seat user to buy a key they will never use.
  const r = withPolicy("gpt-seat-plus-flash", () => inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "" })));
  assert.match(r.stdout, /does not need one/);
  assert.ok(!/Setup incomplete/.test(r.stdout), `must not block: ${r.stdout}`);
  assert.equal(r.status, 0);
});

test("the wizard blames the policy for the key requirement, and names the keyless alternative", () => {
  // This repo has no .sdlc/project.json, so the wizard resolves the default
  // metered policy — which really does bill the key, so the block is correct.
  // What it must not do is present the key as unconditional: a ChatGPT seat
  // plus gpt-seat-plus-flash runs the same models without one.
  const r = withPolicy("gpt-plus-flash", () => inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "" })));
  assert.match(r.stdout, /OPENAI_API_KEY is not set/);
  assert.match(r.stdout, /policy 'gpt-plus-flash' bills it/, "the reason must name the policy");
  assert.match(r.stdout, /gpt-seat-plus-flash/, "the way out must be on screen, not only in the docs");
  assert.ok(
    !/no in-session fallback/i.test(r.stdout),
    "the old claim that nothing covers the judgment tier is false since the seat policy landed",
  );
});

test("a codex that is not logged in blocks setup, through the exit code", () => {
  const r = inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" }), { MMO_STAND_IN_LOGIN: "out" });
  assert.match(r.stdout, /not logged in/);
  assert.match(r.stdout, /Setup incomplete/);
  assert.equal(r.status, 1);
});

test("the wizard never mentions Anthropic (D9)", () => {
  const r = inSandbox((sb) => runWizard(sb));
  assert.ok(!/ANTHROPIC/i.test(r.stdout), "no Anthropic credential belongs in codex setup");
});

test("checking setup does not write state into the repo", () => {
  // A wizard that writes a selection file just for looking would leave a
  // dirty checkout behind every CI run.
  const selectFile = join(REPO_ROOT, ".sdlc", "local", "mmo-select.json");
  const before = existsSync(selectFile) ? readFileSync(selectFile, "utf8") : null;
  inSandbox((sb) => runWizard(sb));
  const after = existsSync(selectFile) ? readFileSync(selectFile, "utf8") : null;
  assert.equal(after, before, "the wizard changed project state while only checking");
});

test("the wizard points at verify-setup for a re-check without questions", () => {
  const r = inSandbox((sb) => runWizard(sb));
  assert.match(r.stdout, /verify-setup\.mjs/, "the non-interactive re-check path must be discoverable");
});

test("the closing banner shows a runnable driver invocation, not a Claude one", () => {
  const r = inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" }));
  assert.ok(!/\bclaude\b/i.test(r.stdout), "no Claude Code invocation may survive into codex setup");
  assert.match(r.stdout, /Setup complete/, r.stdout);
  assert.match(r.stdout, /\$mmo-codex:greenfield/, "the session route comes first");
  assert.match(r.stdout, /--mode=greenfield/);
  assert.doesNotMatch(r.stdout, /--output-dir/, "run.mjs refuses an --output-dir of the shared .sdlc folder");
});

test("the setup tests never reach a real codex", () => {
  inSandbox((sb) => {
    const r = spawnSync("codex", ["--version"], { encoding: "utf8", env: sb.env });
    assert.match(r.stdout, /stand-in for tests/);
    assert.deepEqual(sb.calls(), ["--version"]);
  });
});

test("the wizard registers the bridge in the test's CODEX_HOME, with this clone's server path", () => {
  inSandbox((sb) => {
    const r = runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" });
    assert.match(r.stdout, /Registered\./, r.stdout);
    assert.ok(sb.calls().includes("login status"), sb.calls().join("\n"));
    assert.ok(
      sb.calls().includes(`mcp add model-dispatch -- node ${DIST_ENTRY}`),
      `expected the registration to name ${DIST_ENTRY}:\n${sb.calls().join("\n")}`,
    );
    assert.match(sb.config(), /^\[mcp_servers\.model-dispatch\]$/m);
  });
});

test("a second run finds the registration and does not add it again", () => {
  inSandbox((sb) => {
    runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" });
    const adds = () => sb.calls().filter((call) => call.startsWith("mcp add")).length;
    const before = adds();
    const r = runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" });
    assert.match(r.stdout, /Already registered\./);
    assert.equal(adds(), before, "a registered bridge must not be added twice");
  });
});

test("the wizard does not run npm when the bridge is already built", {
  skip: !(existsSync(DIST_ENTRY) && existsSync(join(SERVER_DIR, "node_modules"))) && "the bridge is not built in this checkout",
}, () => {
  inSandbox((sb) => {
    const r = runWizard(sb);
    assert.match(r.stdout, /Already installed and built\./);
    assert.deepEqual(sb.calls().filter((call) => call.startsWith("npm ")), []);
  });
});

test("on a clone whose bridge is not built, the wizard's npm ci and build reach only the stand-in", () => {
  const clone = mkdtempSync(join(tmpdir(), "mmo-unbuilt-clone-"));
  try {
    mkdirSync(join(clone, "tools"));
    cpSync(join(REPO_ROOT, "tools", "setup.mjs"), join(clone, "tools", "setup.mjs"));
    cpSync(join(REPO_ROOT, "plugin"), join(clone, "plugin"), {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|dist|\.venv)$/.test(src),
    });
    inSandbox((sb) => {
      const r = runWizard(sb, {}, clone);
      assert.match(r.stdout, /installing dependencies/, r.stdout + r.stderr);
      assert.deepEqual(sb.calls().filter((call) => call.startsWith("npm ")), ["npm ci", "npm run build"]);
      assert.equal(existsSync(join(clone, "plugin", "mcp", "model-dispatch", "node_modules")), false);
    });
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

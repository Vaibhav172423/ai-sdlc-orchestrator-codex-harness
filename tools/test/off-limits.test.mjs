import { test } from "node:test";
import assert from "node:assert/strict";

import { HARDCODED_OFF_LIMITS, OFF_LIMITS_DEFAULT } from "../../plugin/scripts/lib/off-limits.mjs";

test("every pre-contract off-limits pattern is also in the project default", () => {
  const missing = HARDCODED_OFF_LIMITS.filter((p) => !OFF_LIMITS_DEFAULT.includes(p));
  assert.deepEqual(missing, [], "a path refused before a contract exists must stay refused once one does");
});

test("the harness's enforcement state is protected before any contract exists", () => {
  for (const p of [".sdlc/local/**", ".codex/config.toml", ".agents/**", ".env"]) {
    assert.ok(HARDCODED_OFF_LIMITS.includes(p), p);
  }
});

test("the harness's own output directory is not off-limits — the run writes its artifacts there", () => {
  assert.ok(!OFF_LIMITS_DEFAULT.includes(".sdlc/**"));
});

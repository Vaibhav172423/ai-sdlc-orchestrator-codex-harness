import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "policy-console", "policy-server.mjs");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function withConsole(fn) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    await new Promise((ready, fail) => {
      let err = "";
      const timer = setTimeout(() => fail(new Error(`console did not start: ${err}`)), 10_000);
      child.stderr.on("data", (c) => {
        err += c;
        if (/listening on/.test(err)) {
          clearTimeout(timer);
          ready();
        }
      });
      child.once("exit", (code) => fail(new Error(`console exited ${code}: ${err}`)));
    });
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
  }
}

test("a policy built in the console keeps its base policy's driver pin and cost cap", async () => {
  await withConsole(async (base) => {
    const policies = await (await fetch(`${base}/api/policies`)).json();
    const list = Array.isArray(policies) ? policies : policies.policies;
    const flash = list.find((p) => p.id === "flash-agsdk-only");
    assert.ok(flash, "flash-agsdk-only is offered");
    const res = await fetch(`${base}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseId: "flash-agsdk-only",
        name: "my-flash",
        models: flash.models,
        routing: flash.routing,
        thinking: flash.thinking,
        intentOverrides: flash.intentOverrides,
      }),
    });
    const out = await res.json();
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const saved = parseYaml(out.yaml);
    assert.deepEqual(
      { model_name: saved.driver?.model_name, effort: saved.driver?.reasoning?.effort },
      { model_name: "gpt-5.6-terra", effort: "high" },
    );
    assert.equal(saved.hard_cost_cap_usd, 50);
  });
});

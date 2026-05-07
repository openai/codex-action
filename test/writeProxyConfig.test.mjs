import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function runWriteProxyConfig(codexHome, port) {
  return spawnSync(
    process.execPath,
    [
      mainPath,
      "write-proxy-config",
      "--codex-home",
      codexHome,
      "--port",
      String(port),
      "--safety-strategy",
      "unsafe",
    ],
    {
      encoding: "utf8",
    }
  );
}

test("write-proxy-config replaces prior managed config on repeated runs", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  const configPath = path.join(codexHome, "config.toml");

  await writeFile(configPath, 'approval_policy = "never"\n', "utf8");

  let result = runWriteProxyConfig(codexHome, 1234);
  assert.equal(result.status, 0, result.stderr);

  result = runWriteProxyConfig(codexHome, 4321);
  assert.equal(result.status, 0, result.stderr);

  const config = await readFile(configPath, "utf8");

  assert.equal(
    (config.match(/model_provider = "codex-action-responses-proxy"/g) ?? []).length,
    1,
  );
  assert.equal(
    (config.match(/\[model_providers\.codex-action-responses-proxy\]/g) ?? []).length,
    1,
  );
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:4321\/v1"/);
  assert.doesNotMatch(config, /base_url = "http:\/\/127\.0\.0\.1:1234\/v1"/);
  assert.match(config, /approval_policy = "never"/);
});
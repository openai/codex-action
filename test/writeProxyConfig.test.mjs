import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      "read-only",
    ],
    { encoding: "utf8" }
  );
}

test("write-proxy-config replaces prior generated config blocks", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-action-test-"));
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, 'sandbox_mode = "read-only"\n', "utf8");

  let result = runWriteProxyConfig(codexHome, 1234);
  assert.equal(result.status, 0, result.stderr);

  result = runWriteProxyConfig(codexHome, 5678);
  assert.equal(result.status, 0, result.stderr);

  const config = readFileSync(configPath, "utf8");
  assert.equal(
    config.match(/^model_provider = "codex-action-responses-proxy"$/gm)
      ?.length,
    1
  );
  assert.equal(
    config.match(/^\[model_providers\.codex-action-responses-proxy\]$/gm)
      ?.length,
    1
  );
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:5678\/v1"/);
  assert.doesNotMatch(config, /base_url = "http:\/\/127\.0\.0\.1:1234\/v1"/);
  assert.match(config, /sandbox_mode = "read-only"/);
});

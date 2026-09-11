import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("preserves an existing model provider when adding the action proxy", () => {
  const codexHome = mkdtempSync(
    path.join(tmpdir(), "codex-action-proxy-config-")
  );
  const configPath = path.join(codexHome, "config.toml");

  try {
    writeFileSync(
      configPath,
      `model = "gpt-5.3-codex"
model_provider = "azure"

[model_providers.azure]
name = "Azure"
base_url = "https://example.openai.azure.com/openai/v1"
env_key = "AZURE_OPENAI_API_KEY"
wire_api = "responses"
`,
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [
        mainPath,
        "write-proxy-config",
        "--codex-home",
        codexHome,
        "--port",
        "12345",
        "--safety-strategy",
        "unsafe",
      ],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);

    const config = readFileSync(configPath, "utf8");

    assert.equal(
      (config.match(/^model_provider\s*=/gm) ?? []).length,
      1
    );
    assert.match(config, /^model_provider = "azure"$/m);
    assert.match(config, /^\[model_providers\.azure\]$/m);
    assert.match(
      config,
      /^\[model_providers\.codex-action-responses-proxy\]$/m
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

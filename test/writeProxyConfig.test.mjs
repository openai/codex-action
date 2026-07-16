import assert from "node:assert/strict";
import {
  chmodSync,
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

test("forwards the installed Codex runtime version through the proxy provider", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-proxy-config-"));
  const codexHome = path.join(tempDir, "codex-home");
  const fakeCodexPath = path.join(tempDir, "codex");
  writeFileSync(fakeCodexPath, "#!/bin/sh\necho 'codex-cli 0.144.0-alpha.1'\n", "utf8");
  chmodSync(fakeCodexPath, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [
        mainPath,
        "write-proxy-config",
        "--codex-home",
        codexHome,
        "--port",
        "9876",
        "--safety-strategy",
        "drop-sudo",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.match(config, /http_headers = \{ version = "0\.144\.0-alpha\.1" \}/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

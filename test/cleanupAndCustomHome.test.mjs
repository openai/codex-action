import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("resolve-codex-home creates non-existent custom codex-home directory (Issue #135)", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-custom-home-test-"));
  const nonExistentCustomHome = path.join(tempDir, "nested", "custom-codex-home");

  try {
    assert.equal(existsSync(nonExistentCustomHome), false);

    const result = spawnSync(
      process.execPath,
      [
        mainPath,
        "resolve-codex-home",
        "--codex-home-override",
        nonExistentCustomHome,
        "--safety-strategy",
        "unsafe",
        "--codex-user",
        "",
        "--github-run-id",
        "12345",
      ],
      {
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 0, `resolve-codex-home failed: ${result.stderr}`);
    assert.equal(existsSync(nonExistentCustomHome), true, "custom codex-home must be created");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run-codex-exec cleans up implicit temporary output directories even when Codex fails (Issue #137)", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-temp-cleanup-test-"));
  const fakeCodexPath = path.join(tempDir, "codex.mjs");

  let createdTempOutputDir = null;

  // Fake codex exits with code 1 after inspecting args to see the created temp output path
  writeFileSync(
    fakeCodexPath,
    `import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex >= 0 && outputIndex + 1 < args.length) {
  const outputFile = args[outputIndex + 1];
  const outputDir = path.dirname(outputFile);
  writeFileSync(${JSON.stringify(path.join(tempDir, "temp_dir.txt"))}, outputDir);
}
process.exit(1);
`,
    "utf8"
  );

  const posixLauncher = path.join(tempDir, "codex");
  writeFileSync(posixLauncher, `#!/bin/sh\nexec node "${fakeCodexPath}" "$@"\n`, "utf8");
  chmodSync(posixLauncher, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [
        mainPath,
        "run-codex-exec",
        "--prompt",
        "hello",
        "--prompt-file",
        "",
        "--codex-home",
        "",
        "--cd",
        tempDir,
        "--extra-args",
        "",
        "--output-file",
        "", // implicit temp output file!
        "--output-schema-file",
        "",
        "--output-schema",
        "",
        "--sandbox",
        "",
        "--model",
        "gpt-5.4",
        "--effort",
        "low",
        "--safety-strategy",
        "unsafe",
        "--codex-user",
        "",
      ],
      {
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH}`,
        },
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 1);
    const recordedTempDir = spawnSync("cat", [path.join(tempDir, "temp_dir.txt")], { encoding: "utf8" }).stdout.trim();
    assert.ok(recordedTempDir.length > 0);
    // The temp directory must be cleaned up in finally block!
    assert.equal(existsSync(recordedTempDir), false, "temporary output directory must be cleaned up on failure");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

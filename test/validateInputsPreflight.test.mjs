import assert from "node:assert/strict";
import {
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

test("validate-inputs rejects mutually exclusive prompt and prompt-file (Issue #139)", () => {
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "validate-inputs",
      "--prompt",
      "Hello",
      "--prompt-file",
      "some-file.md",
      "--working-directory",
      process.cwd(),
      "--output-schema",
      "",
      "--output-schema-file",
      "",
      "--sandbox",
      "",
      "--permission-profile",
      "",
      "--safety-strategy",
      "drop-sudo",
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Only one of `prompt` or `prompt-file` may be specified/);
});

test("validate-inputs rejects non-existent prompt-file (Issue #141)", () => {
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "validate-inputs",
      "--prompt",
      "",
      "--prompt-file",
      "/tmp/definitely-does-not-exist-12345.md",
      "--working-directory",
      process.cwd(),
      "--output-schema",
      "",
      "--output-schema-file",
      "",
      "--sandbox",
      "",
      "--permission-profile",
      "",
      "--safety-strategy",
      "drop-sudo",
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /The specified `prompt-file` does not exist/);
});

test("validate-inputs rejects non-existent working-directory (Issue #141)", () => {
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "validate-inputs",
      "--prompt",
      "Hello",
      "--prompt-file",
      "",
      "--working-directory",
      "/tmp/non-existent-dir-abcde",
      "--output-schema",
      "",
      "--output-schema-file",
      "",
      "--sandbox",
      "",
      "--permission-profile",
      "",
      "--safety-strategy",
      "drop-sudo",
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /The specified `working-directory` does not exist/);
});

test("validate-inputs rejects permission-profile with read-only safety-strategy (Issue #139)", () => {
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "validate-inputs",
      "--prompt",
      "Hello",
      "--prompt-file",
      "",
      "--working-directory",
      process.cwd(),
      "--output-schema",
      "",
      "--output-schema-file",
      "",
      "--sandbox",
      "",
      "--permission-profile",
      "custom-profile",
      "--safety-strategy",
      "read-only",
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /`permission-profile` cannot be used with the `read-only` safety strategy/);
});

test("validate-inputs passes with valid configuration", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-preflight-valid-"));
  const promptFile = path.join(tempDir, "prompt.md");
  writeFileSync(promptFile, "Valid prompt content", "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [
        mainPath,
        "validate-inputs",
        "--prompt",
        "",
        "--prompt-file",
        promptFile,
        "--working-directory",
        tempDir,
        "--output-schema",
        "",
        "--output-schema-file",
        "",
        "--sandbox",
        "",
        "--permission-profile",
        "",
        "--safety-strategy",
        "drop-sudo",
      ],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Input preflight validation passed successfully/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

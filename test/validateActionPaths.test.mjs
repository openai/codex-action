import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../scripts/validateActionPaths.mjs", import.meta.url)
);

function run({ promptFile = "", workingDirectory }) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_PROMPT_FILE: promptFile,
      CODEX_WORKING_DIRECTORY: workingDirectory,
    },
  });
}

test("accepts a readable prompt file and existing working directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-path-test-"));
  const promptFile = path.join(root, "prompt.md");
  writeFileSync(promptFile, "Review this change", "utf8");

  try {
    const result = run({ promptFile, workingDirectory: root });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows an empty prompt-file when inline prompt is used", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-path-test-"));
  try {
    const result = run({ promptFile: "   ", workingDirectory: root });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a missing prompt-file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-path-test-"));
  const promptFile = path.join(root, "missing.md");

  try {
    const result = run({ promptFile, workingDirectory: root });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /prompt-file does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a directory used as prompt-file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-path-test-"));
  const promptDirectory = path.join(root, "prompt-dir");
  mkdirSync(promptDirectory);

  try {
    const result = run({
      promptFile: promptDirectory,
      workingDirectory: root,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /prompt-file must reference a file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a missing working-directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-path-test-"));
  const missingDirectory = path.join(root, "missing");

  try {
    const result = run({ workingDirectory: missingDirectory });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /working-directory does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a file used as working-directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-path-test-"));
  const filePath = path.join(root, "not-a-directory");
  writeFileSync(filePath, "x", "utf8");

  try {
    const result = run({ workingDirectory: filePath });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /working-directory must reference a directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

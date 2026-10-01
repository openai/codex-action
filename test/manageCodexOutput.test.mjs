import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

const scriptPath = fileURLToPath(
  new URL("../scripts/manageCodexOutput.mjs", import.meta.url)
);

function parseOutputs(file) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

test("prepares and cleans runner-owned output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-output-test-"));
  const githubOutput = path.join(root, "github-output");
  writeFileSync(githubOutput, "", "utf8");

  try {
    const prepare = spawnSync(
      process.execPath,
      [scriptPath, "prepare", "drop-sudo", ""],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: githubOutput, TMPDIR: root },
      }
    );
    assert.equal(prepare.status, 0, prepare.stderr);

    const outputs = parseOutputs(githubOutput);
    assert.ok(outputs.output_file);
    assert.ok(outputs.output_dir);
    assert.equal(existsSync(outputs.output_dir), true);
    assert.equal(path.dirname(outputs.output_file), outputs.output_dir);

    const cleanup = spawnSync(
      process.execPath,
      [scriptPath, "cleanup", "drop-sudo", ""],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_MANAGED_OUTPUT_DIR: outputs.output_dir,
        },
      }
    );
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(existsSync(outputs.output_dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses the configured user for unprivileged output and root cleanup", () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-output-user-test-"));
  const fakeBin = path.join(root, "bin");
  const fakeSudo = path.join(fakeBin, "sudo");
  const githubOutput = path.join(root, "github-output");
  const logFile = path.join(root, "sudo.log");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(githubOutput, "", "utf8");
  writeFileSync(
    fakeSudo,
    `#!/bin/sh
printf '%s\n' "$*" >> "$SUDO_LOG"
if [ "$1" = "-u" ]; then
  shift 2
  if [ "$1" = "--" ]; then shift; fi
  exec "$@"
fi
if [ "$1" = "rm" ]; then
  exec "$@"
fi
exit 2
`,
    "utf8"
  );
  chmodSync(fakeSudo, 0o755);

  try {
    const env = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      SUDO_LOG: logFile,
      GITHUB_OUTPUT: githubOutput,
      TMPDIR: root,
    };
    const prepare = spawnSync(
      process.execPath,
      [scriptPath, "prepare", "unprivileged-user", "guest"],
      { encoding: "utf8", env }
    );
    assert.equal(prepare.status, 0, prepare.stderr);

    const outputs = parseOutputs(githubOutput);
    assert.equal(existsSync(outputs.output_dir), true);

    const cleanup = spawnSync(
      process.execPath,
      [scriptPath, "cleanup", "unprivileged-user", "guest"],
      {
        encoding: "utf8",
        env: { ...env, CODEX_MANAGED_OUTPUT_DIR: outputs.output_dir },
      }
    );
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(existsSync(outputs.output_dir), false);

    const log = readFileSync(logFile, "utf8");
    assert.match(log, /-u guest -- mktemp -d -t codex-action-output\.XXXXXX/);
    assert.match(log, new RegExp(`rm -rf -- ${outputs.output_dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails before creating output when unprivileged-user has no codex-user", () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-output-user-test-"));
  const githubOutput = path.join(root, "github-output");
  writeFileSync(githubOutput, "", "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "prepare", "unprivileged-user", ""],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: githubOutput },
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /codex-user is required/);
    assert.equal(readFileSync(githubOutput, "utf8"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

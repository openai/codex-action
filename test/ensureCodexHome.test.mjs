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
  new URL("../scripts/ensureCodexHome.mjs", import.meta.url)
);

test("creates a missing Codex home for ordinary safety strategies", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-home-test-"));
  const codexHome = path.join(root, "nested", "codex-home");

  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, codexHome, "drop-sudo", ""],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(codexHome), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates a shared unprivileged home and writable per-run server-info file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-home-user-test-"));
  const codexHome = path.join(root, "guest-home", ".codex");
  const fakeBin = path.join(root, "bin");
  const fakeSudo = path.join(fakeBin, "sudo");
  const logFile = path.join(root, "sudo.log");
  const runId = "12345";
  const serverInfoFile = path.join(codexHome, `${runId}.json`);

  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      fakeSudo,
      `#!/bin/sh
printf '%s\n' "$*" >> "$SUDO_LOG"
case "$1" in
  mkdir|touch)
    exec "$@"
    ;;
  chown|chmod)
    exit 0
    ;;
esac
exit 2
`,
      "utf8"
    );
    chmodSync(fakeSudo, 0o755);

    const result = spawnSync(
      process.execPath,
      [scriptPath, codexHome, "unprivileged-user", "guest"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          SUDO_LOG: logFile,
          GITHUB_RUN_ID: runId,
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(codexHome), true);
    assert.equal(existsSync(serverInfoFile), true);
    assert.equal(
      readFileSync(logFile, "utf8"),
      [
        `mkdir -p -- ${codexHome}`,
        `chown guest ${codexHome}`,
        `chmod 755 ${codexHome}`,
        `touch -- ${serverInfoFile}`,
        `chmod 666 ${serverInfoFile}`,
        "",
      ].join("\n")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepares a new run file when the unprivileged Codex home already exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-home-existing-test-"));
  const codexHome = path.join(root, ".codex");
  const fakeBin = path.join(root, "bin");
  const fakeSudo = path.join(fakeBin, "sudo");
  const logFile = path.join(root, "sudo.log");
  const runId = "67890";
  const serverInfoFile = path.join(codexHome, `${runId}.json`);

  try {
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      fakeSudo,
      `#!/bin/sh
printf '%s\n' "$*" >> "$SUDO_LOG"
case "$1" in
  touch)
    exec "$@"
    ;;
  chmod)
    exit 0
    ;;
esac
exit 2
`,
      "utf8"
    );
    chmodSync(fakeSudo, 0o755);

    const result = spawnSync(
      process.execPath,
      [scriptPath, codexHome, "unprivileged-user", "guest"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          SUDO_LOG: logFile,
          GITHUB_RUN_ID: runId,
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(serverInfoFile), true);
    assert.equal(
      readFileSync(logFile, "utf8"),
      [`touch -- ${serverInfoFile}`, `chmod 666 ${serverInfoFile}`, ""].join(
        "\n"
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails clearly when unprivileged-user has no codex-user", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-home-user-test-"));
  const codexHome = path.join(root, ".codex");

  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, codexHome, "unprivileged-user", ""],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_RUN_ID: "12345" },
      }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /codex-user is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails clearly when an unprivileged run has no GitHub run id", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-home-run-id-test-"));
  const codexHome = path.join(root, ".codex");
  const env = { ...process.env };
  delete env.GITHUB_RUN_ID;

  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, codexHome, "unprivileged-user", "guest"],
      { encoding: "utf8", env }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GITHUB_RUN_ID is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

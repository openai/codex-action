import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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

test("creates a missing Codex home as the configured unprivileged user", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-home-user-test-"));
  const codexHome = path.join(root, "guest-home", ".codex");
  const fakeBin = path.join(root, "bin");
  const fakeSudo = path.join(fakeBin, "sudo");
  const logFile = path.join(root, "sudo.log");

  try {
    spawnSync("mkdir", ["-p", fakeBin], { encoding: "utf8" });
    writeFileSync(
      fakeSudo,
      `#!/bin/sh
printf '%s\n' "$*" >> "$SUDO_LOG"
if [ "$1" = "-u" ]; then shift 2; fi
if [ "$1" = "--" ]; then shift; fi
exec "$@"
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
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(codexHome), true);
    assert.equal(
      readFileSync(logFile, "utf8"),
      `-u guest -- mkdir -p -- ${codexHome}\n`
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
      { encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /codex-user is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

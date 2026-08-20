import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const canTestRootPath =
  process.platform === "linux" &&
  process.getuid?.() !== 0 &&
  spawnSync("/usr/bin/sudo", ["-n", "true"], { stdio: "ignore" }).status === 0;

test(
  "drop-sudo ignores caller-controlled PATH before running privileged commands",
  { skip: !canTestRootPath },
  () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-root-path-"));
    const markerPath = path.join(tempDir, "executed-as-root");
    const missingUser = `cdxpath${process.pid}${Date.now().toString(36)}`;

    try {
      for (const command of ["id", "sh", "deluser", "gpasswd"]) {
        const fakeCommand = path.join(tempDir, command);
        writeFileSync(
          fakeCommand,
          `#!/bin/sh\n/usr/bin/touch "$CODEX_ROOT_PATH_MARKER"\nexit 97\n`
        );
        chmodSync(fakeCommand, 0o755);
      }

      const result = spawnSync(
        "/usr/bin/sudo",
        [
          "-n",
          "--",
          "/usr/bin/env",
          `PATH=${tempDir}:${process.env.PATH ?? ""}`,
          `CODEX_ROOT_PATH_MARKER=${markerPath}`,
          process.execPath,
          mainPath,
          "drop-sudo",
          "--root-phase",
          "--user",
          missingUser,
          "--group",
          "sudo",
          "--runner-credentials",
          JSON.stringify({
            userId: process.getuid(),
            primaryGroupId: process.getgid(),
            supplementaryGroupIds: process.getgroups(),
          }),
        ],
        { encoding: "utf8", timeout: 10_000 }
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Command failed: id /);
      assert.equal(existsSync(markerPath), false, result.stderr);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
);

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("check-proxy-status returns true when proxy is alive with PID", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-proxy-status-alive-"));
  const serverInfoFile = path.join(tempDir, "server_info.json");

  // Start a dummy background process to simulate alive proxy
  const dummyChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const pid = dummyChild.pid;

  writeFileSync(
    serverInfoFile,
    JSON.stringify({ port: 12345, pid }),
    "utf8"
  );

  try {
    const result = spawnSync(
      process.execPath,
      [mainPath, "check-proxy-status", serverInfoFile],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Responses API proxy is running/);
  } finally {
    dummyChild.kill("SIGKILL");
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("check-proxy-status removes stale server-info and returns false when proxy PID is dead (Issue #133)", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-proxy-status-dead-"));
  const serverInfoFile = path.join(tempDir, "server_info.json");

  // An unreachable/dead PID
  const deadPid = 99999999;

  writeFileSync(
    serverInfoFile,
    JSON.stringify({ port: 12345, pid: deadPid }),
    "utf8"
  );

  try {
    assert.equal(existsSync(serverInfoFile), true);

    const result = spawnSync(
      process.execPath,
      [mainPath, "check-proxy-status", serverInfoFile],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Stale server-info file found for dead proxy PID/);
    assert.equal(existsSync(serverInfoFile), false, "stale server-info file must be deleted");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

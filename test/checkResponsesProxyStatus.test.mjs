import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../scripts/checkResponsesProxyStatus.mjs", import.meta.url)
);

function runStatus(serverInfoFile) {
  const outputFile = `${serverInfoFile}.output`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, serverInfoFile], {
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      let output = "";
      try {
        output = readFileSync(outputFile, "utf8");
      } catch {}
      resolve({ status, stdout, stderr, output });
    });
  });
}

test("reports a missing server-info file as not running", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-proxy-status-"));
  const serverInfo = path.join(dir, "missing.json");
  try {
    const result = await runStatus(serverInfo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "server_info_file_exists=false\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removes malformed server info and reports not running", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-proxy-status-"));
  const serverInfo = path.join(dir, "server.json");
  writeFileSync(serverInfo, "not json", "utf8");
  try {
    const result = await runStatus(serverInfo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "server_info_file_exists=false\n");
    assert.throws(() => readFileSync(serverInfo, "utf8"), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removes dead proxy metadata and reports not running", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-proxy-status-"));
  const serverInfo = path.join(dir, "server.json");
  writeFileSync(
    serverInfo,
    JSON.stringify({ pid: 2147483647, port: 65535 }),
    "utf8"
  );
  try {
    const result = await runStatus(serverInfo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "server_info_file_exists=false\n");
    assert.throws(() => readFileSync(serverInfo, "utf8"), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reuses metadata only when both pid and loopback port are live", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-proxy-status-"));
  const serverInfo = path.join(dir, "server.json");
  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(
    serverInfo,
    JSON.stringify({ pid: process.pid, port: address.port }),
    "utf8"
  );

  try {
    const result = await runStatus(serverInfo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "server_info_file_exists=true\n");
    assert.match(result.stdout, /Responses API proxy is running/);
    assert.equal(
      JSON.parse(readFileSync(serverInfo, "utf8")).port,
      address.port
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

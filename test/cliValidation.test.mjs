import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [mainPath, ...args], {
    encoding: "utf8",
  });
}

function runRunCodexExec(extraArgs) {
  return runCli([
    "run-codex-exec",
    "--prompt",
    "hello",
    "--prompt-file",
    "",
    "--codex-home",
    "",
    "--cd",
    process.cwd(),
    "--extra-args",
    extraArgs,
    "--output-file",
    "",
    "--output-schema-file",
    "",
    "--output-schema",
    "",
    "--sandbox",
    "workspace-write",
    "--model",
    "",
    "--effort",
    "",
    "--safety-strategy",
    "unsafe",
    "--codex-user",
    "",
  ]);
}

test("write-proxy-config rejects out-of-range ports", () => {
  const result = runCli([
    "write-proxy-config",
    "--codex-home",
    "/tmp/codex-home",
    "--port",
    "65536",
    "--safety-strategy",
    "unsafe",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid port: 65536/);
});

test("run-codex-exec wraps malformed extra args JSON", () => {
  const result = runRunCodexExec('["--model"');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --extra-args JSON:/);
});

test("run-codex-exec rejects non-string JSON args", () => {
  const result = runRunCodexExec('["--model", 1]');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected a JSON array of strings/);
});
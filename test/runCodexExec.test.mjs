import assert from "node:assert/strict";
import {
  chmodSync,
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

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/**
 * Runs the bundled `run-codex-exec` command with a generated fake `codex` executable first on
 * `PATH`. The fake captures its arguments and writes a final-message file without making an API
 * request, so successful cases exercise command construction, process spawning, and output
 * handling without an API key. Validation-error cases assert that the fake was never spawned.
 */
function runCodexExecWithFakeCodex({
  sandbox = "",
  permissionProfile = "",
  extraArgs = "",
  safetyStrategy = "drop-sudo",
} = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-permissions-"));
  const capturePath = path.join(tempDir, "args.json");
  const outputPath = path.join(tempDir, "output.txt");
  const fakeCodexPath = path.join(tempDir, "codex.mjs");
  writeFileSync(
    fakeCodexPath,
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.CODEX_CAPTURE_ARGS, JSON.stringify(args));
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0 || outputIndex + 1 >= args.length) {
  throw new Error("missing --output-last-message");
}
writeFileSync(args[outputIndex + 1], "fake final message\\n");
`,
    "utf8"
  );
  const posixLauncher = path.join(tempDir, "codex");
  writeFileSync(
    posixLauncher,
    `#!/bin/sh\nexec node "${fakeCodexPath}" "$@"\n`,
    "utf8"
  );
  chmodSync(posixLauncher, 0o755);
  writeFileSync(
    path.join(tempDir, "codex.cmd"),
    `@node "${fakeCodexPath}" %*\r\n`,
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "run-codex-exec",
      "--prompt",
      "test prompt",
      "--prompt-file",
      "",
      "--codex-home",
      "",
      "--cd",
      tempDir,
      "--extra-args",
      extraArgs,
      "--output-file",
      outputPath,
      "--output-schema-file",
      "",
      "--output-schema",
      "",
      "--sandbox",
      sandbox,
      ...(permissionProfile == null
        ? []
        : ["--permission-profile", permissionProfile]),
      "--model",
      "",
      "--effort",
      "",
      "--safety-strategy",
      safetyStrategy,
      "--codex-user",
      "",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CODEX_CAPTURE_ARGS: capturePath,
      },
    }
  );

  let capturedArgs = null;
  try {
    capturedArgs = JSON.parse(readFileSync(capturePath, "utf8"));
  } catch {
    // Expected when argument validation rejects the invocation before spawning Codex.
  }
  rmSync(tempDir, { recursive: true, force: true });
  return { result, capturedArgs };
}

test("preserves workspace-write as the default legacy sandbox", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-2), ["--sandbox", "workspace-write"]);
});

test("allows permission-profile to be omitted", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: null,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-2), ["--sandbox", "workspace-write"]);
});

test("selects a permission profile without passing --sandbox", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: "public-review",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(capturedArgs.includes("--sandbox"), false);
  assert.deepEqual(capturedArgs.slice(-2), [
    "--config",
    'default_permissions="public-review"',
  ]);
});

test("rejects permission-profile with sandbox", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: "public-review",
    sandbox: "read-only",
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedArgs, null);
  assert.match(result.stderr, /mutually exclusive/);
});

test("rejects permission-profile with the read-only safety strategy", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: "public-review",
    safetyStrategy: "read-only",
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedArgs, null);
  assert.match(result.stderr, /forces the legacy read-only sandbox/);
});

test("rejects permission-profile with a sandbox in codex-args", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: "public-review",
    extraArgs: '["--sandbox", "read-only"]',
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedArgs, null);
  assert.match(result.stderr, /sandbox override in `codex-args`/);
});

for (const extraArgs of [
  '["--config", "sandbox_workspace_write.network_access=true"]',
  '["--config=sandbox_workspace_write.network_access=true"]',
]) {
  test(`rejects permission-profile with ${extraArgs} in codex-args`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile: "public-review",
      extraArgs,
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /sandbox override in `codex-args`/);
  });
}

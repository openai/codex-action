import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));
const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function runWithEnvironmentPrompt({ directPrompt = "" } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-prompt-"));
  const capturePath = path.join(tempDir, "prompt.txt");
  const outputPath = path.join(tempDir, "output.txt");
  const fakeCodexPath = path.join(tempDir, "codex.mjs");
  writeFileSync(
    fakeCodexPath,
    `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.CODEX_CAPTURE_PROMPT, readFileSync(0, "utf8"));
const outputIndex = args.indexOf("--output-last-message");
writeFileSync(args[outputIndex + 1], "fake final message\\n");
`
  );
  const launcherPath = path.join(tempDir, "codex");
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nexec node "${fakeCodexPath}" "$@"\n`
  );
  chmodSync(launcherPath, 0o755);
  writeFileSync(
    path.join(tempDir, "codex.cmd"),
    `@node "${fakeCodexPath}" %*\r\n`
  );

  const prompt = "first line\nsecond line with spaces";
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "run-codex-exec",
      "--prompt",
      directPrompt,
      "--prompt-file",
      "",
      "--prompt-environment-variable",
      "CODEX_PROMPT",
      "--codex-home",
      "",
      "--cd",
      tempDir,
      "--extra-args",
      "",
      "--output-file",
      outputPath,
      "--output-schema-file",
      "",
      "--output-schema",
      "",
      "--sandbox",
      "",
      "--permission-profile",
      "",
      "--model",
      "",
      "--effort",
      "",
      "--safety-strategy",
      "unsafe",
      "--codex-user",
      "",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CODEX_CAPTURE_PROMPT: capturePath,
        CODEX_PROMPT: prompt,
      },
    }
  );

  let capturedPrompt = null;
  try {
    capturedPrompt = readFileSync(capturePath, "utf8");
  } catch {
    // Expected when prompt validation rejects the invocation.
  }
  rmSync(tempDir, { recursive: true, force: true });
  return { result, capturedPrompt, prompt };
}

test("keeps the action inline prompt out of the helper argv", () => {
  const action = readFileSync(actionPath, "utf8");
  assert.match(
    action,
    /--prompt-environment-variable "\$\{CODEX_PROMPT:\+CODEX_PROMPT\}"/
  );
  assert.doesNotMatch(action, /--prompt "\$\{CODEX_PROMPT\}"/);

  const { result, capturedPrompt, prompt } = runWithEnvironmentPrompt();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(capturedPrompt, prompt);
});

test("rejects direct and environment-backed prompts together", () => {
  const { result, capturedPrompt } = runWithEnvironmentPrompt({
    directPrompt: "direct prompt",
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedPrompt, null);
  assert.match(result.stderr, /Only one prompt source may be specified/);
});

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("run-codex-exec reads prompt from environment variable (--prompt-env)", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-prompt-env-"));
  const capturePromptPath = path.join(tempDir, "captured_prompt.txt");
  const outputPath = path.join(tempDir, "output.txt");
  const fakeCodexPath = path.join(tempDir, "codex.mjs");

  writeFileSync(
    fakeCodexPath,
    `import { writeFileSync, readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(capturePromptPath)}, prompt);
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
writeFileSync(args[outputIndex + 1], "done\\n");
`,
    "utf8"
  );

  const posixLauncher = path.join(tempDir, "codex");
  writeFileSync(posixLauncher, `#!/bin/sh\nexec node "${fakeCodexPath}" "$@"\n`, "utf8");
  chmodSync(posixLauncher, 0o755);

  try {
    const multiLinePrompt = "Line 1: Hello\nLine 2: World with $SPECIAL & 'chars'\nLine 3: 🚀";
    const result = spawnSync(
      process.execPath,
      [
        mainPath,
        "run-codex-exec",
        "--prompt-env",
        "MY_CUSTOM_PROMPT",
        "--prompt",
        "",
        "--prompt-file",
        "",
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
        "--model",
        "gpt-5.4",
        "--effort",
        "low",
        "--safety-strategy",
        "unsafe",
        "--codex-user",
        "",
      ],
      {
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH}`,
          MY_CUSTOM_PROMPT: multiLinePrompt,
        },
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 0, `helper failed: ${result.stderr}`);
    const captured = spawnSync("cat", [capturePromptPath], { encoding: "utf8" }).stdout;
    assert.equal(captured, multiLinePrompt);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run-codex-exec safely handles early child exit without uncaught EPIPE", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-epipe-"));
  const outputPath = path.join(tempDir, "output.txt");
  const fakeCodexPath = path.join(tempDir, "codex.mjs");

  // A fake codex binary that exits immediately with code 42 without consuming stdin
  writeFileSync(
    fakeCodexPath,
    `process.exit(42);`,
    "utf8"
  );

  const posixLauncher = path.join(tempDir, "codex");
  writeFileSync(posixLauncher, `#!/bin/sh\nexec node "${fakeCodexPath}" "$@"\n`, "utf8");
  chmodSync(posixLauncher, 0o755);

  try {
    // 64KB is enough to exceed typical pipe buffer and trigger EPIPE on immediate child exit without exceeding OS execve env limit
    const promptData = "x".repeat(64 * 1024);

    const result = spawnSync(
      process.execPath,
      [
        mainPath,
        "run-codex-exec",
        "--prompt-env",
        "TEST_PROMPT_VAR",
        "--prompt",
        "",
        "--prompt-file",
        "",
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
        "--model",
        "gpt-5.4",
        "--effort",
        "low",
        "--safety-strategy",
        "unsafe",
        "--codex-user",
        "",
      ],
      {
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH}`,
          TEST_PROMPT_VAR: promptData,
        },
        encoding: "utf8",
      }
    );

    // It must reject cleanly with the child's exit code, without uncaught EventEmitter EPIPE crash
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exited with code 42/);
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|uncaughtException|events.js/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

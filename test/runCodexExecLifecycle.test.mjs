import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const finalMessage = "fixture final message\nsecond line\n";
// The fixture uses exec so the action's direct child is the fake Codex process.
const posixOnly = { skip: process.platform === "win32" };
const descendantScript = `
const { existsSync, writeFileSync } = require("node:fs");
process.once("exit", () => writeFileSync(process.argv[3], ""));
setInterval(() => {
  if (existsSync(process.argv[2])) process.exit(0);
}, 25).unref();
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
if (process.argv[1] === "true") {
  setInterval(() => {
    console.log("descendant stdout");
    console.error("descendant stderr");
  }, 25);
}
setTimeout(() => process.exit(0), 15000);
`;

async function runFixture(body, { timeoutMs = 8000, missingInterpreter = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-action-lifecycle-"));
  const outputPath = path.join(dir, "output.txt");
  const githubOutputPath = path.join(dir, "github-output.txt");
  const cleanupPath = path.join(dir, "cleanup");
  const fakeStartedPath = path.join(dir, "codex-started");
  const fakeStoppedPath = path.join(dir, "codex-stopped");
  const descendantStartedPath = path.join(dir, "descendant-started");
  const descendantStoppedPath = path.join(dir, "descendant-stopped");
  const fakePath = path.join(dir, "codex.mjs");
  writeFileSync(githubOutputPath, "");
  writeFileSync(
    fakePath,
    `import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(fakeStartedPath)}, "");
function markStopped() { writeFileSync(${JSON.stringify(fakeStoppedPath)}, ""); }
process.once("exit", markStopped);
setInterval(() => {
  if (existsSync(${JSON.stringify(cleanupPath)})) process.exit(0);
}, 25).unref();
process.stdin.resume();
await new Promise((resolve) => process.stdin.on("end", resolve));
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf("--output-last-message") + 1], ${JSON.stringify(finalMessage)});
console.log("fixture stdout");
console.error("fixture stderr");
function retainPipes(emit) {
  const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}, String(emit), ${JSON.stringify(cleanupPath)}, ${JSON.stringify(descendantStoppedPath)}], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  writeFileSync(${JSON.stringify(descendantStartedPath)}, "");
  descendant.unref();
}
${body}\n`,
  );
  const launcher = path.join(dir, "codex");
  writeFileSync(
    launcher,
    missingInterpreter
      ? `#!${path.join(dir, "missing-interpreter")}\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fakePath}" "$@"\n`,
  );
  chmodSync(launcher, 0o755);

  let action;
  let timer;
  let closed;
  try {
    action = spawn(
      process.execPath,
      [
        mainPath,
        "run-codex-exec",
        "--prompt", "fixture prompt",
        "--prompt-file", "",
        "--codex-home", "",
        "--cd", dir,
        "--extra-args", "",
        "--output-file", outputPath,
        "--output-schema-file", "",
        "--output-schema", "",
        "--sandbox", "",
        "--model", "",
        "--effort", "",
        "--safety-strategy", "unsafe",
        "--codex-user", "",
      ],
      {
        env: {
          ...process.env,
          PATH: dir,
          GITHUB_OUTPUT: githubOutputPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    action.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
    action.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
    closed = new Promise((resolve, reject) => {
      action.on("error", reject);
      action.on("close", (code, signal) => resolve({ code, signal, timedOut: false }));
    });
    const result = await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
    return {
      ...result,
      stdout,
      stderr,
      output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null,
      githubOutput: readFileSync(githubOutputPath, "utf8"),
    };
  } finally {
    clearTimeout(timer);
    // Ask fixture processes to exit without signaling a PID that may have been reused.
    writeFileSync(cleanupPath, "");
    if (action) {
      if (action.exitCode === null && action.signalCode === null) {
        action.kill("SIGKILL");
      }
      action.stdout.destroy();
      action.stderr.destroy();
      await closed?.catch(() => {});
    }
    const waitForStop = async (startedPath, stoppedPath) => {
      if (!existsSync(startedPath)) return true;
      for (let i = 0; i < 120 && !existsSync(stoppedPath); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return existsSync(stoppedPath);
    };
    const fakeStopped = await waitForStop(fakeStartedPath, fakeStoppedPath);
    const descendantStopped = await waitForStop(descendantStartedPath, descendantStoppedPath);
    rmSync(dir, { recursive: true, force: true });
    assert.ok(fakeStopped && descendantStopped, "fixture processes must stop during cleanup");
  }
}

function assertFinalMessage(result) {
  assert.equal(result.timedOut, false, "the action's log pipes must close after Codex exits");
  assert.equal(result.code, 0, result.stderr);
  const output = result.githubOutput.match(/^final-message<<([^\r\n]+)\r?\n([\s\S]*)\r?\n\1\r?\n$/);
  assert.ok(output, "expected exactly one final-message GitHub output");
  assert.equal(output[2], finalMessage);
}

test("finishes when an exited Codex leaves a quiet descendant holding log pipes", posixOnly, async () => {
  const result = await runFixture("retainPipes(false);");
  assertFinalMessage(result);
  assert.match(result.stdout, /fixture stdout\n/);
  assert.match(result.stderr, /fixture stderr\n/);
  assert.match(result.stdout, /::warning::Codex exited, but its output streams remained open after 5 seconds/);
});

test("keeps shutdown bounded while a descendant continues writing logs", posixOnly, async () => {
  const result = await runFixture("retainPipes(true);");
  assertFinalMessage(result);
  assert.match(result.stdout, /descendant stdout/);
  assert.match(result.stderr, /descendant stderr/);
  assert.match(result.stdout, /::warning::Codex exited, but its output streams remained open after 5 seconds/);
});

test("preserves a failing Codex exit even when a final message and retained pipes exist", posixOnly, async () => {
  const result = await runFixture("retainPipes(false); process.exitCode = 17;");
  assert.equal(result.timedOut, false, "a failing Codex must also release action log pipes");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /exited with code 17/);
  assert.equal(result.output, finalMessage);
  assert.equal(result.githubOutput, "");
});

test("forwards complete large stdout and stderr before normal completion", posixOnly, async () => {
  const stdout = "O".repeat(512 * 1024) + "\nstdout tail\n";
  const stderr = "E".repeat(512 * 1024) + "\nstderr tail\n";
  const result = await runFixture(`await Promise.all([
    new Promise((resolve) => process.stdout.write(${JSON.stringify(stdout)}, resolve)),
    new Promise((resolve) => process.stderr.write(${JSON.stringify(stderr)}, resolve)),
  ]);`);
  assertFinalMessage(result);
  assert.ok(result.stdout.endsWith("fixture stdout\n" + stdout));
  assert.equal(result.stderr, "fixture stderr\n" + stderr);
});

test("preserves complete large final logs when a descendant keeps the pipes open", posixOnly, async () => {
  const stdout = "O".repeat(512 * 1024) + "\nstdout tail\n";
  const stderr = "E".repeat(512 * 1024) + "\nstderr tail\n";
  const result = await runFixture(`retainPipes(false);
  await Promise.all([
    new Promise((resolve) => process.stdout.write(${JSON.stringify(stdout)}, resolve)),
    new Promise((resolve) => process.stderr.write(${JSON.stringify(stderr)}, resolve)),
  ]);`);
  assertFinalMessage(result);
  assert.ok(result.stdout.includes("fixture stdout\n" + stdout));
  assert.equal(result.stderr, "fixture stderr\n" + stderr);
  assert.match(result.stdout, /::warning::Codex exited, but its output streams remained open after 5 seconds/);
});

test("does not publish success while Codex is still running after writing its final message", posixOnly, async () => {
  const result = await runFixture("setTimeout(() => process.exit(0), 10000);", { timeoutMs: 1500 });
  assert.equal(result.output, finalMessage, "the live child must have written its result");
  assert.equal(result.timedOut, true, "an output file must not finish a live Codex process");
  assert.equal(result.githubOutput, "");
});

test("reports signal termination even when a descendant retains log pipes", posixOnly, async () => {
  // Signal termination does not run the fake's exit hook.
  const result = await runFixture('retainPipes(false); markStopped(); process.kill(process.pid, "SIGTERM");');
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /exited with signal SIGTERM/);
  assert.equal(result.githubOutput, "");
});

test("reports a spawn error without publishing a final message", posixOnly, async () => {
  const result = await runFixture("", { missingInterpreter: true });
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /spawn codex ENOENT/);
  assert.equal(result.output, null);
  assert.equal(result.githubOutput, "");
});

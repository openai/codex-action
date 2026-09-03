import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);

function loadRunCodexExec(spawn, stdout, stderr) {
  const { outputFiles } = buildSync({
    entryPoints: [
      fileURLToPath(new URL("../src/runCodexExec.ts", import.meta.url)),
    ],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    external: ["./checkOutput", "@actions/core"],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    require(name) {
      if (name === "child_process" || name === "node:child_process") {
        return { spawn };
      }
      if (name === "./checkOutput") {
        return { checkOutput: async () => "" };
      }
      if (name === "@actions/core") {
        return { setOutput() {} };
      }
      return require(name);
    },
    process: {
      platform: "darwin",
      env: {},
      stdout,
      stderr,
    },
    console: { log() {} },
    setImmediate,
    clearImmediate,
    setTimeout,
    clearTimeout,
  });
  return module.exports.runCodexExec;
}

function captureOutput() {
  const chunks = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  };
}

test("drains buffered stdout and stderr after the direct child exits", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-streams-"));
  const outputPath = path.join(tempDir, "output.txt");
  writeFileSync(outputPath, "fake final message\n", "utf8");

  const stdout = captureOutput();
  const stderr = captureOutput();
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const stdoutPayload = `stdout-start:${"o".repeat(1024 * 1024)}:stdout-end`;
  const stderrPayload = `stderr-start:${"e".repeat(1024 * 1024)}:stderr-end`;
  const runCodexExec = loadRunCodexExec(
    () => {
      setImmediate(() => {
        child.emit("exit", 0);
        setImmediate(() => {
          child.stdout.write(stdoutPayload);
          child.stderr.write(stderrPayload);
        });
      });
      return child;
    },
    stdout.stream,
    stderr.stream
  );

  try {
    await runCodexExec({
      prompt: { type: "inline", content: "test" },
      codexHome: null,
      cd: tempDir,
      extraArgs: [],
      explicitOutputFile: outputPath,
      outputSchema: null,
      model: null,
      effort: null,
      safetyStrategy: "unsafe",
      codexUser: null,
      sandbox: null,
      permissionProfile: null,
    });

    assert.equal(Buffer.concat(stdout.chunks).toString(), stdoutPayload);
    assert.equal(Buffer.concat(stderr.chunks).toString(), stderrPayload);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadRunCodexExec(spawn) {
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
    },
    console: { log() {} },
  });
  return module.exports.runCodexExec;
}

test("rejects a Codex stdin error through the execution promise", async () => {
  const stdinError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const runCodexExec = loadRunCodexExec(() => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {
      process.nextTick(() => child.stdin.emit("error", stdinError));
    };
    child.stdin.end = () => {};
    setImmediate(() => child.emit("close", 7));
    return child;
  });

  await assert.rejects(
    runCodexExec({
      prompt: { type: "inline", content: "buffered prompt" },
      codexHome: null,
      cd: "/synthetic",
      extraArgs: [],
      explicitOutputFile: "/synthetic/output",
      outputSchema: null,
      model: null,
      effort: null,
      safetyStrategy: "unsafe",
      codexUser: null,
      sandbox: null,
      permissionProfile: null,
    }),
    (error) => error === stdinError
  );
});

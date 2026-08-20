import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import vm from "node:vm";

const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/linuxCredentials.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { parseLinuxRunnerCredentials, includeAccountGroups } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const original = { userId: 1001, primaryGroupId: 999, supplementaryGroupIds: [27, 998] };
const require = createRequire(import.meta.url);

function loadLauncher(file, spawn) {
  const { outputFiles } = buildSync({
    entryPoints: [fileURLToPath(new URL(`../src/${file}.ts`, import.meta.url))],
    bundle: true, format: "cjs", platform: "node", write: false,
    external: ["./checkOutput", "@actions/core"],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require(name) {
      if (name === "child_process" || name === "node:child_process") return { spawn };
      if (name === "./checkOutput") return { checkOutput: async (args) => args[0] === "which" ? "/synthetic/codex" : "" };
      if (name === "@actions/core") return { setOutput() {} };
      if (name === "os") return { userInfo: () => ({ username: "runner", homedir: "/synthetic" }) };
      return require(name);
    },
    process: { platform: "linux", getuid: () => original.userId,
      getgid: () => original.primaryGroupId, getgroups: () => original.supplementaryGroupIds,
      execPath: "/synthetic/node", argv: ["node", "/synthetic/main.js"], execArgv: [], env: {} },
    console: { log() {} },
  });
  return module.exports;
}

test("both Linux launch paths pass the original process credentials", async () => {
  const stopped = new Error("captured before privileged execution");
  let captured;
  const run = loadLauncher("runCodexExec", (program, args) => {
    captured = { program, args };
    throw stopped;
  });
  await assert.rejects(run.runCodexExec({
    prompt: { type: "inline", content: "test" }, codexHome: null, cd: "/synthetic",
    extraArgs: [], explicitOutputFile: "/synthetic/output", outputSchema: null,
    model: null, effort: null, safetyStrategy: "drop-sudo", codexUser: null,
    sandbox: null, permissionProfile: null,
  }), (error) => error === stopped);
  const marker = captured.args.indexOf("codex-action-drop-sudo");
  assert.deepEqual(JSON.parse(captured.args[marker + 8]), original);
  assert.equal(captured.args[marker + 9], "/synthetic/codex");
  assert.match(captured.args[captured.args.indexOf("-c") + 1], /--runner-credentials "\$runner_credentials"/);

  const drop = loadLauncher("dropSudo", (program, args) => {
    if (args.includes("--root-phase")) {
      captured = { program, args };
      throw stopped;
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    process.nextTick(() => child.emit("close", 0));
    return child;
  });
  await assert.rejects(drop.dropSudo({ user: "runner", group: "sudo", rootPhase: false }), (error) => error === stopped);
  assert.deepEqual(JSON.parse(captured.args[captured.args.indexOf("--runner-credentials") + 1]), original);
});

test("captures the live credentials without serializing them", () => {
  const { captureLinuxRunnerCredentials } = loadLauncher("linuxCredentials", () => {
    assert.fail("capturing credentials must not launch a process");
  });
  const captured = captureLinuxRunnerCredentials();
  assert.equal(captured.userId, original.userId);
  assert.equal(captured.primaryGroupId, original.primaryGroupId);
  assert.equal(captured.supplementaryGroupIds, original.supplementaryGroupIds);
});

test("retains live-only primary and supplementary groups", () => {
  const result = includeAccountGroups(original, 1001, [1001, 27, 997]);
  assert.equal(result.primaryGroupId, 999);
  assert.deepEqual(result.supplementaryGroupIds, [27, 998, 1001, 997]);
  assert.throws(() => includeAccountGroups(original, 1002, [1002]), /does not match/);
});

test("rejects malformed or root runner credentials", () => {
  for (const value of [
    null, {}, { ...original, userId: 0 }, { ...original, userId: -1 },
    { ...original, userId: "1001" }, { ...original, primaryGroupId: 0xffffffff },
    { ...original, supplementaryGroupIds: [1.5] },
    { ...original, supplementaryGroupIds: [null] },
    { ...original, supplementaryGroupIds: Array(65537).fill(1) },
  ]) {
    assert.throws(() => parseLinuxRunnerCredentials(JSON.stringify(value)), /Invalid original/);
  }
});

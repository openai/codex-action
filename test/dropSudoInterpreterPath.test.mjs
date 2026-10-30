import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import vm from "node:vm";

const require = createRequire(import.meta.url);

// A Node.js path outside sudo's secure_path, as on a self-hosted runner
// that uses setup-node, nvm, or another version manager.
const RUNNER_NODE = "/opt/hostedtoolcache/node/24.21.0/x64/bin/node";
const ACTION_ENTRY = "/synthetic/dist/main.js";

function loadDropSudo({ execPath, platform = "linux", spawn }) {
  const { outputFiles } = buildSync({
    entryPoints: [fileURLToPath(new URL("../src/dropSudo.ts", import.meta.url))],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
  });

  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    require(name) {
      if (name === "child_process" || name === "node:child_process") {
        return { spawn };
      }
      return require(name);
    },
    process: {
      platform,
      execPath,
      argv: ["node", ACTION_ENTRY],
      execArgv: [],
      env: {},
      getuid: () => 1001,
      getgid: () => 1001,
      getgroups: () => [1001],
    },
    console: { log() {} },
  });

  return module.exports;
}

function succeedingSpawn(onCall) {
  return (program, args) => {
    onCall(program, args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    process.nextTick(() => child.emit("close", 0));
    return child;
  };
}

test("drop-sudo re-enters through process.execPath instead of a bare node", async () => {
  const calls = [];
  const drop = loadDropSudo({
    execPath: RUNNER_NODE,
    spawn: succeedingSpawn((program, args) => calls.push({ program, args })),
  });

  await drop.dropSudo({ user: "runner", group: "sudo", rootPhase: false });

  const rootPhase = calls.find((call) => call.args.includes("drop-sudo"));
  assert.ok(rootPhase, "expected a privileged root-phase invocation");

  // sudo resets PATH, so use the exact Node.js path from the caller.
  const interpreter = rootPhase.args[rootPhase.args.indexOf("-n") + 1];
  assert.equal(
    interpreter,
    RUNNER_NODE,
    "the privileged phase must run the Node.js binary that runs the action"
  );
  assert.notEqual(
    interpreter,
    "node",
    "a bare node may not be available through sudo's secure_path"
  );

  // Keep the rest of the argument list unchanged.
  const interpreterIndex = rootPhase.args.indexOf(interpreter);
  assert.equal(rootPhase.args[interpreterIndex + 1], ACTION_ENTRY);
  assert.equal(rootPhase.args[interpreterIndex + 2], "drop-sudo");
  assert.equal(rootPhase.args[interpreterIndex + 3], "--root-phase");
  assert.equal(rootPhase.args[interpreterIndex + 4], "--user");
  assert.equal(rootPhase.args[interpreterIndex + 5], "runner");
  assert.equal(rootPhase.args[interpreterIndex + 6], "--group");
  assert.equal(rootPhase.args[interpreterIndex + 7], "sudo");
});

test("drop-sudo forwards runner credentials to the privileged phase", async () => {
  const calls = [];
  const drop = loadDropSudo({
    execPath: RUNNER_NODE,
    spawn: succeedingSpawn((program, args) => calls.push({ program, args })),
  });

  await drop.dropSudo({ user: "runner", group: "sudo", rootPhase: false });

  const rootPhase = calls.find((call) => call.args.includes("drop-sudo"));
  const credentialsIndex = rootPhase.args.indexOf("--runner-credentials");
  assert.notEqual(credentialsIndex, -1);

  const credentials = JSON.parse(rootPhase.args[credentialsIndex + 1]);
  assert.deepEqual(credentials, {
    userId: 1001,
    primaryGroupId: 1001,
    supplementaryGroupIds: [1001],
  });
});

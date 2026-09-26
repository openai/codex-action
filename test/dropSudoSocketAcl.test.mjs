import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const sourcePath = fileURLToPath(new URL("../src/dropSudo.ts", import.meta.url));
const { outputFiles } = buildSync({
  stdin: {
    contents: `${readFileSync(sourcePath, "utf8")}\nexport { canWriteRootServiceSocket };`,
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
    loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", write: false,
});

function loadFixture(spawn, filesystem) {
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console: { log() {} },
    process: { platform: "linux", getuid: () => 0, env: {} },
    require(name) {
      if (name === "node:fs") return { constants: {}, promises: filesystem };
      if (name === "node:child_process") return { spawn };
      return require(name);
    },
  });
  return module.exports;
}

for (const scenario of [
  { name: "missing setfacl", expected: /requires \/usr\/bin\/setfacl/, lastCommand: "/usr/bin/setfacl" },
  { name: "missing nobody", expected: /requires an unprivileged nobody account/, lastCommand: "id" },
  { name: "root nobody group", expected: /requires a non-root nobody primary group/, lastCommand: "id" },
]) {
  test(`${scenario.name} fails before account or socket mutations`, async () => {
    const commands = [];
    const drop = loadFixture((command, args) => {
      commands.push(command);
      assert.ok(command === "id" || command === "/usr/bin/setfacl",
        `unexpected privileged command: ${command}`);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      process.nextTick(() => {
        if (command === "/usr/bin/setfacl") {
          child.emit("error", Object.assign(new Error("missing setfacl"), { code: "ENOENT" }));
          return;
        }
        const value = args[1] === "nobody" ? (scenario.name === "root nobody group" ? "0" : "65534") :
          args[0] === "-Gn" ? "runner sudo" : args[0] === "-G" ? "1001 27" : "1001";
        child.stdout.emit("data", `${value}\n`);
        child.emit("close", args[1] === "nobody" && scenario.name === "missing nobody" ? 1 : 0);
      });
      return child;
    }, new Proxy({}, {
      get() { assert.fail("filesystem access preceded the setup checks"); },
    }));
    await assert.rejects(drop.dropSudo({
      user: "runner", group: "sudo", rootPhase: true,
      runnerCredentials: JSON.stringify({ userId: 1001, primaryGroupId: 1001, supplementaryGroupIds: [27] }),
    }), scenario.expected);
    assert.equal(commands.at(-1), scenario.lastCommand);
  });
}

test("socket discovery tolerates disappearance but fails on other open errors", async () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const error = Object.assign(new Error(code), { code });
    const drop = loadFixture(() => assert.fail("must not spawn without a pinned socket"), {
      open: async () => { throw error; },
    });
    const result = drop.canWriteRootServiceSocket("/synthetic/socket", {});
    if (code === "ENOENT") assert.equal(await result, false);
    else await assert.rejects(result, (actual) => actual === error);
  }
});

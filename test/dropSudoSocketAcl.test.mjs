import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const linuxNoFollow = 0o400000;
const sourcePath = fileURLToPath(new URL("../src/dropSudo.ts", import.meta.url));
const { outputFiles } = buildSync({
  stdin: {
    contents: `${readFileSync(sourcePath, "utf8")}\nexport { canWriteRootServiceSocket, restrictRootServiceSocket };`,
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
    loader: "ts",
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});

function loadFixture(spawn, filesystem) {
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    console: { log() {} },
    process: { platform: "linux", getuid: () => 0, env: {} },
    require(name) {
      if (name === "node:fs") {
        return { constants: { O_NOFOLLOW: linuxNoFollow }, promises: filesystem };
      }
      if (name === "node:child_process") return { spawn };
      return require(name);
    },
  });
  return module.exports;
}

for (const scenario of [
  {
    name: "missing setfacl",
    expected: /requires \/usr\/bin\/setfacl/,
    lastCommand: "/usr/bin/setfacl",
  },
  {
    name: "missing nobody",
    expected: /requires an unprivileged nobody account/,
    lastCommand: "id",
  },
  {
    name: "root nobody group",
    expected: /requires a non-root nobody primary group/,
    lastCommand: "id",
  },
]) {
  test(`${scenario.name} fails before account or socket mutations`, async () => {
    const commands = [];
    const drop = loadFixture((command, args) => {
      commands.push(command);
      assert.ok(
        command === "id" || command === "/usr/bin/setfacl",
        `unexpected privileged command: ${command}`
      );
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      process.nextTick(() => {
        if (command === "/usr/bin/setfacl") {
          child.emit("error", Object.assign(new Error("missing setfacl"), {
            code: "ENOENT",
          }));
          return;
        }
        let value = { "-Gn": "runner sudo", "-G": "1001 27" }[args[0]] ?? "1001";
        if (args[1] === "nobody") {
          value = scenario.name === "root nobody group" ? "0" : "65534";
        }
        child.stdout.emit("data", `${value}\n`);
        const missingNobody =
          args[1] === "nobody" && scenario.name === "missing nobody";
        child.emit("close", missingNobody ? 1 : 0);
      });
      return child;
    }, new Proxy({}, {
      get() {
        assert.fail("filesystem access preceded the setup checks");
      },
    }));
    await assert.rejects(drop.dropSudo({
      user: "runner",
      group: "sudo",
      rootPhase: true,
      runnerCredentials: JSON.stringify({
        userId: 1001,
        primaryGroupId: 1001,
        supplementaryGroupIds: [27],
      }),
    }), scenario.expected);
    assert.equal(commands.at(-1), scenario.lastCommand);
  });
}

test("socket discovery tolerates disappearance but fails on other open errors", async () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const error = Object.assign(new Error(code), { code });
    const drop = loadFixture(() => assert.fail("must not spawn without a pinned socket"), {
      open: async () => {
        throw error;
      },
    });
    const result = drop.canWriteRootServiceSocket("/synthetic/socket", {});
    if (code === "ENOENT") assert.equal(await result, false);
    else await assert.rejects(result, (actual) => actual === error);
  }
});

const socket = { path: "/run/synthetic.sock", device: 1, inode: 2 };
const credentials = {
  userId: 1001,
  primaryGroupId: 1001,
  supplementaryGroupIds: [27],
  fallbackGroupId: 65534,
};
const socketStats = { isSocket: () => true, uid: 0, dev: 1, ino: 2, mode: 0o777 };

for (const [name, replacement, expected] of [
  ["different device", { dev: 3 }, /changed while dropping privileges/],
  ["different inode", { ino: 3 }, /changed while dropping privileges/],
  ["symlink replacement", { isSocket: () => false }, /Expected .* to be a socket/],
]) {
  test(`${name} aborts before ACL mutation`, async () => {
    let closed = false;
    const drop = loadFixture(() => assert.fail("must not mutate an unverified socket"), {
      open: async (_path, flags) => {
        assert.ok(flags & linuxNoFollow, "must not follow a replacement symlink");
        return {
          fd: 42,
          stat: async () => ({ ...socketStats, ...replacement }),
          close: async () => {
            closed = true;
          },
        };
      },
    });
    await assert.rejects(drop.restrictRootServiceSocket(socket, credentials), expected);
    assert.equal(closed, true, "must release the pinned descriptor on failure");
  });
}

test("successful ACL command fails closed if either runner identity remains writable", async () => {
  for (const writableGroup of [credentials.primaryGroupId, credentials.fallbackGroupId]) {
    const commands = [];
    let closed = false;
    const drop = loadFixture((command, args, options) => {
      commands.push(command);
      assert.equal(options.stdio[3], 42, "must forward the pinned descriptor");
      assert.equal(args.at(-1), "/proc/self/fd/3");
      let code = 0;
      if (command === "/usr/bin/setpriv") {
        assert.ok(args.includes(`--reuid=${credentials.userId}`));
        code = args.includes(`--regid=${writableGroup}`) ? 0 : 1;
      } else {
        assert.equal(command, "/usr/bin/setfacl");
      }
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", code));
      return child;
    }, {
      open: async () => ({
        fd: 42,
        stat: async () => socketStats,
        close: async () => {
          closed = true;
        },
      }),
    });
    await assert.rejects(
      drop.restrictRootServiceSocket(socket, credentials),
      /Could not restrict access to \/run\/synthetic\.sock/
    );
    assert.equal(commands[0], "/usr/bin/setfacl");
    assert.ok(commands.includes("/usr/bin/setpriv"), "must verify effective access");
    assert.equal(closed, true, "must release the pinned descriptor on failure");
  }
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dockerSocket = "/var/run/docker.sock";
const canTestDockerCleanup =
  process.platform === "linux" &&
  existsSync(dockerSocket) &&
  spawnSync("sudo", ["-n", "true"]).status === 0;

function sudo(args) {
  const result = spawnSync("sudo", ["-n", "--", ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test(
  "drop-sudo blocks Docker access even for inherited group memberships",
  { skip: !canTestDockerCleanup, timeout: 30_000 },
  async (t) => {
    const user = `codexdrop${process.pid}${Date.now().toString(36)}`;
    const originalSocket = statSync(dockerSocket);
    let userCreated = false;
    let probe;

    t.after(async () => {
      if (probe != null && probe.exitCode == null) {
        await new Promise((resolve) => {
          probe.once("close", resolve);
          probe.kill();
        });
      }
      sudo(["chmod", (originalSocket.mode & 0o777).toString(8), dockerSocket]);
      if (userCreated) {
        sudo(["userdel", user]);
      }
    });

    sudo(["useradd", "--no-create-home", "--groups", "sudo,docker", user]);
    userCreated = true;

    probe = spawn(
      "sudo",
      [
        "-n",
        "-u",
        user,
        "--",
        process.execPath,
        "-e",
        `const { accessSync, constants } = require("node:fs");
function report() {
  let accessible = true;
  try {
    accessSync(process.argv[1], constants.R_OK | constants.W_OK);
  } catch {
    accessible = false;
  }
  console.log(JSON.stringify({ groups: process.getgroups(), accessible }));
}
report();
process.stdin.once("data", report);`,
        dockerSocket,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const lines = createInterface({ input: probe.stdout })[
      Symbol.asyncIterator
    ]();
    const before = JSON.parse((await lines.next()).value);
    assert.equal(before.accessible, true);
    assert.equal(before.groups.includes(originalSocket.gid), true);

    sudo([
      process.execPath,
      mainPath,
      "drop-sudo",
      "--root-phase",
      "--user",
      user,
      "--group",
      "sudo",
    ]);

    const accountGroups = sudo(["id", "-nG", user]).split(/\s+/);
    assert.equal(accountGroups.includes("sudo"), false);
    assert.equal(accountGroups.includes("docker"), false);
    assert.equal(statSync(dockerSocket).mode & 0o777, 0o600);

    probe.stdin.end("check\n");
    const after = JSON.parse((await lines.next()).value);
    assert.deepEqual(after.groups, before.groups);
    assert.equal(after.accessible, false);
  }
);

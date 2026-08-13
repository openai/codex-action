import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));
const dockerSocket = "/var/run/docker.sock";
const canTestDockerIsolation =
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

test("defers Linux sudo cleanup until the protected Codex launcher", () => {
  const action = readFileSync(actionPath, "utf8");
  const expected = `\${{ inputs['safety-strategy'] == 'drop-sudo' && inputs['openai-api-key'] != '' && (runner.os != 'Linux' || (inputs.prompt == '' && inputs['prompt-file'] == '')) }}`;

  for (const name of [
    "Drop sudo privilege, if appropriate",
    "Verify sudo privilege removed",
  ]) {
    const marker = `    - name: ${name}\n`;
    const start = action.indexOf(marker);
    assert.notEqual(start, -1, `missing action step: ${name}`);
    const next = action.indexOf("\n    - name: ", start + marker.length);
    const block = action.slice(start, next < 0 ? undefined : next);
    assert.equal(
      block.split("\n").find((line) => line.startsWith("      if: ")),
      `      if: ${expected}`
    );
  }
});

test(
  "drop-sudo blocks Docker for Codex while preserving it for later steps",
  { skip: !canTestDockerIsolation, timeout: 30_000 },
  (t) => {
    const user = `codexdrop${process.pid}${Date.now().toString(36)}`;
    const privilegedGroup = `cdxp${process.pid}${Date.now().toString(36)}`;
    const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-drop-sudo-"));
    const capturePath = path.join(tempDir, "capture.json");
    const outputPath = path.join(tempDir, "output.md");
    const codexPath = path.join(tempDir, "codex");
    const sudoersPath = `/etc/sudoers.d/${user}`;
    const originalSocket = statSync(dockerSocket);
    let userCreated = false;
    let groupCreated = false;

    t.after(() => {
      sudo(["rm", "-f", sudoersPath]);
      if (userCreated) {
        sudo(["userdel", user]);
      }
      if (groupCreated) {
        sudo(["groupdel", privilegedGroup]);
      }
      sudo(["rm", "-rf", tempDir]);
    });

    sudo(["groupadd", privilegedGroup]);
    groupCreated = true;
    sudo([
      "useradd",
      "--no-create-home",
      "--groups",
      `sudo,docker,${privilegedGroup}`,
      user,
    ]);
    userCreated = true;
    const sudoersSource = path.join(tempDir, "sudoers");
    const groupSudoersSource = path.join(tempDir, "group-sudoers");
    writeFileSync(sudoersSource, `${user} ALL=(ALL) NOPASSWD:ALL\n`);
    writeFileSync(
      groupSudoersSource,
      `%${privilegedGroup} ALL=(ALL) NOPASSWD:ALL\n`
    );
    sudo(["install", "--mode=0440", sudoersSource, sudoersPath]);
    writeFileSync(
      codexPath,
      `#!${process.execPath}
const { accessSync, constants, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
let dockerAccessible = true;
try {
  accessSync("/var/run/docker.sock", constants.R_OK | constants.W_OK);
} catch {
  dockerAccessible = false;
}
const status = readFileSync("/proc/self/status", "utf8").split("\\n");
const noNewPrivs = status.find((line) => line.startsWith("NoNewPrivs:"))
  .split(/\\s+/)[1];
const supplementaryGroups = status.find((line) => line.startsWith("Groups:"))
  .slice("Groups:".length)
  .trim();
writeFileSync(process.env.CODEX_CAPTURE_PATH, JSON.stringify({
  uid: process.getuid(),
  gid: process.getgid(),
  groups: process.getgroups(),
  supplementaryGroups,
  dockerAccessible,
  sudoStatus: spawnSync("/usr/bin/sudo", ["-n", "true"]).status,
  noNewPrivs,
  home: process.env.HOME,
  marker: process.env.CODEX_TEST_MARKER,
  prompt: readFileSync(0, "utf8"),
}));
writeFileSync(output, "fake final message\\n");
`
    );
    chmodSync(codexPath, 0o755);
    sudo(["chown", "-R", user, tempDir]);

    const command = [
      "-n",
      "-u",
      user,
      "--",
      "/usr/bin/env",
      `HOME=${tempDir}`,
      `PATH=${tempDir}:${process.env.PATH ?? ""}`,
      `CODEX_CAPTURE_PATH=${capturePath}`,
      "CODEX_TEST_MARKER=preserved",
      process.execPath,
      mainPath,
      "run-codex-exec",
      "--prompt",
      "test prompt\nsecond line",
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
      "--permission-profile",
      "",
      "--model",
      "",
      "--effort",
      "",
      "--safety-strategy",
      "drop-sudo",
      "--codex-user",
      "",
    ];
    const result = spawnSync("sudo", command, {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Confirmed sudo privilege is disabled/);

    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(capture.uid, Number(sudo(["id", "-u", user])));
    assert.equal(capture.gid, Number(sudo(["id", "-g", user])));
    assert.deepEqual(capture.groups, [capture.gid]);
    assert.equal(capture.supplementaryGroups, "");
    assert.equal(capture.dockerAccessible, false);
    assert.notEqual(capture.sudoStatus, 0);
    assert.equal(capture.noNewPrivs, "1");
    assert.equal(capture.home, tempDir);
    assert.equal(capture.marker, "preserved");
    assert.equal(capture.prompt, "test prompt\nsecond line");
    assert.equal(readFileSync(outputPath, "utf8"), "fake final message\n");

    const accountGroups = sudo(["id", "-nG", user]).split(/\s+/);
    assert.equal(accountGroups.includes("sudo"), false);
    assert.equal(accountGroups.includes("docker"), true);
    assert.equal(statSync(dockerSocket).mode, originalSocket.mode);
    sudo(["/usr/bin/sudo", "-n", "-u", user, "--", "test", "-w", dockerSocket]);

    sudo(["install", "--mode=0440", groupSudoersSource, sudoersPath]);
    const failed = spawnSync("sudo", command, {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Expected sudo to be disabled/);
    assert.deepEqual(JSON.parse(readFileSync(capturePath, "utf8")), capture);
  }
);

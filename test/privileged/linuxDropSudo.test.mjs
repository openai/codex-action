import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(
  new URL("../../dist/main.js", import.meta.url)
);
const fakeCodexPath = fileURLToPath(
  new URL("../fixtures/fakeCodexLinuxIdentity.mjs", import.meta.url)
);
const isLinux = process.platform === "linux";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr ?? result.error ?? ""}`
  );
  return result;
}

function runSudo(args, options = {}) {
  return run("/usr/bin/sudo", ["-n", "--", ...args], options);
}

function runAsUser(user, args, options = {}) {
  return run("/usr/bin/sudo", ["-n", "-u", user, "--", ...args], options);
}

function spawnCodexAs({
  uid,
  gid,
  user,
  home,
  binDir,
  workspace,
  outputPath,
  prompt,
  extraEnv = {},
}) {
  return spawnSync(
    "/usr/bin/sudo",
    [
      "-n",
      "--",
      "/usr/bin/setpriv",
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--init-groups",
      "--",
      "/usr/bin/env",
      `HOME=${home}`,
      `USER=${user}`,
      `LOGNAME=${user}`,
      `PATH=${binDir}:${process.env.PATH ?? ""}`,
      ...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`),
      process.execPath,
      mainPath,
      "run-codex-exec",
      "--prompt", prompt,
      "--prompt-file", "",
      "--codex-home", "",
      "--cd", workspace,
      "--extra-args", "",
      "--output-file", outputPath,
      "--output-schema-file", "",
      "--output-schema", "",
      "--sandbox", "",
      "--permission-profile", "",
      "--model", "",
      "--effort", "",
      "--safety-strategy", "drop-sudo",
      "--codex-user", "",
    ],
    { encoding: "utf8", timeout: 120_000 }
  );
}

function registerCleanup(t, { user, groups, sudoersPath, tempDir }) {
  t.after(() => {
    const failures = [];
    const attempt = (args, allowedStatuses = [0]) => {
      const result = spawnSync("/usr/bin/sudo", ["-n", "--", ...args], {
        encoding: "utf8",
      });
      if (!allowedStatuses.includes(result.status)) {
        failures.push(
          `${args.join(" ")}: ${result.stderr ?? result.error ?? result.status}`
        );
      }
    };

    attempt(["/usr/bin/rm", "-f", sudoersPath]);
    attempt(["/usr/sbin/userdel", "-r", user], [0, 6]);
    for (const group of groups) {
      attempt(["/usr/sbin/groupdel", group], [0, 6]);
    }
    attempt(["/usr/bin/rm", "-rf", tempDir]);
    assert.deepEqual(failures, []);
  });
}

test(
  "Linux drop-sudo launches Codex with a reduced process identity",
  { skip: !isLinux },
  (t) => {
    assert.equal(
      spawnSync("/usr/bin/sudo", ["-n", "true"]).status,
      0,
      "the privileged test requires passwordless sudo"
    );
    for (const executable of [
      "/usr/bin/env", "/usr/bin/gpasswd", "/usr/bin/id", "/usr/bin/setpriv",
      "/usr/bin/sudo", "/usr/sbin/groupadd", "/usr/sbin/groupdel",
      "/usr/sbin/useradd", "/usr/sbin/userdel",
    ]) {
      assert.equal(existsSync(executable), true, `missing ${executable}`);
    }

    const suffix = `${process.pid}${Date.now().toString(36).slice(-4)}`;
    const user = `cdxu${suffix}`;
    const primaryGroup = `cdxp${suffix}`;
    const supplementaryGroup = `cdxs${suffix}`;
    const tempDir = mkdtempSync(path.join(tmpdir(), "codex-drop-sudo-"));
    const home = path.join(tempDir, "home");
    const binDir = path.join(tempDir, "bin");
    const workspace = path.join(tempDir, "workspace");
    const capturePath = path.join(tempDir, "capture.json");
    const outputPath = path.join(tempDir, "output.md");
    const groupFile = path.join(tempDir, "supplementary-group-only");
    const sudoersSource = path.join(tempDir, "sudoers");
    const sudoersPath = `/etc/sudoers.d/${user}`;
    mkdirSync(binDir);
    mkdirSync(workspace);

    registerCleanup(t, {
      user,
      groups: [supplementaryGroup, primaryGroup],
      sudoersPath,
      tempDir,
    });

    runSudo(["/usr/sbin/groupadd", primaryGroup]);
    runSudo(["/usr/sbin/groupadd", supplementaryGroup]);
    runSudo([
      "/usr/sbin/useradd",
      "--create-home",
      "--home-dir",
      home,
      "--gid",
      primaryGroup,
      "--groups",
      `sudo,${supplementaryGroup}`,
      "--shell",
      "/bin/bash",
      user,
    ]);

    writeFileSync(sudoersSource, `${user} ALL=(ALL) NOPASSWD:ALL\n`);
    runSudo([
      "/usr/bin/install",
      "--owner=root",
      "--group=root",
      "--mode=0440",
      sudoersSource,
      sudoersPath,
    ]);
    const launcher = path.join(binDir, "codex");
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexPath}" "$@"\n`
    );
    chmodSync(launcher, 0o755);
    writeFileSync(groupFile, "group-only\n");
    runSudo(["/usr/bin/chown", "-R", `${user}:${primaryGroup}`, tempDir]);
    runSudo(["/usr/bin/chown", `root:${supplementaryGroup}`, groupFile]);
    runSudo(["/usr/bin/chmod", "0640", groupFile]);

    assert.equal(
      spawnSync("/usr/bin/sudo", [
        "-n", "-u", user, "/usr/bin/sudo", "-n", "true",
      ]).status,
      0,
      "synthetic runner must start with sudo"
    );
    const groupsBefore = runAsUser(user, ["/usr/bin/id", "-G"]).stdout
      .trim()
      .split(/\s+/);
    const supplementaryGid = String(statSync(groupFile).gid);
    assert.equal(groupsBefore.includes(supplementaryGid), true);
    runAsUser(user, ["/usr/bin/cat", groupFile]);

    const uid = run("/usr/bin/id", ["-u", user]).stdout.trim();
    const gid = run("/usr/bin/id", ["-g", user]).stdout.trim();
    const prompt = "first line\nsecond line\n";
    const result = spawnCodexAs({
      uid,
      gid,
      user,
      home,
      binDir,
      workspace,
      outputPath,
      prompt,
      extraEnv: {
        CODEX_CAPTURE_PATH: capturePath,
        SUPPLEMENTARY_GROUP_FILE: groupFile,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Confirmed sudo privilege is disabled/);

    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.deepEqual(capture, {
      identity: {
        uid: Number(uid),
        gid: Number(gid),
        groups: "",
        idGroups: gid,
        accountGroups: capture.identity.accountGroups,
        capInh: capture.identity.capInh,
        capPrm: capture.identity.capPrm,
        capEff: capture.identity.capEff,
        capBnd: capture.identity.capBnd,
        capAmb: capture.identity.capAmb,
        noNewPrivs: "1",
        sudoStatus: capture.identity.sudoStatus,
        home,
        cwd: workspace,
        supplementaryFileReadable: false,
      },
      prompt,
    });
    for (const field of ["capInh", "capPrm", "capEff", "capBnd", "capAmb"]) {
      assert.match(capture.identity[field], /^0+$/);
    }
    assert.notEqual(capture.identity.sudoStatus, 0);
    assert.equal(
      capture.identity.accountGroups.split(/\s+/).includes("sudo"),
      false
    );
    assert.equal(readFileSync(outputPath, "utf8"), "fake final message\n");
    assert.equal(
      run("/usr/bin/id", ["-nG", user]).stdout.split(/\s+/).includes("sudo"),
      false
    );
  }
);

test(
  "Linux drop-sudo does not release Codex when sudo remains available",
  { skip: !isLinux },
  (t) => {
    const suffix = `${process.pid}${Date.now().toString(36).slice(-4)}f`;
    const user = `cdxu${suffix}`;
    const primaryGroup = `cdxp${suffix}`;
    const sudoGroup = `cdxa${suffix}`;
    const tempDir = mkdtempSync(path.join(tmpdir(), "codex-drop-sudo-fail-"));
    const home = path.join(tempDir, "home");
    const binDir = path.join(tempDir, "bin");
    const workspace = path.join(tempDir, "workspace");
    const outputPath = path.join(tempDir, "output.md");
    const startedPath = path.join(tempDir, "codex-started");
    const sudoersSource = path.join(tempDir, "sudoers");
    const sudoersPath = `/etc/sudoers.d/${user}`;
    mkdirSync(binDir);
    mkdirSync(workspace);
    registerCleanup(t, {
      user,
      groups: [sudoGroup, primaryGroup],
      sudoersPath,
      tempDir,
    });

    runSudo(["/usr/sbin/groupadd", primaryGroup]);
    runSudo(["/usr/sbin/groupadd", sudoGroup]);
    runSudo([
      "/usr/sbin/useradd",
      "--create-home",
      "--home-dir",
      home,
      "--gid",
      primaryGroup,
      "--groups",
      sudoGroup,
      "--shell",
      "/bin/bash",
      user,
    ]);
    writeFileSync(sudoersSource, `%${sudoGroup} ALL=(ALL) NOPASSWD:ALL\n`);
    runSudo([
      "/usr/bin/install",
      "--owner=root",
      "--group=root",
      "--mode=0440",
      sudoersSource,
      sudoersPath,
    ]);
    const launcher = path.join(binDir, "codex");
    writeFileSync(launcher, `#!/bin/sh\n: > "$CODEX_STARTED"\n`);
    chmodSync(launcher, 0o755);
    runSudo(["/usr/bin/chown", "-R", `${user}:${primaryGroup}`, tempDir]);

    const uid = run("/usr/bin/id", ["-u", user]).stdout.trim();
    const gid = run("/usr/bin/id", ["-g", user]).stdout.trim();
    assert.equal(
      runAsUser(user, ["/usr/bin/sudo", "-n", "true"]).status,
      0
    );
    const result = spawnCodexAs({
      uid,
      gid,
      user,
      home,
      binDir,
      workspace,
      outputPath,
      prompt: "must remain gated",
      extraEnv: { CODEX_STARTED: startedPath },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected sudo to be disabled/);
    assert.equal(existsSync(startedPath), false);
  }
);

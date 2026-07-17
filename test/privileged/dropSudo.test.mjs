import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bundledMainPath = fileURLToPath(
  new URL("../../dist/main.js", import.meta.url)
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
  return run("/usr/bin/sudo", ["-n", ...args], options);
}

function listUsers(prefix) {
  const result = run("/usr/bin/getent", ["passwd"]);
  return new Set(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(":", 1)[0])
      .filter((user) => user.startsWith(prefix))
  );
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

test(
  "drop-sudo isolates Codex from the privileged runner identity",
  { skip: !isLinux },
  async (t) => {
    assert.equal(
      spawnSync("/usr/bin/sudo", ["-n", "true"], {
        encoding: "utf8",
      }).status,
      0,
      "the privileged Linux regression test requires passwordless sudo"
    );

    const requiredExecutables = [
      "/usr/bin/find",
      "/usr/bin/gpasswd",
      "/usr/bin/getfacl",
      "/usr/bin/getent",
      "/usr/bin/git",
      "/usr/bin/id",
      "/usr/bin/install",
      "/usr/bin/setfacl",
      "/usr/bin/setpriv",
      "/usr/bin/tee",
      "/usr/sbin/groupadd",
      "/usr/sbin/groupdel",
      "/usr/sbin/nologin",
      "/usr/sbin/useradd",
      "/usr/sbin/userdel",
      "/usr/sbin/visudo",
    ];
    for (const executable of requiredExecutables) {
      assert.equal(
        existsSync(executable),
        true,
        `privileged Linux regression test requires ${executable}`
      );
    }

    const suffix = `${process.pid}${Date.now().toString(36).slice(-4)}`;
    const user = `cdx${suffix}`;
    const primaryGroup = `cdxp${suffix}`;
    const dangerGroup = `cdxd${suffix}`;
    const sudoersPath = `/etc/sudoers.d/${user}`;
    const tempDir = mkdtempSync(path.join(tmpdir(), "codex-drop-sudo-"));
    const canaryDir = mkdtempSync(path.join(tmpdir(), "codex-danger-"));
    const githubWorkspace = path.join(tempDir, "workspace");
    const workspace = path.join(githubWorkspace, "nested-repo");
    const nestedGitRepo = path.join(githubWorkspace, "another", "repo");
    const codexHome = path.join(tempDir, "codex-home");
    const binDir = path.join(tempDir, "bin");
    const maliciousBinDir = path.join(tempDir, "malicious-bin");
    const outsideWorkspace = path.join(tempDir, "outside-workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(nestedGitRepo, { recursive: true });
    mkdirSync(codexHome);
    mkdirSync(binDir);
    mkdirSync(maliciousBinDir);
    mkdirSync(outsideWorkspace);

    let dedicatedPrefix = null;
    let preexistingDedicatedUsers = new Set();
    let socketServerPid = null;
    t.after(() => {
      if (socketServerPid != null) {
        spawnSync("/usr/bin/sudo", ["-n", "kill", String(socketServerPid)]);
      }
      if (dedicatedPrefix != null) {
        const currentDedicatedUsers = listUsers(dedicatedPrefix);
        for (const dedicatedUser of currentDedicatedUsers) {
          if (!preexistingDedicatedUsers.has(dedicatedUser)) {
            const dedicatedUid = spawnSync(
              "/usr/bin/id",
              ["-u", dedicatedUser],
              { encoding: "utf8" }
            ).stdout.trim();
            if (/^\d+$/.test(dedicatedUid)) {
              spawnSync("/usr/bin/sudo", [
                "-n",
                "--",
                "/usr/bin/setfacl",
                "-x",
                `u:${dedicatedUid}`,
                "/tmp",
              ]);
            }
            spawnSync("/usr/bin/sudo", [
              "-n",
              "--",
              "/usr/sbin/userdel",
              "--remove",
              dedicatedUser,
            ]);
            spawnSync("/usr/bin/sudo", [
              "-n",
              "--",
              "/usr/sbin/groupdel",
              dedicatedUser,
            ]);
          }
        }
      }
      spawnSync("/usr/bin/sudo", ["-n", "rm", "-f", sudoersPath]);
      spawnSync("/usr/bin/sudo", [
        "-n",
        "--",
        "/usr/sbin/userdel",
        user,
      ]);
      spawnSync("/usr/bin/sudo", [
        "-n",
        "--",
        "/usr/sbin/groupdel",
        primaryGroup,
      ]);
      spawnSync("/usr/bin/sudo", [
        "-n",
        "--",
        "/usr/sbin/groupdel",
        dangerGroup,
      ]);
      spawnSync("/usr/bin/sudo", ["-n", "rm", "-rf", tempDir, canaryDir]);
    });

    runSudo(["--", "/usr/sbin/groupadd", primaryGroup]);
    runSudo(["--", "/usr/sbin/groupadd", dangerGroup]);
    runSudo([
      "--",
      "/usr/sbin/useradd",
      "--no-create-home",
      "--gid",
      primaryGroup,
      "--groups",
      `sudo,${dangerGroup}`,
      "--shell",
      "/bin/bash",
      user,
    ]);

    const sudoersSource = path.join(tempDir, "sudoers");
    writeFileSync(
      sudoersSource,
      `${user} ALL=(ALL:ALL) NOPASSWD: ALL\n%${dangerGroup} ALL=(ALL:ALL) NOPASSWD: ALL\n`,
      "utf8"
    );
    runSudo([
      "--",
      "/usr/bin/install",
      "-o",
      "root",
      "-g",
      "root",
      "-m",
      "0440",
      sudoersSource,
      sudoersPath,
    ]);
    runSudo(["--", "/usr/sbin/visudo", "-cf", sudoersPath]);

    const runnerUid = Number(run("/usr/bin/id", ["-u", user]).stdout.trim());
    const runnerGid = Number(run("/usr/bin/id", ["-g", user]).stdout.trim());
    const dangerGroupId = Number(
      run("/usr/bin/getent", ["group", dangerGroup])
        .stdout.trim()
        .split(":")[2]
    );
    dedicatedPrefix = `${`codexaction${runnerUid}`.slice(0, 23)}x`;
    preexistingDedicatedUsers = listUsers(dedicatedPrefix);

    const canaryPath = path.join(canaryDir, "danger-canary");
    writeFileSync(canaryPath, "root-equivalent group access\n", "utf8");
    runSudo(["chown", "-R", `root:${dangerGroup}`, canaryDir]);
    runSudo(["chmod", "0770", canaryDir]);
    runSudo(["chmod", "0640", canaryPath]);

    const fakeCodexPath = path.join(binDir, "codex.mjs");
    const launcherPath = path.join(binDir, "codex");
    const capturePath = path.join(workspace, "capture.json");
    const outputPath = path.join(workspace, "output.md");
    const schemaPath = path.join(workspace, "schema.json");
    const testPrompt = "verify clean identity\nwith exact multiline stdin\n";
    const linkedWorkingDirectory = path.join(workspace, "linked-workdir");
    const linkedCodexHome = path.join(workspace, "linked-codex-home");
    const linkedSchemaPath = path.join(workspace, "linked-schema.json");
    const protectedSchemaPath = path.join(
      tempDir,
      "protected-schema-target.json"
    );
    const groupOnlySchemaDirectory = path.join(
      tempDir,
      "group-only-schema-directory"
    );
    const groupOnlySchemaPath = path.join(
      groupOnlySchemaDirectory,
      "schema.json"
    );
    const failedWorkingDirectoryOutput = path.join(
      workspace,
      "failed-workdir-output.md"
    );
    const failedSchemaOutput = path.join(workspace, "failed-schema-output.md");
    const failedGroupOnlySchemaOutput = path.join(
      workspace,
      "failed-group-only-schema-output.md"
    );
    const failedPrivilegeCleanupOutput = path.join(
      workspace,
      "failed-privilege-cleanup-output.md"
    );
    const failedCodexExecutableOutput = path.join(
      workspace,
      "failed-codex-executable-output.md"
    );
    const failedCodexHomeOutput = path.join(
      workspace,
      "failed-codex-home-output.md"
    );
    const failedRootRunnerOutput = path.join(
      workspace,
      "failed-root-runner-output.md"
    );
    const protectedOutputTarget = path.join(
      tempDir,
      "protected-output-target"
    );
    const outputSymlink = path.join(workspace, "output-symlink.md");
    const linkedOutputParent = path.join(workspace, "linked-output-parent");
    const linkedParentOutput = path.join(
      linkedOutputParent,
      "created-through-link.md"
    );
    const foreignOutput = path.join(workspace, "foreign-output.md");
    const outputDirectory = path.join(workspace, "output-directory");
    const hardlinkedOutput = path.join(workspace, "hardlinked-output.md");
    const hardlinkedOutputPeer = path.join(
      tempDir,
      "hardlinked-output-peer.md"
    );
    const workspaceWritePath = path.join(workspace, "created-by-codex.txt");
    const githubOutputPath = path.join(tempDir, "github-output");
    const parentSignalMarker = path.join(tempDir, "parent-signal-marker");
    const runnerSecretPath = path.join(tempDir, "runner-secret");
    const runnerSecretHardlink = path.join(
      workspace,
      "runner-secret-hardlink"
    );
    const foreignWorkspaceFile = path.join(
      workspace,
      "foreign-workspace-file"
    );
    const protectedCodexExecutable = path.join(
      tempDir,
      "protected-codex-executable"
    );
    const maliciousCodexPath = path.join(maliciousBinDir, "codex");
    const socketServerPath = path.join(tempDir, "socket-server.cjs");
    const socketReadyPath = path.join(tempDir, "socket-ready");
    const dangerSocketReadyPath = path.join(tempDir, "danger-socket-ready");
    const lateSocketReadyPath = path.join(tempDir, "late-socket-ready");
    const runnerSocketPath = path.join(workspace, "runner.sock");
    const dangerSocketPath = path.join(canaryDir, "danger.sock");
    const lateRunnerSocketPath = path.join(workspace, "late-runner.sock");
    const copiedMainPath = path.join(tempDir, "main.cjs");
    const harnessPath = path.join(tempDir, "harness.cjs");

    copyFileSync(bundledMainPath, copiedMainPath);
    writeFileSync(
      harnessPath,
      `const { writeFileSync } = require("node:fs");
process.env.CODEX_ACTION_PARENT_PID = String(process.pid);
process.on("SIGUSR1", () => {
  writeFileSync(process.env.CODEX_PARENT_SIGNAL_MARKER, "signaled\\n");
});
require(${JSON.stringify(copiedMainPath)});
`,
      "utf8"
    );
    writeFileSync(
      socketServerPath,
      `const { chmodSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createServer } = require("node:net");
const [socketPath, readyPath, dangerSocketPath, dangerReadyPath, lateSocketPath, lateReadyPath, watchedDirectory, runnerUid] =
  process.argv.slice(2);
const server = createServer((socket) => socket.end());
const dangerServer = createServer((socket) => socket.end());
const lateServer = createServer((socket) => socket.end());
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  writeFileSync(readyPath, String(process.pid));
});
dangerServer.listen(dangerSocketPath, () => {
  chmodSync(dangerSocketPath, 0o660);
  writeFileSync(dangerReadyPath, "ready");
});
const timer = setInterval(() => {
  const acl = execFileSync("/usr/bin/getfacl", ["-n", "-p", watchedDirectory], {
    encoding: "utf8",
  });
  if (acl.includes("default:user:" + runnerUid + ":rwx")) {
    clearInterval(timer);
    lateServer.listen(lateSocketPath, () => {
      // Keep the ACL mask open so an accidentally inherited Codex-user ACL
      // would make this connection succeed and fail the regression test.
      chmodSync(lateSocketPath, 0o660);
      writeFileSync(lateReadyPath, "ready");
    });
  }
}, 10);
process.on("SIGTERM", () => {
  clearInterval(timer);
  server.close();
  dangerServer.close();
  if (lateServer.listening) {
    lateServer.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
});
`,
      "utf8"
    );
    writeFileSync(
      fakeCodexPath,
      `import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const startupRunnerGroups = spawnSync(
  "/usr/bin/id",
  ["-nG", process.env.CODEX_RUNNER_USER],
  { encoding: "utf8" }
);
let receivedPrompt = "";
for await (const chunk of process.stdin) {
  receivedPrompt += chunk;
}

const statusFor = (pid) => readFileSync("/proc/" + pid + "/status", "utf8");
const statusValue = (status, name) =>
  status.match(new RegExp("^" + name + ":\\\\s*(.+)$", "m"))?.[1] ?? null;
const selfStatus = statusFor("self");
const parentPid = Number(process.env.CODEX_ACTION_PARENT_PID);
const parentStatus = statusFor(parentPid);
let canReadParentEnvironment = true;
try {
  readFileSync("/proc/" + parentPid + "/environ");
} catch {
  canReadParentEnvironment = false;
}
let cursor = process.pid;
let parentIsAncestor = false;
for (let depth = 0; depth < 16 && cursor > 1; depth += 1) {
  if (cursor === parentPid) {
    parentIsAncestor = true;
    break;
  }
  const ppid = Number(statusValue(statusFor(cursor), "PPid"));
  if (!Number.isSafeInteger(ppid) || ppid === cursor) break;
  cursor = ppid;
}

const signalError = (signal) => {
  try {
    process.kill(parentPid, signal);
    return null;
  } catch (error) {
    return error.code ?? error.name;
  }
};
let canReadCanary = true;
try {
  readFileSync(process.env.CODEX_DANGER_CANARY);
} catch {
  canReadCanary = false;
}
let canReadForeignWorkspaceFile = true;
try {
  readFileSync(process.env.CODEX_FOREIGN_WORKSPACE_FILE);
} catch {
  canReadForeignWorkspaceFile = false;
}
let canReadRunnerSecretHardlink = true;
try {
  readFileSync(process.env.CODEX_RUNNER_SECRET_HARDLINK);
} catch {
  canReadRunnerSecretHardlink = false;
}

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const schemaIndex = args.indexOf("--output-schema");
const cdIndex = args.indexOf("--cd");
const sudo = spawnSync("/usr/bin/sudo", ["-n", "true"], { encoding: "utf8" });
const idGroups = spawnSync("/usr/bin/id", ["-G"], { encoding: "utf8" });
const git = spawnSync("/usr/bin/git", ["-C", args[cdIndex + 1], "status", "--porcelain"], {
  encoding: "utf8",
});
const nestedGit = spawnSync(
  "/usr/bin/git",
  ["-C", process.env.CODEX_NESTED_GIT_REPO, "status", "--porcelain"],
  { encoding: "utf8" }
);
const scrubbedNames = [
  "SUDO_COMMAND",
  "SUDO_USER",
  "SUDO_UID",
  "SUDO_GID",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "ENV",
  "BASH_ENV",
  "SHELLOPTS",
];
const scrubbedEnvironment = Object.fromEntries(
  scrubbedNames.map((name) => [name, process.env[name] ?? null])
);
const socketError = (socketPath) => new Promise((resolve) => {
  const socket = createConnection(socketPath);
  socket.once("connect", () => {
    socket.destroy();
    resolve(null);
  });
  socket.once("error", (error) => resolve(error.code ?? error.name));
});
for (let attempt = 0; attempt < 100 && !existsSync(process.env.CODEX_LATE_SOCKET_READY); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const existingSocketError = await socketError(process.env.CODEX_RUNNER_SOCKET);
const dangerSocketError = await socketError(process.env.CODEX_DANGER_SOCKET);
const lateSocketError = existsSync(process.env.CODEX_LATE_SOCKET_READY)
  ? await socketError(process.env.CODEX_LATE_RUNNER_SOCKET)
  : "READY_TIMEOUT";
try {
  writeFileSync(process.env.CODEX_WORKSPACE_WRITE, "workspace write works\\n");
} catch (error) {
  const acl = spawnSync("/usr/bin/getfacl", ["-p", args[cdIndex + 1]], {
    encoding: "utf8",
  });
  console.error("workspace ACL:\\n" + acl.stdout + acl.stderr);
  throw error;
}
writeFileSync(process.env.CODEX_HOME + "/child-state", "Codex home write works\\n");
writeFileSync(
  process.env.CODEX_CAPTURE_PATH,
  JSON.stringify({
    uid: process.getuid(),
    gid: process.getgid(),
    groups: process.getgroups(),
    uidStatus: statusValue(selfStatus, "Uid"),
    gidStatus: statusValue(selfStatus, "Gid"),
    noNewPrivs: statusValue(selfStatus, "NoNewPrivs"),
    capEff: statusValue(selfStatus, "CapEff"),
    capPrm: statusValue(selfStatus, "CapPrm"),
    capBnd: statusValue(selfStatus, "CapBnd"),
    capAmb: statusValue(selfStatus, "CapAmb"),
    parentUid: statusValue(parentStatus, "Uid"),
    parentGroups: statusValue(parentStatus, "Groups"),
    parentIsAncestor,
    canReadParentEnvironment,
    signalZeroError: signalError(0),
    signalUsr1Error: signalError("SIGUSR1"),
    receivedPrompt,
    canReadCanary,
    canReadForeignWorkspaceFile,
    canReadRunnerSecretHardlink,
    sudoStatus: sudo.status,
    idGroupsStatus: idGroups.status,
    idGroups: idGroups.stdout.trim(),
    gitStatus: git.status,
    gitStderr: git.stderr,
    nestedGitStatus: nestedGit.status,
    nestedGitStderr: nestedGit.stderr,
    startupRunnerGroupsStatus: startupRunnerGroups.status,
    startupRunnerGroups: startupRunnerGroups.stdout.trim(),
    existingSocketError,
    dangerSocketError,
    lateSocketError,
    schema: JSON.parse(readFileSync(args[schemaIndex + 1], "utf8")),
    user: process.env.USER,
    logname: process.env.LOGNAME,
    home: process.env.HOME,
    path: process.env.PATH,
    githubOutput: process.env.GITHUB_OUTPUT ?? null,
    scrubbedEnvironment,
  })
);
writeFileSync(args[outputIndex + 1], "clean identity verified\\n");
unlinkSync(args[outputIndex + 1]);
symlinkSync(process.env.CODEX_RUNNER_SECRET, args[outputIndex + 1]);
`,
      "utf8"
    );
    writeFileSync(
      launcherPath,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexPath}" "$@"\n`,
      "utf8"
    );
    chmodSync(launcherPath, 0o755);
    writeFileSync(schemaPath, '{"type":"object"}\n', "utf8");
    writeFileSync(protectedSchemaPath, '{"protected":true}\n', "utf8");
    symlinkSync(outsideWorkspace, linkedWorkingDirectory);
    symlinkSync(outsideWorkspace, linkedCodexHome);
    symlinkSync(protectedSchemaPath, linkedSchemaPath);
    writeFileSync(githubOutputPath, "", "utf8");
    writeFileSync(runnerSecretPath, "runner secret must not be exposed\n", "utf8");
    linkSync(runnerSecretPath, runnerSecretHardlink);
    writeFileSync(
      foreignWorkspaceFile,
      "foreign group-derived file access must not be exposed\n",
      "utf8"
    );
    writeFileSync(protectedOutputTarget, "protected output target\n", "utf8");
    symlinkSync(protectedOutputTarget, outputSymlink);
    symlinkSync(outsideWorkspace, linkedOutputParent);
    writeFileSync(foreignOutput, "foreign output\n", "utf8");
    mkdirSync(outputDirectory);
    mkdirSync(groupOnlySchemaDirectory);
    writeFileSync(groupOnlySchemaPath, '{"groupOnly":true}\n', "utf8");
    writeFileSync(hardlinkedOutput, "hardlinked output\n", "utf8");
    linkSync(hardlinkedOutput, hardlinkedOutputPeer);
    writeFileSync(
      protectedCodexExecutable,
      "#!/bin/sh\necho private executable must not be transferred\n",
      "utf8"
    );
    symlinkSync(protectedCodexExecutable, maliciousCodexPath);

    runSudo(["chown", "-R", `${user}:${primaryGroup}`, tempDir]);
    runSudo([
      "chmod",
      "0755",
      tempDir,
      binDir,
      maliciousBinDir,
      githubWorkspace,
      workspace,
      nestedGitRepo,
      codexHome,
    ]);
    runSudo([
      "chmod",
      "0644",
      copiedMainPath,
      harnessPath,
      socketServerPath,
      fakeCodexPath,
    ]);
    runSudo(["chmod", "0600", runnerSecretPath]);
    runSudo(["chmod", "0600", hardlinkedOutput]);
    runSudo(["chmod", "0600", protectedSchemaPath]);
    runSudo(["chmod", "0600", protectedOutputTarget]);
    runSudo(["chmod", "0700", protectedCodexExecutable]);
    runSudo(["chown", `root:${dangerGroup}`, foreignWorkspaceFile]);
    runSudo(["chmod", "0640", foreignWorkspaceFile]);
    runSudo(["chown", "-R", `root:${dangerGroup}`, groupOnlySchemaDirectory]);
    runSudo(["chmod", "0750", groupOnlySchemaDirectory]);
    runSudo(["chmod", "0644", groupOnlySchemaPath]);
    runSudo(["chown", "root:root", foreignOutput]);
    runSudo(["chmod", "0666", foreignOutput]);
    runSudo([
      "-u",
      user,
      "--",
      "/usr/bin/git",
      "-C",
      workspace,
      "init",
      "-q",
    ]);
    runSudo([
      "-u",
      user,
      "--",
      "/usr/bin/git",
      "-C",
      nestedGitRepo,
      "init",
      "-q",
    ]);

    const initialGroups = runSudo(["-u", user, "--", "/usr/bin/id", "-G"])
      .stdout.trim()
      .split(/\s+/)
      .map(Number);
    assert.equal(initialGroups.includes(dangerGroupId), true);
    runSudo(["-u", user, "--", "/usr/bin/cat", canaryPath]);
    assert.equal(
      spawnSync(
        "/usr/bin/sudo",
        ["-n", "-u", user, "--", "/usr/bin/sudo", "-n", "true"],
        { encoding: "utf8" }
      ).status,
      0,
      "synthetic runner must begin with working sudo"
    );

    const runAction = ({
      workingDirectory = workspace,
      outputFile = outputPath,
      outputSchemaFile = schemaPath,
      pathDirectory = binDir,
      codexHomeDirectory = codexHome,
      runAsRoot = false,
    } = {}) => {
      const sudoUserArgs = runAsRoot ? [] : ["-u", user];
      return spawnSync(
        "/usr/bin/sudo",
        [
          "-n",
          ...sudoUserArgs,
          "--",
          "/usr/bin/env",
          `HOME=${tempDir}`,
          `PATH=${pathDirectory}:${process.env.PATH ?? ""}`,
          `CODEX_CAPTURE_PATH=${capturePath}`,
          `CODEX_DANGER_CANARY=${canaryPath}`,
          `CODEX_FOREIGN_WORKSPACE_FILE=${foreignWorkspaceFile}`,
          `CODEX_RUNNER_SECRET_HARDLINK=${runnerSecretHardlink}`,
          `CODEX_WORKSPACE_WRITE=${workspaceWritePath}`,
          `CODEX_PARENT_SIGNAL_MARKER=${parentSignalMarker}`,
          `CODEX_RUNNER_USER=${user}`,
          `CODEX_RUNNER_SECRET=${runnerSecretPath}`,
          `CODEX_RUNNER_SOCKET=${runnerSocketPath}`,
          `CODEX_DANGER_SOCKET=${dangerSocketPath}`,
          `CODEX_LATE_RUNNER_SOCKET=${lateRunnerSocketPath}`,
          `CODEX_LATE_SOCKET_READY=${lateSocketReadyPath}`,
          `CODEX_NESTED_GIT_REPO=${nestedGitRepo}`,
          "SUDO_COMMAND=must-be-scrubbed",
          "SUDO_USER=must-be-scrubbed",
          "SUDO_UID=1234",
          "SUDO_GID=1234",
          "GITHUB_ENV=must-be-scrubbed",
          "GITHUB_PATH=must-be-scrubbed",
          `GITHUB_OUTPUT=${githubOutputPath}`,
          "GITHUB_STEP_SUMMARY=must-be-scrubbed",
          "ENV=must-be-scrubbed",
          "BASH_ENV=must-be-scrubbed",
          "SHELLOPTS=must-be-scrubbed",
          `GITHUB_WORKSPACE=${githubWorkspace}`,
          process.execPath,
          harnessPath,
          "run-codex-exec",
          "--prompt",
          testPrompt,
          "--prompt-file",
          "",
          "--codex-home",
          codexHomeDirectory,
          "--cd",
          workingDirectory,
          "--extra-args",
          "",
          "--output-file",
          outputFile,
          "--output-schema-file",
          outputSchemaFile,
          "--output-schema",
          "",
          "--sandbox",
          "danger-full-access",
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
        ],
        { encoding: "utf8", timeout: 120_000 }
      );
    };

    const assertActionRejected = (result, pattern) => {
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
        pattern
      );
      assert.equal(existsSync(capturePath), false);
    };

    assertActionRejected(
      runAction({
        outputFile: failedRootRunnerOutput,
        runAsRoot: true,
      }),
      /cannot run Codex from a runner whose default user is root/
    );

    const linkedCodexHomeAclBefore = run("/usr/bin/getfacl", [
      "-n",
      "-p",
      outsideWorkspace,
    ]).stdout;
    assertActionRejected(
      runAction({
        codexHomeDirectory: linkedCodexHome,
        outputFile: failedCodexHomeOutput,
      }),
      /refuses a Codex home path containing symbolic links/
    );
    assert.equal(
      run("/usr/bin/getfacl", ["-n", "-p", outsideWorkspace]).stdout,
      linkedCodexHomeAclBefore,
      "a rejected Codex home symlink must not change the target ACL"
    );

    const protectedOutputAclBefore = run("/usr/bin/getfacl", [
      "-n",
      "-p",
      protectedOutputTarget,
    ]).stdout;
    const rejectedOutputs = [
      {
        file: outputSymlink,
        pattern: /refuses an output path containing symbolic links/,
      },
      {
        file: linkedParentOutput,
        pattern: /refuses an output path containing symbolic links/,
      },
      {
        file: foreignOutput,
        pattern: /requires the output file to be owned by runner UID/,
      },
      {
        file: outputDirectory,
        pattern: /requires a regular output file/,
      },
      {
        file: hardlinkedOutput,
        pattern: /refuses an output file with multiple hard links/,
      },
    ];
    for (const { file, pattern } of rejectedOutputs) {
      assertActionRejected(runAction({ outputFile: file }), pattern);
    }
    assert.equal(existsSync(linkedParentOutput), false);
    assert.equal(
      run("/usr/bin/getfacl", ["-n", "-p", protectedOutputTarget]).stdout,
      protectedOutputAclBefore,
      "a rejected output symlink must not change the target ACL"
    );

    const groupOnlySchemaAclBefore = run("/usr/bin/getfacl", [
      "-n",
      "-p",
      groupOnlySchemaDirectory,
      groupOnlySchemaPath,
    ]).stdout;
    assertActionRejected(
      runAction({
        outputFile: failedGroupOnlySchemaOutput,
        outputSchemaFile: groupOnlySchemaPath,
      }),
      /refuses to transfer group-derived directory access/
    );
    assert.equal(
      run("/usr/bin/getfacl", [
        "-n",
        "-p",
        groupOnlySchemaDirectory,
        groupOnlySchemaPath,
      ]).stdout,
      groupOnlySchemaAclBefore,
      "a rejected group-derived schema path must not change foreign ACLs"
    );

    const protectedCodexAclBefore = run("/usr/bin/getfacl", [
      "-n",
      "-p",
      protectedCodexExecutable,
    ]).stdout;
    const protectedCodexResult = runAction({
      outputFile: failedCodexExecutableOutput,
      pathDirectory: maliciousBinDir,
    });
    assert.notEqual(protectedCodexResult.status, 0);
    assert.match(
      `${protectedCodexResult.stdout ?? ""}\n${protectedCodexResult.stderr ?? ""}`,
      /requires the Codex executable to resolve to a regular file that is already world-readable and executable/
    );
    assert.equal(existsSync(capturePath), false);
    assert.equal(
      run("/usr/bin/getfacl", ["-n", "-p", protectedCodexExecutable]).stdout,
      protectedCodexAclBefore,
      "a rejected Codex executable must not change the target ACL"
    );

    const privilegeCleanupResult = runAction({
      outputFile: failedPrivilegeCleanupOutput,
    });
    assert.notEqual(privilegeCleanupResult.status, 0);
    assert.match(
      `${privilegeCleanupResult.stdout ?? ""}\n${privilegeCleanupResult.stderr ?? ""}`,
      /Expected sudo to be disabled, but sudo succeeded/
    );
    assert.equal(
      existsSync(capturePath),
      false,
      "Codex must not start when runner sudo remains available"
    );

    runSudo(["--", "/usr/bin/gpasswd", "-a", user, "sudo"]);
    runSudo(["--", "/usr/bin/tee", sudoersSource], {
      input: `${user} ALL=(ALL:ALL) NOPASSWD: ALL\n`,
    });
    runSudo([
      "--",
      "/usr/bin/install",
      "-o",
      "root",
      "-g",
      "root",
      "-m",
      "0440",
      sudoersSource,
      sudoersPath,
    ]);
    runSudo(["--", "/usr/sbin/visudo", "-cf", sudoersPath]);
    assert.equal(
      spawnSync(
        "/usr/bin/sudo",
        ["-n", "-u", user, "--", "/usr/bin/sudo", "-n", "true"],
        { encoding: "utf8" }
      ).status,
      0,
      "the synthetic runner must be restored for subsequent cases"
    );

    const linkedWorkingDirectoryResult = runAction({
      workingDirectory: linkedWorkingDirectory,
      outputFile: failedWorkingDirectoryOutput,
    });
    assert.notEqual(linkedWorkingDirectoryResult.status, 0);
    assert.match(
      `${linkedWorkingDirectoryResult.stdout ?? ""}\n${linkedWorkingDirectoryResult.stderr ?? ""}`,
      /refuses a directory path containing symbolic links/
    );
    assert.equal(existsSync(capturePath), false);

    const protectedSchemaAclBefore = run("/usr/bin/getfacl", [
      "-n",
      "-p",
      protectedSchemaPath,
    ]).stdout;
    const linkedSchemaResult = runAction({
      outputFile: failedSchemaOutput,
      outputSchemaFile: linkedSchemaPath,
    });
    assert.notEqual(linkedSchemaResult.status, 0);
    assert.match(
      `${linkedSchemaResult.stdout ?? ""}\n${linkedSchemaResult.stderr ?? ""}`,
      /refuses a file path containing symbolic links/
    );
    assert.equal(existsSync(capturePath), false);
    assert.equal(
      run("/usr/bin/getfacl", ["-n", "-p", protectedSchemaPath]).stdout,
      protectedSchemaAclBefore,
      "a rejected schema symlink must not change the target ACL"
    );
    assert.equal(
      spawnSync(
        "/usr/bin/sudo",
        ["-n", "-u", user, "--", "/usr/bin/sudo", "-n", "true"],
        { encoding: "utf8" }
      ).status,
      0,
      "failed setup must not revoke synthetic runner sudo"
    );

    // The failed post-gate case prepared an earlier dedicated identity. Clear
    // its directory defaults so the late socket is created only after the
    // successful invocation installs the identity under test.
    runSudo([
      "--",
      "/usr/bin/find",
      "-P",
      githubWorkspace,
      "-type",
      "d",
      "-exec",
      "/usr/bin/setfacl",
      "-k",
      "--",
      "{}",
      "+",
    ]);

    const socketServer = spawn(
      "/usr/bin/sudo",
      [
        "-n",
        "-u",
        user,
        "--",
        process.execPath,
        socketServerPath,
        runnerSocketPath,
        socketReadyPath,
        dangerSocketPath,
        dangerSocketReadyPath,
        lateRunnerSocketPath,
        lateSocketReadyPath,
        workspace,
        String(runnerUid),
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let socketServerStderr = "";
    socketServer.stderr.setEncoding("utf8");
    socketServer.stderr.on("data", (chunk) => {
      socketServerStderr += chunk;
    });
    try {
      await waitForFile(socketReadyPath);
      await waitForFile(dangerSocketReadyPath);
    } catch (error) {
      throw new Error(`${error.message}: ${socketServerStderr}`);
    }
    runSudo(["chown", `root:${dangerGroup}`, dangerSocketPath]);
    runSudo(["chmod", "0660", dangerSocketPath]);
    socketServerPid = Number(readFileSync(socketReadyPath, "utf8"));
    assert.equal(
      Number.isSafeInteger(socketServerPid) && socketServerPid > 1,
      true
    );

    const result = runAction();

    assert.equal(
      result.status,
      0,
      `${result.stdout ?? ""}\n${result.stderr ?? result.error ?? ""}`
    );
    assert.equal(
      spawnSync("/usr/bin/sudo", ["-n", "true"], {
        encoding: "utf8",
      }).status,
      0,
      "the real test runner must retain sudo"
    );
    assert.equal(
      spawnSync("/usr/bin/getent", ["passwd", user], {
        encoding: "utf8",
      }).status,
      0,
      "the synthetic runner account must still exist"
    );
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.notEqual(capture.uid, runnerUid);
    assert.notEqual(capture.gid, runnerGid);
    assert.equal(capture.uid === 0, false);
    assert.deepEqual(
      capture.uidStatus.split(/\s+/).map(Number),
      [capture.uid, capture.uid, capture.uid, capture.uid]
    );
    assert.deepEqual(
      capture.gidStatus.split(/\s+/).map(Number),
      [capture.gid, capture.gid, capture.gid, capture.gid]
    );
    assert.deepEqual(capture.groups, [capture.gid]);
    assert.equal(capture.idGroupsStatus, 0);
    assert.deepEqual(capture.idGroups.split(/\s+/).map(Number), [capture.gid]);
    assert.equal(capture.noNewPrivs, "1");
    assert.equal(capture.capEff, "0000000000000000");
    assert.equal(capture.capPrm, "0000000000000000");
    assert.equal(capture.capBnd, "0000000000000000");
    assert.equal(capture.capAmb, "0000000000000000");
    assert.equal(capture.parentIsAncestor, true);
    assert.equal(capture.canReadParentEnvironment, false);
    assert.equal(Number(capture.parentUid.split(/\s+/)[0]), runnerUid);
    assert.equal(
      capture.parentGroups.split(/\s+/).map(Number).includes(dangerGroupId),
      true
    );
    assert.equal(capture.signalZeroError, "EPERM");
    assert.equal(capture.signalUsr1Error, "EPERM");
    assert.equal(existsSync(parentSignalMarker), false);
    assert.equal(capture.receivedPrompt, testPrompt);
    assert.equal(capture.canReadCanary, false);
    assert.equal(capture.canReadForeignWorkspaceFile, false);
    assert.equal(capture.canReadRunnerSecretHardlink, false);
    assert.notEqual(capture.sudoStatus, 0);
    assert.equal(capture.gitStatus, 0, capture.gitStderr);
    assert.equal(capture.nestedGitStatus, 0, capture.nestedGitStderr);
    assert.equal(capture.startupRunnerGroupsStatus, 0);
    assert.equal(
      capture.startupRunnerGroups.split(/\s+/).includes("sudo"),
      false,
      "Codex startup must not run before runner sudo is revoked"
    );
    assert.equal(
      ["EACCES", "EPERM"].includes(capture.existingSocketError),
      true
    );
    assert.equal(["EACCES", "EPERM"].includes(capture.dangerSocketError), true);
    assert.equal(["EACCES", "EPERM"].includes(capture.lateSocketError), true);
    assert.deepEqual(capture.schema, { type: "object" });
    assert.match(capture.user, /^codexaction\d+x[0-9a-f]{8}$/);
    assert.equal(capture.logname, capture.user);
    assert.equal(capture.home, `/home/${capture.user}`);
    assert.equal(capture.path.startsWith(binDir + ":"), true);
    assert.equal(capture.githubOutput, null);
    assert.deepEqual(capture.scrubbedEnvironment, {
      SUDO_COMMAND: null,
      SUDO_USER: null,
      SUDO_UID: null,
      SUDO_GID: null,
      GITHUB_ENV: null,
      GITHUB_PATH: null,
      GITHUB_OUTPUT: null,
      GITHUB_STEP_SUMMARY: null,
      ENV: null,
      BASH_ENV: null,
      SHELLOPTS: null,
    });
    assert.equal(
      readFileSync(workspaceWritePath, "utf8"),
      "workspace write works\n"
    );
    assert.equal(
      readFileSync(path.join(codexHome, "child-state"), "utf8"),
      "Codex home write works\n"
    );
    const githubOutput = readFileSync(githubOutputPath, "utf8");
    assert.match(githubOutput, /clean identity verified/);
    assert.doesNotMatch(githubOutput, /runner secret must not be exposed/);
    assert.equal(lstatSync(outputPath).isSymbolicLink(), true);
    assert.notEqual(
      spawnSync(
        "/usr/bin/sudo",
        ["-n", "-u", user, "--", "/usr/bin/sudo", "-n", "true"],
        { encoding: "utf8" }
      ).status,
      0,
      "synthetic runner sudo authorization must be revoked globally"
    );
  }
);

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
const dockerSocket = "/var/run/docker.sock";
const canTestLinuxIsolation =
  process.platform === "linux" &&
  process.getuid?.() !== 0 &&
  existsSync(dockerSocket) &&
  spawnSync("sudo", ["-n", "true"]).status === 0;
const canTestSocketAcls =
  canTestLinuxIsolation &&
  spawnSync("/usr/bin/setfacl", ["--version"], { stdio: "ignore" }).status === 0;

function sudo(args) {
  const result = spawnSync("sudo", ["-n", "--", ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function snapshotRootSockets() {
  const output = sudo([
    "find",
    "/run",
    "-type",
    "s",
    "-uid",
    "0",
    "-printf",
    "%p\t%U\t%G\t%m\n",
  ]);
  return output.length === 0
    ? []
    : output.split("\n").map((line) => {
        const [socketPath, uid, gid, mode] = line.split("\t");
        return { socketPath, uid, gid, mode };
      });
}

function restoreRootSockets(sockets) {
  for (const { socketPath, uid, gid, mode } of sockets) {
    const exists = spawnSync("sudo", ["-n", "--", "test", "-S", socketPath]);
    if (exists.status === 0) {
      sudo(["chown", `${uid}:${gid}`, socketPath]);
      sudo(["chmod", mode, socketPath]);
    }
  }
}

function createRootSocket(socketPath, group, mode) {
  sudo([
    process.execPath,
    "-e",
    'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))',
    socketPath,
  ]);
  sudo(["chown", `0:${group}`, socketPath]);
  sudo(["chmod", mode, socketPath]);
}

test(
  "drop-sudo closes inherited Linux credential and service-socket bypasses",
  { skip: !canTestLinuxIsolation, timeout: 300_000 },
  async (t) => {
    if (!canTestSocketAcls) {
      t.diagnostic("setfacl unavailable; named socket ACL coverage skipped");
    }

    for (const [index, scenario] of [
      {
        name: "workspace sandbox preserves compatible workflow arguments",
        extraArgs: [
          "--enable",
          "use_legacy_landlock",
          "--search",
          "--ephemeral",
          "--model",
          "gpt-5.4",
          "-c",
          'model_reasoning_effort="high"',
          "--config",
          'service_tier="fast"',
        ],
        verifyForwardedArgs: true,
      },
      { name: "stale live groups cannot retain socket access", staleGroups: true },
      {
        name: "permission profiles cannot gain privileges",
        profile: ":workspace",
      },
      {
        name: "built-in read-only profiles cannot gain privileges",
        profile: ":read-only",
      },
      {
        name: "named permission profiles cannot gain privileges",
        profile: "public-review",
      },
      {
        name: "unconfined execution cannot gain privileges",
        sandbox: "danger-full-access",
      },
      {
        name: "the unconfined permission profile cannot gain privileges",
        profile: ":danger-full-access",
      },
      {
        name: "the explicit sandbox bypass cannot gain privileges",
        extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      },
      {
        name: "the sandbox bypass alias cannot gain privileges",
        extraArgs: ["--yolo"],
      },
      {
        name: "hook trust bypasses fail before irreversible cleanup",
        extraArgs: ["--dangerously-bypass-hook-trust"],
        rejectedBeforeCleanup: true,
      },
      {
        name: "read-only full-auto conflicts fail before irreversible cleanup",
        sandbox: "read-only",
        extraArgs: ["--full-auto"],
        rejectedBeforeCleanup: true,
      },
      {
        name: "MCP command overrides fail before irreversible cleanup",
        extraArgs: ["--config", 'mcp_servers.evil.command="/bin/sh"'],
        rejectedBeforeCleanup: true,
      },
      {
        name: "the replacement primary group cannot inherit sudo policy",
        replacementGroupSudoGrant: true,
      },
      {
        name: "a command-specific User_Alias cannot gain privileges",
        userAliasSudoGrant: true,
      },
      { name: "remaining sudo grants fail closed", remainingSudoGrant: true },
    ].entries()) {
      await t.test(scenario.name, { timeout: 45_000 }, (subtest) => {
        const suffix = `${process.pid}${Date.now().toString(36)}${index}`;
        const user = `codexdrop${suffix}`;
        const privilegedGroup = `cdxp${suffix}`;
        const worldGroup = `cdxw${suffix}`;
        const remainingGroup = `cdxr${suffix}`;
        const tempDir = mkdtempSync(
          path.join(tmpdir(), "codex-action-drop-sudo-")
        );
        const capturePath = path.join(tempDir, "capture.json");
        const outputPath = path.join(tempDir, "output.md");
        const codexPath = path.join(tempDir, "codex");
        const bundledActionPath = path.join(tempDir, "main.js");
        const sudoersPath = `/etc/sudoers.d/${user}`;
        const serviceSocket = `/run/codex-action-${suffix}-service.sock`;
        const worldSocket = `/run/codex-action-${suffix}-world.sock`;
        const fallbackSocket = `/run/codex-action-${suffix}-fallback.sock`;
        const namedUserAclSocket = `/run/codex-action-${suffix}-acl-user.sock`;
        const fallbackAclSocket = `/run/codex-action-${suffix}-acl-fallback.sock`;
        const staleAclSocket = `/run/codex-action-${suffix}-acl-stale.sock`;
        const liveGroupsPath = path.join(tempDir, "live-groups.txt");
        const originalDockerSocket = statSync(dockerSocket);
        const safeGroup = Number(sudo(["id", "-g", "nobody"]));
        const safeGroupName = sudo(["id", "-gn", "nobody"]);
        const sudoAlias = `CODEX_DROP_${suffix}`.toUpperCase();
        const groupsCreated = [];
        let userCreated = false;
        let originalSockets = [];

        subtest.after(() => {
          sudo(["rm", "-f", sudoersPath]);
          restoreRootSockets(originalSockets);
          sudo([
            "rm",
            "-f",
            serviceSocket,
            worldSocket,
            fallbackSocket,
            namedUserAclSocket,
            fallbackAclSocket,
            staleAclSocket,
          ]);
          if (userCreated) {
            sudo(["userdel", user]);
          }
          for (const group of groupsCreated) {
            sudo(["groupdel", group]);
          }
          sudo(["rm", "-rf", tempDir]);
        });

        for (const group of [
          privilegedGroup,
          worldGroup,
          ...(scenario.remainingSudoGrant ? [remainingGroup] : []),
        ]) {
          sudo(["groupadd", group]);
          groupsCreated.push(group);
        }
        const supplementaryGroups = [
          "sudo",
          privilegedGroup,
          ...(scenario.remainingSudoGrant ? [remainingGroup] : []),
        ];
        sudo([
          "useradd",
          "--no-create-home",
          "--gid",
          String(originalDockerSocket.gid),
          "--groups",
          supplementaryGroups.join(","),
          user,
        ]);
        userCreated = true;
        const userId = Number(sudo(["id", "-u", user]));

        const sudoersSource = path.join(tempDir, "sudoers");
        const sudoRules = [`${user} ALL=(ALL) NOPASSWD:ALL`];
        if (scenario.remainingSudoGrant) {
          sudoRules.push(`%${remainingGroup} ALL=(ALL) NOPASSWD:ALL`);
        }
        if (scenario.replacementGroupSudoGrant) {
          sudoRules.push(
            `%${safeGroupName} ALL=(root) NOPASSWD: /usr/bin/true`
          );
        }
        if (scenario.userAliasSudoGrant) {
          sudoRules.push(
            `User_Alias ${sudoAlias} = ${user}`,
            `${sudoAlias} ALL=(root) NOPASSWD: /usr/bin/id -u`
          );
        }
        writeFileSync(
          sudoersSource,
          `${sudoRules.join("\n")}\n`
        );
        sudo(["install", "--mode=0440", sudoersSource, sudoersPath]);

        createRootSocket(serviceSocket, privilegedGroup, "0660");
        createRootSocket(worldSocket, worldGroup, "0666");
        createRootSocket(fallbackSocket, String(safeGroup), "0660");
        if (canTestSocketAcls) {
          createRootSocket(namedUserAclSocket, worldGroup, "0660");
          createRootSocket(fallbackAclSocket, worldGroup, "0660");
          sudo([
            "/usr/bin/setfacl",
            "-m",
            `u:${user}:rw`,
            namedUserAclSocket,
          ]);
          sudo([
            "/usr/bin/setfacl",
            "-m",
            `g:${safeGroup}:rw`,
            fallbackAclSocket,
          ]);
          if (scenario.staleGroups) {
            createRootSocket(staleAclSocket, worldGroup, "0660");
            sudo(["/usr/bin/setfacl", "-m", `g:${privilegedGroup}:rw`, staleAclSocket]);
          }
        }
        originalSockets = snapshotRootSockets();
        for (const socket of [
          dockerSocket,
          serviceSocket,
          worldSocket,
          ...(canTestSocketAcls ? [namedUserAclSocket] : []),
          ...(canTestSocketAcls && scenario.staleGroups ? [staleAclSocket] : []),
        ]) {
          sudo(["/usr/bin/sudo", "-n", "-u", user, "--", "test", "-w", socket]);
        }
        assert.notEqual(
          spawnSync("sudo", [
            "-n",
            "-u",
            user,
            "--",
            "test",
            "-w",
            fallbackSocket,
          ]).status,
          0
        );
        if (canTestSocketAcls) {
          assert.notEqual(
            spawnSync("sudo", [
              "-n",
              "-u",
              user,
              "--",
              "test",
              "-w",
              fallbackAclSocket,
            ]).status,
            0
          );
          sudo([
            "/usr/bin/setpriv",
            `--reuid=${userId}`,
            `--regid=${safeGroup}`,
            "--clear-groups",
            "--",
            "/usr/bin/test",
            "-w",
            fallbackAclSocket,
          ]);
        }

        copyFileSync(mainPath, bundledActionPath);
        writeFileSync(
          codexPath,
          `#!${process.execPath}
const { accessSync, constants, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
function canWrite(socket) {
  try {
    accessSync(socket, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
const status = Object.fromEntries(
  readFileSync("/proc/self/status", "utf8")
    .split("\\n")
    .map((line) => line.split(/:\\s*/, 2))
);
const child = spawnSync(process.execPath, ["-p", "process.env.NODE_OPTIONS"], {
  encoding: "utf8",
});
const sudoTrue = spawnSync("/usr/bin/sudo", ["-n", "/usr/bin/true"], {
  encoding: "utf8",
});
const sudoId = spawnSync("/usr/bin/sudo", ["-n", "/usr/bin/id", "-u"], {
  encoding: "utf8",
});
writeFileSync(process.env.CODEX_CAPTURE_PATH, JSON.stringify({
  args,
  uid: process.getuid(),
  gid: process.getgid(),
  groups: process.getgroups(),
  supplementaryGroups: status.Groups.trim(),
  dockerAccessible: canWrite("/var/run/docker.sock"),
  serviceAccessible: canWrite(process.env.CODEX_SERVICE_SOCKET),
  worldAccessible: canWrite(process.env.CODEX_WORLD_SOCKET),
  fallbackAccessible: canWrite(process.env.CODEX_FALLBACK_SOCKET),
  namedUserAclAccessible: process.env.CODEX_NAMED_USER_ACL_SOCKET
    ? canWrite(process.env.CODEX_NAMED_USER_ACL_SOCKET)
    : null,
  fallbackAclAccessible: process.env.CODEX_FALLBACK_ACL_SOCKET
    ? canWrite(process.env.CODEX_FALLBACK_ACL_SOCKET)
    : null,
  sudoStatus: sudoTrue.status,
  sudoIdStatus: sudoId.status,
  sudoIdStdout: sudoId.stdout.trim(),
  noNewPrivs: status.NoNewPrivs,
  capBounding: status.CapBnd,
  capEffective: status.CapEff,
  capInheritable: status.CapInh,
  capPermitted: status.CapPrm,
  capAmbient: status.CapAmb,
  nodeOptions: process.env.NODE_OPTIONS,
  childNodeOptions: child.stdout.trim(),
  home: process.env.HOME,
  marker: process.env.CODEX_TEST_MARKER,
  prompt: readFileSync(0, "utf8"),
}));
writeFileSync(output, "fake final message\\n");
`
        );
        chmodSync(codexPath, 0o755);
        chmodSync(tempDir, 0o711);
        sudo(["chown", "-R", user, tempDir]);

        const command = [
          "-n",
          "-u",
          user,
          "--",
          "/usr/bin/env",
          `HOME=${tempDir}`,
          `PATH=${tempDir}:${process.env.PATH ?? ""}`,
          "NODE_OPTIONS=--disable-sigusr1",
          `CODEX_CAPTURE_PATH=${capturePath}`,
          `CODEX_SERVICE_SOCKET=${serviceSocket}`,
          `CODEX_WORLD_SOCKET=${worldSocket}`,
          `CODEX_FALLBACK_SOCKET=${fallbackSocket}`,
          ...(canTestSocketAcls
            ? [
                `CODEX_NAMED_USER_ACL_SOCKET=${namedUserAclSocket}`,
                `CODEX_FALLBACK_ACL_SOCKET=${fallbackAclSocket}`,
              ]
            : []),
          "CODEX_TEST_MARKER=preserved",
          process.execPath,
          bundledActionPath,
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
          scenario.extraArgs ? JSON.stringify(scenario.extraArgs) : "",
          "--output-file",
          outputPath,
          "--output-schema-file",
          "",
          "--output-schema",
          "",
          "--sandbox",
          scenario.sandbox ?? "",
          "--permission-profile",
          scenario.profile ?? "",
          "--model",
          "",
          "--effort",
          "",
          "--safety-strategy",
          "drop-sudo",
          "--codex-user",
          "",
          "--project-instructions-mode",
          "workspace",
        ];
        const launchCommand = scenario.staleGroups
          ? [
              ...command.slice(0, 4),
              "/bin/sh", "-ec",
              '/usr/bin/sudo -n /usr/bin/gpasswd -d "$1" "$2"; /usr/bin/id -G > "$3"; shift 3; exec "$@"',
              "codex-stale-groups", user, privilegedGroup, liveGroupsPath,
              ...command.slice(4),
            ]
          : command;
        const result = spawnSync("sudo", launchCommand, {
          encoding: "utf8",
          timeout: 35_000,
        });

        if (scenario.rejectedBeforeCleanup) {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /codex-args/);
          assert.equal(existsSync(capturePath), false);

          const stillPrivileged = spawnSync(
            "/usr/bin/sudo",
            ["-n", "-u", user, "--", "/usr/bin/sudo", "-n", "/usr/bin/true"],
            { encoding: "utf8" }
          );
          assert.equal(stillPrivileged.status, 0, stillPrivileged.stderr);

          const accountGroups = sudo(["id", "-nG", user]).split(/\s+/);
          assert.equal(accountGroups.includes("sudo"), true);
          assert.equal(accountGroups.includes(privilegedGroup), true);
          for (const { socketPath, mode } of originalSockets) {
            assert.equal(
              Number.parseInt(sudo(["stat", "-c", "%a", socketPath]), 8),
              Number.parseInt(mode, 8),
              `${socketPath} changed before argument rejection`
            );
          }
          return;
        }

        if (scenario.remainingSudoGrant) {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /Expected sudo to be disabled/);
          assert.equal(existsSync(capturePath), false);
          return;
        }

        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(
          result.stdout,
          /Confirmed the standard sudo probe is disabled/
        );
        assert.match(
          result.stdout,
          /Launching Codex with no_new_privs and empty capability sets/
        );
        const capture = JSON.parse(readFileSync(capturePath, "utf8"));
        assert.equal(capture.uid, userId);
        assert.equal(capture.gid, safeGroup);
        assert.notEqual(capture.gid, originalDockerSocket.gid);
        assert.deepEqual(capture.groups, [safeGroup]);
        assert.equal(capture.supplementaryGroups, "");
        assert.equal(capture.dockerAccessible, false);
        assert.equal(capture.serviceAccessible, false);
        assert.equal(capture.worldAccessible, false);
        assert.equal(capture.fallbackAccessible, false);
        assert.equal(
          capture.namedUserAclAccessible,
          canTestSocketAcls ? false : null
        );
        assert.equal(
          capture.fallbackAclAccessible,
          canTestSocketAcls ? false : null
        );
        assert.ok(Number.isInteger(capture.sudoStatus));
        assert.notEqual(capture.sudoStatus, 0);
        assert.ok(Number.isInteger(capture.sudoIdStatus));
        assert.notEqual(capture.sudoIdStatus, 0);
        assert.notEqual(capture.sudoIdStdout, "0");
        assert.equal(capture.noNewPrivs, "1");
        assert.equal(capture.capBounding, "0000000000000000");
        assert.equal(capture.capEffective, "0000000000000000");
        assert.equal(capture.capInheritable, "0000000000000000");
        assert.equal(capture.capPermitted, "0000000000000000");
        assert.equal(capture.capAmbient, "0000000000000000");
        assert.equal(capture.nodeOptions, "--disable-sigusr1");
        assert.equal(capture.childNodeOptions, "--disable-sigusr1");
        assert.equal(capture.home, tempDir);
        assert.equal(capture.marker, "preserved");
        assert.equal(capture.prompt, "test prompt\nsecond line");
        if (scenario.verifyForwardedArgs) {
          const forwardedStart = capture.args.indexOf(scenario.extraArgs[0]);
          assert.notEqual(forwardedStart, -1);
          assert.deepEqual(
            capture.args.slice(
              forwardedStart,
              forwardedStart + scenario.extraArgs.length
            ),
            scenario.extraArgs
          );
        }
        assert.equal(readFileSync(outputPath, "utf8"), "fake final message\n");

        if (
          scenario.replacementGroupSudoGrant ||
          scenario.userAliasSudoGrant
        ) {
          const grantedCommand = scenario.replacementGroupSudoGrant
            ? ["/usr/bin/true"]
            : ["/usr/bin/id", "-u"];
          const unprotected = spawnSync(
            "/usr/bin/sudo",
            [
              "-n",
              "--",
              "/usr/bin/setpriv",
              `--reuid=${userId}`,
              `--regid=${safeGroup}`,
              "--clear-groups",
              "--",
              "/usr/bin/sudo",
              "-n",
              ...grantedCommand,
            ],
            { encoding: "utf8" }
          );
          assert.equal(
            unprotected.status,
            0,
            `expected the residual sudo rule to remain effective without no_new_privs: ${unprotected.stderr}`
          );
          if (scenario.userAliasSudoGrant) {
            assert.equal(unprotected.stdout.trim(), "0");
          }
        }

        const accountGroups = sudo(["id", "-nG", user]).split(/\s+/);
        assert.equal(accountGroups.includes("sudo"), false);
        assert.equal(accountGroups.includes(privilegedGroup), false);
        if (scenario.staleGroups) {
          const staleGid = sudo(["getent", "group", privilegedGroup]).split(":")[2];
          assert.ok(readFileSync(liveGroupsPath, "utf8").trim().split(/\s+/).includes(staleGid));
        }
        for (const socket of [
          dockerSocket,
          serviceSocket,
          worldSocket,
          fallbackSocket,
          ...(canTestSocketAcls
            ? [namedUserAclSocket, fallbackAclSocket]
            : []),
          ...(canTestSocketAcls && scenario.staleGroups ? [staleAclSocket] : []),
        ]) {
          assert.equal(statSync(socket).mode & 0o077, 0);
          const access = spawnSync("sudo", [
            "-n",
            "-u",
            user,
            "--",
            "test",
            "-w",
            socket,
          ]);
          assert.notEqual(access.status, 0);
        }

        const failed = spawnSync("sudo", command, {
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /requires passwordless sudo.*separate job/);
        assert.deepEqual(JSON.parse(readFileSync(capturePath, "utf8")), capture);
      });
    }
  }
);

import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";
import {
  captureLinuxRunnerCredentials,
  includeAccountGroups,
  LinuxRunnerCredentials,
  parseLinuxRunnerCredentials,
} from "./linuxCredentials";

interface ExecOptions {
  capture?: boolean;
  ignoreFailure?: boolean;
  inheritedFileDescriptor?: number;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DropSudoOptions {
  user: string;
  group: string;
  rootPhase: boolean;
  runnerCredentials?: string;
}

const LINUX_PLATFORM = "linux";
const MACOS_PLATFORM = "darwin";
const LINUX_RUNTIME_DIRECTORY = "/run";
const LINUX_O_PATH = 0o10000000;

interface LinuxGroup {
  id: number;
  name: string;
  primary: boolean;
}

interface RootServiceSocket {
  path: string;
  groupId: number;
  device: number;
  inode: number;
}

interface LinuxSocketCredentials extends LinuxRunnerCredentials {
  fallbackGroupId?: number;
}

export async function dropSudo(options: DropSudoOptions): Promise<void> {
  const platform = process.platform;
  if (![LINUX_PLATFORM, MACOS_PLATFORM].includes(platform)) {
    throw new Error(
      `Unsupported OS for drop-sudo safety strategy: ${platform}`
    );
  }

  const { rootPhase } = options;
  if (rootPhase) {
    await dropSudoWithPrivileges(options);
    return;
  }

  const runnerCredentials =
    platform === LINUX_PLATFORM
      ? JSON.stringify(captureLinuxRunnerCredentials())
      : undefined;

  await ensurePasswordlessSudo();
  // `sudo -K` invalidates cached credentials but exits non-zero when no ticket
  // exists yet. Ignore that failure so fresh runners don't blow up.
  await execCommand("sudo", ["-K"], { ignoreFailure: true });

  const execArgs = [...process.execArgv];
  const scriptPath = process.argv[1];
  // Re-enter this command under sudo so the privilege-dropping work happens in a
  // single place regardless of the host platform.
  await execCommand("sudo", [
    "-n",
    "node",
    ...execArgs,
    scriptPath,
    "drop-sudo",
    "--root-phase",
    "--user",
    options.user,
    "--group",
    options.group,
    ...(runnerCredentials === undefined
      ? []
      : ["--runner-credentials", runnerCredentials]),
  ]);

  // Invalidate the sudo ticket again; ignore failures for the same reason as
  // above (some environments return an error when no timestamp exists).
  await execCommand("sudo", ["-K"], { ignoreFailure: true });

  if (platform === LINUX_PLATFORM) {
    await verifyPrivilegedSocketsRestricted();
  }
}

async function dropSudoWithPrivileges(options: DropSudoOptions): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("drop-sudo root phase must run as root.");
  }

  process.env.PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

  let changed = false;
  let originalLinuxGroupIds: Set<number> | undefined;
  let linuxSocketCredentials: LinuxSocketCredentials | undefined;

  switch (process.platform) {
    case LINUX_PLATFORM: {
      if (options.runnerCredentials === undefined) {
        throw new Error(
          "Linux drop-sudo requires the original runner credentials."
        );
      }
      const originalCredentials = parseLinuxRunnerCredentials(
        options.runnerCredentials
      );
      const userGroups = await getLinuxGroups(options.user);
      const userId = await execCommand("id", ["-u", options.user], {
        capture: true,
      });
      linuxSocketCredentials = includeAccountGroups(
        originalCredentials,
        parseNumericId(userId.stdout.trim()),
        userGroups.map(({ id }) => id)
      );
      originalLinuxGroupIds = new Set([
        linuxSocketCredentials.primaryGroupId,
        ...linuxSocketCredentials.supplementaryGroupIds,
      ]);
      const fallbackGroup = await execCommand("id", ["-g", "nobody"], {
        capture: true,
        ignoreFailure: true,
      });
      if (fallbackGroup.code === 0) {
        const fallbackGroupId = parseNumericId(fallbackGroup.stdout.trim());
        if (fallbackGroupId !== 0) {
          originalLinuxGroupIds.add(fallbackGroupId);
          linuxSocketCredentials.fallbackGroupId = fallbackGroupId;
        }
      }
      const groupsById = new Map(userGroups.map((group) => [group.id, group]));
      const serviceSockets = await findRootServiceSockets(
        LINUX_RUNTIME_DIRECTORY,
        originalLinuxGroupIds,
        linuxSocketCredentials
      );
      const groups = new Set([options.group]);
      for (const socket of serviceSockets) {
        const group = groupsById.get(socket.groupId);
        if (group && !group.primary) {
          groups.add(group.name);
        }
      }
      for (const group of groups) {
        if (await removeUserFromLinuxGroup(options.user, group)) {
          changed = true;
        }
      }
      for (const socket of serviceSockets) {
        if (await restrictRootServiceSocket(socket)) {
          changed = true;
        }
      }
      break;
    }
    case MACOS_PLATFORM: {
      if (await isUserInGroup(options.user, options.group)) {
        await execCommand("dseditgroup", [
          "-o",
          "edit",
          "-d",
          options.user,
          "-t",
          "user",
          options.group,
        ]);
        console.log(
          `Used 'dseditgroup -o edit -d ${options.user} -t user ${options.group}' to drop sudo privilege.`
        );
        changed = true;
      } else {
        console.log(
          `${options.user} is not a member of the ${options.group} group.`
        );
      }
      break;
    }
    default: {
      throw new Error(
        `Unsupported OS for drop-sudo safety strategy: ${process.platform}`
      );
    }
  }

  const messages = await removeUserFromSudoersD(options.user);
  if (messages.length > 0) {
    for (const message of messages) {
      console.log(message);
    }
    changed = true;
  } else {
    console.log(
      `No ${options.user} entries found in /etc/sudoers.d requiring changes.`
    );
  }

  const sudoersMessage = await stripUserEntriesFromFile(
    "/etc/sudoers",
    options.user
  );
  if (sudoersMessage) {
    console.log(sudoersMessage);
    changed = true;
  } else {
    console.log(
      `No ${options.user} entries found in /etc/sudoers requiring changes.`
    );
  }

  if (!changed) {
    console.log(`${options.user} already lacks sudo privileges.`);
  }

  const groupsAfter = await execCommand("id", ["-Gn", options.user], {
    capture: true,
  });
  console.log(
    `Groups for ${options.user} after cleanup: ${groupsAfter.stdout.trim()}`
  );

  if (originalLinuxGroupIds) {
    await verifyPrivilegedSocketsRestricted(
      originalLinuxGroupIds,
      linuxSocketCredentials
    );
  }
}

async function removeUserFromLinuxGroup(
  user: string,
  group: string
): Promise<boolean> {
  if (!(await isUserInGroup(user, group))) {
    console.log(`${user} is not a member of the ${group} group.`);
    return false;
  }

  if (await commandExists("deluser")) {
    await execCommand("deluser", [user, group]);
    console.log(`Used 'deluser ${user} ${group}' to drop group access.`);
  } else if (await commandExists("gpasswd")) {
    await execCommand("gpasswd", ["-d", user, group]);
    console.log(`Used 'gpasswd -d ${user} ${group}' to drop group access.`);
  } else {
    throw new Error("Neither deluser nor gpasswd available.");
  }

  return true;
}

async function getLinuxGroups(user: string): Promise<Array<LinuxGroup>> {
  const [idsResult, namesResult, primaryResult] = await Promise.all([
    execCommand("id", ["-G", user], { capture: true }),
    execCommand("id", ["-Gn", user], { capture: true }),
    execCommand("id", ["-g", user], { capture: true }),
  ]);
  const ids = splitFields(idsResult.stdout).map(parseNumericId);
  const names = splitFields(namesResult.stdout);
  const primaryId = parseNumericId(primaryResult.stdout.trim());

  if (ids.length !== names.length) {
    throw new Error(`Could not resolve group names for ${user}.`);
  }

  return ids.map((id, index) => ({
    id,
    name: names[index],
    primary: id === primaryId,
  }));
}

function splitFields(value: string): Array<string> {
  return value
    .trim()
    .split(/\s+/)
    .filter((field) => field.length > 0);
}

function parseNumericId(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid numeric ID: ${value}`);
  }
  return Number.parseInt(value, 10);
}

async function findRootServiceSockets(
  directory: string,
  groupIds: Set<number>,
  credentials?: LinuxSocketCredentials,
  ignoreUnreadable = false,
  displayDirectory = directory
): Promise<Array<RootServiceSocket>> {
  let directoryHandle;
  try {
    directoryHandle = await fs.open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" ||
      (ignoreUnreadable && (code === "EACCES" || code === "EPERM"))
    ) {
      return [];
    }
    throw error;
  }

  try {
    const directoryDescriptorPath = `/proc/self/fd/${directoryHandle.fd}`;
    const entries = await fs.readdir(directoryDescriptorPath, {
      withFileTypes: true,
    });
    const sockets: Array<RootServiceSocket> = [];

    for (const entry of entries) {
      const entryPath = path.join(directoryDescriptorPath, entry.name);
      const displayPath = path.join(displayDirectory, entry.name);
      if (entry.isDirectory()) {
        sockets.push(
          ...(await findRootServiceSockets(
            entryPath,
            groupIds,
            credentials,
            ignoreUnreadable,
            displayPath
          ))
        );
        continue;
      }
      if (!entry.isSocket()) {
        continue;
      }

      let stats;
      try {
        stats = await fs.lstat(entryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      const groupWritable =
        (stats.mode & 0o020) !== 0 && groupIds.has(stats.gid);
      const worldWritable = (stats.mode & 0o002) !== 0;
      const aclWritable =
        !groupWritable &&
        !worldWritable &&
        (stats.mode & 0o020) !== 0 &&
        stats.isSocket() &&
        stats.uid === 0 &&
        (await hasWritableSocketAcl(entryPath, stats, credentials));
      if (
        stats.isSocket() &&
        stats.uid === 0 &&
        (groupWritable || worldWritable || aclWritable)
      ) {
        sockets.push({
          path: displayPath,
          groupId: stats.gid,
          device: stats.dev,
          inode: stats.ino,
        });
      }
    }

    return sockets;
  } finally {
    await directoryHandle.close();
  }
}

async function hasWritableSocketAcl(
  socketPath: string,
  expectedStats: Awaited<ReturnType<typeof fs.lstat>>,
  credentials?: LinuxSocketCredentials
): Promise<boolean> {
  if (!credentials) {
    try {
      await fs.access(socketPath, fsConstants.W_OK);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  const socketHandle = await fs.open(
    socketPath,
    LINUX_O_PATH | fsConstants.O_NOFOLLOW
  );
  try {
    const stats = await socketHandle.stat();
    if (
      !stats.isSocket() ||
      stats.uid !== 0 ||
      stats.dev !== expectedStats.dev ||
      stats.ino !== expectedStats.ino
    ) {
      throw new Error(`A privileged service socket changed during discovery.`);
    }

    const identityGroups = [
      {
        primaryGroupId: credentials.primaryGroupId,
        supplementaryGroupIds: credentials.supplementaryGroupIds,
      },
      ...(credentials.fallbackGroupId === undefined
        ? []
        : [
            {
              primaryGroupId: credentials.fallbackGroupId,
              supplementaryGroupIds: [],
            },
          ]),
    ];

    for (const identity of identityGroups) {
      const groupArgument =
        identity.supplementaryGroupIds.length === 0
          ? "--clear-groups"
          : `--groups=${identity.supplementaryGroupIds.join(",")}`;
      const result = await execCommand(
        "/usr/bin/setpriv",
        [
          `--reuid=${credentials.userId}`,
          `--regid=${identity.primaryGroupId}`,
          groupArgument,
          "--",
          "/usr/bin/test",
          "-w",
          "/proc/self/fd/3",
        ],
        {
          capture: true,
          ignoreFailure: true,
          inheritedFileDescriptor: socketHandle.fd,
        }
      );
      if (result.code === 0) {
        return true;
      }
      if (result.code !== 1 || result.stderr.trim().length > 0) {
        throw new Error(`Could not verify access to a privileged service socket.`);
      }
    }

    return false;
  } finally {
    await socketHandle.close();
  }
}

async function restrictRootServiceSocket(
  socket: RootServiceSocket
): Promise<boolean> {
  let socketHandle;
  try {
    socketHandle = await fs.open(
      socket.path,
      LINUX_O_PATH | fsConstants.O_NOFOLLOW
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  try {
    const stats = await socketHandle.stat();
    if (!stats.isSocket()) {
      throw new Error(`Expected ${socket.path} to be a socket.`);
    }
    if (stats.uid !== 0) {
      throw new Error(`Expected ${socket.path} to be owned by root.`);
    }
    if (stats.dev !== socket.device || stats.ino !== socket.inode) {
      throw new Error(`${socket.path} changed while dropping privileges.`);
    }
    if ((stats.mode & 0o077) === 0) {
      console.log(`Access to ${socket.path} is already restricted.`);
      return false;
    }

    await fs.chmod(`/proc/self/fd/${socketHandle.fd}`, stats.mode & 0o700);
    const restrictedStats = await socketHandle.stat();
    if ((restrictedStats.mode & 0o077) !== 0) {
      throw new Error(`Could not restrict access to ${socket.path}.`);
    }
    console.log(`Restricted access to ${socket.path}.`);
    return true;
  } finally {
    await socketHandle.close();
  }
}

async function verifyPrivilegedSocketsRestricted(
  originalGroupIds?: Set<number>,
  credentials?: LinuxSocketCredentials
): Promise<void> {
  const groupIds =
    originalGroupIds ??
    new Set(typeof process.getgroups === "function" ? process.getgroups() : []);
  if (!originalGroupIds && typeof process.getgid === "function") {
    groupIds.add(process.getgid());
  }

  const sockets = await findRootServiceSockets(
    LINUX_RUNTIME_DIRECTORY,
    groupIds,
    credentials,
    !originalGroupIds
  );
  for (const socket of sockets) {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      throw new Error(`drop-sudo did not revoke access to ${socket.path}.`);
    }

    try {
      await fs.access(socket.path, fsConstants.W_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
        continue;
      }
      throw error;
    }
    throw new Error(`drop-sudo did not revoke access to ${socket.path}.`);
  }
}

async function ensurePasswordlessSudo(): Promise<void> {
  try {
    await execCommand("sudo", ["-n", "true"], { capture: true });
  } catch (error) {
    throw new Error("Unexpected: passwordless sudo not available.");
  }
}

async function isUserInGroup(user: string, group: string): Promise<boolean> {
  const result = await execCommand("id", ["-nG", user], {
    capture: true,
    ignoreFailure: true,
  });
  if (result.code !== 0) {
    return false;
  }
  const groups = result.stdout
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0);
  return groups.includes(group);
}

async function commandExists(binary: string): Promise<boolean> {
  const result = await execCommand("sh", ["-c", `command -v ${binary}`], {
    capture: true,
    ignoreFailure: true,
  });
  return result.code === 0;
}

/**
 * Strips non-comment entries granting sudo to `user` across `/etc/sudoers.d`
 * files.
 *
 * Strategy:
 *   - enumerate regular files under `/etc/sudoers.d`
 *   - remove lines whose first token matches the target user while keeping
 *     comments/blank lines intact
 *   - rewrite files in-place with original newline style and permissions
 *   - report which files were changed so callers can surface useful logs
 */
async function removeUserFromSudoersD(user: string): Promise<Array<string>> {
  const sudoersDir = "/etc/sudoers.d";
  let entries: Array<string> = [];
  try {
    const dirEntries = await fs.readdir(sudoersDir, { withFileTypes: true });
    entries = dirEntries
      .filter((dirent) => dirent.isFile())
      .map((dirent) => path.join(sudoersDir, dirent.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const messages: Array<string> = [];

  for (const entryPath of entries) {
    const message = await stripUserEntriesFromFile(entryPath, user);
    if (message) {
      messages.push(message);
    }
  }

  return messages;
}

async function stripUserEntriesFromFile(
  filePath: string,
  user: string
): Promise<string | null> {
  let stats;
  let original: string;
  try {
    stats = await fs.stat(filePath);
    original = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline =
    original.endsWith("\n") || original.endsWith("\r\n");
  const rawLines = original.split(/\r?\n/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const filteredLines: Array<string> = [];
  let changed = false;

  for (const line of rawLines) {
    const trimmedLeading = line.trimStart();
    if (trimmedLeading.startsWith("#")) {
      filteredLines.push(line);
      continue;
    }
    if (trimmedLeading.length === 0) {
      filteredLines.push(line);
      continue;
    }
    const tokens = trimmedLeading.split(/\s+/);
    if (tokens[0] === user) {
      changed = true;
      continue;
    }
    filteredLines.push(line);
  }

  if (!changed) {
    return null;
  }

  const rebuilt = filteredLines.join(newline) + (endsWithNewline ? newline : "");
  try {
    await fs.writeFile(filePath, rebuilt, "utf8");
    await fs.chmod(filePath, stats.mode & 0o777);
  } catch {
    return null;
  }

  return `Removed ${user} entry from ${filePath}`;
}

async function execCommand(
  command: string,
  args: Array<string>,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const capture = options.capture ?? false;
  const child = spawn(command, args, {
    stdio: capture
      ? options.inheritedFileDescriptor === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", options.inheritedFileDescriptor]
      : "inherit",
  });

  let stdout = "";
  let stderr = "";

  if (capture && child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
  }

  if (capture && child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
  }

  return await new Promise<ExecResult>((resolve, reject) => {
    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !options.ignoreFailure) {
        const error = new Error(
          `Command failed: ${command} ${args.join(" ")} (exit code ${exitCode})`
        );
        (error as ExecError).code = exitCode;
        (error as ExecError).stdout = stdout;
        (error as ExecError).stderr = stderr;
        reject(error);
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

interface ExecError extends Error {
  code: number;
  stdout: string;
  stderr: string;
}

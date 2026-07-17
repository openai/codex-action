import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";

interface ExecOptions {
  capture?: boolean;
  ignoreFailure?: boolean;
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
}

const LINUX_PLATFORM = "linux";
const MACOS_PLATFORM = "darwin";
const LINUX_RUNTIME_DIRECTORY = "/run";

interface LinuxGroup {
  id: number;
  name: string;
  primary: boolean;
}

interface RootServiceSocket {
  path: string;
  groupId: number;
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

  let changed = false;

  switch (process.platform) {
    case LINUX_PLATFORM: {
      const serviceSockets = await findRootServiceSocketsForUser(options.user);
      const groups = new Set([
        options.group,
        ...serviceSockets
          .filter(({ group }) => !group.primary)
          .map(({ group }) => group.name),
      ]);
      for (const group of groups) {
        if (await removeUserFromLinuxGroup(options.user, group)) {
          changed = true;
        }
      }
      for (const { socket } of serviceSockets) {
        if (await restrictRootServiceSocket(socket.path)) {
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

async function findRootServiceSocketsForUser(
  user: string
): Promise<Array<{ socket: RootServiceSocket; group: LinuxGroup }>> {
  const groups = await getLinuxGroups(user);
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const sockets = await findRootServiceSockets(
    LINUX_RUNTIME_DIRECTORY,
    new Set(groupsById.keys())
  );

  return sockets.map((socket) => ({
    socket,
    group: groupsById.get(socket.groupId)!,
  }));
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
  ignoreUnreadable = false
): Promise<Array<RootServiceSocket>> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
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

  const sockets: Array<RootServiceSocket> = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sockets.push(
        ...(await findRootServiceSockets(
          entryPath,
          groupIds,
          ignoreUnreadable
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
    if (
      stats.isSocket() &&
      stats.uid === 0 &&
      (stats.mode & 0o020) !== 0 &&
      groupIds.has(stats.gid)
    ) {
      sockets.push({ path: entryPath, groupId: stats.gid });
    }
  }
  return sockets;
}

async function restrictRootServiceSocket(
  socketPath: string
): Promise<boolean> {
  let stats;
  try {
    stats = await fs.lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (!stats.isSocket()) {
    throw new Error(`Expected ${socketPath} to be a socket.`);
  }
  if (stats.uid !== 0) {
    throw new Error(`Expected ${socketPath} to be owned by root.`);
  }
  if ((stats.mode & 0o077) === 0) {
    console.log(`Access to ${socketPath} is already restricted.`);
    return false;
  }

  await fs.chmod(socketPath, stats.mode & 0o700);
  console.log(`Restricted access to ${socketPath}.`);
  return true;
}

async function verifyPrivilegedSocketsRestricted(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return;
  }

  const groupIds = new Set(
    typeof process.getgroups === "function" ? process.getgroups() : []
  );
  if (typeof process.getgid === "function") {
    groupIds.add(process.getgid());
  }
  const sockets = await findRootServiceSockets(
    LINUX_RUNTIME_DIRECTORY,
    groupIds,
    true
  );
  for (const socket of sockets) {
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
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
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

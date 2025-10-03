import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
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
}

async function dropSudoWithPrivileges(options: DropSudoOptions): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("drop-sudo root phase must run as root.");
  }

  let changed = false;

  switch (process.platform) {
    case LINUX_PLATFORM: {
      if (await isUserInGroup(options.user, options.group)) {
        if (await commandExists("deluser")) {
          await execCommand("deluser", [options.user, options.group]);
          console.log(
            `Used 'deluser ${options.user} ${options.group}' to drop sudo privilege.`
          );
        } else if (await commandExists("gpasswd")) {
          await execCommand("gpasswd", ["-d", options.user, options.group]);
          console.log(
            `Used 'gpasswd -d ${options.user} ${options.group}' to drop sudo privilege.`
          );
        } else {
          throw new Error("Neither deluser nor gpasswd available.");
        }
        changed = true;
      } else {
        console.log(
          `${options.user} is not a member of the ${options.group} group.`
        );
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

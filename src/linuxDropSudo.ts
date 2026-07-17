import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { discoverNestedGitRepositories } from "./linuxGitRepositories";
import {
  ENV_PATH,
  FIND_PATH,
  GIT_PATH,
  ID_PATH,
  NOLOGIN_PATH,
  SETFACL_PATH,
  SETPRIV_PATH,
  SHELL_PATH,
  SUDO_PATH,
  USERADD_PATH,
  USERDEL_PATH,
} from "./linuxSystemPaths";

const TRUSTED_EXECUTABLES = [
  SUDO_PATH,
  SETPRIV_PATH,
  SETFACL_PATH,
  FIND_PATH,
  ENV_PATH,
  ID_PATH,
  GIT_PATH,
  USERADD_PATH,
  USERDEL_PATH,
  NOLOGIN_PATH,
  SHELL_PATH,
];

export interface LinuxCodexIdentity {
  user: string;
  uid: number;
  gid: number;
  home: string;
  workingDirectory: string;
  codexExecutable: string;
  gitSafeDirectories: Array<string>;
}

interface PrepareLinuxCodexIdentityOptions {
  runnerUid: number;
  workingDirectory: string;
  codexHome: string | null;
  outputFile: string;
  outputSchema: string | null;
  codexExecutable: string;
}

/**
 * Creates a per-invocation Linux account and grants it access only to the paths Codex needs.
 * The account deliberately differs from the runner identity so Codex cannot signal or ptrace
 * runner-owned processes that still carry supplementary groups such as `docker`.
 */
export async function prepareLinuxCodexIdentity({
  runnerUid,
  workingDirectory,
  codexHome,
  outputFile,
  outputSchema,
  codexExecutable,
}: PrepareLinuxCodexIdentityOptions): Promise<LinuxCodexIdentity> {
  await Promise.all(TRUSTED_EXECUTABLES.map(verifyTrustedExecutable));

  const resolvedWorkingDirectory = await resolveDirectory(workingDirectory);
  const resolvedCodexExecutable = await resolveCodexExecutable(codexExecutable);
  const workspaceAccess = await discoverWorkspaceRoots(
    resolvedWorkingDirectory
  );
  const workspaceRoots = [...workspaceAccess.roots];
  if (codexHome != null) {
    workspaceRoots.push(await resolveDirectory(codexHome));
  }
  const accessRoots = removeNestedPaths(workspaceRoots);
  const user = createIdentityName(runnerUid);
  const home = `/home/${user}`;
  let created = false;
  let accessGranted = false;

  try {
    await runRootCommand(USERADD_PATH, [
      "--system",
      "--create-home",
      "--user-group",
      "--home-dir",
      home,
      "--shell",
      NOLOGIN_PATH,
      user,
    ]);
    created = true;

    const uid = await readNumericIdentity(user, "-u");
    const gid = await readNumericIdentity(user, "-g");
    if (uid === 0 || uid === runnerUid) {
      throw new Error(
        `Linux drop-sudo created an invalid Codex UID (${uid}); expected a non-root identity distinct from runner UID ${runnerUid}.`
      );
    }
    const groups = await readIdentityGroups(user);
    if (groups.length !== 1 || groups[0] !== gid) {
      throw new Error(
        `Linux drop-sudo requires the dedicated Codex account to have only primary GID ${gid}; found ${groups.join(", ")}.`
      );
    }

    accessGranted = true;
    await grantFileAccess(outputFile, uid, "rw-", runnerUid);
    if (outputSchema != null) {
      await grantFileAccess(outputSchema, uid, "r--", runnerUid);
    }
    for (const root of accessRoots) {
      await grantTreeAccess(root, uid, runnerUid);
    }

    console.log(
      `Prepared dedicated Linux Codex identity ${user} (uid ${uid}, gid ${gid}).`
    );
    return {
      user,
      uid,
      gid,
      home,
      workingDirectory: resolvedWorkingDirectory,
      codexExecutable: resolvedCodexExecutable,
      gitSafeDirectories: workspaceAccess.gitSafeDirectories,
    };
  } catch (error) {
    if (created && !accessGranted) {
      await runRootCommand(USERDEL_PATH, ["--remove", user], true);
    } else if (created) {
      console.warn(
        `Linux drop-sudo setup failed after granting ACLs; leaving locked account '${user}' in place to prevent UID reuse.`
      );
    }
    throw error;
  }
}

async function discoverWorkspaceRoots(
  workingDirectory: string
): Promise<{
  roots: Array<string>;
  gitSafeDirectories: Array<string>;
}> {
  const roots = [workingDirectory];
  const gitSafeDirectories = new Set<string>();
  const githubWorkspace = process.env.GITHUB_WORKSPACE;
  if (githubWorkspace != null && githubWorkspace.length > 0) {
    try {
      const resolvedWorkspace = await resolveDirectory(githubWorkspace);
      if (isPathWithin(workingDirectory, resolvedWorkspace)) {
        roots.push(resolvedWorkspace);
      }
    } catch {
      // Fall back to the requested working directory when GITHUB_WORKSPACE is stale.
    }
  }

  const gitRoot = await runCommand(
    GIT_PATH,
    ["-C", workingDirectory, "rev-parse", "--show-toplevel"],
    true
  );
  if (gitRoot.code === 0 && gitRoot.stdout.trim().length > 0) {
    try {
      const resolvedGitRoot = await resolveDirectory(gitRoot.stdout.trim());
      if (isPathWithin(workingDirectory, resolvedGitRoot)) {
        roots.push(resolvedGitRoot);
        gitSafeDirectories.add(resolvedGitRoot);
      }
    } catch {
      // `workingDirectory` is still sufficient for non-standard Git layouts.
    }
  }

  const safeDirectoryRoots = removeNestedPaths(roots);
  for (const root of safeDirectoryRoots) {
    gitSafeDirectories.add(root);
    for (const repository of await discoverNestedGitRepositories(root)) {
      gitSafeDirectories.add(repository);
    }
  }
  return {
    roots,
    gitSafeDirectories: [...gitSafeDirectories],
  };
}

async function grantTreeAccess(
  root: string,
  uid: number,
  runnerUid: number
): Promise<void> {
  assertSafeRecursiveRoot(root);
  const rootStats = await stat(root);
  if (rootStats.uid !== runnerUid) {
    throw new Error(
      `Linux drop-sudo requires access roots to be owned by runner UID ${runnerUid}; '${root}' is owned by UID ${rootStats.uid}.`
    );
  }
  await grantTraverseAccess(root, uid, runnerUid);
  await runRootCommand(FIND_PATH, [
    "-P",
    root,
    "-xdev",
    "(",
    "-type",
    "d",
    "-o",
    "(",
    "-type",
    "f",
    "-links",
    "1",
    ")",
    ")",
    "-uid",
    String(runnerUid),
    "-exec",
    SETFACL_PATH,
    "-m",
    `u:${uid}:rwX,u:${runnerUid}:rwX`,
    "--",
    "{}",
    "+",
  ]);
  await runRootCommand(FIND_PATH, [
    "-P",
    root,
    "-xdev",
    "-type",
    "d",
    "-uid",
    String(runnerUid),
    "-exec",
    SETFACL_PATH,
    "-m",
    `u:${uid}:rwx,u:${runnerUid}:rwx,d:u:${runnerUid}:rwx`,
    "--",
    "{}",
    "+",
  ]);
}

async function grantFileAccess(
  file: string,
  uid: number,
  permissions: "rw-" | "r--",
  runnerUid: number
): Promise<void> {
  const absoluteFile = path.resolve(file);
  const linkStats = await lstat(absoluteFile);
  const canonicalFile = await realpath(absoluteFile);
  if (linkStats.isSymbolicLink() || canonicalFile !== absoluteFile) {
    throw new Error(
      `Linux drop-sudo refuses a file path containing symbolic links: '${absoluteFile}'.`
    );
  }
  const fileStats = await stat(canonicalFile);
  if (!fileStats.isFile()) {
    throw new Error(
      `Linux drop-sudo expected a regular file but found '${absoluteFile}'.`
    );
  }
  if (fileStats.uid !== runnerUid) {
    if ((fileStats.mode & 0o004) === 0) {
      throw new Error(
        `Linux drop-sudo refuses to transfer group-derived file access for '${absoluteFile}'. The file must be owned by runner UID ${runnerUid} or already be world-readable.`
      );
    }
    await grantTraverseAccess(absoluteFile, uid, runnerUid);
    return;
  }
  if (fileStats.nlink !== 1) {
    throw new Error(
      `Linux drop-sudo refuses to grant access to a file with multiple hard links: '${absoluteFile}'.`
    );
  }
  await grantTraverseAccess(absoluteFile, uid, runnerUid);
  await runRootCommand(SETFACL_PATH, [
    "-m",
    `u:${uid}:${permissions}`,
    "--",
    canonicalFile,
  ]);
}

async function resolveCodexExecutable(file: string): Promise<string> {
  const absoluteFile = path.resolve(file);
  const canonicalFile = await realpath(absoluteFile);
  const fileStats = await stat(canonicalFile);
  if (!fileStats.isFile() || (fileStats.mode & 0o005) !== 0o005) {
    throw new Error(
      `Linux drop-sudo requires the Codex executable to resolve to a regular file that is already world-readable and executable: '${absoluteFile}'.`
    );
  }

  let current = path.dirname(canonicalFile);
  for (;;) {
    const directoryStats = await stat(current);
    if (!directoryStats.isDirectory() || (directoryStats.mode & 0o001) === 0) {
      throw new Error(
        `Linux drop-sudo requires every Codex executable parent directory to already be world-searchable: '${current}'.`
      );
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return canonicalFile;
}

async function grantTraverseAccess(
  target: string,
  uid: number,
  runnerUid: number
): Promise<void> {
  const ancestors: Array<string> = [];
  let current = path.dirname(path.resolve(target));
  while (current !== path.parse(current).root) {
    const directoryStats = await stat(current);
    if (!directoryStats.isDirectory()) {
      throw new Error(
        `Linux drop-sudo expected a directory while checking '${current}'.`
      );
    }
    if (directoryStats.uid === runnerUid) {
      ancestors.push(current);
    } else if ((directoryStats.mode & 0o001) === 0) {
      throw new Error(
        `Linux drop-sudo refuses to transfer group-derived directory access through '${current}'. It must be owned by runner UID ${runnerUid} or already be world-searchable.`
      );
    }
    current = path.dirname(current);
  }
  if (ancestors.length > 0) {
    await runRootCommand(SETFACL_PATH, [
      "-m",
      `u:${uid}:--x`,
      "--",
      ...ancestors,
    ]);
  }
}

async function readNumericIdentity(
  user: string,
  flag: "-u" | "-g"
): Promise<number> {
  const result = await runCommand(ID_PATH, [flag, user]);
  const value = Number(result.stdout.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Could not resolve ${flag} for dedicated user '${user}'.`);
  }
  return value;
}

async function readIdentityGroups(user: string): Promise<Array<number>> {
  const result = await runCommand(ID_PATH, ["-G", user]);
  const groups = result.stdout
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0)
    .map(Number);
  if (groups.some((group) => !Number.isSafeInteger(group) || group < 0)) {
    throw new Error(`Could not resolve groups for dedicated user '${user}'.`);
  }
  return [...new Set(groups)];
}

async function verifyTrustedExecutable(file: string): Promise<void> {
  let canonicalFile: string;
  let fileStats;
  try {
    canonicalFile = await realpath(file);
    fileStats = await stat(canonicalFile);
  } catch {
    throw new Error(
      `Linux drop-sudo requires trusted executable '${file}'.`
    );
  }
  if (
    !fileStats.isFile() ||
    fileStats.uid !== 0 ||
    (fileStats.mode & 0o111) === 0 ||
    (fileStats.mode & 0o022) !== 0
  ) {
    throw new Error(
      `Linux drop-sudo requires '${file}' to resolve to a root-owned executable that is not group- or world-writable.`
    );
  }
}

async function resolveDirectory(directory: string): Promise<string> {
  const absoluteDirectory = path.resolve(directory);
  const resolved = await realpath(absoluteDirectory);
  if (resolved !== absoluteDirectory) {
    throw new Error(
      `Linux drop-sudo refuses a directory path containing symbolic links: '${absoluteDirectory}'.`
    );
  }
  const directoryStats = await stat(resolved);
  if (!directoryStats.isDirectory()) {
    throw new Error(
      `Linux drop-sudo expected a directory but found '${resolved}'.`
    );
  }
  return resolved;
}

function removeNestedPaths(paths: Array<string>): Array<string> {
  const sorted = [...new Set(paths.map((value) => path.resolve(value)))].sort(
    (left, right) => left.length - right.length
  );
  return sorted.filter(
    (candidate, index) =>
      !sorted
        .slice(0, index)
        .some((parent) => isPathWithin(candidate, parent))
  );
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertSafeRecursiveRoot(root: string): void {
  if (root === path.parse(root).root) {
    throw new Error(
      "Linux drop-sudo refuses to grant recursive access to the filesystem root."
    );
  }
}

function createIdentityName(runnerUid: number): string {
  const suffix = randomBytes(4).toString("hex");
  const prefix = `codexaction${runnerUid}`.slice(0, 23);
  return `${prefix}x${suffix}`;
}

async function runRootCommand(
  command: string,
  args: Array<string>,
  ignoreFailure = false
): Promise<CommandResult> {
  return await runCommand(
    SUDO_PATH,
    ["-n", "--", command, ...args],
    ignoreFailure
  );
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  command: string,
  args: Array<string>,
  ignoreFailure = false
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !ignoreFailure) {
        reject(
          new Error(
            `Command failed: ${command} ${args.join(" ")} (exit code ${exitCode}): ${stderr.trim()}`
          )
        );
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

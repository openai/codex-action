import { spawn } from "child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { setOutput } from "@actions/core";
import { checkOutput } from "./checkOutput";
import { dropSudo, verifySudoUnavailable } from "./dropSudo";
import {
  buildGatedCodexCommand,
  endChildInput,
  waitForLinuxGate,
  type GatedCodexCommand,
} from "./linuxDropSudo";

export type PromptSource =
  | {
      type: "inline";
      content: string;
    }
  | {
      type: "file";
      path: string;
    };

export type SafetyStrategy =
  | "drop-sudo"
  | "read-only"
  | "unprivileged-user"
  | "unsafe";

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

type PermissionSelection =
  | { type: "sandbox"; mode: SandboxMode }
  | { type: "profile"; name: string };

export type OutputSchemaSource =
  | {
      type: "file";
      path: string;
    }
  | {
      type: "inline";
      content: string;
    };

/**
 * Builds and runs a `codex exec` command, writes the prompt to its standard input, and publishes
 * the command's final message as the action output.
 *
 * Authentication is intentionally outside this function. The composite action starts or reuses
 * the Responses API proxy and writes the corresponding Codex configuration before invoking this
 * command. Keeping that setup separate also lets tests put a fake `codex` executable on `PATH` to
 * verify command construction and output handling without an API key or network request.
 */
export async function runCodexExec({
  prompt,
  codexHome,
  cd,
  extraArgs,
  explicitOutputFile,
  outputSchema,
  model,
  effort,
  safetyStrategy,
  codexUser,
  sandbox,
  permissionProfile,
}: {
  prompt: PromptSource;
  codexHome: string | null;
  cd: string;
  extraArgs: Array<string>;
  explicitOutputFile: string | null;
  outputSchema: OutputSchemaSource | null;
  model: string | null;
  effort: string | null;
  safetyStrategy: SafetyStrategy;
  codexUser: string | null;
  sandbox: SandboxMode | null;
  permissionProfile: string | null;
}): Promise<void> {
  let input: string;
  switch (prompt.type) {
    case "inline":
      input = prompt.content;
      break;
    case "file":
      input = await readFile(prompt.path, "utf8");
      break;
  }

  const runAsUser: string | null =
    safetyStrategy === "unprivileged-user" ? codexUser : null;

  let outputFile: OutputFile;
  if (explicitOutputFile != null) {
    outputFile = { type: "explicit", file: explicitOutputFile };
  } else {
    outputFile = await createTempOutputFile({ runAsUser });
  }

  const resolvedOutputSchema = await resolveOutputSchema(
    outputSchema,
    runAsUser
  );
  const permissionSelection = determinePermissionSelection({
    safetyStrategy,
    requestedSandbox: sandbox,
    permissionProfile,
    extraArgs,
  });

  const commandPrefix: Array<string> = [];
  let linuxDropSudoUser: string | null = null;
  let linuxGate: GatedCodexCommand | null = null;

  let pathToCodex = "codex";
  if (safetyStrategy === "drop-sudo" && process.platform === "linux") {
    if (
      typeof process.getuid !== "function" ||
      typeof process.getgid !== "function"
    ) {
      throw new Error("Linux drop-sudo requires POSIX user and group APIs.");
    }

    const uid = process.getuid();
    if (uid === 0) {
      throw new Error(
        "Linux drop-sudo cannot run Codex from a runner whose default user is root."
      );
    }

    pathToCodex = (await checkOutput(["which", "codex"])).trim();
    if (!pathToCodex) {
      throw new Error("could not find 'codex' in PATH");
    }
    linuxDropSudoUser = os.userInfo().username;
  } else if (safetyStrategy === "unprivileged-user") {
    if (codexUser == null) {
      throw new Error(
        "codexUser must be specified when using the 'unprivileged-user' safety strategy."
      );
    }

    if (process.platform === "win32") {
      throw new Error(
        "the 'unprivileged-user' safety strategy is not supported on Windows."
      );
    }

    // We are currently running as a privileged user, but `codexUser` will run
    // with a different $PATH variable, so we need to find the full path to
    // `codex`.
    pathToCodex = (await checkOutput(["which", "codex"])).trim();
    if (!pathToCodex) {
      throw new Error("could not find 'codex' in PATH");
    }

    commandPrefix.push("sudo", "-u", codexUser, "--");
  }

  const codexArgs = [
    "exec",
    "--skip-git-repo-check",
    "--cd",
    cd,
    "--output-last-message",
    outputFile.file,
  ];

  if (resolvedOutputSchema != null) {
    codexArgs.push("--output-schema", resolvedOutputSchema.file);
  }

  if (model != null) {
    codexArgs.push("--model", model);
  }

  if (effort != null) {
    // https://github.com/openai/codex/blob/00debb6399eb51c4b9273f0bc012912c42fe6c91/docs/config.md#config
    // https://github.com/openai/codex/blob/00debb6399eb51c4b9273f0bc012912c42fe6c91/docs/config.md#model_reasoning_effort
    codexArgs.push("--config", `model_reasoning_effort="${effort}"`);
  }

  codexArgs.push(...extraArgs);

  switch (permissionSelection.type) {
    case "sandbox":
      codexArgs.push("--sandbox", permissionSelection.mode);
      break;
    case "profile":
      codexArgs.push(
        "--config",
        `default_permissions=${JSON.stringify(permissionSelection.name)}`
      );
      break;
  }

  const env = { ...process.env };
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_github_action";
  }
  let extraEnv = "";
  if (codexHome != null) {
    env.CODEX_HOME = codexHome;
    extraEnv = `CODEX_HOME=${codexHome} `;
  }

  let program: string;
  let command: Array<string>;
  if (linuxDropSudoUser != null) {
    const userInfo = os.userInfo();
    linuxGate = buildGatedCodexCommand({
      uid: process.getuid!(),
      gid: process.getgid!(),
      user: linuxDropSudoUser,
      home: process.env.HOME ?? userInfo.homedir,
      codexPath: pathToCodex,
      codexArgs,
    });
    program = linuxGate.program;
    command = linuxGate.args;
    console.log(
      `Running with Linux drop-sudo protection: ${extraEnv}${pathToCodex} ${codexArgs
        .map((arg) => JSON.stringify(arg))
        .join(" ")}`
    );
  } else {
    const fullCommand = [...commandPrefix, pathToCodex, ...codexArgs];
    program = fullCommand.shift()!;
    command = fullCommand;
    console.log(
      `Running: ${extraEnv}${program} ${command
        .map((arg) => JSON.stringify(arg))
        .join(" ")}`
    );
  }

  try {
    const child = spawn(program, command, {
      env,
      stdio: ["pipe", linuxGate == null ? "inherit" : "pipe", "inherit"],
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const completed = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    const gateReady =
      linuxGate == null
        ? Promise.resolve()
        : waitForLinuxGate(child, linuxGate.readyToken);

    try {
      await Promise.all([spawned, gateReady]);
      if (linuxDropSudoUser != null) {
        await dropSudo({
          user: linuxDropSudoUser,
          group: "sudo",
          rootPhase: false,
        });
        await verifySudoUnavailable();
      }

      if (linuxGate != null && child.exitCode != null) {
        throw new Error(
          `${program} exited before privilege cleanup completed (code ${child.exitCode})`
        );
      }
      const childInput =
        linuxGate == null ? input : `${linuxGate.goToken}\n${input}`;
      await endChildInput(child, childInput);
    } catch (error) {
      if (child.stdin != null && !child.stdin.destroyed) {
        child.stdin.on("error", () => undefined);
        child.stdin.end();
      }
      await completed.catch(() => undefined);
      throw error;
    }

    const code = await completed;
    if (code !== 0) {
      throw new Error(`${program} exited with code ${code}`);
    }
    await finalizeExecution(outputFile, runAsUser);
  } finally {
    await cleanupOutputSchema(resolvedOutputSchema);
  }
}

async function finalizeExecution(
  outputFile: OutputFile,
  runAsUser: string | null
): Promise<void> {
  try {
    let lastMessage: string;
    if (runAsUser == null) {
      lastMessage = await readFile(outputFile.file, "utf8");
    } else {
      lastMessage = await checkOutput([
        "sudo",
        "-u",
        runAsUser,
        "cat",
        outputFile.file,
      ]);
    }
    setOutput("final-message", lastMessage);
  } finally {
    await cleanupTempOutput(outputFile, runAsUser);
  }
}

type OutputFile =
  | {
      type: "explicit";
      file: string;
    }
  | {
      type: "temp";
      file: string;
    };

type ResolvedOutputSchema =
  | {
      type: "explicit";
      file: string;
    }
  | {
      type: "temp";
      file: string;
      dir: string;
    };

async function createTempOutputFile({
  runAsUser,
}: {
  runAsUser: string | null;
}): Promise<OutputFile> {
  const dir = await createTempDir("codex-exec-", runAsUser);
  return { type: "temp", file: path.join(dir, "output.md") };
}

async function cleanupTempOutput(
  outputFile: OutputFile,
  runAsUser: string | null
): Promise<void> {
  switch (outputFile.type) {
    case "explicit":
      // Do not delete user-specified output files.
      return;
    case "temp": {
      const { file } = outputFile;
      if (runAsUser == null) {
        const dir = path.dirname(file);
        await rm(dir, { recursive: true, force: true });
      } else {
        await checkOutput(["sudo", "rm", "-rf", path.dirname(file)]);
      }
      break;
    }
  }
}

async function resolveOutputSchema(
  schema: OutputSchemaSource | null,
  runAsUser: string | null
): Promise<ResolvedOutputSchema | null> {
  if (schema == null) {
    return null;
  }

  switch (schema.type) {
    case "file":
      return { type: "explicit", file: schema.path };
    case "inline": {
      const dir = await createTempDir("codex-output-schema-", runAsUser);
      const file = path.join(dir, "schema.json");
      await writeFile(file, schema.content);
      return { type: "temp", file, dir };
    }
  }
}

async function cleanupOutputSchema(
  schema: ResolvedOutputSchema | null
): Promise<void> {
  if (schema == null) {
    return;
  }

  switch (schema.type) {
    case "explicit":
      return;
    case "temp":
      await rm(schema.dir, { recursive: true, force: true });
      return;
  }
}

async function createTempDir(
  prefix: string,
  runAsUser: string | null
): Promise<string> {
  if (runAsUser == null) {
    return await mkdtemp(path.join(os.tmpdir(), prefix));
  } else {
    return (
      await checkOutput([
        "sudo",
        "-u",
        runAsUser,
        "mktemp",
        "-d",
        "-t",
        `${prefix}.XXXXXX`,
      ])
    ).trim();
  }
}

function determinePermissionSelection({
  safetyStrategy,
  requestedSandbox,
  permissionProfile,
  extraArgs,
}: {
  safetyStrategy: SafetyStrategy;
  requestedSandbox: SandboxMode | null;
  permissionProfile: string | null;
  extraArgs: Array<string>;
}): PermissionSelection {
  if (permissionProfile != null && requestedSandbox != null) {
    throw new Error(
      "`permission-profile` and `sandbox` are mutually exclusive. Permission profiles do not compose with legacy sandbox settings."
    );
  }
  if (permissionProfile != null && safetyStrategy === "read-only") {
    throw new Error(
      "`permission-profile` cannot be combined with the `read-only` safety strategy because that strategy forces the legacy read-only sandbox."
    );
  }
  if (permissionProfile != null && extraArgsSelectSandbox(extraArgs)) {
    throw new Error(
      "`permission-profile` cannot be combined with a sandbox override in `codex-args`."
    );
  }
  if (safetyStrategy === "read-only") {
    return { type: "sandbox", mode: "read-only" };
  }
  if (permissionProfile != null) {
    return { type: "profile", name: permissionProfile };
  }
  return { type: "sandbox", mode: requestedSandbox ?? "workspace-write" };
}

function extraArgsSelectSandbox(args: Array<string>): boolean {
  return args.some((arg, index) => {
    if (
      arg === "--sandbox" ||
      arg.startsWith("--sandbox=") ||
      arg === "-s" ||
      arg.startsWith("-s=")
    ) {
      return true;
    }
    if (arg === "--config" || arg === "-c") {
      return configOverrideSelectsSandbox(args[index + 1]);
    }
    if (arg.startsWith("--config=")) {
      return configOverrideSelectsSandbox(arg.slice("--config=".length));
    }
    if (arg.startsWith("-c=")) {
      return configOverrideSelectsSandbox(arg.slice("-c=".length));
    }
    return false;
  });
}

function configOverrideSelectsSandbox(override: string | undefined): boolean {
  const key = override?.trimStart().split(/[=.]/, 1)[0];
  return key === "sandbox_mode" || key === "sandbox_workspace_write";
}

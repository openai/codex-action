import { spawn } from "child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { setOutput } from "@actions/core";
import { checkOutput } from "./checkOutput";

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

export type OutputSchemaSource =
  | {
      type: "file";
      path: string;
    }
  | {
      type: "inline";
      content: string;
    };

export async function runCodexExec({
  prompt,
  codexHome,
  cd,
  extraArgs,
  explicitOutputFile,
  outputSchema,
  model,
  safetyStrategy,
  codexUser,
  sandbox,
}: {
  prompt: PromptSource;
  codexHome: string | null;
  cd: string;
  extraArgs: Array<string>;
  explicitOutputFile: string | null;
  outputSchema: OutputSchemaSource | null;
  model: string | null;
  safetyStrategy: SafetyStrategy;
  codexUser: string | null;
  sandbox: SandboxMode;
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
  const sandboxMode = await determineSandboxMode({
    safetyStrategy,
    requestedSandbox: sandbox,
  });

  const command: Array<string> = [];

  let pathToCodex = "codex";
  if (safetyStrategy === "unprivileged-user") {
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

    command.push("sudo", "-u", codexUser, "--");
  }

  command.push(
    pathToCodex,
    "exec",
    "--skip-git-repo-check",
    "--cd",
    cd,
    "--output-last-message",
    outputFile.file
  );

  if (resolvedOutputSchema != null) {
    command.push("--output-schema", resolvedOutputSchema.file);
  }

  if (model != null) {
    command.push("--model", model);
  }

  command.push(...extraArgs);

  command.push("--sandbox", sandboxMode);

  const env = { ...process.env };
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_github_action";
  }
  let extraEnv = "";
  if (codexHome != null) {
    env.CODEX_HOME = codexHome;
    extraEnv = `CODEX_HOME=${codexHome} `;
  }

  // Split the `program` from the `args` for `spawn()`.
  const program = command.shift()!;
  console.log(
    `Running: ${extraEnv}${program} ${command
      .map((a) => JSON.stringify(a))
      .join(" ")}`
  );
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(program, command, {
        env,
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin.write(input);
      child.stdin.end();

      child.on("error", reject);

      child.on("close", async (code) => {
        if (code !== 0) {
          reject(new Error(`${program} exited with code ${code}`));
          return;
        }

        try {
          await finalizeExecution(outputFile, runAsUser);
          resolve(undefined);
        } catch (err) {
          reject(err);
        }
      });
    });
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

async function determineSandboxMode({
  safetyStrategy,
  requestedSandbox,
}: {
  safetyStrategy: SafetyStrategy;
  requestedSandbox: SandboxMode;
}): Promise<SandboxMode> {
  if (safetyStrategy === "read-only") {
    return "read-only";
  } else {
    return requestedSandbox;
  }
}

import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import path from "path";
import { setOutput } from "@actions/core";

export type PromptSource =
  | {
      type: "text";
      content: string;
    }
  | {
      type: "file";
      path: string;
    };

export type SafetyStrategy =
  | "drop_sudo"
  | "read_only"
  | "unprivileged_user"
  | "unsafe";

export async function runCodexExec({
  prompt,
  codexHome,
  cd,
  proxyPort,
  extraArgs,
  explicitOutputFile,
  safetyStrategy,
  codexUser,
}: {
  prompt: PromptSource;
  codexHome: string | null;
  cd: string;
  proxyPort: number;
  extraArgs: Array<string>;
  explicitOutputFile: string | null;
  safetyStrategy: SafetyStrategy;
  codexUser: string | null;
}): Promise<void> {
  let input: string;
  switch (prompt.type) {
    case "text":
      input = prompt.content;
      break;
    case "file":
      input = await readFile(prompt.path, "utf8");
      break;
  }

  let outputFile: OutputFile;
  if (explicitOutputFile != null) {
    outputFile = { type: "explicit", file: explicitOutputFile };
  } else {
    outputFile = await createTempOutputFile();
  }

  const command: Array<string> = [];

  if (safetyStrategy === "unprivileged_user") {
    if (codexUser == null) {
      throw new Error(
        "codexUser must be specified when using the 'unprivileged_user' safety strategy."
      );
    }

    command.push("sudo", "-u", codexUser, "--");
  }

  const providerBaseUrl = `http://127.0.0.1:${proxyPort}/v1`;
  const providerId = "openai-proxy";
  const providerConfig = `model_providers.${providerId}={ name = "OpenAI Proxy", base_url = "${providerBaseUrl}", wire_api = "responses" }`;

  command.push(
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--cd",
    cd,
    "--config",
    providerConfig,
    "--config",
    `model_provider="${providerId}"`,
    "--output-last-message",
    outputFile.file
  );
  command.push(...extraArgs);

  // Note that if profiles expand to support their own sandbox policies, a
  // custom profile could override this setting.
  if (safetyStrategy === "read_only") {
    command.push("--config", 'sandbox_mode="read-only"');
  }

  const env = { ...process.env };
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
  return new Promise((resolve, reject) => {
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
        await finalizeExecution(outputFile);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function finalizeExecution(outputFile: OutputFile): Promise<void> {
  try {
    const lastMessage = await readFile(outputFile.file, "utf8");
    setOutput("final_message", lastMessage);
  } finally {
    await cleanupTempOutput(outputFile);
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

async function createTempOutputFile(): Promise<OutputFile> {
  const dir = await mkdtemp("codex-exec-");
  return { type: "temp", file: path.join(dir, "output.md") };
}

async function cleanupTempOutput(outputFile: OutputFile): Promise<void> {
  switch (outputFile.type) {
    case "explicit":
      // Do not delete user-specified output files.
      return;
    case "temp": {
      const { file } = outputFile;
      const dir = path.dirname(file);
      await rm(dir, { recursive: true, force: true });
      break;
    }
  }
}

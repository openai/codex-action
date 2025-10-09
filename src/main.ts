import { Command, Option } from "commander";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pkg from "../package.json" assert { type: "json" };

// Enhanced AI code review functionality - supports OpenAI-compatible APIs

import { readServerInfo } from "./readServerInfo";
import {
  SandboxMode,
  OutputSchemaSource,
  PromptSource,
  runCodexExec,
  SafetyStrategy,
} from "./runCodexExec";
import { dropSudo } from "./dropSudo";
import { ensureActorHasWriteAccess } from "./checkActorPermissions";
import parseArgsStringToArgv from "string-argv";
import { writeProxyConfig } from "./writeProxyConfig";
import { writeCustomConfig } from "./writeCustomConfig";
import { checkOutput } from "./checkOutput";

export async function main() {
  const program = new Command();

  program
    .name("codex-action")
    .version(pkg.version)
    .description("Multitool to support openai/codex-action.");

  program
    .command("read-server-info")
    .description("Read server info from the responses API proxy")
    .argument("<serverInfoFile>", "Path to the server info file")
    .action(async (serverInfoFile: string) => {
      await readServerInfo(serverInfoFile);
    });

  program
    .command("resolve-codex-home")
    .description(
      "Resolve the Codex home directory with precedence: input, env, default (~/.codex)"
    )
    .requiredOption(
      "--codex-home-override <DIRECTORY>",
      "Optional codex-home input value (may be empty)"
    )
    .requiredOption(
      "--safety-strategy <strategy>",
      "Safety strategy to take into account when picking defaults"
    )
    .requiredOption(
      "--codex-user <user>",
      "Codex user to consider when safety strategy is 'unprivileged-user'"
    )
    .requiredOption("--github-run-id <id>", "GitHub run ID")
    .action(
      async (options: {
        codexHomeOverride: string;
        safetyStrategy: string;
        codexUser: string;
        githubRunId: string;
      }) => {
        const safetyStrategy = toSafetyStrategy(options.safetyStrategy);
        const codexUser = emptyAsNull(options.codexUser);
        const resolved = await resolveCodexHome(
          emptyAsNull(options.codexHomeOverride),
          safetyStrategy,
          codexUser,
          options.githubRunId
        );

        const { setOutput } = await import("@actions/core");
        setOutput("codex-home", resolved);
        console.log(`Resolved Codex home: ${resolved}`);
      }
    );

  program
    .command("write-proxy-config")
    .description(
      "Write the OpenAI Proxy model provider config into CODEX_HOME/config.toml"
    )
    .requiredOption("--codex-home <DIRECTORY>", "Path to Codex home directory")
    .requiredOption("--port <port>", "Proxy server port", parseIntStrict)
    .requiredOption(
      "--safety-strategy <strategy>",
      "Safety strategy to use. One of 'drop-sudo', 'read-only', 'unprivileged-user', or 'unsafe'."
    )
    .option(
      "--custom-base-url <URL>",
      "Custom base URL for OpenAI-compatible API endpoint"
    )
    .action(
      async (options: {
        codexHome: string;
        port: number;
        safetyStrategy: string;
        customBaseUrl?: string;
      }) => {
        const safetyStrategy = toSafetyStrategy(options.safetyStrategy);
        await writeProxyConfig(
          options.codexHome,
          options.port,
          safetyStrategy,
          options.customBaseUrl
        );
      }
    );

  program
    .command("write-custom-config")
    .description(
      "Write custom OpenAI-compatible API config into CODEX_HOME/config.toml"
    )
    .requiredOption("--codex-home <DIRECTORY>", "Path to Codex home directory")
    .requiredOption(
      "--base-url <URL>",
      "Base URL for the custom OpenAI-compatible API endpoint"
    )
    .requiredOption(
      "--safety-strategy <strategy>",
      "Safety strategy to use. One of 'drop-sudo', 'read-only', 'unprivileged-user', or 'unsafe'."
    )
    .option("--model <model>", "Model name to use with custom API endpoint")
    .action(
      async (options: {
        codexHome: string;
        baseUrl: string;
        safetyStrategy: string;
        model?: string;
      }) => {
        const safetyStrategy = toSafetyStrategy(options.safetyStrategy);
        await writeCustomConfig(
          options.codexHome,
          options.baseUrl,
          safetyStrategy,
          options.model
        );
      }
    );

  program
    .command("drop-sudo")
    .description("Drops sudo privileges for the configured user.")
    .addOption(new Option("--user <user>", "User to modify").default("runner"))
    .addOption(
      new Option("--group <group>", "Group granting sudo privileges").default(
        "sudo"
      )
    )
    .addOption(new Option("--root-phase", "internal").default(false).hideHelp())
    .action(
      async (options: { user: string; group: string; rootPhase: boolean }) => {
        await dropSudo({
          user: options.user,
          group: options.group,
          rootPhase: options.rootPhase,
        });
      }
    );

  program
    .command("run-codex-exec")
    .description("Invokes `codex exec` with the appropriate arguments")
    .requiredOption("--prompt <prompt>", "Prompt to pass to `codex exec`.")
    .requiredOption(
      "--prompt-file <FILE>",
      "File containing the prompt to pass to `codex exec`."
    )
    .requiredOption(
      "--codex-home <DIRECTORY>",
      "Path to the Codex CLI home directory (where config files are stored)."
    )
    .requiredOption("--cd <DIRECTORY>", "Working directory for Codex")
    .requiredOption(
      "--extra-args <args>",
      "Additional args to pass through to `codex exec` as JSON array or shell string.",
      parseExtraArgs
    )
    .requiredOption(
      "--output-file <FILE>",
      "Path where the final message from `codex exec` will be written."
    )
    .requiredOption(
      "--output-schema-file <FILE>",
      "Path to a schema file to pass to `codex exec --output-schema`."
    )
    .requiredOption(
      "--output-schema <SCHEMA>",
      "Inline schema contents to pass to `codex exec --output-schema`."
    )
    .requiredOption(
      "--sandbox <SANDBOX>",
      "Sandbox mode override to pass to `codex exec`."
    )
    .requiredOption("--model <model>", "Model the agent should use")
    .requiredOption(
      "--safety-strategy <strategy>",
      "Safety strategy to use. One of 'drop-sudo', 'read-only', 'unprivileged-user', or 'unsafe'."
    )
    .requiredOption(
      "--codex-user <user>",
      "User to run codex exec as when using the 'unprivileged-user' safety strategy."
    )
    .action(
      async (options: {
        prompt: string;
        promptFile: string;
        codexHome: string;
        cd: string;
        extraArgs: Array<string>;
        outputFile: string;
        outputSchemaFile: string;
        outputSchema: string;
        sandbox: string;
        model: string;
        safetyStrategy: string;
        codexUser: string;
      }) => {
        const {
          prompt,
          promptFile,
          outputFile,
          codexHome,
          cd,
          extraArgs,
          outputSchema,
          outputSchemaFile,
          sandbox,
          model,
          safetyStrategy,
          codexUser,
        } = options;

        const normalizedPrompt = emptyAsNull(prompt);
        const normalizedPromptFile = emptyAsNull(promptFile);
        if (normalizedPrompt != null && normalizedPromptFile != null) {
          throw new Error(
            "Only one of `prompt` or `prompt-file` may be specified."
          );
        }

        let promptSource: PromptSource;
        if (normalizedPrompt != null) {
          promptSource = { type: "inline", content: normalizedPrompt };
        } else if (normalizedPromptFile != null) {
          promptSource = { type: "file", path: normalizedPromptFile };
        } else {
          throw new Error(
            "Either `prompt` or `prompt-file` must be specified."
          );
        }

        // Custom option processing to coerces to null does not work with
        // Commander.js's requiredOption, so we have to post-process here.
        const normalizedOutputSchemaFile = emptyAsNull(outputSchemaFile);
        const normalizedOutputSchema = emptyAsNull(outputSchema);

        if (
          normalizedOutputSchemaFile != null &&
          normalizedOutputSchema != null
        ) {
          throw new Error(
            "Only one of `output-schema` or `output-schema-file` may be specified."
          );
        }

        let outputSchemaSource: OutputSchemaSource | null = null;
        if (normalizedOutputSchema != null) {
          outputSchemaSource = {
            type: "inline",
            content: normalizedOutputSchema,
          };
        } else if (normalizedOutputSchemaFile != null) {
          outputSchemaSource = {
            type: "file",
            path: normalizedOutputSchemaFile,
          };
        }

        await runCodexExec({
          prompt: promptSource,
          codexHome: emptyAsNull(codexHome),
          cd,
          extraArgs,
          explicitOutputFile: emptyAsNull(outputFile),
          outputSchema: outputSchemaSource,
          sandbox: toSandboxMode(sandbox),
          model: emptyAsNull(model),
          safetyStrategy: toSafetyStrategy(safetyStrategy),
          codexUser: emptyAsNull(codexUser),
        });
      }
    );

  program
    .command("check-write-access")
    .description(
      "Checks that the triggering actor has write access to the repository"
    )
    .option(
      "--allow-bots <boolean>",
      "Allow GitHub App and bot actors to bypass the write-access check (default: true).",
      parseBoolean,
      true
    )
    .option(
      "--allow-users <users>",
      "Comma-separated list of GitHub usernames who can run this action, or '*' to allow all users.",
      ""
    )
    .action(
      async ({
        allowBots,
        allowUsers,
      }: {
        allowBots: boolean;
        allowUsers: string;
      }) => {
        const result = await ensureActorHasWriteAccess({
          allowBotActors: allowBots,
          allowUsers,
        });
        switch (result.status) {
          case "approved": {
            console.log(`Actor '${result.actor}' is permitted to continue.`);
            break;
          }
          case "rejected": {
            const message = `Actor '${result.actor}' is not permitted to run this action: ${result.reason}`;
            console.error(message);
            throw new Error(message);
          }
        }
      }
    );

  program.parse();
}

function parseIntStrict(value: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parseExtraArgs(value: string): Array<string> {
  if (value.length === 0) {
    return [];
  }

  if (value.startsWith("[")) {
    return JSON.parse(value);
  } else {
    return parseArgsStringToArgv(value);
  }
}

function toSafetyStrategy(value: string): SafetyStrategy {
  switch (value) {
    case "drop-sudo":
    case "read-only":
    case "unprivileged-user":
    case "unsafe":
      return value;
    default:
      throw new Error(
        `Invalid safety strategy: ${value}. Must be one of 'drop-sudo', 'read-only', 'unprivileged-user', or 'unsafe'.`
      );
  }
}

function toSandboxMode(value: string): SandboxMode {
  switch (value) {
    case "read-only":
    case "workspace-write":
    case "danger-full-access":
      return value;
    default:
      throw new Error(
        `Invalid sandbox: ${value}. Must be one of 'read-only', 'workspace-write', or 'danger-full-access'.`
      );
  }
}

function emptyAsNull(value: string): string | null {
  return value.trim().length == 0 ? null : value;
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

main();

async function resolveCodexHome(
  inputCodexHome: string | null,
  safetyStrategy: SafetyStrategy,
  codexUser: string | null,
  githubRunId: string
): Promise<string> {
  if (inputCodexHome != null) {
    return expandTilde(inputCodexHome);
  }
  const envHome = emptyAsNull(process.env.CODEX_HOME ?? "");
  if (envHome != null) {
    return envHome;
  }

  if (safetyStrategy === "unprivileged-user") {
    if (codexUser == null) {
      throw new Error(
        "codex-user input must be provided when using 'unprivileged-user' safety strategy and no codex-home is specified."
      );
    }

    return await deriveSharedCodexHomeForUnprivilegedUser(
      codexUser,
      githubRunId
    );
  } else {
    const codexHome = path.join(os.homedir(), ".codex");
    // Ensure directory exists for downstream steps that will write files here.
    await fs.mkdir(codexHome, { recursive: true });
    return codexHome;
  }
}

async function deriveSharedCodexHomeForUnprivilegedUser(
  user: string,
  githubRunId: string
): Promise<string> {
  const home = (
    await checkOutput(["sudo", "-u", user, "--", "printenv", "HOME"])
  ).trim();
  if (!home) {
    throw new Error(`Could not determine home directory for user '${user}'.`);
  }
  const codexHome = path.join(home, ".codex");
  try {
    const stat = await fs.stat(codexHome);
    if (stat.isDirectory()) {
      // Directory already exists and may contain a config.toml created by the
      // user (or a previous invocation of codex-action), so assume it's
      // correctly permissioned.
      return codexHome;
    }
  } catch {
    // Ignore stat errors and try to create the directory.
  }

  // We must use sudo for the following file system operations because we
  // are writing to the home directory of a different user.
  await checkOutput(["sudo", "mkdir", codexHome]);
  await checkOutput(["sudo", "chown", `${user}`, codexHome]);
  await checkOutput(["sudo", "chmod", "755", codexHome]);

  // codex-responses-api-proxy will need to write the server info file.
  const serverInfoFile = path.join(codexHome, `${githubRunId}.json`);
  await checkOutput(["sudo", "touch", serverInfoFile]);
  // Make the file world-writable for the moment, but this will be locked down
  // to read-only by root before the action completes.
  await checkOutput(["sudo", "chmod", "666", serverInfoFile]);

  return codexHome;
}

function expandTilde(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

import { Command, Option } from "commander";
import pkg from "../package.json" assert { type: "json" };

import { readServerInfo } from "./readServerInfo";
import { PromptSource, runCodexExec, SafetyStrategy } from "./runCodexExec";
import { dropSudo } from "./dropSudo";
import { ensureActorHasWriteAccess } from "./checkActorPermissions";
import parseArgsStringToArgv from "string-argv";

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
      "--proxy-port <port>",
      "Port of the Responses API Proxy",
      parseIntStrict
    )
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
      "--safety-strategy <strategy>",
      "Safety strategy to use. One of 'drop_sudo', 'read_only', 'unprivileged_user', or 'unsafe'."
    )
    .requiredOption(
      "--codex-user <user>",
      "User to run codex exec as when using the 'unprivileged_user' safety strategy."
    )
    .action(
      async (options: {
        prompt: string;
        promptFile: string;
        codexHome: string;
        cd: string;
        proxyPort: number;
        extraArgs: Array<string>;
        outputFile: string;
        outputSchemaFile: string;
        safetyStrategy: string;
        codexUser: string;
      }) => {
        const {
          prompt,
          promptFile,
          codexHome,
          cd,
          proxyPort,
          extraArgs,
          outputFile,
          outputSchemaFile,
          safetyStrategy,
          codexUser,
        } = options;

        const normalizedPrompt = emptyAsNull(prompt);
        const normalizedPromptFile = emptyAsNull(promptFile);
        let promptSource: PromptSource;
        if (normalizedPrompt != null) {
          promptSource = { type: "text", content: normalizedPrompt };
        } else if (normalizedPromptFile != null) {
          promptSource = { type: "file", path: normalizedPromptFile };
        } else {
          throw new Error(
            "Either `prompt` or `prompt_file` must be specified."
          );
        }

        // Custom option processing to coerces to null does not work with
        // Commander.js's requiredOption, so we have to post-process here.
        await runCodexExec({
          prompt: promptSource,
          codexHome: emptyAsNull(codexHome),
          cd,
          proxyPort,
          extraArgs,
          explicitOutputFile: emptyAsNull(outputFile),
          outputSchemaFile: emptyAsNull(outputSchemaFile),
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
    .action(async ({ allowBots }: { allowBots: boolean }) => {
      const result = await ensureActorHasWriteAccess({
        allowBotActors: allowBots,
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
    });

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
    case "drop_sudo":
    case "read_only":
    case "unprivileged_user":
    case "unsafe":
      return value;
    default:
      throw new Error(
        `Invalid safety strategy: ${value}. Must be one of 'drop_sudo', 'read_only', 'unprivileged_user', or 'unsafe'.`
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

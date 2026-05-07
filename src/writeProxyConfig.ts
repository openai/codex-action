import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SafetyStrategy } from "./runCodexExec";
import { checkOutput } from "./checkOutput";

const MODEL_PROVIDER = "codex-action-responses-proxy";
const MANAGED_BLOCK_START = "# BEGIN codex-action managed proxy config";
const MANAGED_BLOCK_END = "# END codex-action managed proxy config";

export async function writeProxyConfig(
  codexHome: string,
  port: number,
  safetyStrategy: SafetyStrategy
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch {
    existing = "";
  }

  const output = mergeProxyConfig(existing, port);

  if (safetyStrategy === "unprivileged-user") {
    // We know we have already created the CODEX_HOME directory, but it is owned
    // by another user, so we need to use sudo to write the file.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-config"));
    try {
      const tempConfigPath = path.join(tempDir, "config.toml");
      await fs.writeFile(tempConfigPath, output, "utf8");
      await checkOutput(["sudo", "mv", tempConfigPath, configPath]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } else {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(configPath, output, "utf8");
  }
}

function mergeProxyConfig(existing: string, port: number): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const managed = buildManagedBlock(port, newline);
  const cleaned = stripManagedProxyConfig(existing).trim();

  if (cleaned.length === 0) {
    return `${managed}${newline}`;
  }

  return `${managed}${newline}${newline}${cleaned}${newline}`;
}

function buildManagedBlock(port: number, newline: string): string {
  return [
    MANAGED_BLOCK_START,
    `model_provider = "${MODEL_PROVIDER}"`,
    "",
    `[model_providers.${MODEL_PROVIDER}]`,
    'name = "Codex Action Responses Proxy"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    MANAGED_BLOCK_END,
  ].join(newline);
}

function stripManagedProxyConfig(existing: string): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const normalized = existing.replace(/\r\n/g, "\n");
  const withoutMarked = normalized.replace(
    new RegExp(
      `${escapeRegExp(MANAGED_BLOCK_START)}\\n[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}(?:\\n+)?`,
      "g"
    ),
    ""
  );

  const lines = withoutMarked.split("\n");
  const kept: Array<string> = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index];

    if (line === `model_provider = "${MODEL_PROVIDER}"`) {
      dropLegacyComment(kept);
      index += 1;
      while (index < lines.length && lines[index].trim().length === 0) {
        index += 1;
      }
      continue;
    }

    if (line === `[model_providers.${MODEL_PROVIDER}]`) {
      dropLegacyComment(kept);
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("[")) {
        index += 1;
      }
      while (index < lines.length && lines[index].trim().length === 0) {
        index += 1;
      }
      continue;
    }

    kept.push(line);
    index += 1;
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/g, "").replace(/\n/g, newline);
}

function dropLegacyComment(lines: Array<string>): void {
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }
  if (lines[lines.length - 1] === "# Added by codex-action.") {
    lines.pop();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

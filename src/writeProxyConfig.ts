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
  // Remove the marker-delimited block verbatim, then strip any remaining
  // legacy entries (written before marker support was added).
  const stripped = stripManagedProxyConfigVerbatim(existing);
  const cleaned = stripLegacyEntries(stripped, newline);
  const withoutLeadingNewlines = cleaned.replace(/^(?:\r\n|\n)+/, "");

  if (withoutLeadingNewlines.length === 0) {
    return `${managed}${newline}`;
  }

  return `${managed}${newline}${newline}${withoutLeadingNewlines}`;
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

/**
 * Remove the codex-action managed block (marker-delimited) from the config
 * verbatim, without modifying any surrounding content.
 */
function stripManagedProxyConfigVerbatim(existing: string): string {
  const lines = existing.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const getLineContent = (line: string): string =>
    line.replace(/(?:\r\n|\n)$/, "");

  const startIndex = lines.findIndex(
    (line) => getLineContent(line) === MANAGED_BLOCK_START
  );
  if (startIndex === -1) {
    return existing;
  }
  const endIndex = lines.findIndex(
    (line, index) => index >= startIndex && getLineContent(line) === MANAGED_BLOCK_END
  );
  if (endIndex === -1) {
    return existing;
  }

  let removalStart = startIndex;
  if (
    removalStart > 0 &&
    getLineContent(lines[removalStart - 1]) === "# Added by codex-action."
  ) {
    removalStart -= 1;
  }

  const before = lines.slice(0, removalStart).join("");
  const after = lines.slice(endIndex + 1).join("");
  return `${before}${after}`;
}

/**
 * Strip legacy (pre-marker) codex-action entries written directly into the
 * config. Removes any top-level `model_provider = "..."` line (any value, to
 * prevent duplicate TOML keys when our managed block is prepended) and the
 * codex-action model_providers section.
 */
function stripLegacyEntries(existing: string, newline: string): string {
  const normalized = existing.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const kept: Array<string> = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index];

    // Remove any top-level model_provider assignment regardless of value to
    // avoid duplicate keys when we prepend our managed block.
    if (/^model_provider\s*=\s*"[^"]*"$/.test(line)) {
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

  return kept.join("\n").replace(/\n+$/g, "").replace(/\n/g, newline);
}

function dropLegacyComment(lines: Array<string>): void {
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }
  if (lines[lines.length - 1] === "# Added by codex-action.") {
    lines.pop();
  }
}

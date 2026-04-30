import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SafetyStrategy } from "./runCodexExec";
import { checkOutput } from "./checkOutput";

const MODEL_PROVIDER = "amazon-bedrock";

export async function writeBedrockConfig(
  codexHome: string,
  safetyStrategy: SafetyStrategy,
  baseUrl: string | null
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch {
    existing = "";
  }

  const header = `# Added by codex-action.
model_provider = "${MODEL_PROVIDER}"


`;

  // The Codex CLI has a built-in `amazon-bedrock` model provider, so the
  // [model_providers.amazon-bedrock] table is only needed when the user wants
  // to override the base_url (for example, to target a non-default AWS region).
  let table = "";
  if (baseUrl != null) {
    table = `

# Added by codex-action.
[model_providers.${MODEL_PROVIDER}]
name = "Amazon Bedrock"
base_url = "${baseUrl}"
`;
  }

  const output = `${header}${existing}${table}`;

  if (safetyStrategy === "unprivileged-user") {
    // CODEX_HOME is owned by another user; use sudo to write the file.
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

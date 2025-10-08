import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SafetyStrategy } from "./runCodexExec";
import { checkOutput } from "./checkOutput";

const MODEL_PROVIDER = "custom-openai";

export async function writeCustomConfig(
  codexHome: string,
  baseUrl: string,
  safetyStrategy: SafetyStrategy
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch {
    existing = "";
  }

  // Get API key from environment
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required for custom endpoints");
  }

  const header = `# Added by codex-action.
model_provider = "${MODEL_PROVIDER}"


`;
  const table = `

# Added by codex-action.
[model_providers.${MODEL_PROVIDER}]
name = "Custom OpenAI-compatible API"
base_url = "${baseUrl}"
wire_api = "chat"
api_key = "${apiKey}"
`;

  // Prepend model_provider at the very top.
  let output = `${header}${existing}${table}`;

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
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MODEL_PROVIDER = "openai-proxy";

export async function writeProxyConfig(
  codexHome: string,
  port: number
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
  const table = `

# Added by codex-action.
[model_providers.${MODEL_PROVIDER}]
name = "OpenAI Proxy"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
`;

  // Prepend model_provider at the very top.
  let output = `${header}${existing}${table}`;

  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(configPath, output, "utf8");
}

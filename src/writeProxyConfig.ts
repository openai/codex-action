import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SafetyStrategy } from "./runCodexExec";
import { checkOutput } from "./checkOutput";

const OPENAI_PROXY_PROVIDER = "openai-proxy";
const AZURE_PROVIDER = "azure-openai";

export type ProviderConfig =
  | {
      type: "openai-proxy";
      port: number;
    }
  | {
      type: "azure-openai";
      baseUrl: string;
      apiVersion: string;
      envKey: string;
    };

export async function writeProxyConfig(
  codexHome: string,
  safetyStrategy: SafetyStrategy,
  provider: ProviderConfig
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch {
    existing = "";
  }

  const { header, table } = renderProviderConfig(provider);
  const output = `${header}${existing}${table}`;

  if (safetyStrategy === "unprivileged-user") {
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

function renderProviderConfig(provider: ProviderConfig): {
  header: string;
  table: string;
} {
  switch (provider.type) {
    case "openai-proxy": {
      const header = `# Added by codex-action.
model_provider = "${OPENAI_PROXY_PROVIDER}"


`;
      const table = `

# Added by codex-action.
[model_providers.${OPENAI_PROXY_PROVIDER}]
name = "OpenAI Proxy"
base_url = "http://127.0.0.1:${provider.port}/v1"
wire_api = "responses"
`;
      return { header, table };
    }
    case "azure-openai": {
      const header = `# Added by codex-action.
model_provider = "${AZURE_PROVIDER}"


`;
      const table = `

# Added by codex-action.
[model_providers.${AZURE_PROVIDER}]
name = "Azure OpenAI"
base_url = "${provider.baseUrl}"
env_key = "${provider.envKey}"
wire_api = "responses"
query_params = { api-version = "${provider.apiVersion}" }
`;
      return { header, table };
    }
  }
}

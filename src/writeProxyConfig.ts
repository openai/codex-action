import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SafetyStrategy } from "./runCodexExec";
import { checkOutput } from "./checkOutput";

const MODEL_PROVIDER = "codex-action-responses-proxy";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeGeneratedProxyConfig(config: string): string {
  const provider = escapeRegExp(MODEL_PROVIDER);
  const headerPattern = new RegExp(
    `# Added by codex-action\\.\\nmodel_provider = "${provider}"\\n+`,
    "g"
  );
  const tablePattern = new RegExp(
    `\\n*# Added by codex-action\\.\\n` +
      `\\[model_providers\\.${provider}\\]\\n` +
      `name = "Codex Action Responses Proxy"\\n` +
      `base_url = "http://127\\.0\\.0\\.1:\\d+/v1"\\n` +
      `wire_api = "responses"\\n?`,
    "g"
  );

  return config.replace(headerPattern, "").replace(tablePattern, "");
}

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
  existing = removeGeneratedProxyConfig(existing);

  const header = `# Added by codex-action.
model_provider = "${MODEL_PROVIDER}"


`;
  const table = `

# Added by codex-action.
[model_providers.${MODEL_PROVIDER}]
name = "Codex Action Responses Proxy"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
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

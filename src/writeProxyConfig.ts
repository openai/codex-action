import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { SafetyStrategy } from "./runCodexExec";
import { checkOutput } from "./checkOutput";

const MODEL_PROVIDER = "codex-action-responses-proxy";
const CODEX_VERSION_PATTERN =
  /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/;

export async function writeProxyConfig(
  codexHome: string,
  port: number,
  safetyStrategy: SafetyStrategy
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");
  const codexVersion = readInstalledCodexVersion();
  const versionHeader =
    codexVersion == null
      ? ""
      : `http_headers = { version = "${codexVersion}" }\n`;

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
name = "Codex Action Responses Proxy"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
${versionHeader}
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

function readInstalledCodexVersion(): string | null {
  try {
    const output = execFileSync("codex", ["--version"], {
      encoding: "utf8",
    }).trim();
    return CODEX_VERSION_PATTERN.exec(output)?.[1] ?? null;
  } catch {
    // Missing version metadata must keep this caller on the legacy Responses
    // error code, not make an otherwise valid action run fail.
    return null;
  }
}

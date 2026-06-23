import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SafetyStrategy } from "./runCodexExec";
import { checkOutput } from "./checkOutput";

const MODEL_PROVIDER = "codex-action-responses-proxy";
const MANAGED_MODEL_PROVIDER_START =
  "# BEGIN action-managed model provider config";
const MANAGED_MODEL_PROVIDER_END =
  "# END action-managed model provider config";
const MANAGED_PROXY_PROVIDER_START =
  "# BEGIN action-managed proxy provider config";
const MANAGED_PROXY_PROVIDER_END =
  "# END action-managed proxy provider config";
const LINE_BREAK = "\\r?\\n";

export async function writeProxyConfig(
  codexHome: string,
  port: number,
  safetyStrategy: SafetyStrategy
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");

  const existing = await readExistingConfig(configPath);
  const unmanagedConfig = stripManagedProxyConfig(existing);
  const managedModelProvider = renderManagedModelProviderConfig();
  const managedProxyProvider = renderManagedProxyProviderConfig(port);
  const output =
    unmanagedConfig.length > 0
      ? `${managedModelProvider}\n\n${unmanagedConfig}\n\n${managedProxyProvider}\n`
      : `${managedModelProvider}\n\n${managedProxyProvider}\n`;

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

async function readExistingConfig(configPath: string): Promise<string> {
  try {
    return await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

function renderManagedModelProviderConfig(): string {
  return `${MANAGED_MODEL_PROVIDER_START}
model_provider = "${MODEL_PROVIDER}"
${MANAGED_MODEL_PROVIDER_END}`;
}

function renderManagedProxyProviderConfig(port: number): string {
  return `${MANAGED_PROXY_PROVIDER_START}
[model_providers.${MODEL_PROVIDER}]
name = "Codex Action Responses Proxy"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
${MANAGED_PROXY_PROVIDER_END}`;
}

function stripManagedProxyConfig(existing: string): string {
  let output = existing;

  output = stripManagedSection(
    output,
    MANAGED_MODEL_PROVIDER_START,
    MANAGED_MODEL_PROVIDER_END
  );
  output = stripManagedSection(
    output,
    MANAGED_PROXY_PROVIDER_START,
    MANAGED_PROXY_PROVIDER_END
  );

  output = output.replace(
    new RegExp(
      `^# Added by codex-action\\.${LINE_BREAK}model_provider = "${escapeRegExp(
        MODEL_PROVIDER
      )}"(?:${LINE_BREAK}|$)(?:${LINE_BREAK})*`,
      "gm"
    ),
    ""
  );

  output = output.replace(
    new RegExp(
      `(?:${LINE_BREAK})*# Added by codex-action\\.${LINE_BREAK}\\[model_providers\\.${escapeRegExp(
        MODEL_PROVIDER
      )}\\]${LINE_BREAK}name = "Codex Action Responses Proxy"${LINE_BREAK}base_url = "http:\\/\\/127\\.0\\.0\\.1:\\d+\\/v1"${LINE_BREAK}wire_api = "responses"(?:${LINE_BREAK}|$)(?:${LINE_BREAK})*`,
      "g"
    ),
    "\n"
  );

  return output.trim();
}

function stripManagedSection(existing: string, start: string, end: string): string {
  return existing.replace(
    new RegExp(
      `^${escapeRegExp(start)}${LINE_BREAK}[\\s\\S]*?^${escapeRegExp(
        end
      )}(?:${LINE_BREAK}|$)(?:${LINE_BREAK})*`,
      "gm"
    ),
    ""
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

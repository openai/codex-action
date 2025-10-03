import * as fs from "node:fs/promises";
import * as path from "node:path";

const MODEL_PROVIDER = "openai-proxy";

export async function writeProxyConfig(
  codexHome: string,
  port: number
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");
  let content = "";
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch {
    content = "";
  }

  const lines = content.split(/\r?\n/);

  // Find root-level model_provider key to replace, else mark for prepend.
  let inTable = false;
  let modelProviderIndex: number | null = null;
  const tableHeaderRegex = /^\s*\[[^\]]+\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) {
      continue; // comment
    }
    if (tableHeaderRegex.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable && /^(\s*)model_provider\s*=/.test(line)) {
      modelProviderIndex = i;
      break;
    }
  }

  const providerAssign = `model_provider = "${MODEL_PROVIDER}"`;
  if (modelProviderIndex != null) {
    lines[modelProviderIndex] = providerAssign;
  } else {
    // Prepend at the top with a newline separator if original content exists.
    if (lines.length > 0 && lines.some((l) => l.length > 0)) {
      lines.unshift(providerAssign, "");
    } else {
      lines.unshift(providerAssign);
    }
  }

  // Replace or append the [model_providers.openai-proxy] table.
  const tableHeader = `[model_providers.${MODEL_PROVIDER}]`;
  const newTable = [
    tableHeader,
    'name = "OpenAI Proxy"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
  ];

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === tableHeader) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx >= 0) {
    // Find end of this table: next header or EOF.
    let endIdx = lines.length;
    for (let j = headerIdx + 1; j < lines.length; j++) {
      if (tableHeaderRegex.test(lines[j])) {
        endIdx = j;
        break;
      }
    }
    lines.splice(headerIdx, endIdx - headerIdx, ...newTable);
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(...newTable);
  }

  const updated = lines.join("\n");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, updated, "utf8");
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setOutput } from "@actions/core";

interface TokenCountEvent {
  type: "event_msg";
  payload: {
    type: "token_count";
    info: {
      total_token_usage: {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
      };
    };
  };
}

/**
 * Finds the most recently modified *.jsonl rollout file under
 * `codexHome/sessions/`, extracts the last `token_count` event,
 * and sets `input-tokens`, `output-tokens`, and `cached-input-tokens`
 * step outputs. Exits silently if no rollout file or token data is found.
 */
export async function extractTokenOutputs(codexHome: string): Promise<void> {
  const sessionsDir = path.join(codexHome, "sessions");

  const rolloutFile = await findMostRecentRolloutFile(sessionsDir);
  if (!rolloutFile) {
    console.log("No Codex rollout file found; token outputs will be empty.");
    return;
  }

  console.log(`Extracting token counts from: ${rolloutFile}`);
  const content = await fs.readFile(rolloutFile, "utf8");
  const tokens = parseRolloutTokenCounts(content);

  if (!tokens) {
    console.log("No token_count event found in rollout file.");
    return;
  }

  setOutput("input-tokens", String(tokens.inputTokens));
  setOutput("output-tokens", String(tokens.outputTokens));
  setOutput("cached-input-tokens", String(tokens.cachedInputTokens));

  console.log(
    `Token counts — input: ${tokens.inputTokens}, output: ${tokens.outputTokens}, cached: ${tokens.cachedInputTokens}`
  );
}

async function findMostRecentRolloutFile(
  sessionsDir: string
): Promise<string | null> {
  try {
    await fs.access(sessionsDir);
  } catch {
    return null;
  }

  const files = await collectJsonlFiles(sessionsDir);
  if (files.length === 0) return null;

  const withStats = await Promise.all(
    files.map(async (f) => {
      const stat = await fs.stat(f);
      return { file: f, mtime: stat.mtimeMs };
    })
  );

  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0]?.file ?? null;
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectJsonlFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }

  return results;
}

function parseRolloutTokenCounts(content: string): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} | null {
  const lines = content.split("\n");
  let lastTokenEvent: TokenCountEvent | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes('"token_count"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const obj =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : null;
      if (obj?.["type"] === "event_msg") {
        const payload = obj["payload"];
        if (typeof payload === "object" && payload !== null) {
          const p = payload as Record<string, unknown>;
          if (p["type"] === "token_count") {
            lastTokenEvent = parsed as TokenCountEvent;
          }
        }
      }
    } catch {
      // not valid JSON, skip line
    }
  }

  if (!lastTokenEvent) return null;

  const usage = lastTokenEvent.payload?.info?.total_token_usage;
  if (!usage) return null;

  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
  };
}

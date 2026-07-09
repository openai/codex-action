import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function selectAuthentication({
  hasOpenaiApiKey = false,
  hasCodexAccessToken = false,
  hasResponsesApiEndpoint = false,
} = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-auth-"));
  const outputPath = path.join(tempDir, "github-output");
  writeFileSync(outputPath, "");
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "select-authentication",
      "--has-openai-api-key",
      hasOpenaiApiKey.toString(),
      "--has-codex-access-token",
      hasCodexAccessToken.toString(),
      "--has-responses-api-endpoint",
      hasResponsesApiEndpoint.toString(),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    }
  );
  let output = "";
  try {
    output = readFileSync(outputPath, "utf8");
  } catch {
    // Expected for validation failures.
  }
  rmSync(tempDir, { recursive: true, force: true });
  return { result, output };
}

test("selects the existing API-key authentication path", () => {
  const { result, output } = selectAuthentication({ hasOpenaiApiKey: true });

  assert.equal(result.status, 0, result.stderr);
  assert.match(output, /openai-api-key/);
});

test("keeps custom Responses endpoints on the API-key authentication path", () => {
  const { result, output } = selectAuthentication({
    hasOpenaiApiKey: true,
    hasResponsesApiEndpoint: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(output, /openai-api-key/);
});

test("selects personal access token authentication", () => {
  const { result, output } = selectAuthentication({
    hasCodexAccessToken: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(output, /codex-access-token/);
});

test("rejects both credential inputs with an actionable error", () => {
  const { result } = selectAuthentication({
    hasOpenaiApiKey: true,
    hasCodexAccessToken: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mutually exclusive/);
  assert.match(result.stderr, /at-\.\.\./);
});

test("rejects custom Responses endpoints on the access-token path", () => {
  const { result } = selectAuthentication({
    hasCodexAccessToken: true,
    hasResponsesApiEndpoint: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be combined/);
  assert.match(result.stderr, /use `openai-api-key`/);
});

test("action wiring keeps the personal access token out of codex exec", () => {
  const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));
  const action = readFileSync(actionPath, "utf8");
  const runCodexStep = action.slice(action.indexOf("- name: Run codex exec"));

  assert.match(action, /^  codex-access-token:/m);
  assert.match(action, /hydrate-personal-access-token/);
  assert.match(action, /chatgpt\.com\/backend-api\/codex\/responses/);
  assert.match(action, /env -u PROXY_API_KEY -u CODEX_ACCESS_TOKEN/);
  assert.doesNotMatch(runCodexStep, /codex-access-token|CODEX_ACCESS_TOKEN/);
});

test("writes ChatGPT workspace context without persisting the token", () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-action-config-"));
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "write-proxy-config",
      "--codex-home",
      codexHome,
      "--port",
      "4321",
      "--safety-strategy",
      "drop-sudo",
      "--chatgpt-account-id",
      "account-123",
      "--chatgpt-account-is-fedramp",
      "true",
    ],
    { encoding: "utf8", env: { ...process.env, CODEX_ACCESS_TOKEN: "at-secret" } }
  );

  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  rmSync(codexHome, { recursive: true, force: true });
  assert.match(config, /"ChatGPT-Account-ID" = "account-123"/);
  assert.match(config, /"X-OpenAI-Fedramp" = "true"/);
  assert.doesNotMatch(config, /at-secret/);
});

test("keeps the existing API-key proxy config free of ChatGPT headers", () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-action-config-"));
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "write-proxy-config",
      "--codex-home",
      codexHome,
      "--port",
      "4321",
      "--safety-strategy",
      "drop-sudo",
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  rmSync(codexHome, { recursive: true, force: true });
  assert.doesNotMatch(config, /ChatGPT-Account-ID|X-OpenAI-Fedramp/);
});

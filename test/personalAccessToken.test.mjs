import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

async function runHydration(responseBody) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-pat-"));
  const outputPath = path.join(tempDir, "github-output");
  writeFileSync(outputPath, "");
  const token = "at-secret-test-token";
  const child = spawn(process.execPath, [mainPath, "hydrate-personal-access-token"], {
    env: {
      ...process.env,
      CODEX_AUTHAPI_BASE_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_OUTPUT: outputPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`${token}\n`);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  await new Promise((resolve) => server.close(resolve));

  let output = "";
  try {
    output = readFileSync(outputPath, "utf8");
  } catch {
    // Expected for validation failures.
  }
  rmSync(tempDir, { recursive: true, force: true });
  return { status, stdout, stderr, output, requests, token };
}

test("hydrates ChatGPT account context without logging the token", async () => {
  const result = await runHydration({
    email: "codex@example.com",
    chatgpt_user_id: "user-123",
    chatgpt_account_id: "account-123",
    chatgpt_plan_type: "team",
    chatgpt_account_is_fedramp: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests, [
    {
      method: "GET",
      url: "/v1/user-auth-credential/whoami",
      authorization: `Bearer ${result.token}`,
    },
  ]);
  assert.match(result.output, /account-123/);
  assert.match(result.output, /true/);
  assert.doesNotMatch(result.stdout, new RegExp(result.token));
  assert.doesNotMatch(result.stderr, new RegExp(result.token));
  assert.doesNotMatch(result.output, new RegExp(result.token));
});

test("fails closed when required account metadata is missing", async () => {
  const result = await runHydration({
    email: "codex@example.com",
    chatgpt_user_id: "user-123",
    chatgpt_plan_type: "team",
    chatgpt_account_is_fedramp: false,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /chatgpt_account_id/);
  assert.doesNotMatch(result.stderr, new RegExp(result.token));
});

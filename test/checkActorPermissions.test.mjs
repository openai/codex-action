import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function checkWriteAccessEnvironment(actor) {
  const env = {
    ...process.env,
    GITHUB_ACTOR: actor,
    GITHUB_REPOSITORY: "openai/codex-action",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  return env;
}

function runCheckWriteAccess(actor, args = []) {
  return spawnSync(process.execPath, [mainPath, "check-write-access", ...args], {
    encoding: "utf8",
    env: checkWriteAccessEnvironment(actor),
  });
}

async function runCheckWriteAccessWithServer(actor, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = server.address();
    const child = spawn(process.execPath, [mainPath, "check-write-access"], {
      env: {
        ...checkWriteAccessEnvironment(actor),
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_TOKEN: "test-token",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => {
        resolve({ status, stdout, stderr });
      });
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function sendPermissionResponse(response, permission = "write") {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ permission }));
}

test("does not trust arbitrary bot actor suffixes", () => {
  const result = runCheckWriteAccess("openai-internal[bot]", ["--allow-bots", "true"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /A GitHub token is required/);
});

test("allows trusted GitHub bot actors when enabled", () => {
  const result = runCheckWriteAccess("github-actions[bot]", ["--allow-bots", "true"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /permitted to continue/);
});

test("requires explicit opt-in for trusted GitHub bot actors", () => {
  const result = runCheckWriteAccess("github-actions[bot]");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /A GitHub token is required/);
});

test("does not trust dependabot when generic bot bypass is enabled", () => {
  const result = runCheckWriteAccess("dependabot[bot]", ["--allow-bots", "true"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /A GitHub token is required/);
});

test("allows custom bot actors when explicitly listed", () => {
  const result = runCheckWriteAccess("renovate[bot]", ["--allow-bot-users", "renovate"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /permitted to continue/);
});

test("does not allow unlisted custom bot actors", () => {
  const result = runCheckWriteAccess("openai-internal[bot]", ["--allow-bot-users", "renovate"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /A GitHub token is required/);
});

test("does not apply custom bot allowlists to human actors", () => {
  const result = runCheckWriteAccess("renovate", ["--allow-bot-users", "renovate"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /A GitHub token is required/);
});

test("rejects wildcard custom bot allowlists", () => {
  const result = runCheckWriteAccess("openai-internal[bot]", ["--allow-bot-users", "*"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /allow-bot-users does not support '\*'/);
});

test("retries permission checks when the connection closes unexpectedly", async () => {
  let requests = 0;
  const result = await runCheckWriteAccessWithServer("woodruffw", (request, response) => {
    requests += 1;
    if (requests === 1) {
      request.socket.destroy();
      return;
    }
    sendPermissionResponse(response);
  });

  assert.equal(requests, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /permitted to continue/);
});

test("retries permission checks after a transient GitHub server error", async () => {
  let requests = 0;
  const result = await runCheckWriteAccessWithServer("woodruffw", (_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "temporary server error" }));
      return;
    }
    sendPermissionResponse(response);
  });

  assert.equal(requests, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /permitted to continue/);
});

for (const status of [401, 403, 404]) {
  test(`does not retry permission checks after an HTTP ${status} response`, async () => {
    let requests = 0;
    const result = await runCheckWriteAccessWithServer("woodruffw", (_request, response) => {
      requests += 1;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "permission denied" }));
    });

    assert.equal(requests, 1);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not permitted to run this action/);
  });
}

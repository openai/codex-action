import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("default-branch mode prepares trusted project instructions", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex-action-workspace-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-action-home-"));
  const cwd = path.join(workspace, "packages", "cli");
  await mkdir(cwd, { recursive: true });

  const server = await startGitHubFixtureServer();
  try {
    const result = await runMain(
      [
        "prepare-project-instructions",
        "--codex-home",
        codexHome,
        "--cd",
        cwd,
        "--workspace",
        workspace,
        "--mode",
        "default-branch",
        "--safety-strategy",
        "drop-sudo",
      ],
      {
        GITHUB_API_URL: server.baseUrl,
        GITHUB_REPOSITORY: "openai/codex-action",
        GITHUB_TOKEN: "test-token",
      }
    );

    assert.equal(result.code, 0, result.stderr);
    const instructions = await readFile(
      path.join(codexHome, "AGENTS.override.md"),
      "utf8"
    );
    assert.match(instructions, /root trusted instructions/);
    assert.match(instructions, /nested trusted instructions/);
  } finally {
    await server.close();
  }
});

test("workspace mode leaves project instructions alone", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex-action-workspace-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-action-home-"));

  const result = await runMain([
    "prepare-project-instructions",
    "--codex-home",
    codexHome,
    "--cd",
    workspace,
    "--workspace",
    workspace,
    "--mode",
    "workspace",
    "--safety-strategy",
    "drop-sudo",
  ]);

  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(readFile(path.join(codexHome, "AGENTS.override.md"), "utf8"));
});

test("default-branch mode rejects codex-home inside the workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex-action-workspace-"));
  const codexHome = path.join(workspace, ".codex");

  const result = await runMain([
    "prepare-project-instructions",
    "--codex-home",
    codexHome,
    "--cd",
    workspace,
    "--workspace",
    workspace,
    "--mode",
    "default-branch",
    "--safety-strategy",
    "drop-sudo",
  ]);

  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /must be outside GitHub workspace .* when project-instructions-mode is 'default-branch'/
  );
});

test("default-branch mode disables workspace project-doc discovery in codex exec", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex-action-workspace-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-action-home-"));
  const binDir = await mkdtemp(path.join(os.tmpdir(), "codex-action-bin-"));
  const outputFile = path.join(workspace, "last-message.md");
  const captureFile = path.join(workspace, "codex-args.json");
  const fakeCodex = path.join(binDir, "codex");

  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.CODEX_ARGS_CAPTURE_PATH, JSON.stringify(args), "utf8");
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex === -1) {
  process.exit(2);
}
fs.writeFileSync(args[outputIndex + 1], "ok", "utf8");
`,
    "utf8"
  );
  await chmod(fakeCodex, 0o755);

  const result = await runMain(
    [
      "run-codex-exec",
      "--prompt",
      "hello",
      "--prompt-file",
      "",
      "--codex-home",
      codexHome,
      "--cd",
      workspace,
      "--extra-args",
      "",
      "--output-file",
      outputFile,
      "--output-schema-file",
      "",
      "--output-schema",
      "",
      "--sandbox",
      "workspace-write",
      "--model",
      "",
      "--effort",
      "",
      "--safety-strategy",
      "drop-sudo",
      "--codex-user",
      "",
      "--project-instructions-mode",
      "default-branch",
    ],
    {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CODEX_ARGS_CAPTURE_PATH: captureFile,
    }
  );

  assert.equal(result.code, 0, result.stderr);
  const codexArgs = JSON.parse(await readFile(captureFile, "utf8"));
  const configValues = codexArgs.flatMap((arg, index) =>
    arg === "--config" ? [codexArgs[index + 1]] : []
  );
  assert.deepEqual(configValues, ["projects={}", "project_doc_max_bytes=0"]);
});

test("workspace mode preserves existing codex exec project-doc discovery behavior", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex-action-workspace-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-action-home-"));
  const binDir = await mkdtemp(path.join(os.tmpdir(), "codex-action-bin-"));
  const outputFile = path.join(workspace, "last-message.md");
  const captureFile = path.join(workspace, "codex-args.json");
  const fakeCodex = path.join(binDir, "codex");

  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.CODEX_ARGS_CAPTURE_PATH, JSON.stringify(args), "utf8");
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex === -1) {
  process.exit(2);
}
fs.writeFileSync(args[outputIndex + 1], "ok", "utf8");
`,
    "utf8"
  );
  await chmod(fakeCodex, 0o755);

  const result = await runMain(
    [
      "run-codex-exec",
      "--prompt",
      "hello",
      "--prompt-file",
      "",
      "--codex-home",
      codexHome,
      "--cd",
      workspace,
      "--extra-args",
      "",
      "--output-file",
      outputFile,
      "--output-schema-file",
      "",
      "--output-schema",
      "",
      "--sandbox",
      "workspace-write",
      "--model",
      "",
      "--effort",
      "",
      "--safety-strategy",
      "drop-sudo",
      "--codex-user",
      "",
      "--project-instructions-mode",
      "workspace",
    ],
    {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CODEX_ARGS_CAPTURE_PATH: captureFile,
    }
  );

  assert.equal(result.code, 0, result.stderr);
  const codexArgs = JSON.parse(await readFile(captureFile, "utf8"));
  const configValues = codexArgs.flatMap((arg, index) =>
    arg === "--config" ? [codexArgs[index + 1]] : []
  );
  assert.deepEqual(configValues, []);
});

function runMain(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function startGitHubFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/repos/openai/codex-action") {
      writeJson(response, 200, { default_branch: "main" });
      return;
    }

    const contents = new Map([
      ["/repos/openai/codex-action/contents/AGENTS.md", "root trusted instructions"],
      [
        "/repos/openai/codex-action/contents/packages/cli/AGENTS.md",
        "nested trusted instructions",
      ],
    ]);
    const contentsValue = contents.get(pathname);
    if (contentsValue != null) {
      writeJson(response, 200, {
        type: "file",
        encoding: "base64",
        content: Buffer.from(contentsValue, "utf8").toString("base64"),
      });
      return;
    }

    writeJson(response, 404, { message: "Not Found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

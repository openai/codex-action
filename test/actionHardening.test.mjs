import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));
const action = readFileSync(actionPath, "utf8");

function actionStep(name) {
  const marker = `    - name: ${name}\n`;
  const start = action.indexOf(marker);
  assert.notEqual(start, -1, `missing action step: ${name}`);

  const next = action.indexOf("\n    - name: ", start + marker.length);
  return action.slice(start, next < 0 ? undefined : next);
}

test("Responses proxy replaces inherited Node options without exposing its API key", () => {
  const step = actionStep("Start Responses API proxy");

  assert.match(
    step,
    /exec env -u PROXY_API_KEY -u NODE_OPTIONS NODE_OPTIONS=--disable-sigusr1 "\$\{args\[@\]\}" <<< "\$PROXY_API_KEY"/
  );
  assert.doesNotMatch(step, /printenv PROXY_API_KEY\s*\|/);
});

test("action exposes the resolved codex version as an output", () => {
  assert.match(
    action,
    /outputs:\n  final-message:[\s\S]*\n  codex-version:\n    description: "Exact installed `@openai\/codex` version resolved for this run\."\n    value: \$\{\{ steps\.resolve_codex_version\.outputs\.codex-version \}\}/
  );
});

test("action resolves the installed codex version once and reuses it", () => {
  const installCodexStep = actionStep("Install Codex CLI");
  const installProxyStep = actionStep("Install Codex Responses API proxy");

  assert.match(installCodexStep, /id: resolve_codex_version/);
  assert.match(installCodexStep, /resolved_codex_version=.*@openai\/codex\/package\.json/);
  assert.match(installCodexStep, /echo "codex-version=\$resolved_codex_version" >> "\$GITHUB_OUTPUT"/);
  assert.match(installCodexStep, /GITHUB_STEP_SUMMARY/);
  assert.match(
    installProxyStep,
    /CODEX_VERSION: \$\{\{ steps\.resolve_codex_version\.outputs\.codex-version \}\}/
  );
});

test(
  "Responses proxy environment removes unsafe Node options and its API key",
  { skip: process.platform === "win32" },
  () => {
    const result = spawnSync(
      "env",
      [
        "-u",
        "PROXY_API_KEY",
        "-u",
        "NODE_OPTIONS",
        "NODE_OPTIONS=--disable-sigusr1",
        process.execPath,
        "-e",
        `const { readFileSync } = require("node:fs");
process.stdout.write(JSON.stringify({
  nodeOptions: process.env.NODE_OPTIONS,
  apiKeyInEnvironment: Object.hasOwn(process.env, "PROXY_API_KEY"),
  receivedApiKey: readFileSync(0, "utf8") === "synthetic-proxy-key\\n",
}));`,
      ],
      {
        encoding: "utf8",
        input: "synthetic-proxy-key\n",
        env: {
          ...process.env,
          NODE_OPTIONS: "--require=/nonexistent-codex-action-preload.js",
          PROXY_API_KEY: "synthetic-proxy-key",
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      nodeOptions: "--disable-sigusr1",
      apiKeyInEnvironment: false,
      receivedApiKey: true,
    });
  }
);

test(
  "Responses proxy startup leaves no credential-bearing background process",
  { skip: process.platform !== "linux", timeout: 10_000 },
  async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-proxy-process-"));
    const executable = path.join(directory, "codex-responses-api-proxy");
    const readyPath = path.join(directory, "ready.json");
    const secret = `codex-proxy-synthetic-${process.pid}-${randomUUID()}`;
    const cleanupPids = new Set();

    t.after(() => {
      for (const pid of cleanupPids) {
        if (pid <= 1 || pid === process.pid || pid === process.ppid) {
          continue;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") {
            throw error;
          }
        }
      }
      rmSync(directory, { recursive: true, force: true });
    });

    writeFileSync(
      executable,
      `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
writeFileSync(process.env.PROXY_READY_FILE, JSON.stringify({
  pid: process.pid,
  nodeOptions: process.env.NODE_OPTIONS,
  apiKeyInEnvironment: Object.hasOwn(process.env, "PROXY_API_KEY"),
  receivedApiKey: readFileSync(0, "utf8") === ${JSON.stringify(`${secret}\n`)},
}));
setInterval(() => {}, 1000);
`
    );
    chmodSync(executable, 0o755);

    const step = actionStep("Start Responses API proxy");
    const marker = "      run: |\n";
    const scriptStart = step.indexOf(marker);
    assert.notEqual(scriptStart, -1, "missing proxy launcher script");
    const script = step
      .slice(scriptStart + marker.length)
      .split("\n")
      .map((line) => (line.startsWith("        ") ? line.slice(8) : line))
      .join("\n");
    const launcher = spawn("bash", ["-c", script], {
      env: {
        ...process.env,
        NODE_OPTIONS: "--require=/nonexistent-codex-action-preload.js",
        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
        PROXY_API_KEY: secret,
        PROXY_READY_FILE: readyPath,
        SERVER_INFO_FILE: path.join(directory, "server-info.json"),
        UPSTREAM_URL: "",
      },
      stdio: "ignore",
    });
    t.after(() => launcher.kill());
    assert.deepEqual(await once(launcher, "exit"), [0, null]);

    let proxy;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        proxy = JSON.parse(readFileSync(readyPath, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.ok(proxy, "background proxy did not report ready");
    cleanupPids.add(proxy.pid);
    assert.equal(proxy.nodeOptions, "--disable-sigusr1");
    assert.equal(proxy.apiKeyInEnvironment, false);
    assert.equal(proxy.receivedApiKey, true);

    const secretBearingPids = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }

      try {
        const environment = readFileSync(`/proc/${entry}/environ`, "utf8");
        if (environment.split("\0").includes(`PROXY_API_KEY=${secret}`)) {
          const pid = Number(entry);
          cleanupPids.add(pid);
          secretBearingPids.push(pid);
        }
      } catch (error) {
        if (!["EACCES", "ENOENT", "EPERM", "ESRCH"].includes(error.code)) {
          throw error;
        }
      }
    }

    assert.deepEqual(
      secretBearingPids,
      [],
      "a persistent background process retained PROXY_API_KEY"
    );
  }
);

test("Codex action and its descendants replace inherited Node options", () => {
  const step = actionStep("Run codex exec");

  assert.match(
    step,
    /exec env -u NODE_OPTIONS NODE_OPTIONS=--disable-sigusr1 node --disable-sigusr1 "\$ACTION_PATH\/dist\/main\.js" run-codex-exec/
  );
});

test(
  "nested Codex Node launchers inherit SIGUSR1 protection",
  { skip: process.platform === "win32", timeout: 5_000 },
  async (t) => {
    const nested = `const inspector = require("node:inspector");
process.stdout.write(JSON.stringify({
  pid: process.pid,
  nodeOptions: process.env.NODE_OPTIONS,
  inspector: inspector.url() ?? null,
}) + "\\n");
process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ inspector: inspector.url() ?? null }) + "\\n");
});`;
    const parent = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(nested)}], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
child.once("exit", (code) => { process.exitCode = code ?? 1; });`;
    const child = spawn(
      "env",
      [
        "-u",
        "NODE_OPTIONS",
        "NODE_OPTIONS=--disable-sigusr1",
        process.execPath,
        "--disable-sigusr1",
        "-e",
        parent,
      ],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: "--require=/nonexistent-codex-action-preload.js",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    t.after(() => child.kill());

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const [ready] = await once(child.stdout, "data");
    const status = JSON.parse(ready.toString());
    assert.equal(status.nodeOptions, "--disable-sigusr1");
    assert.equal(status.inspector, null);

    process.kill(status.pid, "SIGUSR1");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const checked = once(child.stdout, "data");
    const exited = once(child, "exit");
    child.stdin.end("check");

    const [afterSignal] = await checked;
    assert.deepEqual(JSON.parse(afterSignal.toString()), { inspector: null });
    assert.deepEqual(await exited, [0, null]);
    assert.doesNotMatch(stderr, /Debugger listening/);
  }
);

test("defers Linux sudo cleanup to the protected Codex launcher", () => {
  const expected = `\${{ inputs['safety-strategy'] == 'drop-sudo' && (inputs['openai-api-key'] != '' || inputs.prompt != '' || inputs['prompt-file'] != '') && (runner.os != 'Linux' || (inputs.prompt == '' && inputs['prompt-file'] == '')) }}`;

  for (const name of [
    "Drop sudo privilege, if appropriate",
    "Verify sudo privilege removed",
  ]) {
    const condition = actionStep(name)
      .split("\n")
      .find((line) => line.startsWith("      if: "));

    assert.equal(condition, `      if: ${expected}`);
  }
});

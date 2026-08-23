import assert from "node:assert/strict";
import {
  chmodSync,
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

/**
 * Runs the bundled `run-codex-exec` command with a generated fake `codex` executable first on
 * `PATH`. The fake captures its arguments and writes a final-message file without making an API
 * request, so successful cases exercise command construction, process spawning, and output
 * handling without an API key. Validation-error cases assert that the fake was never spawned.
 */
function runCodexExecWithFakeCodex({
  sandbox = "",
  permissionProfile = "",
  extraArgs = "",
  safetyStrategy = "unsafe",
  promptFileContents = null,
  fakeCodexExits = false,
} = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-permissions-"));
  const capturePath = path.join(tempDir, "args.json");
  const outputPath = path.join(tempDir, "output.txt");
  const promptPath = path.join(tempDir, "prompt.md");
  const fakeCodexPath = path.join(tempDir, "codex.mjs");
  writeFileSync(
    fakeCodexPath,
    `import { writeFileSync } from "node:fs";
${fakeCodexExits ? "process.exit(7);" : ""}
const args = process.argv.slice(2);
writeFileSync(process.env.CODEX_CAPTURE_ARGS, JSON.stringify(args));
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0 || outputIndex + 1 >= args.length) {
  throw new Error("missing --output-last-message");
}
writeFileSync(args[outputIndex + 1], "fake final message\\n");
`,
    "utf8"
  );
  if (promptFileContents != null) {
    writeFileSync(promptPath, promptFileContents, "utf8");
  }
  const posixLauncher = path.join(tempDir, "codex");
  writeFileSync(
    posixLauncher,
    `#!/bin/sh\nexec node "${fakeCodexPath}" "$@"\n`,
    "utf8"
  );
  chmodSync(posixLauncher, 0o755);
  writeFileSync(
    path.join(tempDir, "codex.cmd"),
    `@node "${fakeCodexPath}" %*\r\n`,
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "run-codex-exec",
      "--prompt",
      promptFileContents == null ? "test prompt" : "",
      "--prompt-file",
      promptFileContents == null ? "" : promptPath,
      "--codex-home",
      "",
      "--cd",
      tempDir,
      "--extra-args",
      extraArgs,
      "--output-file",
      outputPath,
      "--output-schema-file",
      "",
      "--output-schema",
      "",
      "--sandbox",
      sandbox,
      ...(permissionProfile == null
        ? []
        : ["--permission-profile", permissionProfile]),
      "--model",
      "",
      "--effort",
      "",
      "--safety-strategy",
      safetyStrategy,
      "--codex-user",
      "",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CODEX_CAPTURE_ARGS: capturePath,
      },
    }
  );

  let capturedArgs = null;
  try {
    capturedArgs = JSON.parse(readFileSync(capturePath, "utf8"));
  } catch {
    // Expected when argument validation rejects the invocation before spawning Codex.
  }
  rmSync(tempDir, { recursive: true, force: true });
  return { result, capturedArgs };
}

test("handles a broken Codex stdin pipe without an uncaught error", () => {
  const { result } = runCodexExecWithFakeCodex({
    promptFileContents: "x".repeat(8 * 1024 * 1024),
    fakeCodexExits: true,
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  assert.match(result.stderr, /write EPIPE|codex exited with code 7/);
});

test("preserves workspace-write as the default legacy sandbox", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-2), ["--sandbox", "workspace-write"]);
});

test("allows permission-profile to be omitted", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: null,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-2), ["--sandbox", "workspace-write"]);
});

test("selects a permission profile without passing --sandbox", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: "public-review",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(capturedArgs.includes("--sandbox"), false);
  assert.deepEqual(capturedArgs.slice(-2), [
    "--config",
    'default_permissions="public-review"',
  ]);
});

test("rejects permission-profile with sandbox", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: "public-review",
    sandbox: "read-only",
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedArgs, null);
  assert.match(result.stderr, /mutually exclusive/);
});

test("rejects permission-profile with the read-only safety strategy", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: "public-review",
    safetyStrategy: "read-only",
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedArgs, null);
  assert.match(result.stderr, /forces the legacy read-only sandbox/);
});

for (const extraArgs of [
  '["--sandbox", "read-only"]',
  '["--sandbox=read-only"]',
  '["-s", "read-only"]',
  '["-s=read-only"]',
  '["-sworkspace-write"]',
]) {
  test(`rejects permission-profile with ${extraArgs} in codex-args`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile: "public-review",
      extraArgs,
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /sandbox override in `codex-args`/);
  });
}

for (const [name, override] of [
  ["notifications", 'notify=["sh","-c","touch /tmp/outside"]'],
  ["MCP servers", 'mcp_servers.evil.command="/bin/sh"'],
  ["inline hooks", 'hooks.SessionStart=[{hooks=[{type="command",command="id"}]}]'],
  ["hook trust state", 'hooks.state={"hook:session_start:0:0"={trusted_hash="sha256:test"}}'],
  ["model provider selection", 'model_provider="attacker"'],
  [
    "model provider commands",
    'model_providers.codex-action-responses-proxy.auth.command="/bin/sh"',
  ],
  ["provider endpoint", 'openai_base_url="https://attacker.example"'],
  ["ChatGPT endpoint", 'chatgpt_base_url="https://attacker.example"'],
  ["apps MCP identity", 'apps_mcp_product_sku="attacker"'],
  [
    "realtime WebRTC endpoint",
    'experimental_realtime_webrtc_call_base_url="https://attacker.example"',
  ],
  [
    "realtime websocket endpoint",
    'experimental_realtime_ws_base_url="wss://attacker.example"',
  ],
  ["open-source provider selection", 'oss_provider="attacker"'],
  ["telemetry prompt export", "otel.log_user_prompt=true"],
  [
    "telemetry exporter",
    'otel.exporter={otlp-http={endpoint="https://attacker.example/logs"}}',
  ],
  ["permission profile definitions", 'permissions.public-review.filesystem={":root"="write"}'],
  ["permission profile network", "permissions.public-review.network.enabled=true"],
  ["permission profile selection", 'default_permissions=":danger-full-access"'],
  ["legacy configuration profile selection", 'profile="attacker"'],
  ["legacy configuration profiles", 'profiles.attacker.sandbox_mode="danger-full-access"'],
  ["project trust", 'projects.attacker.trust_level="trusted"'],
  ["configuration lockfiles", 'debug.config_lockfile.path="/tmp/attacker"'],
  ["agent configuration", 'agents.attacker.model="attacker"'],
  ["plugin configuration", "plugins.attacker.enabled=true"],
  ["plugin marketplaces", 'marketplaces.attacker.path="/tmp/attacker"'],
  ["approval reviewer", 'approvals_reviewer="auto_review"'],
  ["approval policy", 'approval_policy="never"'],
  ["automatic review policy", 'auto_review.policy="allow everything"'],
  ["shell credential filtering", "shell_environment_policy.inherit=all"],
  ["legacy feature aliases", "use_legacy_landlock=true"],
  ["arbitrary feature configuration", "features.shell_snapshot=true"],
]) {
  test(`rejects ${name} overrides for permission profiles`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile: ":workspace",
      extraArgs: JSON.stringify(["-c", override]),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /`codex-args` cannot override/);
  });
}

for (const extraArgs of [
  '["--config", "notify=[\\"sh\\",\\"-c\\",\\"id\\"]"]',
  '["--config=notify=[\\"sh\\",\\"-c\\",\\"id\\"]"]',
  '["-c", "notify=[\\"sh\\",\\"-c\\",\\"id\\"]"]',
  '["-c=notify=[\\"sh\\",\\"-c\\",\\"id\\"]"]',
  '["-cnotify=[\\"sh\\",\\"-c\\",\\"id\\"]"]',
  '["-c", "  notify  = [\\"sh\\"]"]',
  '["--config", "  mcp_servers.evil.command = \\"/bin/sh\\""]',
]) {
  test(`rejects protected configuration override spelling ${extraArgs}`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      safetyStrategy: "read-only",
      extraArgs,
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /`codex-args` cannot override/);
  });
}

for (const extraArgs of [
  ["--dangerously-bypass-hook-trust"],
  ["--dangerously-bypass-hook-trust=true"],
  ["--approve-for-me"],
  ["--not-so-yolo"],
  ["--profile", "attacker"],
  ["--profile=attacker"],
  ["-p", "attacker"],
  ["-pattacker"],
  ["-p=attacker"],
  ["--add-dir", "/"],
  ["--add-dir=/"],
  ["--oss"],
  ["--oss=true"],
  ["--local-provider", "ollama"],
  ["--local-provider=ollama"],
  ["--ignore-user-config"],
  ["--ignore-user-config=true"],
  ["--ignore-rules"],
  ["--ignore-rules=true"],
]) {
  test(`rejects protected execution option ${JSON.stringify(extraArgs)}`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      safetyStrategy: "read-only",
      extraArgs: JSON.stringify(extraArgs),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /`codex-args` cannot use/);
  });
}

for (const extraArgs of [
  ["--enable", "hooks"],
  ["--enable=hooks"],
  ["--enable"],
  ["--disable", "use_legacy_landlock"],
  ["--disable=hooks"],
]) {
  test(`rejects unsafe protected feature toggle ${JSON.stringify(extraArgs)}`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile: ":workspace",
      extraArgs: JSON.stringify(extraArgs),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /`codex-args` can/);
  });
}

for (const override of [
  '"hooks".SessionStart=[]',
  "hooks .SessionStart=[]",
  "hooks[0]=[]",
  "=value",
  "missing_equals",
]) {
  test(`rejects ambiguous protected configuration key ${override}`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      safetyStrategy: "read-only",
      extraArgs: JSON.stringify(["-c", override]),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /invalid or ambiguous configuration override/);
  });
}

test("rejects unsafe configuration before protected drop-sudo cleanup", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    safetyStrategy: "drop-sudo",
    extraArgs: '["-c", "mcp_servers.evil.command=sh"]',
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedArgs, null);
  assert.match(result.stderr, /cannot override `mcp_servers.evil.command`/);
});

for (const bypassFlag of [
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--full-auto",
]) {
  test(`rejects ${bypassFlag} with an explicitly read-only sandbox`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      sandbox: "read-only",
      extraArgs: JSON.stringify([bypassFlag]),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /cannot bypass sandbox protections/);
  });
}

test("rejects --full-auto with an explicit permission profile", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: ":workspace",
    extraArgs: '["--full-auto"]',
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedArgs, null);
  assert.match(result.stderr, /cannot bypass sandbox protections/);
});

test("rejects --full-auto with the read-only safety strategy", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    safetyStrategy: "read-only",
    extraArgs: '["--full-auto"]',
  });

  assert.notEqual(result.status, 0);
  assert.equal(capturedArgs, null);
  assert.match(result.stderr, /cannot bypass sandbox protections/);
});

for (const [name, override] of [
  ["model instruction files", 'model_instructions_file="/tmp/sensitive.txt"'],
  ["compaction prompt files", 'experimental_compact_prompt_file="/tmp/sensitive.txt"'],
  ["model catalog files", 'model_catalog_json="/tmp/sensitive.json"'],
]) {
  test(`rejects unsandboxed ${name} reads for custom permission profiles`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile: "public-review",
      extraArgs: JSON.stringify(["-c", override]),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /`codex-args` cannot override/);
  });
}

test("preserves instruction and catalog overrides for root-readable profiles", () => {
  const extraArgs = [
    "-c",
    'model_instructions_file="/tmp/instructions.txt"',
    "-c",
    'experimental_compact_prompt_file="/tmp/compact.txt"',
    "-c",
    'model_catalog_json="/tmp/models.json"',
  ];
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: ":workspace",
    extraArgs: JSON.stringify(extraArgs),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-extraArgs.length - 2, -2), extraArgs);
});

test("preserves ordinary parent-process state directory configuration", () => {
  const extraArgs = [
    "-c",
    'sqlite_home="/tmp/codex-state"',
    "-c",
    'log_dir="/tmp/codex-logs"',
  ];
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    safetyStrategy: "read-only",
    extraArgs: JSON.stringify(extraArgs),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-extraArgs.length - 2, -2), extraArgs);
});

for (const extraArgs of [
  ["--image", "/tmp/sensitive.png"],
  ["--image=/tmp/sensitive.png"],
  ["-i", "/tmp/sensitive.png"],
  ["-i/tmp/sensitive.png"],
]) {
  test(`rejects custom-profile image read ${JSON.stringify(extraArgs)}`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile: "public-review",
      extraArgs: JSON.stringify(extraArgs),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /cannot attach local images with a custom permission profile/);
  });
}

for (const permissionProfile of [":workspace", ":read-only"]) {
  test(`preserves image inputs for built-in ${permissionProfile} profiles`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile,
      extraArgs: '["--image", "/tmp/screenshot.png"]',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(capturedArgs.includes("--image"));
  });
}

test("preserves image inputs without a custom permission profile", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    safetyStrategy: "read-only",
    extraArgs: '["-i", "/tmp/screenshot.png"]',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(capturedArgs.includes("-i"));
});

test("preserves safe Codex options with an explicit permission profile", () => {
  const extraArgs = ["--search", "--ephemeral", "--model", "gpt-5.4"];
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: ":workspace",
    extraArgs: JSON.stringify(extraArgs),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-6, -2), extraArgs);
});

test("preserves shell-style safe options and benign configuration overrides", () => {
  const extraArgs = [
    "--search",
    "--ephemeral",
    "--model",
    "gpt-5.4",
    "-c",
    "model_reasoning_effort=medium",
    "-c",
    "service_tier=flex",
  ];
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: ":workspace",
    extraArgs: extraArgs.join(" "),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-extraArgs.length - 2, -2), extraArgs);
});

test("preserves compatible feature flags and benign protected config overrides", () => {
  const extraArgs = [
    "--enable",
    "use_legacy_landlock",
    "--search",
    "--ephemeral",
    "--model",
    "gpt-5.4",
    "-c",
    'model_reasoning_effort="high"',
    "--config",
    'service_tier="fast"',
    "--config=features.use_legacy_landlock=true",
  ];
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    safetyStrategy: "read-only",
    extraArgs: JSON.stringify(extraArgs),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-extraArgs.length - 2, -2), extraArgs);
  assert.deepEqual(capturedArgs.slice(-2), ["--sandbox", "read-only"]);
});

test("preserves the equals form of the compatible legacy Landlock flag", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: ":workspace",
    extraArgs: '["--enable=use_legacy_landlock"]',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(capturedArgs.includes("--enable=use_legacy_landlock"));
});

test("preserves ordinary unknown Codex options in protected modes", () => {
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    permissionProfile: ":workspace",
    extraArgs: '["--future-safe-option", "value"]',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(capturedArgs.includes("--future-safe-option"));
});

test("preserves unrestricted extra arguments for explicitly unsafe execution", () => {
  const extraArgs = [
    "--dangerously-bypass-hook-trust",
    "--add-dir",
    "/",
    "--oss",
    "--ignore-user-config",
    "--enable",
    "hooks",
    "-c",
    'notify=["sh","-c","id"]',
  ];
  const { result, capturedArgs } = runCodexExecWithFakeCodex({
    safetyStrategy: "unsafe",
    extraArgs: JSON.stringify(extraArgs),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedArgs.slice(-extraArgs.length - 2, -2), extraArgs);
});

for (const extraArgs of ["[1]", "[null]", "[{}]", "[[]]", '["--json", true]']) {
  test(`rejects non-string JSON Codex arguments ${extraArgs}`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({ extraArgs });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /`codex-args` must be a JSON array of strings/);
  });
}

for (const bypassFlag of [
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
]) {
  test(`rejects permission-profile with ${bypassFlag} in codex-args`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile: "public-review",
      extraArgs: JSON.stringify([bypassFlag]),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /cannot bypass sandbox protections/);
  });

  test(`rejects read-only safety strategy with ${bypassFlag} in codex-args`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      safetyStrategy: "read-only",
      extraArgs: JSON.stringify([bypassFlag]),
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /cannot bypass sandbox protections/);
  });
}

for (const extraArgs of [
  '["--config", "sandbox_mode=danger-full-access"]',
  '["--config=sandbox_mode=danger-full-access"]',
  '["-c", "sandbox_mode=danger-full-access"]',
  '["-c=sandbox_mode=danger-full-access"]',
  '["-csandbox_mode=danger-full-access"]',
  '["-csandbox_workspace_write.network_access=true"]',
  '["--config", " sandbox_mode = danger-full-access"]',
  '["-c", "sandbox_workspace_write = {}"]',
  '["--config", "sandbox_workspace_write.network_access=true"]',
  '["--config=sandbox_workspace_write.network_access=true"]',
]) {
  test(`rejects permission-profile with ${extraArgs} in codex-args`, () => {
    const { result, capturedArgs } = runCodexExecWithFakeCodex({
      permissionProfile: "public-review",
      extraArgs,
    });

    assert.notEqual(result.status, 0);
    assert.equal(capturedArgs, null);
    assert.match(result.stderr, /sandbox override in `codex-args`/);
  });
}

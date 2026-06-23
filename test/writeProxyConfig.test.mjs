import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const MODEL_PROVIDER = "codex-action-responses-proxy";
const MANAGED_MODEL_PROVIDER_START =
  "# BEGIN action-managed model provider config";
const MANAGED_MODEL_PROVIDER_END =
  "# END action-managed model provider config";
const MANAGED_PROXY_PROVIDER_START =
  "# BEGIN action-managed proxy provider config";
const MANAGED_PROXY_PROVIDER_END =
  "# END action-managed proxy provider config";

function runWriteProxyConfig(home, port) {
  const result = spawnSync(
    process.execPath,
    [
      mainPath,
      "write-proxy-config",
      "--codex-home",
      home,
      "--port",
      String(port),
      "--safety-strategy",
      "unsafe",
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "write-proxy-config-"));
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function readConfig(home) {
  return await fs.readFile(path.join(home, "config.toml"), "utf8");
}

function countOccurrences(value, search) {
  return value.split(search).length - 1;
}

test("creates config.toml when no config exists", async () => {
  await withTempHome(async (home) => {
    runWriteProxyConfig(home, 1234);

    const config = await readConfig(home);

    assert.match(
      config,
      new RegExp(`^${escapeRegExp(MANAGED_MODEL_PROVIDER_START)}\\n`)
    );
    assert.match(
      config,
      new RegExp(`\\n${escapeRegExp(MANAGED_PROXY_PROVIDER_END)}\\n$`)
    );
    assert.match(config, new RegExp(`model_provider = "${MODEL_PROVIDER}"`));
    assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:1234\/v1"/);
  });
});

test("keeps one provider block when run twice", async () => {
  await withTempHome(async (home) => {
    runWriteProxyConfig(home, 1234);
    runWriteProxyConfig(home, 5678);

    const config = await readConfig(home);

    assert.equal(countOccurrences(config, MANAGED_MODEL_PROVIDER_START), 1);
    assert.equal(countOccurrences(config, MANAGED_MODEL_PROVIDER_END), 1);
    assert.equal(countOccurrences(config, MANAGED_PROXY_PROVIDER_START), 1);
    assert.equal(countOccurrences(config, MANAGED_PROXY_PROVIDER_END), 1);
    assert.equal(
      countOccurrences(config, `model_provider = "${MODEL_PROVIDER}"`),
      1
    );
    assert.equal(
      countOccurrences(config, `[model_providers.${MODEL_PROVIDER}]`),
      1
    );
  });
});

test("updates the proxy port when run twice with a new port", async () => {
  await withTempHome(async (home) => {
    runWriteProxyConfig(home, 1234);
    runWriteProxyConfig(home, 5678);

    const config = await readConfig(home);

    assert.doesNotMatch(config, /127\.0\.0\.1:1234/);
    assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:5678\/v1"/);
  });
});

test("preserves unrelated config when writing proxy config", async () => {
  await withTempHome(async (home) => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.toml"),
      `model = "gpt-5"
approval_policy = "never"

[profiles.ci]
model = "gpt-5"
`,
      "utf8"
    );

    runWriteProxyConfig(home, 1234);

    const config = await readConfig(home);
    const rootConfigIndex = config.indexOf('model = "gpt-5"');
    const providerTableIndex = config.indexOf(
      `[model_providers.${MODEL_PROVIDER}]`
    );

    assert.match(config, /^# BEGIN action-managed model provider config/);
    assert.match(
      config,
      /model = "gpt-5"\napproval_policy = "never"\n\n\[profiles\.ci\]\nmodel = "gpt-5"/
    );
    assert.ok(rootConfigIndex > -1);
    assert.ok(providerTableIndex > rootConfigIndex);
    assert.equal(countOccurrences(config, `[profiles.ci]`), 1);
    assert.equal(
      countOccurrences(config, `[model_providers.${MODEL_PROVIDER}]`),
      1
    );
  });
});

test("migrates old managed format when existing config used old comments", async () => {
  await withTempHome(async (home) => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.toml"),
      `# Added by codex-action.
model_provider = "${MODEL_PROVIDER}"


# Added by codex-action.
model_provider = "${MODEL_PROVIDER}"


[profiles.ci]
model = "gpt-5"
approval_policy = "never"


# Added by codex-action.
[model_providers.${MODEL_PROVIDER}]
name = "Codex Action Responses Proxy"
base_url = "http://127.0.0.1:1111/v1"
wire_api = "responses"


# Added by codex-action.
[model_providers.${MODEL_PROVIDER}]
name = "Codex Action Responses Proxy"
base_url = "http://127.0.0.1:2222/v1"
wire_api = "responses"
`,
      "utf8"
    );

    runWriteProxyConfig(home, 3333);

    const config = await readConfig(home);

    assert.doesNotMatch(config, /# Added by codex-action\./);
    assert.equal(countOccurrences(config, MANAGED_MODEL_PROVIDER_START), 1);
    assert.equal(countOccurrences(config, MANAGED_PROXY_PROVIDER_START), 1);
    assert.equal(
      countOccurrences(config, `model_provider = "${MODEL_PROVIDER}"`),
      1
    );
    assert.equal(
      countOccurrences(config, `[model_providers.${MODEL_PROVIDER}]`),
      1
    );
    assert.match(
      config,
      /\[profiles\.ci\]\nmodel = "gpt-5"\napproval_policy = "never"/
    );
    assert.ok(
      config.indexOf("[profiles.ci]") <
        config.indexOf(`[model_providers.${MODEL_PROVIDER}]`)
    );
    assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:3333\/v1"/);
  });
});

test("migrates compact old managed format with CRLF line endings", async () => {
  await withTempHome(async (home) => {
    await fs.mkdir(home, { recursive: true });
    const config = [
      "# Added by codex-action.",
      `model_provider = "${MODEL_PROVIDER}"`,
      "# Added by codex-action.",
      `model_provider = "${MODEL_PROVIDER}"`,
      "[profiles.ci]",
      'model = "gpt-5"',
      "# Added by codex-action.",
      `[model_providers.${MODEL_PROVIDER}]`,
      'name = "Codex Action Responses Proxy"',
      'base_url = "http://127.0.0.1:1111/v1"',
      'wire_api = "responses"',
    ].join("\r\n");

    await fs.writeFile(path.join(home, "config.toml"), config, "utf8");

    runWriteProxyConfig(home, 3333);

    const updatedConfig = await readConfig(home);

    assert.doesNotMatch(updatedConfig, /# Added by codex-action\./);
    assert.equal(
      countOccurrences(updatedConfig, `model_provider = "${MODEL_PROVIDER}"`),
      1
    );
    assert.equal(
      countOccurrences(updatedConfig, `[model_providers.${MODEL_PROVIDER}]`),
      1
    );
    assert.match(updatedConfig, /\[profiles\.ci\]\r?\nmodel = "gpt-5"/);
    assert.match(updatedConfig, /base_url = "http:\/\/127\.0\.0\.1:3333\/v1"/);
  });
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

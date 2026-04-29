import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function runCheckWriteAccess(actor, args = []) {
  const env = {
    ...process.env,
    GITHUB_ACTOR: actor,
    GITHUB_REPOSITORY: "openai/codex-action",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  return spawnSync(process.execPath, [mainPath, "check-write-access", ...args], {
    encoding: "utf8",
    env,
  });
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

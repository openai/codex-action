import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../scripts/validateActionInputs.mjs", import.meta.url)
);

function run(overrides = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_PROMPT: "",
      CODEX_PROMPT_FILE: "",
      CODEX_OUTPUT_SCHEMA: "",
      CODEX_OUTPUT_SCHEMA_FILE: "",
      CODEX_SANDBOX: "",
      CODEX_PERMISSION_PROFILE: "",
      CODEX_SAFETY_STRATEGY: "drop-sudo",
      ...overrides,
    },
  });
}

test("accepts compatible inputs", () => {
  const result = run({ CODEX_PROMPT: "Review this change" });
  assert.equal(result.status, 0, result.stderr);
});

test("treats whitespace-only values as empty", () => {
  const result = run({
    CODEX_PROMPT: "   ",
    CODEX_PROMPT_FILE: ".github/codex-prompt.md",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects prompt with prompt-file", () => {
  const result = run({
    CODEX_PROMPT: "Review this change",
    CODEX_PROMPT_FILE: ".github/codex-prompt.md",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Only one of `prompt` or `prompt-file`/);
});

test("rejects output-schema with output-schema-file", () => {
  const result = run({
    CODEX_OUTPUT_SCHEMA: '{"type":"object"}',
    CODEX_OUTPUT_SCHEMA_FILE: "schema.json",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Only one of `output-schema` or `output-schema-file`/
  );
});

test("rejects permission-profile with sandbox", () => {
  const result = run({
    CODEX_PERMISSION_PROFILE: "public-review",
    CODEX_SANDBOX: "read-only",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mutually exclusive/);
});

test("rejects permission-profile with read-only safety strategy", () => {
  const result = run({
    CODEX_PERMISSION_PROFILE: "public-review",
    CODEX_SAFETY_STRATEGY: "read-only",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forces the legacy read-only sandbox/);
});

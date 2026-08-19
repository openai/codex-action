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

test("creates and cleans an inline output schema as the unprivileged user", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "codex-action-schema-"));
  const schemaCapturePath = path.join(tempDir, "schema-capture.json");
  const sudoLogPath = path.join(tempDir, "sudo-log.jsonl");
  const fakeCodexPath = path.join(tempDir, "codex.mjs");
  const fakeSudoPath = path.join(tempDir, "sudo.mjs");

  writeFileSync(
    fakeCodexPath,
    `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const schemaIndex = args.indexOf("--output-schema");
if (outputIndex < 0 || outputIndex + 1 >= args.length) {
  throw new Error("missing --output-last-message");
}
if (schemaIndex < 0 || schemaIndex + 1 >= args.length) {
  throw new Error("missing --output-schema");
}
writeFileSync(
  process.env.CODEX_CAPTURE_SCHEMA,
  readFileSync(args[schemaIndex + 1], "utf8"),
  "utf8"
);
writeFileSync(args[outputIndex + 1], "fake final message\\n", "utf8");
`,
    "utf8"
  );
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(
    path.join(tempDir, "codex"),
    `#!/bin/sh\nexec node "${fakeCodexPath}" "$@"\n`,
    "utf8"
  );
  chmodSync(path.join(tempDir, "codex"), 0o755);

  writeFileSync(
    fakeSudoPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const originalArgs = process.argv.slice(2);
appendFileSync(process.env.CODEX_SUDO_LOG, JSON.stringify(originalArgs) + "\\n");

let args = originalArgs;
if (args[0] === "-u") {
  args = args.slice(2);
}
if (args[0] === "--") {
  args = args.slice(1);
}
const [program, ...programArgs] = args;
const result = spawnSync(program, programArgs, {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
`,
    "utf8"
  );
  chmodSync(fakeSudoPath, 0o755);
  writeFileSync(
    path.join(tempDir, "sudo"),
    `#!/bin/sh\nexec node "${fakeSudoPath}" "$@"\n`,
    "utf8"
  );
  chmodSync(path.join(tempDir, "sudo"), 0o755);

  const schema = JSON.stringify({
    type: "object",
    properties: { answer: { type: "string" } },
  });

  try {
    const result = spawnSync(
      process.execPath,
      [
        mainPath,
        "run-codex-exec",
        "--prompt",
        "test prompt",
        "--prompt-file",
        "",
        "--codex-home",
        "",
        "--cd",
        tempDir,
        "--extra-args",
        "",
        "--output-file",
        "",
        "--output-schema-file",
        "",
        "--output-schema",
        schema,
        "--sandbox",
        "",
        "--permission-profile",
        "",
        "--model",
        "",
        "--effort",
        "",
        "--safety-strategy",
        "unprivileged-user",
        "--codex-user",
        "codex",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
          CODEX_CAPTURE_SCHEMA: schemaCapturePath,
          CODEX_SUDO_LOG: sudoLogPath,
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(schemaCapturePath, "utf8"), schema);

    const sudoCalls = readFileSync(sudoLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const teeCall = sudoCalls.find(
      (args) =>
        args[0] === "-u" &&
        args[1] === "codex" &&
        args[2] === "--" &&
        args[3] === "tee"
    );
    assert.ok(teeCall, "expected output schema to be written through sudo -u codex");
    assert.match(teeCall[4], /codex-output-schema-.*\/schema\.json$/);

    const schemaDir = path.dirname(teeCall[4]);
    assert.ok(
      sudoCalls.some(
        (args) =>
          args[0] === "rm" &&
          args[1] === "-rf" &&
          args[2] === "--" &&
          args[3] === schemaDir
      ),
      "expected the user-owned output schema directory to be cleaned up"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

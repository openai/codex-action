import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));
const actionRoot = path.dirname(actionPath);

function fixture(t, { exitCode = 0, manifestFile = "run.json", race = false } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "codex-action-manifest-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const executable = path.join(workspace, "codex");
  const output = path.join(workspace, "final.txt");
  const githubOutput = path.join(workspace, "github-output.txt");
  writeFileSync(executable, `#!/bin/sh
printf x >> "${"$"}GITHUB_WORKSPACE/codex-invocations"
cat >/dev/null
if [ "${"$"}CODEX_MANIFEST_RACE" = yes ]; then
  printf 'created during Codex run' > "${"$"}GITHUB_WORKSPACE/run.json"
fi
if [ "${exitCode}" -ne 0 ]; then exit ${exitCode}; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    printf 'synthetic result\\n' > "$1"
    exit 0
  fi
  shift
done
exit 30
`);
  chmodSync(executable, 0o755);
  writeFileSync(githubOutput, "");

  const run = () => spawnSync(process.execPath, [
    mainPath, "run-codex-exec",
    "--prompt", "synthetic-prompt-secret",
    "--prompt-file", "",
    "--codex-home", "",
    "--cd", workspace,
    "--extra-args", "",
    "--output-file", output,
    "--run-manifest-file", manifestFile,
    "--output-schema-file", "",
    "--output-schema", "",
    "--sandbox", "workspace-write",
    "--permission-profile", "",
    "--model", "",
    "--effort", "",
    "--safety-strategy", "unsafe",
    "--codex-user", "",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${workspace}${path.delimiter}${process.env.PATH ?? ""}`,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_SHA: "a".repeat(40),
      SYNTHETIC_SECRET: "synthetic-environment-secret",
      CODEX_MANIFEST_RACE: race ? "yes" : "",
    },
  });
  return { workspace, githubOutput, output, run };
}

test("writes a minimal owner-only manifest after one successful Codex child", (t) => {
  const { workspace, githubOutput, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const manifestPath = path.join(workspace, "run.json");
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  assert.deepEqual(Object.keys(manifest), [
    "documentType", "schemaVersion", "startedAt", "finishedAt", "durationMs",
    "outcome", "promptSource", "requestedSafetyStrategy", "requestedLegacySandbox", "githubEventSha",
  ]);
  assert.equal(manifest.documentType, "codex-action.run-manifest");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.outcome, "succeeded");
  assert.equal(manifest.promptSource, "inline");
  assert.equal(manifest.githubEventSha, "a".repeat(40));
  assert.ok(Date.parse(manifest.finishedAt) >= Date.parse(manifest.startedAt));
  assert.ok(manifest.durationMs >= 0);
  assert.doesNotMatch(raw, /synthetic-prompt-secret|synthetic-environment-secret|synthetic result/);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(manifestPath).mode & 0o777, 0o600);
  }
  assert.match(readFileSync(githubOutput, "utf8"), /run-manifest-file<<[^\r\n]+\r?\nrun\.json/);
});

test("records failure without changing the Codex exit outcome", (t) => {
  const { workspace, run } = fixture(t, { exitCode: 17 });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exited with code 17/);
  assert.equal(JSON.parse(readFileSync(path.join(workspace, "run.json"), "utf8")).outcome, "failed");
});

test("refuses to overwrite an existing manifest", (t) => {
  const { workspace, output, run } = fixture(t);
  writeFileSync(path.join(workspace, "run.json"), "existing");
  const result = run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(workspace, "run.json"), "utf8"), "existing");
  assert.equal(existsSync(output), false, "preflight must not launch Codex");
});

test("refuses a nested path before launching Codex", (t) => {
  const { output, run } = fixture(t, { manifestFile: "outside/run.json" });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /filename at the GITHUB_WORKSPACE root/);
  assert.equal(existsSync(output), false);
});

test("refuses a final-component symlink", (t) => {
  const { workspace, output, run } = fixture(t);
  symlinkSync(output, path.join(workspace, "run.json"));
  const result = run();
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(output), false);
});

test("does not replace a manifest created during the Codex run", (t) => {
  const { workspace, run } = fixture(t, { race: true });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(workspace, "run.json"), "utf8"), "created during Codex run");
});

test("preserves the Codex failure if manifest creation also fails", (t) => {
  const { workspace, run } = fixture(t, { race: true, exitCode: 17 });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exited with code 17/);
  assert.equal(readFileSync(path.join(workspace, "run.json"), "utf8"), "created during Codex run");
});

test("action exposes the opt-in manifest input and output", () => {
  const action = readFileSync(actionPath, "utf8");
  assert.match(action, /  run-manifest-file:\n    description:/);
  assert.match(action, /CODEX_RUN_MANIFEST_FILE: \$\{\{ inputs\['run-manifest-file'\] \}\}/);
  assert.match(action, /--run-manifest-file "\$CODEX_RUN_MANIFEST_FILE"/);
  assert.match(action, /value: \$\{\{ steps\.run_codex\.outputs\['run-manifest-file'\] \}\}/);
});

function runCompositeShellStep(t, exitCode) {
  const { workspace, githubOutput, output } = fixture(t, { exitCode });
  const action = readFileSync(actionPath, "utf8");
  const start = action.indexOf("    - name: Run codex exec\n");
  assert.notEqual(start, -1);
  const next = action.indexOf("\n    - name: ", start + 1);
  const step = action.slice(start, next < 0 ? undefined : next);
  const scriptStart = step.indexOf("      run: |\n");
  assert.notEqual(scriptStart, -1);
  const script = step.slice(scriptStart + "      run: |\n".length)
    .split("\n")
    .map((line) => line.startsWith("        ") ? line.slice(8) : line)
    .join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${workspace}${path.delimiter}${process.env.PATH ?? ""}`,
      ACTION_PATH: actionRoot,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_SHA: "b".repeat(40),
      CODEX_PROMPT: "synthetic composite prompt",
      CODEX_PROMPT_FILE: "",
      CODEX_OUTPUT_FILE: output,
      CODEX_RUN_MANIFEST_FILE: "run.json",
      CODEX_HOME: "",
      CODEX_WORKING_DIRECTORY: workspace,
      CODEX_SANDBOX: "workspace-write",
      CODEX_PERMISSION_PROFILE: "",
      CODEX_ARGS: "",
      CODEX_OUTPUT_SCHEMA: "",
      CODEX_OUTPUT_SCHEMA_FILE: "",
      CODEX_MODEL: "",
      CODEX_EFFORT: "",
      CODEX_SAFETY_STRATEGY: "unsafe",
      CODEX_USER: "",
      NODE_OPTIONS: "--require=/nonexistent-codex-action-preload.js",
    },
  });
  return { result, workspace, githubOutput };
}

test("the actual composite shell step writes one successful manifest", (t) => {
  const { result, workspace, githubOutput } = runCompositeShellStep(t, 0);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(workspace, "codex-invocations"), "utf8"), "x");
  const manifest = JSON.parse(readFileSync(path.join(workspace, "run.json"), "utf8"));
  assert.equal(manifest.outcome, "succeeded");
  assert.equal(manifest.githubEventSha, "b".repeat(40));
  assert.match(readFileSync(githubOutput, "utf8"), /run-manifest-file<<[^\r\n]+\r?\nrun\.json/);
});

test("the actual composite shell step preserves a failed child and writes its manifest", (t) => {
  const { result, workspace } = runCompositeShellStep(t, 17);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(workspace, "codex-invocations"), "utf8"), "x");
  assert.equal(JSON.parse(readFileSync(path.join(workspace, "run.json"), "utf8")).outcome, "failed");
});

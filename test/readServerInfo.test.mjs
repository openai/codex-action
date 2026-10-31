import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildSync } from "esbuild";

const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/readServerInfo.ts", import.meta.url))],
  bundle: true, format: "cjs", platform: "node", write: false,
});
const require = createRequire(import.meta.url);

const bundleDir = mkdtempSync(join(tmpdir(), "read-server-info-bundle-"));
const bundlePath = join(bundleDir, "readServerInfo.cjs");
writeFileSync(bundlePath, outputFiles[0].text);

function load() {
  return require(bundlePath).readServerInfo;
}

test("a missing server info file fails fast and names the openai-api-key input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "server-info-"));
  const started = Date.now();
  await assert.rejects(
    load()(join(dir, "missing.json")),
    (error) => {
      assert.match(error.message, /No Responses API proxy server info found/);
      assert.match(error.message, /openai-api-key/);
      return true;
    },
  );
  // The old behavior polled a missing file for about ten seconds.
  assert.ok(Date.now() - started < 2000);
});

test("a server info file with a port sets the port output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "server-info-"));
  const infoFile = join(dir, "info.json");
  const outputFile = join(dir, "output");
  writeFileSync(infoFile, JSON.stringify({ port: 4242 }));
  writeFileSync(outputFile, "");
  const previous = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outputFile;
  try {
    await load()(infoFile);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
  }
  assert.match(readFileSync(outputFile, "utf8"), /port<<.*\n4242\n/s);
});

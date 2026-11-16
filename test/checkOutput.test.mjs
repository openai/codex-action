import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildSync } from "esbuild";

const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/checkOutput.ts", import.meta.url))],
  bundle: true, format: "cjs", platform: "node", write: false,
});
const require = createRequire(import.meta.url);

function capture(chunks, code = 0) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, process,
    require(name) {
      return name === "child_process" ? { spawn: () => proc } : require(name);
    },
  });
  const result = module.exports.checkOutput(["fixture"]);
  for (const chunk of chunks) proc.stdout.write(chunk);
  proc.stdout.end();
  proc.stdout.on("end", () => proc.emit("close", code));
  return result;
}

for (const text of ["/home/André/bin/codex\n", "/home/用户/bin/codex\n", "done 😀\n"]) {
  test(`preserves split UTF-8 output: ${text.trim()}`, async () => {
    const bytes = Buffer.from(text);
    const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
    assert.equal(await capture(chunks), text);
  });
}

test("rejects nonzero exit codes after collecting output", async () => {
  await assert.rejects(capture([Buffer.from("partial")], 7), /exited with code 7/);
});

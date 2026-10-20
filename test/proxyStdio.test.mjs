import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));

async function actionSource() {
  return await readFile(actionPath, "utf8");
}

test("background proxy redirects stdout and stderr away from the step stream", async () => {
  const source = await actionSource();

  assert.ok(
    source.includes(
      'exec env -u PROXY_API_KEY -u NODE_OPTIONS NODE_OPTIONS=--disable-sigusr1 "${args[@]}" <<< "$PROXY_API_KEY"\n        ) >>"$PROXY_LOG_FILE" 2>&1 &'
    )
  );
  assert.match(
    source,
    /PROXY_LOG_FILE: \$\{\{ runner\.temp \}\}\/codex-responses-api-proxy-\$\{\{ github\.run_id \}\}\.log/
  );
});

test("proxy startup failure prints the detached log", async () => {
  const source = await actionSource();

  assert.match(source, /responses-api-proxy did not write server info/);
  assert.match(source, /cat "\$PROXY_LOG_FILE" >&2/);
});

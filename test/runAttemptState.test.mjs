import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));

test("server-info state includes the GitHub run attempt", async () => {
  const source = await readFile(actionPath, "utf8");
  const expected =
    "CODEX_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}";

  assert.equal(source.split(expected).length - 1, 2);
  assert.doesNotMatch(
    source,
    /^\s*CODEX_RUN_ID: \$\{\{ github\.run_id \}\}\s*$/m
  );
  assert.match(source, /server_info_file="\$CODEX_HOME\/\$CODEX_RUN_ID\.json"/);
});

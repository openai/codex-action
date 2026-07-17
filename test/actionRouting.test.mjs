import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));
const action = readFileSync(actionPath, "utf8");

function stepCondition(name) {
  const marker = `    - name: ${name}\n`;
  const start = action.indexOf(marker);
  assert.notEqual(start, -1, `missing action step: ${name}`);
  const next = action.indexOf("\n    - name: ", start + marker.length);
  const block = action.slice(start, next < 0 ? undefined : next);
  const condition = block
    .split("\n")
    .find((line) => line.startsWith("      if: "));
  assert.ok(condition, `missing condition for action step: ${name}`);
  return condition.slice("      if: ".length);
}

test("keeps Linux prompt execution out of the pre-drop steps", () => {
  const expected = `\${{ inputs['safety-strategy'] == 'drop-sudo' && inputs['openai-api-key'] != '' && (runner.os != 'Linux' || (inputs.prompt == '' && inputs['prompt-file'] == '')) }}`;

  assert.equal(stepCondition("Drop sudo privilege, if appropriate"), expected);
  assert.equal(stepCondition("Verify sudo privilege removed"), expected);
});

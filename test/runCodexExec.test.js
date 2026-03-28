const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const { getCodexExecTempRoot } = require("../dist/main.js");

describe("getCodexExecTempRoot", () => {
  it("prefers RUNNER_TEMP over os.tmpdir()", () => {
    const originalRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = path.join(os.tmpdir(), "runner-temp");

    try {
      assert.equal(getCodexExecTempRoot(), process.env.RUNNER_TEMP);
    } finally {
      if (originalRunnerTemp == null) {
        delete process.env.RUNNER_TEMP;
      } else {
        process.env.RUNNER_TEMP = originalRunnerTemp;
      }
    }
  });
});

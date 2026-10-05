import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = fileURLToPath(new URL("../src/execDiagnostics.ts", import.meta.url));
const compiled = buildSync({
  stdin: { contents: `${readFileSync(source, "utf8")}\nexport { collectProcesses };`, loader: "ts" },
  bundle: true, format: "cjs", platform: "node", write: false,
}).outputFiles[0].text;
const prefix = "[codex-action diagnostics] ";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(filesystem = {}, platform = "linux") {
  const module = { exports: {} };
  const events = [];
  const clock = { now: 0, unreferenced: false, cleared: false };
  let tick;
  const timer = { unref() { clock.unreferenced = true; } };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Date: { now: () => clock.now },
    process: { platform, pid: 100, arch: "x64", version: "v20", env: { RUNNER_ENVIRONMENT: "private-runner" } },
    console: { log(line) { assert.ok(line.startsWith(prefix)); events.push(JSON.parse(line.slice(prefix.length))); } },
    setInterval(callback, ms) { assert.equal(ms, 30_000); tick = callback; return timer; },
    clearInterval(value) { assert.equal(value, timer); clock.cleared = true; },
    require(name) {
      if (name === "node:fs/promises") return filesystem;
      if (name === "node:os") return { release: () => "fixture-kernel" };
      assert.fail(`unexpected import: ${name}`);
    },
  });
  return { ...module.exports, events, clock, tick: () => tick() };
}

test("heartbeats report byte counts and quiet time without keeping the process alive", () => {
  const f = fixture({}, "darwin");
  const diagnostic = f.startExecDiagnostics("unsafe");
  diagnostic.spawned(101);
  f.clock.now = 7;
  diagnostic.output("stdout", 5);
  diagnostic.output("stderr", 3);
  f.clock.now = 30_000;
  f.tick();
  assert.deepEqual(f.events.at(-1), {
    event: "heartbeat", phase: "running", elapsedMs: 30_000, quietMs: 29_993,
    stdout: 5, stderr: 3, collecting: false,
  });
  assert.equal(f.events[0].runner, "unknown");
  assert.equal(f.clock.unreferenced, true);
  diagnostic.stop();
  assert.equal(f.clock.cleared, true);
});

test("inaccessible proc is nonfatal and stop suppresses an in-flight snapshot", async () => {
  let complete;
  let reads = 0;
  const f = fixture({
    readdir: () => new Promise((resolve, reject) => { complete = { resolve, reject }; }),
    readFile: async () => { reads++; return "unavailable"; },
  });
  const diagnostic = f.startExecDiagnostics("drop-sudo");
  diagnostic.spawned(101);
  complete.reject(new Error("permission denied"));
  await flush();
  assert.equal(f.events.at(-1).event, "process-snapshot-unavailable");
  f.tick();
  diagnostic.stop();
  const count = f.events.length;
  complete.resolve(["100"]);
  await flush();
  assert.equal(f.events.length, count);
  assert.equal(reads, 0, "stopped diagnostics must not start more reads");
  assert.equal(f.clock.cleared, true);
});

test("an elapsed collection budget prevents new process-detail reads", async () => {
  let complete;
  let reads = 0;
  const f = fixture({
    readdir: () => new Promise((resolve) => { complete = resolve; }),
    readFile: async () => { reads++; return "unavailable"; },
  });
  const diagnostic = f.startExecDiagnostics("unsafe");
  diagnostic.spawned(101);
  f.clock.now = 2_001;
  complete(["100"]);
  await flush();
  assert.equal(reads, 0, "cancelled collection must not start more reads");
  assert.equal(f.events.at(-1).truncated, true);
  diagnostic.stop();
});

test("process snapshots scope descendants, retain reparented identities, and redact file paths", async () => {
  const processes = new Map([[100, [1, "10"]], [101, [100, "11"]], [102, [101, "12"]], [200, [1, "20"]]]);
  const reads = [];
  let reuseDuringDetails = false;
  const f = fixture({
    async readdir(file) {
      reads.push(file);
      if (file === "/proc") return [...processes.keys()].map(String);
      assert.match(file, /^\/proc\/10[012]\/task$/);
      if (file === "/proc/101/task") throw new Error("permission denied");
      return ["1"];
    },
    async readFile(file) {
      reads.push(file);
      assert.match(file, /^\/proc\/\d+\/(stat|status|task\/\d+\/wchan)$/);
      const pid = Number(file.split("/")[2]);
      if (file.endsWith("/stat")) {
        const [parent, start] = processes.get(pid);
        const fields = Array(20).fill("0");
        [fields[0], fields[1], fields[19]] = ["S", String(parent), start];
        const name = pid === 100 ? "MainThread" : pid === 102 ? "sudo" : `worker (${pid})`;
        return `${pid} (${name}) ${fields.join(" ")}`;
      }
      assert.ok(pid >= 100 && pid <= 102, "unrelated process details must not be read");
      if (pid === 101 && reuseDuringDetails) processes.set(101, [1, "99"]);
      if (pid === 102) throw new Error("permission denied");
      return file.endsWith("/status") ? "Uid:\t1000\nGid:\t1001\nNoNewPrivs:\t1\nCapEff:\t0000" : "futex_wait";
    },
    async readlink(file) {
      reads.push(file);
      assert.match(file, /^\/proc\/10[012]\/(exe|fd\/[012])$/);
      if (file.endsWith("/exe")) {
        if (file === "/proc/102/exe") throw new Error("permission denied");
        return file === "/proc/100/exe" ? "/opt/node/bin/node" : "/private/secret-executable";
      }
      return file.endsWith("/0") ? "/dev/null" : file.endsWith("/1") ? "pipe:[42]" : "/private/credential-file";
    },
  });
  const known = new Map();
  const first = await f.collectProcesses(100, known);
  assert.equal(first.processes.map(({ pid }) => pid).join(), "100,101,102");
  assert.deepEqual(Array.from(first.processes[0].stdio), ["/dev/null", "pipe:[42]", "file-or-device"]);
  assert.equal(first.processes[0].noNewPrivs, "1");
  assert.equal(first.processes.map(({ name }) => name).join(), "node,other,sudo");
  assert.equal(first.processes[1].threads.length, 0);
  assert.doesNotMatch(JSON.stringify(first), /credential-file|\/private\/|\/opt\/node\//);
  processes.set(101, [1, "11"]);
  assert.equal((await f.collectProcesses(100, known)).processes.length, 3);
  reuseDuringDetails = true;
  processes.delete(102);
  assert.equal((await f.collectProcesses(100, known)).processes.map(({ pid }) => pid).join(), "100");
  assert.equal((await f.collectProcesses(100, known)).processes.map(({ pid }) => pid).join(), "100");
  for (const file of reads) assert.match(file, /^\/proc(?:\/\d+\/stat|\/10[012]\/(?:status|task(?:\/\d+\/wchan)?|exe|fd\/[012]))?$/);
});

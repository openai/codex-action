import { readFile, readdir, readlink } from "node:fs/promises";
import os from "node:os";

const INTERVAL_MS = 30_000;
const MAX_PROCESSES = 32;
const MAX_THREADS = 16;

export function startExecDiagnostics(safetyStrategy: string) {
  const started = Date.now();
  let phase = "launching";
  let stopped = false;
  let collecting = false;
  let lastOutput = started;
  const bytes = { stdout: 0, stderr: 0 };
  const known = new Map<number, string>();
  const report = (event: string, fields: object = {}) => {
    if (!stopped) {
      console.log(`[codex-action diagnostics] ${JSON.stringify({
        event, phase, elapsedMs: Date.now() - started, ...fields,
      })}`);
    }
  };
  const snapshot = async () => {
    if (stopped || collecting || process.platform !== "linux") return;
    collecting = true;
    const deadline = Date.now() + 2_000;
    try {
      const snapshot = await collectProcesses(process.pid, known, () => !stopped && Date.now() < deadline);
      report("process-snapshot", { truncated: snapshot.truncated });
      for (const entry of snapshot.processes) report("process", entry);
    } catch {
      report("process-snapshot-unavailable");
    } finally {
      collecting = false;
    }
  };
  report("start", {
    platform: process.platform, arch: process.arch, kernel: os.release(),
    node: process.version, pid: process.pid, safetyStrategy,
    runner: ["github-hosted", "self-hosted"].includes(process.env.RUNNER_ENVIRONMENT ?? "")
      ? process.env.RUNNER_ENVIRONMENT : "unknown",
  });
  const timer = setInterval(() => {
    report("heartbeat", { quietMs: Date.now() - lastOutput, ...bytes, collecting });
    void snapshot();
  }, INTERVAL_MS);
  timer.unref();
  return {
    phase(next: string, fields: object = {}) {
      phase = next;
      report("phase", fields);
    },
    spawned(pid: number | undefined) {
      phase = "running";
      report("spawn", { childPid: pid });
      void snapshot();
    },
    output(stream: "stdout" | "stderr", count: number) {
      bytes[stream] += count;
      lastOutput = Date.now();
    },
    stop() {
      clearInterval(timer);
      stopped = true;
    },
  };
}

export type ExecDiagnostics = ReturnType<typeof startExecDiagnostics>;

async function procText(file: string): Promise<string> {
  try { return (await readFile(file, "utf8")).trim(); }
  catch { return "unavailable"; }
}

async function pipeTarget(pid: number, fd: number): Promise<string> {
  try {
    const target = await readlink(`/proc/${pid}/fd/${fd}`);
    // Never include paths to repository, output, or credential files.
    return /^(pipe|socket):\[\d+\]$/.test(target) || target === "/dev/null"
      ? target : "file-or-device";
  } catch { return "unavailable"; }
}

async function collectProcesses(root: number, known: Map<number, string>, active = () => true) {
  const entries = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const processes = [];
  // Bound work on busy self-hosted runners; do not spawn ps or perform DNS/NSS lookups.
  for (let offset = 0; offset < Math.min(entries.length, 4096); offset += 64) {
    if (!active()) break;
    const batch = await Promise.all(entries.slice(offset, offset + 64).map(async (name) => {
      const stat = await procText(`/proc/${name}/stat`);
      const end = stat.lastIndexOf(")");
      if (end < 0) return null;
      const fields = stat.slice(end + 2).split(" ");
      return {
        pid: Number(name), ppid: Number(fields[1]), state: fields[0],
        name: stat.slice(stat.indexOf("(") + 1, end), start: fields[19],
      };
    }));
    for (const entry of batch) if (entry) processes.push(entry);
  }
  const included = new Set([root]);
  let previousSize;
  do {
    previousSize = included.size;
    for (const entry of processes) {
      if (included.has(entry.ppid) || known.get(entry.pid) === entry.start) included.add(entry.pid);
    }
  } while (included.size !== previousSize);
  const descendants = processes.filter((entry) => included.has(entry.pid));
  known.clear();
  const selected = descendants.slice(0, MAX_PROCESSES);
  const details = await Promise.all(selected.map(async (entry) => {
    if (!active()) return null;
    known.set(entry.pid, entry.start);
    const base = `/proc/${entry.pid}`;
    const status = await procText(`${base}/status`);
    if (!active()) return null;
    const tids = await readdir(`${base}/task`).catch(() => [] as string[]);
    if (!active()) return null;
    const threads = await Promise.all(tids.slice(0, MAX_THREADS).map(async (tid) => ({
      tid: Number(tid), wait: await procText(`${base}/task/${tid}/wchan`),
    })));
    if (!active()) return null;
    const stdio = await Promise.all([0, 1, 2].map((fd) => pipeTarget(entry.pid, fd)));
    if (!active()) return null;
    const stat = await procText(`${base}/stat`);
    if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== entry.start) return null;
    return {
      pid: entry.pid, ppid: entry.ppid,
      name: ["node", "nodejs", "codex", "sudo", "sh", "bash", "dash", "setpriv", "env", "npm"].includes(entry.name)
        ? entry.name : "other",
      state: entry.state,
      uid: status.match(/^Uid:\s+(\d+)/m)?.[1],
      gid: status.match(/^Gid:\s+(\d+)/m)?.[1],
      noNewPrivs: status.match(/^NoNewPrivs:\s+(\d+)/m)?.[1],
      capabilities: status.match(/^CapEff:\s+([\da-f]+)/m)?.[1],
      stdio,
      threads, threadsTruncated: tids.length > MAX_THREADS,
    };
  }));
  return {
    processes: details.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    truncated: !active() || entries.length > 4096 || descendants.length > MAX_PROCESSES,
  };
}

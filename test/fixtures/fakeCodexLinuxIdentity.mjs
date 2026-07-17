import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const cdIndex = args.indexOf("--cd");
if (cdIndex < 0 || cdIndex + 1 >= args.length) {
  throw new Error("missing --cd");
}
process.chdir(args[cdIndex + 1]);

const status = readFileSync("/proc/self/status", "utf8");
const statusField = (name) => {
  const line = status
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}:`));
  if (line == null) {
    throw new Error(`missing ${name} in /proc/self/status`);
  }
  return line.slice(name.length + 1).trim();
};

const identity = {
  uid: process.getuid(),
  gid: process.getgid(),
  groups: statusField("Groups"),
  idGroups: spawnSync("/usr/bin/id", ["-G"], { encoding: "utf8" })
    .stdout.trim(),
  accountGroups: spawnSync("/usr/bin/id", ["-nG", process.env.USER], {
    encoding: "utf8",
  }).stdout.trim(),
  capInh: statusField("CapInh"),
  capPrm: statusField("CapPrm"),
  capEff: statusField("CapEff"),
  capBnd: statusField("CapBnd"),
  capAmb: statusField("CapAmb"),
  noNewPrivs: statusField("NoNewPrivs"),
  sudoStatus: spawnSync("/usr/bin/sudo", ["-n", "true"]).status,
  home: process.env.HOME,
  cwd: process.cwd(),
  supplementaryFileReadable: true,
};

try {
  readFileSync(process.env.SUPPLEMENTARY_GROUP_FILE);
} catch {
  identity.supplementaryFileReadable = false;
}

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk;
}

const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0 || outputIndex + 1 >= args.length) {
  throw new Error("missing --output-last-message");
}

writeFileSync(args[outputIndex + 1], "fake final message\n");
writeFileSync(
  process.env.CODEX_CAPTURE_PATH,
  JSON.stringify({ identity, prompt })
);

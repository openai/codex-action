import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const [codexHome, safetyStrategy, codexUser = ""] = process.argv.slice(2);

if (!codexHome) {
  throw new Error("Codex home path is required");
}

if (safetyStrategy === "unprivileged-user") {
  if (!codexUser) {
    throw new Error(
      "codex-user is required when ensuring a Codex home for unprivileged-user"
    );
  }

  const runId = process.env.GITHUB_RUN_ID ?? "";
  if (!runId) {
    throw new Error(
      "GITHUB_RUN_ID is required when preparing an unprivileged Codex home"
    );
  }

  if (!(await pathExists(codexHome))) {
    await run("sudo", ["mkdir", "-p", "--", codexHome]);
    await run("sudo", ["chown", codexUser, codexHome]);
    await run("sudo", ["chmod", "755", codexHome]);
  }

  // The proxy runs as the action's current user, while Codex runs as codexUser.
  // Pre-create the per-run file so the proxy can write server info even when
  // CODEX_HOME itself is owned by the unprivileged user and is not writable by
  // the runner. The existing wait step locks this file back down to root:0444.
  const serverInfoFile = path.join(codexHome, `${runId}.json`);
  if (!(await pathExists(serverInfoFile))) {
    await run("sudo", ["touch", "--", serverInfoFile]);
    await run("sudo", ["chmod", "666", serverInfoFile]);
  }
} else {
  await mkdir(codexHome, { recursive: true });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`${command} terminated by signal ${signal}`));
        return;
      }

      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

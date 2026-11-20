import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const [operation, safetyStrategy, codexUser = ""] = process.argv.slice(2);

switch (operation) {
  case "prepare":
    await prepareOutput();
    break;
  case "cleanup":
    await cleanupOutput();
    break;
  default:
    throw new Error("Expected operation to be 'prepare' or 'cleanup'");
}

async function prepareOutput() {
  let dir;
  if (safetyStrategy === "unprivileged-user") {
    if (!codexUser) {
      throw new Error(
        "codex-user is required when preparing output for unprivileged-user"
      );
    }
    dir = (
      await capture("sudo", [
        "-u",
        codexUser,
        "--",
        "mktemp",
        "-d",
        "-t",
        "codex-action-output.XXXXXX",
      ])
    ).trim();
  } else {
    dir = await mkdtemp(path.join(os.tmpdir(), "codex-action-output-"));
  }

  if (!dir) {
    throw new Error("Could not create managed Codex output directory");
  }

  const outputFile = path.join(dir, "output.md");
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!githubOutput) {
    await removeDirectory(dir);
    throw new Error("GITHUB_OUTPUT is required to publish managed output paths");
  }

  try {
    await appendFile(
      githubOutput,
      `output_file=${outputFile}\noutput_dir=${dir}\n`,
      "utf8"
    );
  } catch (error) {
    await removeDirectory(dir);
    throw error;
  }
}

async function cleanupOutput() {
  const dir = process.env.CODEX_MANAGED_OUTPUT_DIR ?? "";
  if (!dir) {
    return;
  }
  await removeDirectory(dir);
}

async function removeDirectory(dir) {
  if (safetyStrategy === "unprivileged-user") {
    await run("sudo", ["rm", "-rf", "--", dir]);
  } else {
    await rm(dir, { recursive: true, force: true });
  }
}

async function capture(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(exitError(command, code, signal));
    });
  });
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
      reject(exitError(command, code, signal));
    });
  });
}

function exitError(command, code, signal) {
  if (signal) {
    return new Error(`${command} terminated by signal ${signal}`);
  }
  return new Error(`${command} exited with code ${code}`);
}

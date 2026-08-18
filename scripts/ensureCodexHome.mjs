import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

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

  await run("sudo", ["-u", codexUser, "--", "mkdir", "-p", "--", codexHome]);
} else {
  await mkdir(codexHome, { recursive: true });
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

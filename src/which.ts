import { spawn } from "child_process";

export function which(command: string): Promise<string | null> {
  return new Promise<string>((resolve, reject) => {
    const which = spawn("which", [command], {
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    which.on("error", reject);

    let output = "";
    which.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    which.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`which exited with code ${code}`));
        return;
      }

      const path = output.trim();
      if (path === "") {
        reject(new Error("could not find 'codex' in PATH"));
        return;
      }

      resolve(path);
    });
  });
}

import { spawn } from "child_process";

export function checkOutput(command: Array<string>): Promise<string> {
  const [prog, ...args] = command;
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(prog, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    proc.on("error", reject);

    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${prog} exited with code ${code}`));
        return;
      }

      resolve(output);
    });
  });
}

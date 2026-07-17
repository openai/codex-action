import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { FIND_PATH } from "./linuxSystemPaths";

const MAX_GIT_DIRECTORY_OUTPUT_BYTES = 64 * 1024;

export async function discoverNestedGitRepositories(
  root: string
): Promise<Array<string>> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(FIND_PATH, [
      "-P",
      root,
      "-xdev",
      "-name",
      ".git",
      "(",
      "-type",
      "f",
      "-o",
      "-type",
      "d",
      ")",
      "-printf",
      "%h\\0",
      "-prune",
    ]);
    let stdout = "";
    let stderr = "";
    let exceededLimit = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (
        !exceededLimit &&
        Buffer.byteLength(stdout) > MAX_GIT_DIRECTORY_OUTPUT_BYTES
      ) {
        exceededLimit = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) {
        stderr += chunk;
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (exceededLimit) {
        reject(
          new Error(
            `Linux drop-sudo found too many nested Git repositories beneath '${root}'.`
          )
        );
      } else if (code !== 0) {
        reject(
          new Error(
            `Linux drop-sudo could not discover nested Git repositories beneath '${root}': ${stderr.trim()}`
          )
        );
      } else {
        resolve(stdout);
      }
    });
  });

  const repositories: Array<string> = [];
  for (const candidate of output.split("\0")) {
    if (candidate.length === 0) {
      continue;
    }
    const absoluteCandidate = path.resolve(candidate);
    const resolvedCandidate = await realpath(absoluteCandidate);
    if (
      resolvedCandidate === absoluteCandidate &&
      isPathWithin(resolvedCandidate, root)
    ) {
      repositories.push(resolvedCandidate);
    }
  }
  return repositories;
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

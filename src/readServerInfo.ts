import * as core from "@actions/core";
import * as fs from "fs/promises";

/**
 * In theory, this is not called until `serverInfoFile` is non-empty, but we
 * will poll in the rare case that it was a partial write.
 */
export async function readServerInfo(serverInfoFile: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const contents = await fs.readFile(serverInfoFile, { encoding: "utf8" });
      const { port } = JSON.parse(contents);
      if (typeof port !== "number") {
        continue;
      }

      core.setOutput("port", port.toString());
      return;
    } catch (error) {
      if (isMissingFile(error)) {
        // The file is only created by the Responses API proxy, which is only
        // started when `openai-api-key` is set (or was started by an earlier
        // codex-action step in this job). If it does not exist by now, waiting
        // will not create it.
        throw Error(
          `No Responses API proxy server info found at ${serverInfoFile}. ` +
            "The proxy is only started when the `openai-api-key` input is " +
            "non-empty, so check that it is set and that the secret it " +
            "references (for example OPENAI_API_KEY) exists in this repository.",
        );
      }
      console.error(`Error reading server info: ${error}`);
      await sleep(100);
    }
  }

  throw Error(`Failed to read server info from ${serverInfoFile}`);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

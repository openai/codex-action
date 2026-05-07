import * as core from "@actions/core";
import * as fs from "fs/promises";
import { ensureValidPort } from "./ports";

/**
 * In theory, this is not called until `serverInfoFile` is non-empty, but we
 * will poll in the rare case that it was a partial write.
 */
export async function readServerInfo(serverInfoFile: string): Promise<void> {
  let seenEnoent = false;

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const contents = await fs.readFile(serverInfoFile, { encoding: "utf8" });
      const { port } = JSON.parse(contents);
      const parsedPort = ensureValidPort(port);

      core.setOutput("port", parsedPort.toString());
      return;
    } catch (error) {
      if (isEnoent(error)) {
        seenEnoent = true;
      }
      console.error(`Error reading server info: ${error}`);
      await sleep(100);
    }
  }

  const hint = seenEnoent
    ? "\nHint: the server info file was never created — check that the" +
      " 'openai-api-key' input is set and the Responses API proxy started" +
      " successfully."
    : "";
  throw Error(`Failed to read server info from ${serverInfoFile}${hint}`);
}

function isEnoent(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

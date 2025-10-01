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
      console.error(`Error reading server info: ${error}`);
      await sleep(100);
    }
  }

  throw Error(`Failed to read server info from ${serverInfoFile}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

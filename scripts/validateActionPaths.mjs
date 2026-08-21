import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";

const promptFile = (process.env.CODEX_PROMPT_FILE ?? "").trim();
const workingDirectory = (process.env.CODEX_WORKING_DIRECTORY ?? "").trim();

if (promptFile) {
  await requireReadableFile("prompt-file", promptFile);
}

if (!workingDirectory) {
  throw new Error("working-directory resolved to an empty path");
}
await requireDirectory("working-directory", workingDirectory);

async function requireReadableFile(label, target) {
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(`${label} does not exist: ${target}`);
  }

  if (info.isDirectory()) {
    throw new Error(`${label} must reference a file, not a directory: ${target}`);
  }

  try {
    await access(target, constants.R_OK);
  } catch {
    throw new Error(`${label} is not readable: ${target}`);
  }
}

async function requireDirectory(label, target) {
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(`${label} does not exist: ${target}`);
  }

  if (!info.isDirectory()) {
    throw new Error(`${label} must reference a directory: ${target}`);
  }
}

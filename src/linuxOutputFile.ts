import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export async function prepareLinuxOutputFile(file: string): Promise<{
  file: string;
  handle: FileHandle;
}> {
  const absoluteFile = path.resolve(file);
  const absoluteParent = path.dirname(absoluteFile);
  const canonicalParent = await realpath(absoluteParent);
  if (canonicalParent !== absoluteParent) {
    throw new Error(
      `Linux drop-sudo refuses an output path containing symbolic links: '${absoluteFile}'.`
    );
  }
  try {
    const pathStats = await lstat(absoluteFile);
    if (pathStats.isSymbolicLink()) {
      throw new Error(
        `Linux drop-sudo refuses an output path containing symbolic links: '${absoluteFile}'.`
      );
    }
    if (!pathStats.isFile()) {
      throw new Error(
        `Linux drop-sudo requires a regular output file; found '${absoluteFile}'.`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const handle = await open(
    absoluteFile,
    fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_RDWR |
      fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new Error(
        `Linux drop-sudo requires a regular output file; found '${absoluteFile}'.`
      );
    }
    const runnerUid = process.getuid!();
    if (fileStats.uid !== runnerUid) {
      throw new Error(
        `Linux drop-sudo requires the output file to be owned by runner UID ${runnerUid}; '${absoluteFile}' is owned by UID ${fileStats.uid}.`
      );
    }
    if (fileStats.nlink !== 1) {
      throw new Error(
        `Linux drop-sudo refuses an output file with multiple hard links: '${absoluteFile}'.`
      );
    }
    const canonicalFile = await realpath(absoluteFile);
    if (canonicalFile !== absoluteFile) {
      throw new Error(
        `Linux drop-sudo refuses an output path containing symbolic links: '${absoluteFile}'.`
      );
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  return { file: absoluteFile, handle };
}

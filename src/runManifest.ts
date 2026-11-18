import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export type RunManifestOutcome = "succeeded" | "failed";

export interface RunManifestData {
  startedAt: number;
  finishedAt: number;
  outcome: RunManifestOutcome;
  promptSource: "inline" | "file";
  requestedSafetyStrategy: "drop-sudo" | "read-only" | "unprivileged-user" | "unsafe";
  requestedLegacySandbox: "read-only" | "workspace-write" | "danger-full-access" | null;
  githubEventSha: string | null;
}

/** Reject a bad destination before an expensive Codex run begins. */
export async function validateRunManifestPath(
  workspace: string,
  file: string
): Promise<void> {
  const destination = await destinationFor(workspace, file);
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("run-manifest-file already exists");
}

async function destinationFor(workspace: string, file: string): Promise<string> {
  // A single root-level filename avoids project-controlled parent symlink swaps.
  if (
    !workspace || !file || file === "." || file === ".." ||
    file.includes("/") || file.includes("\\") || file.includes(":") ||
    path.isAbsolute(file)
  ) {
    throw new Error("run-manifest-file must be a filename at the GITHUB_WORKSPACE root");
  }
  return path.join(await realpath(workspace), file);
}

/** Write only Action-owned, non-secret fields to a new workspace-root file. */
export async function writeRunManifest(
  workspace: string,
  file: string,
  data: RunManifestData
): Promise<string> {
  const destination = await destinationFor(workspace, file);
  const sha = data.githubEventSha;
  const manifest = {
    documentType: "codex-action.run-manifest",
    schemaVersion: 1,
    startedAt: new Date(data.startedAt).toISOString(),
    finishedAt: new Date(data.finishedAt).toISOString(),
    durationMs: Math.max(0, data.finishedAt - data.startedAt),
    outcome: data.outcome,
    promptSource: data.promptSource,
    requestedSafetyStrategy: data.requestedSafetyStrategy,
    requestedLegacySandbox: data.requestedLegacySandbox,
    githubEventSha: sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null,
  };

  // wx prevents replacement of an existing file or final-component symlink.
  // The file must not be world-readable, even on a permissive runner.
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return file;
}

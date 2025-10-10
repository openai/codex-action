import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkOutput } from "./checkOutput";
import { SafetyStrategy } from "./runCodexExec";

/**
 * Writes a Codex `auth.json` file from a base64-encoded string.
 *
 * - Validates the payload decodes and parses as JSON.
 * - Writes to `<codexHome>/auth.json`.
 * - Sets file mode to 0600.
 * - When using the `unprivileged-user` strategy, writes to a temp path and
 *   then moves the file into place with `sudo`, fixing ownership.
 */
export async function writeAuthJson(
  codexHome: string,
  safetyStrategy: SafetyStrategy,
  codexUser: string | null,
  authJsonB64: string
): Promise<void> {
  const trimmed = authJsonB64.trim();
  if (trimmed.length === 0) {
    throw new Error(
      "Empty CODEX_AUTH_JSON_B64 provided. Expected base64-encoded auth.json contents."
    );
  }

  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, "base64").toString("utf8");
  } catch (err) {
    throw new Error(
      `Failed to decode CODEX_AUTH_JSON_B64 as base64: ${(err as Error).message}`
    );
  }

  try {
    // Validate JSON shape, but do not mutate it.
    JSON.parse(decoded);
  } catch (err) {
    throw new Error(
      `Decoded auth.json is not valid JSON: ${(err as Error).message}`
    );
  }

  const destPath = path.join(codexHome, "auth.json");

  if (safetyStrategy === "unprivileged-user") {
    if (process.platform === "win32") {
      throw new Error(
        "the 'unprivileged-user' safety strategy is not supported on Windows."
      );
    }
    if (codexUser == null) {
      throw new Error(
        "codexUser must be specified when using the 'unprivileged-user' safety strategy."
      );
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-"));
    const tmpFile = path.join(tmpDir, "auth.json");
    try {
      await fs.writeFile(tmpFile, decoded, "utf8");
      // Move into place and fix owner/permissions via sudo.
      await checkOutput(["sudo", "mv", tmpFile, destPath]);
      await checkOutput(["sudo", "chown", codexUser, destPath]);
      await checkOutput(["sudo", "chmod", "600", destPath]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  } else {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(destPath, decoded, "utf8");
    await fs.chmod(destPath, 0o600);
  }
}

